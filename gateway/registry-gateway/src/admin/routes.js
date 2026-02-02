// =============================================================================
// Admin Routes - Supervisor API with SSE Support
// =============================================================================

'use strict';

const express = require('express');
const router = express.Router();
const { requireSupervisor } = require('../middleware/auth');
const fabric = require('../fabric/client');
const sseEventBus = require('../utils/sseEventBus');
const logger = require('../utils/logger');

// In-memory decision store (for quick reference - authoritative state is on-chain)
const decisions = new Map();

function nowIso() {
    return new Date().toISOString();
}

// =============================================================================
// SSE ENDPOINT - Real-time event stream
// =============================================================================

/**
 * GET /admin/api/events/stream
 * Server-Sent Events endpoint for real-time updates.
 * Query params:
 *   - asset_id: (optional) Filter events by asset_id
 */
router.get('/events/stream', (req, res) => {
    const assetIdFilter = req.query.asset_id || null;
    
    logger.info('SSE stream requested:', { assetIdFilter, apiKey: req.auth?.apiKey });
    
    // Add client to SSE event bus
    sseEventBus.addClient(res, assetIdFilter);
});

/**
 * GET /admin/api/events
 * Get recent events (polling fallback)
 */
router.get('/events', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const assetId = req.query.asset_id || null;
    const events = sseEventBus.getRecentEvents(limit, assetId);
    
    res.json({
        success: true,
        count: events.length,
        events
    });
});

// =============================================================================
// DECISION MANAGEMENT (in-memory reference)
// =============================================================================

/**
 * GET /admin/api/decision/:asset_id
 * Get the current decision for an asset (from in-memory cache)
 */
router.get('/decision/:asset_id', (req, res) => {
    const assetId = req.params.asset_id;
    const decision = decisions.get(assetId) || null;
    
    res.json({
        success: true,
        asset_id: assetId,
        decision
    });
});

/**
 * POST /admin/api/decision/:asset_id/approve
 * Approve a claim by endorsing it (calls chaincode)
 */
router.post('/decision/:asset_id/approve', requireSupervisor, async (req, res) => {
    const assetId = req.params.asset_id;
    const { claim_id, reason } = req.body || {};

    if (!claim_id) {
        return res.status(400).json({
            success: false,
            error: 'claim_id is required'
        });
    }

    try {
        // Endorse on-chain (this may activate the claim)
        const claim = await fabric.endorseAnchor(claim_id, req.auth.apiKey);

        // Store decision in memory for quick reference
        const decision = {
            asset_id: assetId,
            claim_id,
            decision: 'APPROVED',
            reason: reason || 'Approved by supervisor',
            decided_by: req.auth.apiKey,
            decided_at: nowIso(),
            on_chain_state: claim.state
        };
        decisions.set(assetId, decision);

        // Emit SSE event
        sseEventBus.emitClaimEndorsed(claim, req.auth.apiKey);

        res.json({
            success: true,
            decision,
            claim
        });
    } catch (error) {
        logger.error('Approve error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /admin/api/decision/:asset_id/reject
 * Reject a claim (calls chaincode - ON-CHAIN)
 */
router.post('/decision/:asset_id/reject', requireSupervisor, async (req, res) => {
    const assetId = req.params.asset_id;
    const { claim_id, reason } = req.body || {};

    if (!claim_id) {
        return res.status(400).json({
            success: false,
            error: 'claim_id is required'
        });
    }
    if (!reason || reason.trim() === '') {
        return res.status(400).json({
            success: false,
            error: 'Rejection reason is required'
        });
    }

    try {
        // Reject on-chain (this is auditable and permanent)
        const claim = await fabric.rejectClaim(claim_id, reason.trim(), req.auth.apiKey);

        // Store decision in memory for quick reference
        const decision = {
            asset_id: assetId,
            claim_id,
            decision: 'REJECTED',
            reason: reason.trim(),
            decided_by: req.auth.apiKey,
            decided_at: nowIso(),
            on_chain_state: claim.state,
            rejection_tx: claim.rejectionTxId
        };
        decisions.set(assetId, decision);

        // Emit SSE event
        sseEventBus.emitClaimRejected(claim, req.auth.apiKey, reason.trim());

        res.json({
            success: true,
            decision,
            claim
        });
    } catch (error) {
        logger.error('Reject error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /admin/api/decision/:asset_id/revoke
 * Revoke the active anchor for an asset
 */
router.post('/decision/:asset_id/revoke', requireSupervisor, async (req, res) => {
    const assetId = req.params.asset_id;
    const { reason, claim_id } = req.body || {};

    if (!reason || reason.trim() === '') {
        return res.status(400).json({
            success: false,
            error: 'Revocation reason is required'
        });
    }

    try {
        const claim = await fabric.revokeAnchor(assetId, claim_id || '', reason.trim(), req.auth.apiKey);

        // Update decision
        const decision = {
            asset_id: assetId,
            claim_id: claim.claimId,
            decision: 'REVOKED',
            reason: reason.trim(),
            decided_by: req.auth.apiKey,
            decided_at: nowIso(),
            on_chain_state: claim.state
        };
        decisions.set(assetId, decision);

        // Emit SSE event
        sseEventBus.emitClaimRevoked(claim, req.auth.apiKey, reason.trim());

        res.json({
            success: true,
            decision,
            claim
        });
    } catch (error) {
        logger.error('Revoke error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /admin/api/decision/:asset_id/reopen
 * Reopen a rejected claim
 */
router.post('/decision/:asset_id/reopen', requireSupervisor, async (req, res) => {
    const assetId = req.params.asset_id;
    const { claim_id, reason } = req.body || {};

    if (!claim_id) {
        return res.status(400).json({
            success: false,
            error: 'claim_id is required'
        });
    }

    try {
        const claim = await fabric.reopenClaim(claim_id, reason || '', req.auth.apiKey);

        // Clear decision (claim is back to proposed)
        decisions.delete(assetId);

        // Emit SSE event
        sseEventBus.emitClaimReopened(claim, req.auth.apiKey);

        res.json({
            success: true,
            claim
        });
    } catch (error) {
        logger.error('Reopen error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /admin/api/decision/:asset_id/reset
 * Reset in-memory decision (does NOT affect on-chain state)
 */
router.post('/decision/:asset_id/reset', requireSupervisor, (req, res) => {
    const assetId = req.params.asset_id;
    const existed = decisions.has(assetId);
    decisions.delete(assetId);

    res.json({
        success: true,
        asset_id: assetId,
        reset: existed
    });
});

// =============================================================================
// ASSET DATA ENDPOINTS (for supervisor UI)
// =============================================================================

/**
 * GET /admin/api/asset/:asset_id
 * Get complete asset data for supervisor UI
 */
router.get('/asset/:asset_id', async (req, res) => {
    const assetId = req.params.asset_id;

    try {
        const [active, claims] = await Promise.all([
            fabric.resolveAnchor(assetId),
            fabric.listClaims(assetId)
        ]);

        const decision = decisions.get(assetId) || null;

        res.json({
            success: true,
            asset_id: assetId,
            active,
            claims,
            decision,
            timestamp: nowIso()
        });
    } catch (error) {
        logger.error('Asset data error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /admin/api/claim/:claim_id
 * Get detailed claim data including history
 */
router.get('/claim/:claim_id', async (req, res) => {
    const claimId = req.params.claim_id;

    try {
        const [claim, history] = await Promise.all([
            fabric.getClaim(claimId),
            fabric.getClaimHistory(claimId)
        ]);

        if (!claim) {
            return res.status(404).json({
                success: false,
                error: 'Claim not found'
            });
        }

        res.json({
            success: true,
            claim,
            history,
            timestamp: nowIso()
        });
    } catch (error) {
        logger.error('Claim data error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /admin/api/stats
 * Get SSE connection stats
 */
router.get('/stats', (req, res) => {
    res.json({
        success: true,
        sse_clients: sseEventBus.getClientCount(),
        recent_events: sseEventBus.getRecentEvents(10).length,
        timestamp: nowIso()
    });
});

module.exports = router;
