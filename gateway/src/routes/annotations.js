/**
 * ==============================================================================
 * annotations.js - Annotation routes for governed AI annotations
 *
 * Follows the same patterns as claims.js:
 * - SSE broadcasts are driven by Fabric chaincode events (see events.js)
 * - registerCorrelation() is called before submitting for experiment tracing
 * - req.fabricClient is the org-scoped Fabric client from middleware
 *
 * The /annotations/request endpoint calls the mock annotation generator
 * on localhost:5001, then submits the result to chaincode.
 * ==============================================================================
 */

const express = require('express');
const http = require('http');
const router = express.Router();
const logger = require('../services/logger');
const { registerCorrelation } = require('./events');

// Annotation generator service URL (runs on gateway host per Decision 3)
const ANNOTATION_SERVICE_URL = process.env.ANNOTATION_SERVICE_URL || 'http://localhost:5001';

// ─── Helper: call the annotation generator service ──────────────────────

function callAnnotationService(body) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${ANNOTATION_SERVICE_URL}/annotate`);
        const bodyStr = JSON.stringify(body);

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            },
            timeout: 10000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        reject(new Error(`Annotation service returned ${res.statusCode}: ${data}`));
                    } else {
                        resolve(JSON.parse(data));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse annotation service response: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`Annotation service unreachable: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Annotation service timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

// =============================================================================
// POST /annotations/request — Full orchestration: generate → propose on-chain
// =============================================================================

router.post('/request', async (req, res) => {
    try {
        const { asset_id, tier, class_name, confidence, req_id, run_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const annotationTier = tier || 'ADVISORY';
        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] Annotation request: ${asset_id} (tier=${annotationTier})` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        // 1. Call annotation generator service
        let generated;
        try {
            generated = await callAnnotationService({
                asset_id,
                tier: annotationTier,
                class_name: class_name || 'unknown',
                confidence: confidence || 0.0
            });
        } catch (genError) {
            logger.error(`Annotation generator error: ${genError.message}`);
            return res.status(502).json({
                success: false,
                error: `Annotation generator failed: ${genError.message}`
            });
        }

        logger.info(`Generator returned: ${generated.annotation_text.substring(0, 60)}...`);

        // 2. Register correlation for experiment tracing
        registerCorrelation(asset_id, req_id);

        // 3. Submit to chaincode
        const classContext = {
            className: class_name || 'unknown',
            confidence: confidence || 0.0
        };

        const result = await fabricClient.proposeAnnotation(
            asset_id,
            generated.annotation_text,
            annotationTier,
            classContext,
            generated.generator_id,
            generated.prompt_hash
        );

        logger.info(`Annotation proposed: ${asset_id} → ${result.state}`);

        // NOTE: SSE events are emitted by the chaincode event listener, NOT here.

        res.json(result);

    } catch (error) {
        logger.error(`Annotation request error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// POST /annotations/endorse — Endorse a pending GOVERNED annotation
// =============================================================================

router.post('/endorse', async (req, res) => {
    try {
        const { asset_id, req_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: asset_id'
            });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] EndorseAnnotation: ${asset_id}` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        registerCorrelation(asset_id, req_id);

        const result = await fabricClient.endorseAnnotation(asset_id);

        logger.info(`Annotation endorsed: ${asset_id} by ${fabricClient.getMspId()}`);

        res.json(result);

    } catch (error) {
        logger.error(`Endorse annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// POST /annotations/reject — Reject a pending annotation
// =============================================================================

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

        logger.info(`[${orgId}] RejectAnnotation: ${asset_id}`);

        const result = await fabricClient.rejectAnnotation(asset_id, reason || '');

        logger.info(`Annotation rejected: ${asset_id} by ${fabricClient.getMspId()}`);

        res.json(result);

    } catch (error) {
        logger.error(`Reject annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// POST /annotations/revoke — Revoke an active annotation
// =============================================================================

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

        logger.info(`[${orgId}] RevokeAnnotation: ${asset_id}`);

        const result = await fabricClient.revokeAnnotation(asset_id, reason || '');

        logger.info(`Annotation revoked: ${asset_id} by ${fabricClient.getMspId()}`);

        res.json(result);

    } catch (error) {
        logger.error(`Revoke annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId — Get annotation details
// =============================================================================

router.get('/:assetId', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getAnnotation(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId/active — Get active annotation for asset
// =============================================================================

router.get('/:assetId/active', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getActiveAnnotation(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get active annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId/history — Get annotation ledger history
// =============================================================================

router.get('/:assetId/history', async (req, res) => {
    try {
        const { assetId } = req.params;
        const fabricClient = req.fabricClient;
        const result = await fabricClient.getAnnotationHistory(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotation history error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;