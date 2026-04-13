/**
 * ==============================================================================
 * events.js - Server-Sent Events (SSE) driven by Fabric chaincode events
 *
 * v2.1: Annotation events now include intentType / intent_type field.
 *       Correlation key may be composite (assetId:intentType) for annotations.
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

// ─── Correlation Map ───────────────────────────────────────────────────────

const correlationMap = new Map();
const CORRELATION_TTL_MS = 120_000;

/**
 * Register a correlation so that the chaincode event for this key
 * will carry the req_id when broadcast via SSE.
 * 
 * v2.1: For annotations, the key may be "assetId:intentType".
 */
function registerCorrelation(key, reqId) {
    if (!key || !reqId) return;
    correlationMap.set(key, { reqId, ts: Date.now() });
}

function consumeCorrelation(key) {
    if (!key) return null;
    const entry = correlationMap.get(key);
    if (!entry) return null;
    correlationMap.delete(key);
    return entry.reqId;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of correlationMap) {
        if (now - val.ts > CORRELATION_TTL_MS) {
            correlationMap.delete(key);
        }
    }
}, 60_000);

// ─── Chaincode Event → SSE Translation ────────────────────────────────────

function chaincodeEventToSsePayload(eventName, payload) {
    const base = {};

    // Common fields
    if (payload.assetId)        { base.asset_id = payload.assetId;  base.assetId = payload.assetId; }
    if (payload.claimId)        { base.claim_id = payload.claimId;  base.claimId = payload.claimId; }
    if (payload.annotationId)   { base.annotation_id = payload.annotationId;  base.annotationId = payload.annotationId; }
    // v2.1: intentType on all annotation events
    if (payload.intentType)     { base.intent_type = payload.intentType;  base.intentType = payload.intentType; }

    switch (eventName) {

        // ANCHOR CLAIM EVENTS

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

        // ANNOTATION EVENTS (v2.1: all include intentType)

        case 'ANNOTATION_PROPOSED':
            base.tier = payload.tier || '';
            base.content_text = payload.contentText || '';
            base.contentText = payload.contentText || '';
            base.proposed_via_org = payload.proposedViaOrg || '';
            base.proposedViaOrg = payload.proposedViaOrg || '';
            base.state = 'ANN_PROPOSED';
            base.requires_endorsement_from = payload.requiredEndorsements || ['Org1MSP', 'Org2MSP'];
            break;

        case 'ANNOTATION_ENDORSED_ORG1':
        case 'ANNOTATION_ENDORSED_ORG2':
            base.endorsed_by = payload.endorsedBy || '';
            base.endorsedBy = payload.endorsedBy || '';
            base.endorsements = payload.endorsements || {};
            base.state = payload.state || eventName.replace('ANNOTATION_', 'ANN_');
            break;

        case 'ANNOTATION_ACTIVE':
            base.tier = payload.tier || '';
            base.content_text = payload.contentText || '';
            base.contentText = payload.contentText || '';
            base.activation_method = payload.activationMethod || 'DUAL_ENDORSEMENT';
            base.activationMethod = payload.activationMethod || 'DUAL_ENDORSEMENT';
            base.anchor_claim_id = payload.anchorClaimId || '';
            base.anchorClaimId = payload.anchorClaimId || '';
            base.state = 'ANN_ACTIVE';
            if (payload.finalEndorser) {
                base.final_endorser = payload.finalEndorser;
                base.finalEndorser = payload.finalEndorser;
            }
            if (payload.endorsedBy) {
                base.endorsed_by = payload.endorsedBy;
                base.endorsedBy = payload.endorsedBy;
            }
            break;

        case 'ANNOTATION_REJECTED':
            base.rejected_by = payload.rejectedBy || '';
            base.rejectedBy = payload.rejectedBy || '';
            base.reason = payload.reason || '';
            base.state = 'ANN_REJECTED';
            break;

        case 'ANNOTATION_REVOKED':
            base.revoked_by = payload.revokedBy || '';
            base.revokedBy = payload.revokedBy || '';
            base.reason = payload.reason || '';
            base.state = 'ANN_REVOKED';
            break;

        default:
            Object.assign(base, payload);
            break;
    }

    return base;
}

/**
 * Start the chaincode event listener.
 * v2.1: Annotation correlations use composite key assetId:intentType
 */
function startChaincodeEventListener(fabricClient) {
    fabricClient.subscribeToEvents((eventName, payload, transactionId, blockNumber) => {
        const assetId = payload.assetId || payload.asset_id || null;
        const intentType = payload.intentType || payload.intent_type || null;

        // Try composite key first (for annotations), then plain assetId (for anchors)
        let reqId = null;
        if (assetId && intentType) {
            reqId = consumeCorrelation(`${assetId}:${intentType}`);
        }
        if (!reqId && assetId) {
            reqId = consumeCorrelation(assetId);
        }

        const ssePayload = chaincodeEventToSsePayload(eventName, payload);
        ssePayload.tx_id = transactionId;
        ssePayload.block_number = blockNumber.toString();

        broadcastEvent(eventName, ssePayload, reqId);
    });
}

// ─── Express Routes ───────────────────────────────────────────────────────

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

router.get('/connections', (req, res) => {
    const clientIds = Array.from(clients.keys());
    res.json({ count: clients.size, clients: clientIds });
});

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
