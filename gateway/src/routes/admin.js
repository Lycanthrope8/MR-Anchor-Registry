/**
 * ==============================================================================
 * admin.js - Admin routes for web admin panels
 *
 * SSE broadcasts are no longer emitted here.  They are driven by Fabric
 * chaincode events (see events.js).
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

/**
 * Endorse a claim (admin version)
 * POST /admin/endorse-claim
 */
router.post('/endorse-claim', async (req, res) => {
    try {
        const { asset_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;
        const mspId = fabricClient.getMspId();

        logger.info(`[${orgId}] EndorseClaim: ${asset_id}`);

        const result = await fabricClient.endorseClaim(asset_id);

        logger.info(`Claim endorsed via admin: ${asset_id} by ${mspId}`);

        // SSE events emitted by chaincode event listener, not here.
        res.json(result);

    } catch (error) {
        logger.error(`Admin endorse claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Reject a claim (admin version)
 * POST /admin/reject-claim
 */
router.post('/reject-claim', async (req, res) => {
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
        const mspId = fabricClient.getMspId();

        logger.info(`[${orgId}] RejectClaim: ${asset_id}`);

        const result = await fabricClient.rejectClaim(asset_id, reason || '');

        logger.info(`Claim rejected via admin: ${asset_id} by ${mspId}`);

        res.json(result);

    } catch (error) {
        logger.error(`Admin reject claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Initiate anchor revocation
 * POST /admin/revoke
 */
router.post('/revoke', async (req, res) => {
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
        const mspId = fabricClient.getMspId();

        logger.info(`[${orgId}] RevokeAnchor: ${asset_id}`);

        const result = await fabricClient.revokeAnchor(asset_id, reason || '');

        logger.info(`Revocation initiated: ${asset_id} by ${mspId}`);

        res.json(result);

    } catch (error) {
        logger.error(`Revoke anchor error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endorse a pending revocation
 * POST /admin/endorse-revoke
 */
router.post('/endorse-revoke', async (req, res) => {
    try {
        const { asset_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;
        const mspId = fabricClient.getMspId();

        logger.info(`[${orgId}] EndorseRevoke: ${asset_id}`);

        const result = await fabricClient.endorseRevoke(asset_id);

        logger.info(`Revocation endorsed: ${asset_id} by ${mspId}`);

        res.json(result);

    } catch (error) {
        logger.error(`Endorse revoke error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Reject a pending revocation
 * POST /admin/reject-revoke
 */
router.post('/reject-revoke', async (req, res) => {
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
        const mspId = fabricClient.getMspId();

        logger.info(`[${orgId}] RejectRevoke: ${asset_id}`);

        const result = await fabricClient.rejectRevoke(asset_id, reason || '');

        logger.info(`Revocation rejected: ${asset_id} by ${mspId}`);

        res.json(result);

    } catch (error) {
        logger.error(`Reject revoke error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get all active anchors
 * GET /admin/anchors
 */
router.get('/anchors', async (req, res) => {
    try {
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getAllActiveAnchors();
        res.json(result);
    } catch (error) {
        logger.error(`Get all anchors error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get all pending revocations
 * GET /admin/pending-revocations
 */
router.get('/pending-revocations', async (req, res) => {
    try {
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getPendingRevocations();
        res.json(result);
    } catch (error) {
        logger.error(`Get pending revocations error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get pending revocations for my org
 * GET /admin/pending-revocations/for-me
 */
router.get('/pending-revocations/for-me', async (req, res) => {
    try {
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getPendingRevocationsForOrg();
        res.json(result);
    } catch (error) {
        logger.error(`Get pending revocations for org error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get gateway status
 * GET /admin/status
 */
router.get('/status', (req, res) => {
    const { getClientCount } = require('./events');

    res.json({
        success: true,
        status: 'running',
        org: req.orgId,
        mspId: req.fabricClient?.getMspId() || 'unknown',
        connected: req.fabricClient?.isConnected() || false,
        sse_clients: getClientCount()
    });
});

module.exports = router;
