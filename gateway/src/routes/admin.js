/**
 * ==============================================================================
 * admin.js - Admin routes for web admin panels
 *
 * v2.1: Annotation admin routes now require intent_type parameter.
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

// ─── Anchor Admin Routes (unchanged) ──────────────────────────────────────

router.post('/endorse-claim', async (req, res) => {
    try {
        const { asset_id } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] EndorseClaim: ${asset_id}`);
        const result = await fabricClient.endorseClaim(asset_id);
        logger.info(`Claim endorsed via admin: ${asset_id} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Admin endorse claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/reject-claim', async (req, res) => {
    try {
        const { asset_id, reason } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] RejectClaim: ${asset_id}`);
        const result = await fabricClient.rejectClaim(asset_id, reason || '');
        logger.info(`Claim rejected via admin: ${asset_id} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Admin reject claim error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/revoke', async (req, res) => {
    try {
        const { asset_id, reason } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] RevokeAnchor: ${asset_id}`);
        const result = await fabricClient.revokeAnchor(asset_id, reason || '');
        logger.info(`Revocation initiated: ${asset_id} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Revoke anchor error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/endorse-revoke', async (req, res) => {
    try {
        const { asset_id } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] EndorseRevoke: ${asset_id}`);
        const result = await fabricClient.endorseRevoke(asset_id);
        logger.info(`Revocation endorsed: ${asset_id} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Endorse revoke error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/reject-revoke', async (req, res) => {
    try {
        const { asset_id, reason } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] RejectRevoke: ${asset_id}`);
        const result = await fabricClient.rejectRevoke(asset_id, reason || '');
        logger.info(`Revocation rejected: ${asset_id} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Reject revoke error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/anchors', async (req, res) => {
    try {
        const result = await req.fabricClient.getAllActiveAnchors();
        res.json(result);
    } catch (error) {
        logger.error(`Get all anchors error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/pending-revocations', async (req, res) => {
    try {
        const result = await req.fabricClient.getPendingRevocations();
        res.json(result);
    } catch (error) {
        logger.error(`Get pending revocations error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/pending-revocations/for-me', async (req, res) => {
    try {
        const result = await req.fabricClient.getPendingRevocationsForOrg();
        res.json(result);
    } catch (error) {
        logger.error(`Get pending revocations for org error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

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

// =============================================================================
// ANNOTATION ADMIN ROUTES (v2.1: intent_type required)
// =============================================================================

router.post('/endorse-annotation', async (req, res) => {
    try {
        const { asset_id, intent_type } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        if (!intent_type) return res.status(400).json({ success: false, error: 'Missing required field: intent_type' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] EndorseAnnotation via admin: ${asset_id}:${intent_type}`);
        const result = await fabricClient.endorseAnnotation(asset_id, intent_type);
        logger.info(`Annotation endorsed via admin: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Admin endorse annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/reject-annotation', async (req, res) => {
    try {
        const { asset_id, intent_type, reason } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        if (!intent_type) return res.status(400).json({ success: false, error: 'Missing required field: intent_type' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] RejectAnnotation via admin: ${asset_id}:${intent_type}`);
        const result = await fabricClient.rejectAnnotation(asset_id, intent_type, reason || '');
        logger.info(`Annotation rejected via admin: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Admin reject annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/revoke-annotation', async (req, res) => {
    try {
        const { asset_id, intent_type, reason } = req.body;
        if (!asset_id) return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        if (!intent_type) return res.status(400).json({ success: false, error: 'Missing required field: intent_type' });
        const fabricClient = req.fabricClient;
        logger.info(`[${req.orgId}] RevokeAnnotation via admin: ${asset_id}:${intent_type}`);
        const result = await fabricClient.revokeAnnotation(asset_id, intent_type, reason || '');
        logger.info(`Annotation revoked via admin: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);
        res.json(result);
    } catch (error) {
        logger.error(`Admin revoke annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/annotations', async (req, res) => {
    try {
        const result = await req.fabricClient.getAllActiveAnnotations();
        res.json(result);
    } catch (error) {
        logger.error(`Get all annotations error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/annotations/:assetId/:intentType', async (req, res) => {
    try {
        const result = await req.fabricClient.getAnnotation(req.params.assetId, req.params.intentType);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
