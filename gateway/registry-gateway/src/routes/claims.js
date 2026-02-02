// =============================================================================
// Claims Routes - Propose, Endorse, Reject, Get
// =============================================================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { hashPayload } = require('../utils/hash');
const { requireRole, requireSupervisor } = require('../middleware/auth');
const { storePayload, updateAssetIndex } = require('../db/postgres');
const fabric = require('../fabric/client');
const logger = require('../utils/logger');
const sseEventBus = require('../utils/sseEventBus');

// =============================================================================
// POST /claims/propose - Create a new anchor claim
// =============================================================================

router.post('/propose', requireRole('proposer', 'supervisor'), async (req, res, next) => {
    try {
        const { asset_id, pose_site, quality_metrics } = req.body;

        logger.info('Propose request received:', { asset_id, pose_site, quality_metrics });

        if (!asset_id || !pose_site || !quality_metrics) {
            return res.status(400).json({
                success: false,
                error: 'Required: asset_id, pose_site, quality_metrics'
            });
        }
        if (!pose_site.position) {
            return res.status(400).json({
                success: false,
                error: 'pose_site.position required'
            });
        }

        const publisherId = req.auth.apiKey;
        const payload = { asset_id, pose_site, quality_metrics, publisher_id: publisherId };
        const payloadHash = hashPayload(payload);
        const payloadPtr = uuidv4();

        // Store full payload in PostgreSQL
        await storePayload(payloadHash, payloadPtr, asset_id, pose_site, quality_metrics, publisherId, payload);

        // Prepare summary data for chaincode
        const poseSummary = {
            x: pose_site.position.x || 0,
            y: pose_site.position.y || 0,
            z: pose_site.position.z || 0,
            qw: (pose_site.rotation && pose_site.rotation.qw) || 1
        };
        const qualitySummary = {
            confidence_mean: quality_metrics.confidence_mean || 0,
            stability_rms: quality_metrics.stability_rms || 0
        };

        logger.info('Calling chaincode ProposeAnchor:', {
            asset_id,
            payloadHash,
            payloadPtr,
            poseSummary,
            qualitySummary,
            publisherId
        });

        const claim = await fabric.proposeAnchor(
            asset_id,
            payloadHash,
            payloadPtr,
            poseSummary,
            qualitySummary,
            publisherId
        );

        logger.info('ProposeAnchor result:', claim);

        // Update asset index for dashboard
        await updateAssetIndex(asset_id, claim.claimId, 'PROPOSED', null, publisherId);

        // Emit SSE event
        sseEventBus.emitClaimProposed(claim);

        res.status(201).json({
            success: true,
            claim_id: claim.claimId,
            state: claim.state,
            conflict_classification: claim.conflictClassification,
            payload_hash: payloadHash
        });
    } catch (error) {
        logger.error('Propose error:', error);
        next(error);
    }
});

// =============================================================================
// POST /claims/:claim_id/endorse - Endorse a claim (may activate it)
// =============================================================================

router.post('/:claim_id/endorse', requireRole('endorser', 'supervisor'), async (req, res, next) => {
    try {
        const { claim_id } = req.params;
        const endorserId = req.auth.apiKey;

        logger.info('Endorse request:', { claim_id, endorser: endorserId });

        const claim = await fabric.endorseAnchor(claim_id, endorserId);

        logger.info('Endorse result:', claim);

        // Update asset index if claim became ACTIVE
        if (claim.state === 'ACTIVE') {
            const { setAssetActive } = require('../db/postgres');
            await setAssetActive(claim.assetId, claim.claimId);
        }

        // Emit SSE event
        sseEventBus.emitClaimEndorsed(claim, endorserId);

        res.json({
            success: true,
            claim_id: claim.claimId,
            endorsement_count: claim.endorsementCount,
            new_state: claim.state
        });
    } catch (error) {
        logger.error('Endorse error:', error);
        next(error);
    }
});

// =============================================================================
// POST /claims/:claim_id/reject - Reject a claim (ON-CHAIN, supervisor only)
// =============================================================================

router.post('/:claim_id/reject', requireSupervisor, async (req, res, next) => {
    try {
        const { claim_id } = req.params;
        const { reason } = req.body || {};
        const supervisorId = req.auth.apiKey;

        if (!reason || reason.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Rejection reason is required'
            });
        }

        logger.info('Reject request:', { claim_id, reason, supervisor: supervisorId });

        const claim = await fabric.rejectClaim(claim_id, reason.trim(), supervisorId);

        logger.info('Reject result:', claim);

        // Update asset index
        await updateAssetIndex(claim.assetId, claim.claimId, 'REJECTED', null, null);

        // Emit SSE event
        sseEventBus.emitClaimRejected(claim, supervisorId, reason.trim());

        res.json({
            success: true,
            claim_id: claim.claimId,
            new_state: claim.state,
            rejected_by: supervisorId,
            rejected_at: claim.rejectedAt,
            rejection_reason: claim.rejectionReason
        });
    } catch (error) {
        logger.error('Reject error:', error);
        next(error);
    }
});

// =============================================================================
// POST /claims/:claim_id/reopen - Reopen a rejected claim (supervisor only)
// =============================================================================

router.post('/:claim_id/reopen', requireSupervisor, async (req, res, next) => {
    try {
        const { claim_id } = req.params;
        const { reason } = req.body || {};
        const supervisorId = req.auth.apiKey;

        logger.info('Reopen request:', { claim_id, reason, supervisor: supervisorId });

        const claim = await fabric.reopenClaim(claim_id, reason || '', supervisorId);

        logger.info('Reopen result:', claim);

        // Update asset index - back to PROPOSED
        await updateAssetIndex(claim.assetId, claim.claimId, 'PROPOSED', null, null);

        // Emit SSE event
        sseEventBus.emitClaimReopened(claim, supervisorId);

        res.json({
            success: true,
            claim_id: claim.claimId,
            new_state: claim.state,
            reopened_by: supervisorId,
            reopened_at: claim.reopenedAt
        });
    } catch (error) {
        logger.error('Reopen error:', error);
        next(error);
    }
});

// =============================================================================
// GET /claims/:claim_id - Get claim details
// =============================================================================

router.get('/:claim_id', async (req, res, next) => {
    try {
        const claim = await fabric.getClaim(req.params.claim_id);
        if (!claim) {
            return res.status(404).json({ success: false, error: 'Claim not found' });
        }
        res.json({ success: true, claim });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// GET /claims/:claim_id/history - Get claim history (audit trail)
// =============================================================================

router.get('/:claim_id/history', async (req, res, next) => {
    try {
        const history = await fabric.getClaimHistory(req.params.claim_id);
        res.json({
            success: true,
            claim_id: req.params.claim_id,
            history
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;