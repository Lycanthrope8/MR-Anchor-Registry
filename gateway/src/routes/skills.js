/**
 * ==============================================================================
 * skills.js — Gateway routes for LLM-mediated governance (Phase 4)
 *
 * Endpoints:
 *   POST /skills/interpret           — proxy to runtime, returns Decision + decisionId
 *   GET  /skills/decision/:id        — peek a pending decision (admin-panel review)
 *   POST /skills/execute             — validate, invoke anchor-registry, record audit
 *   GET  /skills/audit/:decisionId   — read-only ReplayDecision
 *   GET  /skills/audit/anchor/:id    — list decisions linked to an asset
 *   GET  /skills/health              — gateway-side runtime + allowlist health
 *
 * Human-in-the-loop flow (Phase 4 default):
 *   1. Unity client → POST /skills/interpret { userText, context }
 *   2. Gateway calls runtime, parks envelope in decisionStore, returns decisionId
 *   3. Admin panel polls GET /skills/decision/:id, shows the Decision to user
 *   4. User confirms → POST /skills/execute { decisionId }
 *   5. Gateway re-validates, invokes anchor-registry, records skill-audit-registry
 *
 * REJECT/CLARIFY decisions never reach step 5; they're recorded immediately at
 * step 2 (with state=RECORDED_REJECT on the chaincode), then returned to the
 * client as informational.
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const path = require('path');

const logger = require('../services/logger');
const SkillRuntimeClient = require('../services/skillRuntimeClient');
const DecisionStore = require('../services/decisionStore');
const allowlist = require('../services/skillManifestAllowlist');
const fnMap = require('../services/fabricFunctionMap');
const { validateEnvelope } = require('../validators/policyValidator');
const { registerCorrelation } = require('./events');


// One runtime client + one decision store per gateway process.
const runtime = new SkillRuntimeClient();
const decisionStore = new DecisionStore({
    walPath: process.env.SKILL_DECISION_WAL ||
             path.resolve(__dirname, '..', '..', '..', 'data', `skill-decisions-${process.env.ORG || 'org1'}.wal`),
});

// =============================================================================
// Helpers
// =============================================================================

function extractChaincodeErrorReason(err) {
    if (!err) return 'unknown error';
    const msg = err.message || String(err);
 
    const m1 = msg.match(/message:'([^']+)'/);
    if (m1) return m1[1];
 
    const m2 = msg.match(/transaction returned with failure:\s*(.+?)(?:\s*$|\n)/);
    if (m2) return m2[1];
 
    return msg;
}

function txIdFrom(chainResponse) {
    if (!chainResponse) return null;
    if (chainResponse.tx_id) return chainResponse.tx_id;
    if (chainResponse.event_id && typeof chainResponse.event_id === 'string') {
        return chainResponse.event_id.split(':')[0];
    }
    return null;
}

/**
 * Build a finished audit envelope for the chaincode, combining what the runtime
 * sent with gateway-side fields (decisionId, gatewayId, validation outcomes).
 */
function buildAuditEnvelope(runtimeEnvelope, gatewayCtx, decisionId, validationOutcome, errors = []) {
    const { decision, audit } = runtimeEnvelope;
    return {
        // primary id (gateway-minted)
        decisionId,

        // skill provenance (from runtime)
        skillId:           audit.skillId,
        skillVersion:      audit.skillVersion,
        skillManifestHash: audit.skillManifestHash,

        // LLM provenance (from runtime)
        llmProvider:       audit.llmProvider,
        llmModel:          audit.llmModel,
        llmCallId:         audit.llmCallId || null,
        llmFinishReason:   audit.llmFinishReason || null,
        llmLatencyMs:      audit.llmLatencyMs ?? null,
        llmUsage:          audit.llmUsage || null,
        tokenEstimate:     audit.tokenEstimate || null,
        levelsLoaded:      audit.levelsLoaded || null,

        // request fingerprints (from runtime)
        intentHash:        audit.intentHash,
        contextHash:       audit.contextHash,
        argumentHash:      audit.argumentHash,

        // decision result (from runtime, with safe fallbacks)
        decisionType:        decision?.decisionType || 'REJECT',
        selectedChaincode:   decision?.selectedChaincode || '',
        selectedFunction:    decision?.selectedFunction || '',
        riskLevel:           decision?.riskLevel || null,
        requiresConfirmation: decision?.requiresConfirmation === true,
        shouldInvoke:        decision?.shouldInvoke === true,

        // validation outcome (gateway-side)
        schemaValidation: validationOutcome.schemaValidation || 'PASS',
        policyValidation: validationOutcome.policyValidation || 'APPROVED',
        policyReasoning:  decision?.policyReasoning || '',
        errors,

        // identity
        submittingOrg: gatewayCtx.mspId,
        gatewayId:     `${gatewayCtx.org}-gateway`,

        // timestamps
        timestamp: audit.timestamp,
    };
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /skills/health
 */
router.get('/health', async (req, res) => {
    const out = {
        gatewayOrg: req.orgId,
        gatewayMsp: req.fabricClient?.getMspId() || 'unknown',
        decisionStore: {
            pending: decisionStore.size(),
        },
        allowlist: allowlist.list(),
    };
    if (runtime.isConfigured()) {
        try {
            out.runtime = await runtime.health();
            out.runtimeReachable = true;
        } catch (e) {
            out.runtimeReachable = false;
            out.runtimeError = e.message;
        }
    } else {
        out.runtimeReachable = false;
        out.runtimeError = 'SKILL_RUNTIME_URL not configured';
    }
    res.json(out);
});

/**
 * POST /skills/interpret
 * Body: { userText: string, context?: object, req_id?: string, run_id?: string }
 */
router.post('/interpret', async (req, res) => {
    const fabricClient = req.fabricClient;
    if (!fabricClient || !fabricClient.isConnected()) {
        return res.status(503).json({ success: false, error: 'Fabric not connected' });
    }
    if (!runtime.isConfigured()) {
        return res.status(503).json({ success: false, error: 'SKILL_RUNTIME_URL not configured' });
    }

    const { userText, context, req_id, run_id } = req.body || {};
    if (typeof userText !== 'string' || !userText.trim()) {
        return res.status(400).json({ success: false, error: 'userText required' });
    }

    const gatewayMsp = fabricClient.getMspId();
    const gatewayCtx = { org: req.orgId, mspId: gatewayMsp };

    let runtimeEnvelope;
    try {
        runtimeEnvelope = await runtime.interpret({
            userText,
            orgMsp: gatewayMsp,
            context: context || {},
        });
    } catch (e) {
        logger.error(`/skills/interpret runtime call failed: ${e.message}`);
        return res.status(502).json({ success: false, error: `runtime: ${e.message}` });
    }

    // Validate the envelope. We validate even REJECT/CLARIFY structurally so we
    // never store a malformed envelope.
    const result = validateEnvelope(runtimeEnvelope, { gatewayMsp, allowlist });
    const validationOutcome = {
        schemaValidation: result.ok ? 'PASS' : 'FAIL',
        policyValidation: result.ok ? 'APPROVED' : 'REJECTED',
    };

    // Mint a fresh decisionId at the gateway (the chaincode will validate uniqueness).
    const decisionId = DecisionStore.newDecisionId();
    const auditEnvelope = buildAuditEnvelope(
        runtimeEnvelope, gatewayCtx, decisionId, validationOutcome, result.errors
    );

    const decisionType = auditEnvelope.decisionType;
    const isInvokeButValid = decisionType === 'INVOKE' && result.ok;

    // For INVOKE that passes validation: park the envelope, return decisionId
    // for the user to confirm via /skills/execute.
    if (isInvokeButValid) {
        decisionStore.put(decisionId, {
            runtimeEnvelope,
            auditEnvelope,
            gatewayCtx,
        });
        if (req_id) registerCorrelation(decisionId, req_id);
        logger.info(`[${req.orgId}] /skills/interpret -> INVOKE pending ${decisionId} ` +
                    `(fn=${runtimeEnvelope.decision.selectedFunction})`);
        return res.json({
            success: true,
            decision_id: decisionId,
            requires_confirmation: true,
            decision: runtimeEnvelope.decision,
            audit: runtimeEnvelope.audit,
            expires_in_ms: 5 * 60 * 1000,
        });
    }

    // For REJECT, CLARIFY, or invalid INVOKE: record immediately as terminal.
    // The chaincode will set state=RECORDED_REJECT for non-INVOKE.
    // For invalid-INVOKE we override the decisionType to REJECT so the audit
    // chain accurately reflects the gateway's decision.
    if (decisionType === 'INVOKE' && !result.ok) {
        auditEnvelope.decisionType = 'REJECT';
        auditEnvelope.shouldInvoke = false;
        auditEnvelope.policyReasoning =
            'Gateway rejected: ' + result.errors.join('; ');
    }

    try {
        const rec = await fabricClient.recordSkillDecision(auditEnvelope);
        logger.info(`[${req.orgId}] /skills/interpret -> ${auditEnvelope.decisionType} ` +
                    `recorded ${decisionId} (tx=${rec.tx_id})`);
        return res.status(result.ok ? 200 : 422).json({
            success: result.ok,
            decision_id: decisionId,
            requires_confirmation: false,
            decision: runtimeEnvelope.decision,
            audit: runtimeEnvelope.audit,
            chain: rec,
            errors: result.errors,
        });
    } catch (e) {
        logger.error(`[${req.orgId}] recordSkillDecision failed for ${decisionId}: ${e.message}`);
        return res.status(500).json({
            success: false,
            decision_id: decisionId,
            error: `audit-record failed: ${e.message}`,
            errors: result.errors,
        });
    }
});

/**
 * GET /skills/decision/:id
 * Peek a pending decision (for admin-panel review). Read-only.
 */
router.get('/decision/:id', (req, res) => {
    const envelope = decisionStore.peek(req.params.id);
    if (!envelope) return res.status(404).json({ success: false, error: 'decision not found or expired' });
    return res.json({
        success: true,
        decision_id: req.params.id,
        decision: envelope.runtimeEnvelope.decision,
        audit: envelope.runtimeEnvelope.audit,
    });
});

/**
 * POST /skills/execute
 * Body: { decision_id: string, confirm: true }
 * Atomically: consume from store, re-validate, invoke anchor-registry, record audit.
 */
router.post('/execute', async (req, res) => {
    const fabricClient = req.fabricClient;
    if (!fabricClient || !fabricClient.isConnected()) {
        return res.status(503).json({ success: false, error: 'Fabric not connected' });
    }

    const { decision_id, confirm } = req.body || {};
    if (!decision_id) return res.status(400).json({ success: false, error: 'decision_id required' });
    if (confirm !== true) return res.status(400).json({ success: false, error: 'must include confirm:true' });

    // Atomic consume — prevents double-execute (gateway-side replay protection).
    const parked = decisionStore.consume(decision_id);
    if (!parked) return res.status(404).json({ success: false, error: 'decision not found, already executed, or expired' });

    const { runtimeEnvelope, auditEnvelope, gatewayCtx } = parked;
    const gatewayMsp = fabricClient.getMspId();

    // Re-validate. Catches: clock has rolled past freshness window during review,
    // allowlist edited between interpret and execute, gateway MSP changed.
    const result = validateEnvelope(runtimeEnvelope, { gatewayMsp, allowlist });
    if (!result.ok) {
        // Record REJECT on chain — bypass attempt MUST leave a trace.
        auditEnvelope.decisionType = 'REJECT';
        auditEnvelope.shouldInvoke = false;
        auditEnvelope.schemaValidation = 'FAIL';
        auditEnvelope.policyValidation = 'REJECTED';
        auditEnvelope.policyReasoning = 'Re-validation failed on execute: ' + result.errors.join('; ');
        auditEnvelope.errors = result.errors;
        try {
            await fabricClient.recordSkillDecision(auditEnvelope);
        } catch (e) {
            logger.error(`recordSkillDecision (REJECT path) failed: ${e.message}`);
        }
        return res.status(422).json({ success: false, decision_id, errors: result.errors });
    }

    // Resolve function name → FabricClient method
    const mapping = fnMap.resolve(result.decision.selectedFunction);
    if (!mapping) {
        return res.status(500).json({
            success: false,
            decision_id,
            error: `internal: no FabricClient mapping for ${result.decision.selectedFunction}`,
        });
    }

    // 1. Record audit FIRST (so the attempt is on-chain even if the anchor invoke fails).
    let recordRes;
    try {
        recordRes = await fabricClient.recordSkillDecision(auditEnvelope);
    } catch (e) {
        logger.error(`[${gatewayCtx.org}] RecordSkillDecision failed: ${e.message}`);
        return res.status(500).json({ success: false, decision_id, error: `audit pre-record failed: ${e.message}` });
    }

    // 2. Invoke anchor-registry
    let anchorResult, anchorTxId, finalState;
    try {
        const args = mapping.mapArgs(result.decision.arguments || {});
        const args_for_log = JSON.stringify(args).slice(0, 200);
        logger.info(`[${gatewayCtx.org}] skill→anchor: ${result.decision.selectedFunction}(${args_for_log})`);
        anchorResult = await fabricClient[mapping.fabricMethod](...args);
        // Many chaincode responses include tx_id; if not, fall back to a placeholder.
        anchorTxId = (anchorResult && (anchorResult.tx_id || anchorResult.txId)) || `unknown-${Date.now()}`;
        finalState = mapping.captureState(anchorResult);
    } catch (e) {
        logger.error(`[${gatewayCtx.org}] anchor-registry invoke failed: ${e.message}`);
 
        // v1.0.2: convert the audit record from RECORDED (non-terminal) to
        // RECORDED_FAILED_ATTEMPT (terminal) with the on-chain failure reason.
        // This means every decision now reaches a terminal audit state,
        // closing the audit-chain gap from v1.0.1.
        const errorReason = extractChaincodeErrorReason(e);
        let outcomeRes = null;
        try {
            outcomeRes = await fabricClient.updateDecisionOutcome(
                decision_id,
                'RECORDED_FAILED_ATTEMPT',
                '',                 // anchorTxId unused on failure path
                errorReason
            );
        } catch (auditErr) {
            // If even the audit-outcome update fails, the record stays at RECORDED.
            // verify-chaincode-v1.0.2.sh catches this inconsistency.
            logger.error(
                `[${gatewayCtx.org}] CRITICAL: UpdateDecisionOutcome failed after chaincode rejection ` +
                `decision_id=${decision_id} originalError="${e.message}" auditError="${auditErr.message}"`
            );
        }
 
        return res.status(409).json({
            success: false,
            decision_id,
            audit_recorded: true,
            audit_tx: recordRes?.tx_id,
            audit_terminal: outcomeRes ? 'RECORDED_FAILED_ATTEMPT' : 'RECORDED',
            audit_outcome_tx: outcomeRes?.tx_id || null,
            ledger_commit: false,
            error: errorReason,
        });
    }

    // 3. Link audit → anchor tx
    let linkRes;
    try {
        linkRes = await fabricClient.linkAnchorTx(
            decision_id,
            anchorTxId,
            finalState,
            result.decision.arguments?.assetId || ''
        );
    } catch (e) {
        logger.error(`[${gatewayCtx.org}] LinkAnchorTx failed for ${decision_id}: ${e.message}`);
        return res.status(500).json({
            success: false,
            decision_id,
            audit_recorded: true,
            audit_tx: recordRes?.tx_id,
            anchor_result: anchorResult,
            anchor_tx: anchorTxId,
            error: `audit link failed: ${e.message}`,
        });
    }

    logger.info(`[${gatewayCtx.org}] /skills/execute -> ok decision=${decision_id} ` +
                `anchor_tx=${anchorTxId} final_state=${finalState}`);

    return res.json({
    success: true,
    decision_id,
    anchor: anchorResult,
    anchor_tx_id: anchorTxId,
    final_state: finalState,
    audit_record_tx: txIdFrom(recordRes),
    audit_link_tx: txIdFrom(linkRes),
    });
});

/**
 * GET /skills/audit/:decisionId
 * Read-only ReplayDecision.
 */
router.get('/audit/:decisionId', async (req, res) => {
    try {
        const out = await req.fabricClient.replayDecision(req.params.decisionId);
        return res.json({ success: true, replay: out });
    } catch (e) {
        return res.status(404).json({ success: false, error: e.message });
    }
});

/**
 * GET /skills/audit/anchor/:assetId
 * Read-only ListDecisionsByAnchor.
 */
router.get('/audit/anchor/:assetId', async (req, res) => {
    try {
        const out = await req.fabricClient.listDecisionsByAnchor(req.params.assetId);
        return res.json({ success: true, ...out });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
