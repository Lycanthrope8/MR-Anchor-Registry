// =============================================================================
// SSE Event Bus - Server-Sent Events for Real-Time Updates
// =============================================================================

const config = require('../config');
const logger = require('../utils/logger');

// Store connected SSE clients
const clients = new Map();
let clientIdCounter = 0;

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

// Recent events buffer for new clients
const MAX_RECENT_EVENTS = 100;
const recentEvents = [];

/**
 * Add a new SSE client connection
 */
function addClient(res, assetIdFilter = null) {
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
        connectedAt: new Date().toISOString()
    });
    
    logger.info(`SSE client ${clientId} connected (filter: ${assetIdFilter || 'all'})`);
    
    // Send initial connection event
    sendToClient(clientId, {
        type: 'CONNECTED',
        clientId,
        timestamp: new Date().toISOString(),
        message: 'SSE connection established'
    });
    
    // Send recent events (filtered)
    const filtered = assetIdFilter 
        ? recentEvents.filter(e => !e.assetId || e.assetId === assetIdFilter)
        : recentEvents;
    
    filtered.slice(-20).forEach(event => {
        sendToClient(clientId, { ...event, isReplay: true });
    });
    
    // Setup heartbeat
    const heartbeatInterval = setInterval(() => {
        if (clients.has(clientId)) {
            sendToClient(clientId, {
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
 * Send event to a specific client
 */
function sendToClient(clientId, data) {
    const client = clients.get(clientId);
    if (!client) return false;
    
    try {
        const eventStr = `data: ${JSON.stringify(data)}\n\n`;
        client.res.write(eventStr);
        return true;
    } catch (err) {
        logger.error(`Error sending to client ${clientId}:`, err.message);
        clients.delete(clientId);
        return false;
    }
}

/**
 * Broadcast event to all connected clients
 */
function broadcast(event) {
    const eventWithTimestamp = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
        eventId: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };
    
    // Store in recent events
    recentEvents.push(eventWithTimestamp);
    while (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
    }
    
    // Broadcast to all connected clients
    let sentCount = 0;
    clients.forEach((client, clientId) => {
        // Filter by asset_id if client specified one
        if (client.assetIdFilter && event.assetId && event.assetId !== client.assetIdFilter) {
            return;
        }
        
        if (sendToClient(clientId, eventWithTimestamp)) {
            sentCount++;
        }
    });
    
    logger.info(`SSE broadcast: ${event.type} to ${sentCount} clients`);
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

// =============================================================================
// EVENT EMITTERS (called by routes when state changes)
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
    emitClaimProposed,
    emitClaimEndorsed,
    emitClaimActivated,
    emitClaimRejected,
    emitClaimRevoked,
    emitClaimReopened,
    emitActiveChanged
};
