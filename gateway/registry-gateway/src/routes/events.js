// =============================================================================
// Events Routes - Headset-accessible SSE stream and snapshot
// EP5: Read-only endpoints accessible to proposer role (not supervisor-only)
// =============================================================================

const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const sseEventBus = require('../utils/sseEventBus');
const fabric = require('../fabric/client');
const logger = require('../utils/logger');

// =============================================================================
// GET /events/stream - SSE event stream for headsets (non-admin)
// Accessible to proposer, endorser, or supervisor roles
// =============================================================================

router.get('/stream', requireRole('proposer', 'endorser', 'supervisor'), (req, res) => {
    const assetIdFilter = req.query.asset_id || null;
    const lastEventId = req.headers['last-event-id'] || req.query.last_event_id || null;
    
    logger.info('Headset SSE stream requested:', { 
        assetIdFilter, 
        lastEventId,
        apiKey: req.auth?.apiKey,
        role: req.auth?.role
    });
    
    // Add client to SSE event bus with Last-Event-ID support
    sseEventBus.addClient(res, assetIdFilter, lastEventId);
});

// =============================================================================
// GET /events/snapshot - Status snapshot for catch-up after reconnect
// Returns all known asset states for the headset to sync
// =============================================================================

router.get('/snapshot', requireRole('proposer', 'endorser', 'supervisor'), async (req, res, next) => {
    try {
        const assetIdFilter = req.query.asset_id || null;
        
        logger.info('Snapshot requested:', { assetIdFilter, apiKey: req.auth?.apiKey });
        
        // Get recent events to build asset state map
        const recentEvents = sseEventBus.getRecentEvents(200, assetIdFilter);
        
        // Build asset state from events (most recent wins)
        const assetStates = new Map();
        
        for (const event of recentEvents) {
            if (!event.assetId) continue;
            
            const current = assetStates.get(event.assetId) || {
                asset_id: event.assetId,
                claim_id: null,
                state: null,
                publisher_id: null,
                endorsement_count: 0,
                last_event_id: null,
                last_event_type: null
            };
            
            // Update from event
            if (event.claimId) current.claim_id = event.claimId;
            if (event.publisherId) current.publisher_id = event.publisherId;
            if (event.endorsementCount) current.endorsement_count = event.endorsementCount;
            current.last_event_id = event.eventId;
            current.last_event_type = event.type;
            
            // Determine state from event type
            switch (event.type) {
                case 'CLAIM_PROPOSED':
                    current.state = 'PROPOSED';
                    break;
                case 'CLAIM_ENDORSED':
                    if (event.state === 'ACTIVE') {
                        current.state = 'ACTIVE';
                    }
                    break;
                case 'CLAIM_ACTIVATED':
                case 'ACTIVE_CHANGED':
                    if (event.activeClaimId || event.state === 'ACTIVE') {
                        current.state = 'ACTIVE';
                    }
                    break;
                case 'CLAIM_REJECTED':
                    current.state = 'REJECTED';
                    break;
                case 'CLAIM_REVOKED':
                    current.state = 'REVOKED';
                    break;
                case 'CLAIM_REOPENED':
                    current.state = 'PROPOSED';
                    break;
            }
            
            assetStates.set(event.assetId, current);
        }
        
        // If a specific asset was requested and not in events, try to resolve from chain
        if (assetIdFilter && !assetStates.has(assetIdFilter)) {
            try {
                const claim = await fabric.resolveAnchor(assetIdFilter);
                if (claim) {
                    assetStates.set(assetIdFilter, {
                        asset_id: assetIdFilter,
                        claim_id: claim.claimId,
                        state: claim.state,
                        publisher_id: claim.publisherId,
                        endorsement_count: claim.endorsementCount || 0,
                        last_event_id: null,
                        last_event_type: null
                    });
                }
            } catch (err) {
                logger.warn(`Failed to resolve asset ${assetIdFilter}:`, err.message);
            }
        }
        
        const assets = Array.from(assetStates.values());
        const latestEventId = sseEventBus.getLatestEventId();
        
        res.json({
            success: true,
            assets,
            count: assets.length,
            last_event_id: latestEventId,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Snapshot error:', error);
        next(error);
    }
});

// =============================================================================
// GET /events - Get recent events (polling fallback)
// =============================================================================

router.get('/', requireRole('proposer', 'endorser', 'supervisor'), (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const assetId = req.query.asset_id || null;
    const events = sseEventBus.getRecentEvents(limit, assetId);
    
    res.json({
        success: true,
        count: events.length,
        events,
        last_event_id: sseEventBus.getLatestEventId()
    });
});

// =============================================================================
// GET /events/status - Connection and event bus status
// =============================================================================

router.get('/status', requireRole('proposer', 'endorser', 'supervisor'), (req, res) => {
    res.json({
        success: true,
        sse_clients: sseEventBus.getClientCount(),
        recent_events_count: sseEventBus.getRecentEvents(1000).length,
        last_event_id: sseEventBus.getLatestEventId(),
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
