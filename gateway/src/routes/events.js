/**
 * ==============================================================================
 * events.js - Server-Sent Events (SSE) driven by Fabric chaincode events
 *
 * SSE events are now sourced from committed ledger state, not from in-process
 * route handlers.  Each gateway subscribes to Fabric chaincode events via the
 * SDK.  Because both peers receive the same committed blocks, SSE clients
 * connected to EITHER gateway see the SAME global event stream.
 *
 * Experiment traceability: route handlers call registerCorrelation(assetId,
 * reqId) before submitting.  When the chaincode event arrives, the req_id is
 * attached to the SSE broadcast for commit-confirm latency measurement.
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

// ─── SSE Client Management ────────────────────────────────────────────────

const clients = new Map();
let eventCounter = 0;

function generateEventId() {
    eventCounter++;
    return `evt_${eventCounter}`;
}

function formatSseMessage(eventId, eventType, data) {
    let message = '';
    message += `id: ${eventId}\n`;
    message += `event: ${eventType}\n`;
    message += `data: ${JSON.stringify(data)}\n\n`;
    return message;
}

/**
 * Broadcast event to ALL connected SSE clients (internal only).
 */
function broadcastEvent(eventType, eventData, reqId) {
    const eventId = generateEventId();
    const timestamp = new Date().toISOString();
    const broadcastTimeMs = Date.now();

    const event = {
        event_id: eventId,
        type: eventType,
        timestamp,
        broadcast_time_ms: broadcastTimeMs,
        ...eventData
    };

    if (reqId) {
        event.req_id = reqId;
    }

    const sseData = formatSseMessage(eventId, eventType, event);

    logger.info(`Broadcasting SSE event: ${eventType} to ${clients.size} clients` +
                (reqId ? ` (req_id=${reqId})` : ''));

    clients.forEach((res, clientId) => {
        try {
            res.write(sseData);
        } catch (error) {
            logger.error(`  -> Failed to send to ${clientId}: ${error.message}`);
            clients.delete(clientId);
        }
    });

    return eventId;
}

// ─── Correlation Map (for experiment req_id enrichment) ────────────────────

const correlationMap = new Map();       // assetId → { reqId, ts }
const CORRELATION_TTL_MS = 120_000;     // 2 min TTL

/**
 * Register a correlation so that the chaincode event for this assetId
 * will carry the req_id when broadcast via SSE.
 *
 * Called by route handlers BEFORE submitting the Fabric transaction.
 */
function registerCorrelation(assetId, reqId) {
    if (!assetId || !reqId) return;
    correlationMap.set(assetId, { reqId, ts: Date.now() });
}

/**
 * Look up and consume a correlation entry.
 */
function consumeCorrelation(assetId) {
    if (!assetId) return null;
    const entry = correlationMap.get(assetId);
    if (!entry) return null;
    correlationMap.delete(assetId);
    return entry.reqId;
}

// Periodic cleanup of stale correlations
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of correlationMap) {
        if (now - val.ts > CORRELATION_TTL_MS) {
            correlationMap.delete(key);
        }
    }
}, 60_000);

// ─── Chaincode Event → SSE Translation ────────────────────────────────────

/**
 * Convert a chaincode event payload into a dual-case SSE payload
 * that is backward-compatible with Unity (camelCase) and admin panels
 * (snake_case).
 */
function chaincodeEventToSsePayload(eventName, payload) {
    // The chaincode _emitEvent already provides: eventId, type, timestamp, + data fields
    // We normalize to include both cases for downstream consumers.

    const base = {};

    // Common fields from chaincode payload
    if (payload.assetId)        { base.asset_id = payload.assetId;  base.assetId = payload.assetId; }
    if (payload.claimId)        { base.claim_id = payload.claimId;  base.claimId = payload.claimId; }

    switch (eventName) {
        case 'CLAIM_PROPOSED':
            base.proposed_via_org = payload.proposedViaOrg || '';
            base.proposedViaOrg = payload.proposedViaOrg || '';
            base.state = 'PROPOSED';
            base.requires_endorsement_from = payload.requiredEndorsements || ['Org1MSP', 'Org2MSP'];
            break;

        case 'CLAIM_ENDORSED_ORG1':
        case 'CLAIM_ENDORSED_ORG2':
            base.endorsed_by = payload.endorsedBy || '';
            base.endorsedBy = payload.endorsedBy || '';
            base.endorsements = payload.endorsements || {};
            base.state = payload.state || eventName.replace('CLAIM_', '');
            break;

        case 'CLAIM_ACTIVATED':
            base.final_endorser = payload.finalEndorser || '';
            base.finalEndorser = payload.finalEndorser || '';
            base.endorsed_by = payload.endorsedBy || ['Org1MSP', 'Org2MSP'];
            base.endorsedBy = payload.endorsedBy || ['Org1MSP', 'Org2MSP'];
            base.state = 'ACTIVE';
            break;

        case 'CLAIM_REJECTED':
            base.rejected_by = payload.rejectedBy || '';
            base.rejectedBy = payload.rejectedBy || '';
            base.reason = payload.reason || '';
            base.state = 'REJECTED';
            break;

        case 'REVOKE_INITIATED':
            base.initiated_by = payload.initiatedBy || '';
            base.initiatedBy = payload.initiatedBy || '';
            base.required_endorser = payload.requiredEndorser || '';
            base.requiredEndorser = payload.requiredEndorser || '';
            base.reason = payload.reason || '';
            base.state = 'REVOKE_PENDING';
            break;

        case 'CLAIM_REVOKED':
            base.initiated_by = payload.initiatedBy || '';
            base.initiatedBy = payload.initiatedBy || '';
            base.endorsed_by = payload.endorsedBy || '';
            base.endorsedBy = payload.endorsedBy || '';
            base.anchor_deleted = true;
            base.anchorDeleted = true;
            base.state = 'REVOKED';
            break;

        case 'REVOKE_REJECTED':
            base.initiated_by = payload.initiatedBy || '';
            base.initiatedBy = payload.initiatedBy || '';
            base.rejected_by = payload.rejectedBy || '';
            base.rejectedBy = payload.rejectedBy || '';
            base.anchor_preserved = true;
            base.anchorPreserved = true;
            base.reason = payload.reason || '';
            base.state = 'ACTIVE';
            break;

        default:
            // Pass through unknown events
            Object.assign(base, payload);
            break;
    }

    return base;
}

/**
 * Start the chaincode event listener.
 * Called once from server.js after the FabricClient is connected.
 */
function startChaincodeEventListener(fabricClient) {
    fabricClient.subscribeToEvents((eventName, payload, transactionId, blockNumber) => {
        const assetId = payload.assetId || payload.asset_id || null;
        const reqId = consumeCorrelation(assetId);

        const ssePayload = chaincodeEventToSsePayload(eventName, payload);
        ssePayload.tx_id = transactionId;
        ssePayload.block_number = blockNumber.toString();

        broadcastEvent(eventName, ssePayload, reqId);
    });
}

// ─── Express Routes ───────────────────────────────────────────────────────

/**
 * SSE Stream endpoint
 * GET /events/stream
 */
router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    clients.set(clientId, res);
    logger.info(`SSE connection opened: ${clientId} (total: ${clients.size})`);

    const connectEvent = formatSseMessage(
        generateEventId(),
        'CONNECTED',
        { client_id: clientId, connected_at: new Date().toISOString() }
    );
    res.write(connectEvent);

    const heartbeatInterval = setInterval(() => {
        try {
            const heartbeat = formatSseMessage(
                generateEventId(),
                'HEARTBEAT',
                { timestamp: new Date().toISOString() }
            );
            res.write(heartbeat);
        } catch (error) {
            clearInterval(heartbeatInterval);
            clients.delete(clientId);
        }
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        clients.delete(clientId);
        logger.info(`SSE connection closed: ${clientId} (remaining: ${clients.size})`);
    });

    req.on('error', (error) => {
        clearInterval(heartbeatInterval);
        clients.delete(clientId);
        logger.error(`SSE connection error: ${clientId} - ${error.message}`);
    });
});

/**
 * Get current snapshot
 * GET /events/snapshot
 */
router.get('/snapshot', async (req, res) => {
    try {
        const fabricClient = req.fabricClient;
        const snapshot = await fabricClient.getSnapshot();
        res.json(snapshot);
    } catch (error) {
        logger.error(`Get snapshot error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get connection count (for debugging)
 * GET /events/connections
 */
router.get('/connections', (req, res) => {
    const clientIds = Array.from(clients.keys());
    res.json({ count: clients.size, clients: clientIds });
});

/**
 * Manual event emission (for testing only — NOT the normal SSE path)
 * POST /events/emit
 */
router.post('/emit', (req, res) => {
    const { type, data } = req.body;
    if (!type) {
        return res.status(400).json({ success: false, error: 'Event type required' });
    }
    const eventId = broadcastEvent(type, data || {});
    res.json({ success: true, event_id: eventId, clients_notified: clients.size });
});

module.exports = router;
module.exports.startChaincodeEventListener = startChaincodeEventListener;
module.exports.registerCorrelation = registerCorrelation;
module.exports.getClientCount = () => clients.size;
