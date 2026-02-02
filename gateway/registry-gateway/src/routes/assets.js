// =============================================================================
// Assets Routes - Resolve, List Claims, Revoke
// =============================================================================

const express = require('express');
const router = express.Router();
const { verifyPayloadHash } = require('../utils/hash');
const { requireSupervisor } = require('../middleware/auth');
const { getPayloadByHash, clearAssetActive, updateAssetIndex } = require('../db/postgres');
const fabric = require('../fabric/client');
const logger = require('../utils/logger');
const sseEventBus = require('../utils/sseEventBus');

// =============================================================================
// GET /assets/:asset_id/resolve - Get active anchor for asset
// =============================================================================

router.get('/:asset_id/resolve', async (req, res, next) => {
    try {
        const claim = await fabric.resolveAnchor(req.params.asset_id);

        if (!claim) {
            return res.json({
                success: true,
                asset_id: req.params.asset_id,
                claim_id: null,
                message: 'No active anchor for this asset'
            });
        }

        // Fetch and verify payload from PostgreSQL
        let payload = null;
        let payloadVerified = false;

        if (claim.payloadHash) {
            const stored = await getPayloadByHash(claim.payloadHash);
            if (stored) {
                payloadVerified = verifyPayloadHash(stored.raw_payload, claim.payloadHash);
                if (payloadVerified) {
                    payload = {
                        pose_site: stored.pose_site,
                        quality_metrics: stored.quality_metrics
                    };
                }
            }
        }

        res.json({
            success: true,
            asset_id: req.params.asset_id,
            claim_id: claim.claimId,
            state: claim.state,
            payload,
            payload_verified: payloadVerified,
            activated_at: claim.activatedAt,
            publisher_id: claim.publisherId,
            endorsement_count: claim.endorsementCount
        });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// GET /assets/:asset_id/claims - List all claims for asset
// =============================================================================

router.get('/:asset_id/claims', async (req, res, next) => {
    try {
        const claims = await fabric.listClaims(req.params.asset_id);

        res.json({
            success: true,
            asset_id: req.params.asset_id,
            count: claims.length,
            claims
        });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// POST /assets/:asset_id/revoke - Revoke active anchor (supervisor only)
// =============================================================================

router.post('/:asset_id/revoke', requireSupervisor, async (req, res, next) => {
    try {
        const { reason, claim_id } = req.body || {};
        const supervisorId = req.auth.apiKey;

        if (!reason || reason.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Revocation reason is required'
            });
        }

        logger.info('Revoke request:', {
            asset_id: req.params.asset_id,
            claim_id,
            reason,
            supervisor: supervisorId
        });

        const claim = await fabric.revokeAnchor(
            req.params.asset_id,
            claim_id || '',
            reason.trim(),
            supervisorId
        );

        logger.info('Revoke result:', claim);

        // Update asset index - clear active, set state to REVOKED
        await clearAssetActive(req.params.asset_id, claim.claimId);

        // Emit SSE event
        sseEventBus.emitClaimRevoked(claim, supervisorId, reason.trim());

        res.json({
            success: true,
            claim_id: claim.claimId,
            new_state: claim.state,
            revoked_by: supervisorId,
            revoked_at: claim.revokedAt
        });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// GET /assets/:asset_id/audit - Get audit log for asset
// =============================================================================

router.get('/:asset_id/audit', async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const auditLog = await fabric.getAuditLog(req.params.asset_id, limit);

        res.json({
            success: true,
            asset_id: req.params.asset_id,
            count: auditLog.length,
            audit_log: auditLog
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;