const express = require('express');
const router = express.Router();
const { verifyPayloadHash } = require('../utils/hash');
const { requireSupervisor } = require('../middleware/auth');
const { getPayloadByHash } = require('../db/postgres');
const fabric = require('../fabric/client');

router.get('/:asset_id/resolve', async (req, res, next) => {
    try {
        const claim = await fabric.resolveAnchor(req.params.asset_id);
        if (!claim) return res.json({ success: true, asset_id: req.params.asset_id, claim_id: null, message: 'No active anchor' });
        
        let payload = null, payloadVerified = false;
        if (claim.payloadHash) {
            const stored = await getPayloadByHash(claim.payloadHash);
            if (stored) {
                payloadVerified = verifyPayloadHash(stored.raw_payload, claim.payloadHash);
                if (payloadVerified) payload = { pose_site: stored.pose_site, quality_metrics: stored.quality_metrics };
            }
        }
        
        res.json({ success: true, asset_id: req.params.asset_id, claim_id: claim.claimId, state: claim.state, payload, payload_verified: payloadVerified, activated_at: claim.activatedAt });
    } catch (error) { next(error); }
});

router.get('/:asset_id/claims', async (req, res, next) => {
    try {
        const claims = await fabric.listClaims(req.params.asset_id);
        res.json({ success: true, asset_id: req.params.asset_id, count: claims.length, claims });
    } catch (error) { next(error); }
});

router.post('/:asset_id/revoke', requireSupervisor, async (req, res, next) => {
    try {
        const { reason, claim_id } = req.body;
        if (!reason) return res.status(400).json({ success: false, error: 'Reason required' });
        const claim = await fabric.revokeAnchor(req.params.asset_id, claim_id || '', reason, req.auth.apiKey);
        res.json({ success: true, claim_id: claim.claimId, new_state: claim.state, revoked_by: req.auth.apiKey });
    } catch (error) { next(error); }
});

module.exports = router;
