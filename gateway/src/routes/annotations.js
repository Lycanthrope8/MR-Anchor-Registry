/**
 * ==============================================================================
 * annotations.js - Annotation routes for governed AI annotations
 *
 * v2.1: All endpoints now require intent_type parameter (multi-card model).
 *       Valid intent types: ASK_ANCHOR, ACTION_SUGGEST
 * ==============================================================================
 */

const express = require('express');
const http = require('http');
const router = express.Router();
const logger = require('../services/logger');
const { registerCorrelation } = require('./events');

// Annotation generator service URL (runs on gateway host per Decision 3)
const ANNOTATION_SERVICE_URL = process.env.ANNOTATION_SERVICE_URL || 'http://localhost:5001';

// Valid intent types (must match chaincode)
const VALID_INTENT_TYPES = ['ASK_ANCHOR', 'ACTION_SUGGEST'];

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

// ─── Helper: validate intent_type ────────────────────────────────────────

function validateIntentType(intentType) {
    if (!intentType) {
        return { valid: false, error: 'Missing required field: intent_type' };
    }
    if (!VALID_INTENT_TYPES.includes(intentType)) {
        return { valid: false, error: `Invalid intent_type: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}` };
    }
    return { valid: true };
}

// =============================================================================
// POST /annotations/request — Full orchestration: generate → propose on-chain
// =============================================================================

router.post('/request', async (req, res) => {
    try {
        const { asset_id, tier, intent_type, class_name, confidence, mode, req_id, run_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        }

        const intentCheck = validateIntentType(intent_type);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const annotationTier = tier || 'ADVISORY';
        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] Annotation request: ${asset_id} (tier=${annotationTier}, intentType=${intent_type}, mode=${mode || 'default'})` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        // 1. Call annotation generator service (v1.0: pass mode for LLM/mock selection)
        let generated;
        try {
            generated = await callAnnotationService({
                asset_id,
                tier: annotationTier,
                intent_type,
                class_name: class_name || 'unknown',
                confidence: confidence || 0.0,
                mode: mode || undefined
            });
        } catch (genError) {
            logger.error(`Annotation generator error: ${genError.message}`);
            return res.status(502).json({
                success: false,
                error: `Annotation generator failed: ${genError.message}`
            });
        }

        const modeUsed = generated.mode_used || 'unknown';
        logger.info(`Generator [${modeUsed}] (${generated.generator_id}): ${generated.annotation_text.substring(0, 60)}...`);

        // 2. Register correlation for experiment tracing
        // v2.1: use composite key for correlation
        registerCorrelation(`${asset_id}:${intent_type}`, req_id);

        // 3. Submit to chaincode (v2.1: intentType is the last parameter)
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
            generated.prompt_hash,
            intent_type
        );

        logger.info(`Annotation proposed: ${asset_id}:${intent_type} → ${result.state} (generator=${generated.generator_id}, mode=${modeUsed})`);

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
        const { asset_id, intent_type, req_id } = req.body;

        if (!asset_id) {
            return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        }

        const intentCheck = validateIntentType(intent_type);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] EndorseAnnotation: ${asset_id}:${intent_type}` +
                    (req_id ? ` (req_id=${req_id})` : ''));

        registerCorrelation(`${asset_id}:${intent_type}`, req_id);

        const result = await fabricClient.endorseAnnotation(asset_id, intent_type);

        logger.info(`Annotation endorsed: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);

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
        const { asset_id, intent_type, reason } = req.body;

        if (!asset_id) {
            return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        }

        const intentCheck = validateIntentType(intent_type);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] RejectAnnotation: ${asset_id}:${intent_type}`);

        const result = await fabricClient.rejectAnnotation(asset_id, intent_type, reason || '');

        logger.info(`Annotation rejected: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);

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
        const { asset_id, intent_type, reason } = req.body;

        if (!asset_id) {
            return res.status(400).json({ success: false, error: 'Missing required field: asset_id' });
        }

        const intentCheck = validateIntentType(intent_type);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const orgId = req.orgId;

        logger.info(`[${orgId}] RevokeAnnotation: ${asset_id}:${intent_type}`);

        const result = await fabricClient.revokeAnnotation(asset_id, intent_type, reason || '');

        logger.info(`Annotation revoked: ${asset_id}:${intent_type} by ${fabricClient.getMspId()}`);

        res.json(result);

    } catch (error) {
        logger.error(`Revoke annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId — Get all annotations (both intent types) for asset
// =============================================================================

router.get('/:assetId', async (req, res) => {
    try {
        const { assetId } = req.params;

        // Avoid matching routes like /request, /endorse etc. as assetId
        const reservedWords = ['request', 'endorse', 'reject', 'revoke'];
        if (reservedWords.includes(assetId.toLowerCase())) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const fabricClient = req.fabricClient;
        const result = await fabricClient.getActiveAnnotationsForAsset(assetId);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotations for asset error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId/:intentType — Get annotation details
// =============================================================================

router.get('/:assetId/:intentType', async (req, res) => {
    try {
        const { assetId, intentType } = req.params;

        const intentCheck = validateIntentType(intentType);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const result = await fabricClient.getAnnotation(assetId, intentType);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId/:intentType/active — Get active annotation
// =============================================================================

router.get('/:assetId/:intentType/active', async (req, res) => {
    try {
        const { assetId, intentType } = req.params;

        const intentCheck = validateIntentType(intentType);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const result = await fabricClient.getActiveAnnotation(assetId, intentType);
        res.json(result);
    } catch (error) {
        logger.error(`Get active annotation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GET /annotations/:assetId/:intentType/history — Get annotation ledger history
// =============================================================================

router.get('/:assetId/:intentType/history', async (req, res) => {
    try {
        const { assetId, intentType } = req.params;

        const intentCheck = validateIntentType(intentType);
        if (!intentCheck.valid) {
            return res.status(400).json({ success: false, error: intentCheck.error });
        }

        const fabricClient = req.fabricClient;
        const result = await fabricClient.getAnnotationHistory(assetId, intentType);
        res.json(result);
    } catch (error) {
        logger.error(`Get annotation history error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;