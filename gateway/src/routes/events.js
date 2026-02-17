/**
 * ==============================================================================
 * events.js - Server-Sent Events (SSE) for real-time updates
 * PHASE 1: Added req_id propagation into SSE events for time-to-consistency
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

// Store connected SSE clients
const clients = new Map();

// Event counter for unique IDs
let eventCounter = 0;

/**
 * Generate unique event ID
 */
function generateEventId() {
    eventCounter++;
    return `evt_${eventCounter}`;
}

/**
 * Broadcast event to ALL connected SSE clients
 * PHASE 1: Now accepts optional reqId for experiment traceability
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
    
    // PHASE 1: Propagate req_id if provided
    if (reqId) {
        event.req_id = reqId;
    }
    
    const sseData = formatSseMessage(eventId, eventType, event);
    
    logger.info(`Broadcasting SSE event: ${eventType} to ${clients.size} clients` +
                (reqId ? ` (req_id=${reqId})` : ''));
    
    // Send to all connected clients
    clients.forEach((res, clientId) => {
        try {
            res.write(sseData);
            logger.info(`  -> Sent to ${clientId}`);
        } catch (error) {
            logger.error(`  -> Failed to send to ${clientId}: ${error.message}`);
            clients.delete(clientId);
        }
    });
    
    return eventId;
}

/**
 * Format SSE message
 */
function formatSseMessage(eventId, eventType, data) {
    let message = '';
    message += `id: ${eventId}\n`;
    message += `event: ${eventType}\n`;
    message += `data: ${JSON.stringify(data)}\n\n`;
    return message;
}

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
    res.json({
        count: clients.size,
        clients: clientIds
    });
});

/**
 * Manual event emission (for testing)
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
module.exports.broadcastEvent = broadcastEvent;
module.exports.getClientCount = () => clients.size;