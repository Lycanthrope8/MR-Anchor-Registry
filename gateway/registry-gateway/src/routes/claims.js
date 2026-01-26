const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { hashPayload } = require('../utils/hash');
const { requireRole } = require('../middleware/auth');
const { storePayload } = require('../db/postgres');
const fabric = require('../fabric/client');
const logger = require('../utils/logger');

router.post('/propose', requireRole('proposer', 'supervisor'), async (req, res, next) => {
    try {
        const { asset_id, pose_site, quality_metrics } = req.body;
        
        logger.info('Propose request received:', { asset_id, pose_site, quality_metrics });
        
        if (!asset_id || !pose_site || !quality_metrics) {
            return res.status(400).json({ success: false, error: 'Required: asset_id, pose_site, quality_metrics' });
        }
        if (!pose_site.position) {
            return res.status(400).json({ success: false, error: 'pose_site.position required' });
        }
        
        const publisherId = req.auth.apiKey;
        const payload = { asset_id, pose_site, quality_metrics, publisher_id: publisherId };
        const payloadHash = hashPayload(payload);
        const payloadPtr = uuidv4();
        
        // Store in PostgreSQL
        await storePayload(payloadHash, payloadPtr, asset_id, pose_site, quality_metrics, publisherId, payload);
        
        // Prepare data for chaincode
        // IMPORTANT: poseSummary and qualitySummary must be objects (will be stringified by fabric client)
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
        
        logger.info('Calling chaincode ProposeAnchor:', { asset_id, payloadHash, payloadPtr, poseSummary, qualitySummary, publisherId });
        
        const claim = await fabric.proposeAnchor(asset_id, payloadHash, payloadPtr, poseSummary, qualitySummary, publisherId);
        
        logger.info('ProposeAnchor result:', claim);
        
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

router.post('/:claim_id/endorse', requireRole('endorser', 'supervisor'), async (req, res, next) => {
    try {
        logger.info('Endorse request:', { claim_id: req.params.claim_id, endorser: req.auth.apiKey });
        
        const claim = await fabric.endorseAnchor(req.params.claim_id, req.auth.apiKey);
        
        logger.info('Endorse result:', claim);
        
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

router.get('/:claim_id', async (req, res, next) => {
    try {
        const claim = await fabric.getClaim(req.params.claim_id);
        if (!claim) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, claim });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
