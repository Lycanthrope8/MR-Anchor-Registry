// =============================================================================
// SSE Event Bus - Server-Sent Events for Real-Time Updates
// EP5 UPDATE: 
// - Added proper id: lines for SSE spec compliance
// - Added Last-Event-ID replay support with ring buffer
// - Events are emitted ONLY after Fabric commit confirmation (handled by caller)
// =============================================================================

const config = require('../config');
const logger = require('../utils/logger');

// Store connected SSE clients
const clients = new Map();
let clientIdCounter = 0;

// Monotonically increasing event ID
let globalEventId = Date.now();

// Event types
const EventTypes = {
    CLAIM_PROPOSED: 'CLAIM_PROPOSED',
    CLAIM_ENDORSED: 'CLAIM_ENDORSED',
    CLAIM_ACTIVATED: 'CLAIM_ACTIVATED',
    CLAIM_REJECTED: 'CLAIM_REJECTED',
    CLAIM_REVOKED: 'CLAIM_REVOKED',
    CLAIM_REOPENED: 'CLAIM_REOPENED',
    ACTIVE_CHANGED: 'ACTIVE_CHANGED',
    HEARTBEAT: 'HEARTBEAT'
};

// Recent events buffer for replay (ring buffer)
const MAX_RECENT_EVENTS = 200;
const recentEvents = [];

// Map event IDs to buffer indices for quick lookup
const eventIdIndex = new Map();

/**
 * Generate next monotonic event ID
 */
function nextEventId() {
    return `evt-${++globalEventId}`;
}

/**
 * Add a new SSE client connection
 * @param {Response} res - Express response object
 * @param {string|null} assetIdFilter - Optional asset ID filter
 * @param {string|null} lastEventId - Last-Event-ID header for replay
 */
function addClient(res, assetIdFilter = null, lastEventId = null) {
    const clientId = ++clientIdCounter;
    
    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // Disable nginx buffering
        'Access-Control-Allow-Origin': '*'
    });
    
    // Store client
    clients.set(clientId, {
        res,
        assetIdFilter,
        connectedAt: new Date().toISOString(),
        lastEventId
    });
    
    logger.info(`SSE client ${clientId} connected (filter: ${assetIdFilter || 'all'}, lastEventId: ${lastEventId || 'none'})`);
    
    // Send initial connection event (with proper id: line)
    const connectedEventId = nextEventId();
    const connectedEvent = {
        type: 'CONNECTED',
        clientId,
        timestamp: new Date().toISOString(),
        message: 'SSE connection established'
    };
    sendToClientRaw(clientId, connectedEventId, connectedEvent);
    
    // Replay events since lastEventId if available
    if (lastEventId) {
        const replayEvents = getEventsSince(lastEventId, assetIdFilter);
        if (replayEvents.length > 0) {
            logger.info(`SSE client ${clientId}: Replaying ${replayEvents.length} events since ${lastEventId}`);
            replayEvents.forEach(event => {
                sendToClientRaw(clientId, event.eventId, { ...event, isReplay: true });
            });
        } else {
            logger.info(`SSE client ${clientId}: No events to replay (lastEventId ${lastEventId} not found or too old)`);
        }
    } else {
        // No lastEventId - send recent events for new clients
        const filtered = assetIdFilter 
            ? recentEvents.filter(e => !e.assetId || e.assetId === assetIdFilter)
            : recentEvents;
        
        filtered.slice(-20).forEach(event => {
            sendToClientRaw(clientId, event.eventId, { ...event, isReplay: true });
        });
    }
    
    // Setup heartbeat
    const heartbeatInterval = setInterval(() => {
        if (clients.has(clientId)) {
            const heartbeatId = nextEventId();
            sendToClientRaw(clientId, heartbeatId, {
                type: EventTypes.HEARTBEAT,
                timestamp: new Date().toISOString()
            });
        } else {
            clearInterval(heartbeatInterval);
        }
    }, config.sse.heartbeatInterval);
    
    // Handle client disconnect
    res.on('close', () => {
        clients.delete(clientId);
        clearInterval(heartbeatInterval);
        logger.info(`SSE client ${clientId} disconnected`);
    });
    
    return clientId;
}

/**
 * Get events since a specific eventId (for replay)
 */
function getEventsSince(lastEventId, assetIdFilter = null) {
    const idx = eventIdIndex.get(lastEventId);
    if (idx === undefined) {
        // Event not found in buffer - could be too old
        return [];
    }
    
    // Find the actual position in recentEvents
    const startIdx = recentEvents.findIndex(e => e.eventId === lastEventId);
    if (startIdx === -1) {
        return [];
    }
    
    // Return events AFTER the lastEventId
    const events = recentEvents.slice(startIdx + 1);
    
    if (assetIdFilter) {
        return events.filter(e => !e.assetId || e.assetId === assetIdFilter);
    }
    
    return events;
}

/**
 * Send event to a specific client with proper SSE format
 */
function sendToClientRaw(clientId, eventId, data) {
    const client = clients.get(clientId);
    if (!client) return false;
    
    try {
        // SSE format with id: line
        const lines = [];
        lines.push(`id: ${eventId}`);
        if (data.type) {
            lines.push(`event: ${data.type}`);
        }
        lines.push(`data: ${JSON.stringify(data)}`);
        lines.push(''); // Empty line to end event
        
        const eventStr = lines.join('\n') + '\n';
        client.res.write(eventStr);
        return true;
    } catch (err) {
        logger.error(`Error sending to client ${clientId}:`, err.message);
        clients.delete(clientId);
        return false;
    }
}

/**
 * Legacy send (for backwards compat) - use sendToClientRaw for new code
 */
function sendToClient(clientId, data) {
    const eventId = data.eventId || nextEventId();
    return sendToClientRaw(clientId, eventId, data);
}

/**
 * Broadcast event to all connected clients
 * IMPORTANT: This should only be called AFTER Fabric commit confirmation
 */
function broadcast(event) {
    const eventId = nextEventId();
    const eventWithMeta = {
        ...event,
        eventId,
        timestamp: event.timestamp || new Date().toISOString()
    };
    
    // Store in recent events ring buffer
    recentEvents.push(eventWithMeta);
    eventIdIndex.set(eventId, recentEvents.length - 1);
    
    // Evict old events if over limit
    while (recentEvents.length > MAX_RECENT_EVENTS) {
        const removed = recentEvents.shift();
        eventIdIndex.delete(removed.eventId);
        
        // Update indices for remaining events
        eventIdIndex.forEach((idx, id) => {
            if (idx > 0) eventIdIndex.set(id, idx - 1);
        });
    }
    
    // Broadcast to all connected clients
    let sentCount = 0;
    clients.forEach((client, clientId) => {
        // Filter by asset_id if client specified one
        if (client.assetIdFilter && event.assetId && event.assetId !== client.assetIdFilter) {
            return;
        }
        
        if (sendToClientRaw(clientId, eventId, eventWithMeta)) {
            sentCount++;
        }
    });
    
    logger.info(`SSE broadcast: ${event.type} (id=${eventId}) to ${sentCount} clients`);
    return sentCount;
}

/**
 * Get connected client count
 */
function getClientCount() {
    return clients.size;
}

/**
 * Get recent events
 */
function getRecentEvents(limit = 50, assetId = null) {
    let filtered = assetId 
        ? recentEvents.filter(e => !e.assetId || e.assetId === assetId)
        : recentEvents;
    
    return filtered.slice(-limit);
}

/**
 * Get the latest event ID (for snapshot endpoint)
 */
function getLatestEventId() {
    if (recentEvents.length === 0) return null;
    return recentEvents[recentEvents.length - 1].eventId;
}

// =============================================================================
// EVENT EMITTERS (called by routes AFTER Fabric commit confirmation)
// =============================================================================

function emitClaimProposed(claim) {
    broadcast({
        type: EventTypes.CLAIM_PROPOSED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        publisherId: claim.publisherId,
        state: claim.state,
        conflictClassification: claim.conflictClassification
    });
}

function emitClaimEndorsed(claim, endorserId) {
    broadcast({
        type: EventTypes.CLAIM_ENDORSED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        endorserId,
        endorsementCount: claim.endorsementCount,
        state: claim.state
    });
    
    // If claim became active, also emit active changed
    if (claim.state === 'ACTIVE') {
        emitActiveChanged(claim.assetId, claim.claimId, 'ENDORSED');
    }
}

function emitClaimActivated(claim) {
    broadcast({
        type: EventTypes.CLAIM_ACTIVATED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        activatedAt: claim.activatedAt
    });
    
    emitActiveChanged(claim.assetId, claim.claimId, 'ACTIVATED');
}

function emitClaimRejected(claim, supervisorId, reason) {
    broadcast({
        type: EventTypes.CLAIM_REJECTED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        supervisorId,
        reason,
        rejectedAt: claim.rejectedAt,
        state: claim.state
    });
}

function emitClaimRevoked(claim, supervisorId, reason) {
    broadcast({
        type: EventTypes.CLAIM_REVOKED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        supervisorId,
        reason,
        revokedAt: claim.revokedAt,
        state: claim.state
    });
    
    emitActiveChanged(claim.assetId, null, 'REVOKED');
}

function emitClaimReopened(claim, supervisorId) {
    broadcast({
        type: EventTypes.CLAIM_REOPENED,
        assetId: claim.assetId,
        claimId: claim.claimId,
        supervisorId,
        reopenedAt: claim.reopenedAt,
        state: claim.state
    });
}

function emitActiveChanged(assetId, activeClaimId, reason) {
    broadcast({
        type: EventTypes.ACTIVE_CHANGED,
        assetId,
        activeClaimId,
        reason
    });
}

module.exports = {
    EventTypes,
    addClient,
    broadcast,
    getClientCount,
    getRecentEvents,
    getLatestEventId,
    getEventsSince,
    emitClaimProposed,
    emitClaimEndorsed,
    emitClaimActivated,
    emitClaimRejected,
    emitClaimRevoked,
    emitClaimReopened,
    emitActiveChanged
};
