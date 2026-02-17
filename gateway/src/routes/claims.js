/**
 * ==============================================================================
 * claims.js - Claim routes for Unity clients
 * PHASE 1: Propagates req_id from request body into SSE broadcastEvent
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { broadcastEvent } = require('./events');

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
        
        const result = await fabricClient.proposeAnchor(
            asset_id,
            pose_site,
            quality_metrics
        );
        
        logger.info(`Anchor proposed: ${asset_id}`);
        
        // BROADCAST SSE EVENT - PHASE 1: pass req_id for traceability
        broadcastEvent('CLAIM_PROPOSED', {
            // Snake case (for web admin panels)
            asset_id: asset_id,
            claim_id: result.claim_id,
            proposed_via_org: result.proposed_via_org || fabricClient.getMspId(),
            // CamelCase (for Unity client)
            assetId: asset_id,
            claimId: result.claim_id,
            proposedViaOrg: result.proposed_via_org || fabricClient.getMspId(),
            // Common
            state: 'PROPOSED',
            requires_endorsement_from: ['Org1MSP', 'Org2MSP']
        }, req_id || null);
        
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
        const mspId = fabricClient.getMspId();
        
        logger.info(`[${orgId}] EndorseClaim: ${asset_id}` +
                    (req_id ? ` (req_id=${req_id})` : ''));
        
        const result = await fabricClient.endorseClaim(asset_id);
        
        logger.info(`Claim endorsed: ${asset_id} by ${mspId}`);
        
        // BROADCAST SSE EVENT based on result - PHASE 1: pass req_id
        if (result.is_fully_endorsed) {
            broadcastEvent('CLAIM_ACTIVATED', {
                asset_id: asset_id,
                claim_id: result.claim_id,
                final_endorser: mspId,
                endorsed_by: ['Org1MSP', 'Org2MSP'],
                assetId: asset_id,
                claimId: result.claim_id,
                finalEndorser: mspId,
                endorsedBy: ['Org1MSP', 'Org2MSP'],
                state: 'ACTIVE'
            }, req_id || null);
        } else {
            const eventType = mspId === 'Org1MSP' ? 'CLAIM_ENDORSED_ORG1' : 'CLAIM_ENDORSED_ORG2';
            broadcastEvent(eventType, {
                asset_id: asset_id,
                claim_id: result.claim_id,
                endorsed_by: mspId,
                assetId: asset_id,
                claimId: result.claim_id,
                endorsedBy: mspId,
                endorsements: result.endorsements,
                state: result.state
            }, req_id || null);
        }
        
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
        const mspId = fabricClient.getMspId();
        
        logger.info(`[${orgId}] RejectClaim: ${asset_id}`);
        
        const result = await fabricClient.rejectClaim(asset_id, reason || '');
        
        logger.info(`Claim rejected: ${asset_id} by ${mspId}`);
        
        broadcastEvent('CLAIM_REJECTED', {
            asset_id: asset_id,
            claim_id: result.claim_id,
            rejected_by: mspId,
            assetId: asset_id,
            claimId: result.claim_id,
            rejectedBy: mspId,
            reason: reason || '',
            state: 'REJECTED'
        });
        
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