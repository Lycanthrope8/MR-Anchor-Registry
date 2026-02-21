/**
 * ==============================================================================
 * claims.js - Claim routes for Unity clients
 *
 * SSE broadcasts are no longer emitted here.  They are driven by Fabric
 * chaincode events (see events.js).  The registerCorrelation() call
 * ensures that experiment req_id values are carried through to SSE.
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { registerCorrelation } = require('./events');

/**
 * Propose a new anchor
 * POST /claims/propose
 */
router.post('/propose', async (req, res) => {
    try {
        const { asset_id, pose_site, quality_metrics, req_id, run_id } = req.body;

        if (!asset_id || !pose_site || !quality_metrics) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: asset_id, pose_site, quality_metrics'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] ProposeAnchor: ${asset_id}` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        // Register correlation BEFORE submitting so the chaincode event
        // listener can attach req_id to the SSE broadcast.
        registerCorrelation(asset_id, req_id);

        const result = await fabricClient.proposeAnchor(
            asset_id, pose_site, quality_metrics
        );

        logger.info(`Anchor proposed: ${asset_id}`);

        // NOTE: SSE CLAIM_PROPOSED event is emitted by the chaincode event
        //       listener in events.js, NOT here.

        res.json(result);

    } catch (error) {
        logger.error(`Propose anchor error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endorse a pending claim
 * POST /claims/endorse
 */
router.post('/endorse', async (req, res) => {
    try {
        const { asset_id, req_id, run_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] EndorseClaim: ${asset_id}` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        // Register correlation for experiment traceability
        registerCorrelation(asset_id, req_id);

        const result = await fabricClient.endorseClaim(asset_id);

        logger.info(`Claim endorsed: ${asset_id} by ${fabricClient.getMspId()}`);

        // NOTE: SSE CLAIM_ENDORSED/CLAIM_ACTIVATED events are emitted by the
        //       chaincode event listener, NOT here.

        res.json(result);

    } catch (error) {
        logger.error(`Endorse claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Reject a pending claim
 * POST /claims/reject
 */
router.post('/reject', async (req, res) => {
    try {
        const { asset_id, reason } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] RejectClaim: ${asset_id}`);

        const result = await fabricClient.rejectClaim(asset_id, reason || '');

        logger.info(`Claim rejected: ${asset_id} by ${fabricClient.getMspId()}`);

        res.json(result);

    } catch (error) {
        logger.error(`Reject claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get claim details
 * GET /claims/:assetId
 */
router.get('/:assetId', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getClaim(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get claim history
 * GET /claims/:assetId/history
 */
router.get('/:assetId/history', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getClaimHistory(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get claim history error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get active anchor
 * GET /claims/:assetId/anchor
 */
router.get('/:assetId/anchor', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getActiveAnchor(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get active anchor error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
