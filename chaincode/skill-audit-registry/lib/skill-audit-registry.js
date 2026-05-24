/*
 * ==============================================================================
 * skill-audit-registry.js — Skill Decision Audit Chaincode
 * DUAL ENDORSEMENT MODEL — Both Org1 AND Org2 must endorse every write
 * ==============================================================================
 *
 * Records the on-chain provenance of LLM-mediated governance decisions.
 *
 * Conventions follow anchor-registry.js exactly:
 *   - Single Contract class extending fabric-contract-api Contract
 *   - Identity from ctx.clientIdentity.getMSPID(), validated against VALID_MSPS
 *   - Event IDs from ctx.stub.getTxID() with per-tx suffix (no global counters)
 *   - Key prefixes use the "PREFIX::" pattern
 *   - All hashes use sha256, payloads JSON-stringified
 *
 * STORED PER DECISION (paraphrasing §7.1 of the proposal):
 *   decisionId, skillId, skillVersion, skillManifestHash,
 *   llmProvider, llmModel, llmCallId,
 *   intentHash, contextHash, argumentHash,
 *   selectedChaincode, selectedFunction, riskLevel,
 *   schemaValidation, policyValidation,
 *   submittingOrg, gatewayId,
 *   linkedAnchorTxId, finalState,
 *   timestamp, recordedAt, txId
 *
 * NEVER STORED: raw user text, raw LLM output, scene data, credentials, poses.
 * Only hashes go on-chain.
 *
 * WORKFLOW (typical decision lifecycle):
 *   1. Gateway calls RecordSkillDecision(envelopeJson)
 *      -> ledger key SKILL_DECISION::<decisionId>  state=RECORDED
 *      -> event SKILL_DECISION_RECORDED emitted
 *   2. Gateway invokes anchor-registry, receives fabricTxId
 *   3. Gateway calls LinkAnchorTx(decisionId, anchorTxId, finalState)
 *      -> existing decision augmented with linkedAnchorTxId + finalState
 *      -> state -> LINKED
 *      -> event SKILL_DECISION_LINKED emitted
 *
 * If the decision was REJECT or CLARIFY (no chaincode call), step 3 is skipped
 * and the decision stays in state=RECORDED. The audit chain is still complete.
 * ==============================================================================
 */

'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

// ----- Constants ------------------------------------------------------------
const VALID_MSPS = ['Org1MSP', 'Org2MSP'];

const PREFIX_DECISION = 'SKILL_DECISION::';
const PREFIX_ANCHOR_INDEX = 'SKILL_DECISION_BY_ANCHOR::'; // assetId -> [decisionId]
const PREFIX_EVENT = 'SKILL_EVENT::';

// Decision lifecycle states (audit-side, not anchor-side)
const STATE_RECORDED = 'RECORDED';     // initial — envelope written
const STATE_LINKED = 'LINKED';         // anchor tx id attached
const STATE_REJECTED_RECORD = 'RECORDED_REJECT';  // decision was REJECT — no anchor link expected

const STATE_RECORDED_AND_LINKED = 'RECORDED_AND_LINKED';     // v1.0.2: terminal — chaincode succeeded, audit linked
const STATE_RECORDED_FAILED_ATTEMPT = 'RECORDED_FAILED_ATTEMPT'; // v1.0.2: terminal — chaincode rejected, reason recorded
 
// Set of all terminal states (used by UpdateDecisionOutcome for idempotency checks).
const TERMINAL_STATES = new Set([
    STATE_LINKED,                   // legacy v1.0.1 terminal (grandfathered)
    STATE_REJECTED_RECORD,          // existing terminal for REJECT/CLARIFY
    STATE_RECORDED_AND_LINKED,      // new in v1.0.2
    STATE_RECORDED_FAILED_ATTEMPT,  // new in v1.0.2
]);
 
const MAX_ERROR_REASON_LEN = 256;

// Allowed values mirroring SKILL.md output contract
const ALLOWED_DECISION_TYPES = ['INVOKE', 'REJECT', 'CLARIFY'];
const ALLOWED_RISK_LEVELS = ['READ_ONLY', 'WRITE_LOW', 'WRITE_GOVERNED', 'FORBIDDEN'];

// Required fields the gateway MUST include in the audit envelope.
// (Optional fields are stored if present but not required.)
const REQUIRED_ENVELOPE_FIELDS = [
    'decisionId',
    'skillId',
    'skillVersion',
    'skillManifestHash',
    'decisionType',
    'llmProvider',
    'llmModel',
    'intentHash',
    'contextHash',
    'argumentHash',
    'submittingOrg',
    'gatewayId',
    'timestamp',
];

// Pattern for sha256 hashes the runtime emits.
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

// ----- Helper: get the transaction's ordering timestamp as ISO string.
// MUST be used everywhere a timestamp is written into state or events,
// because `new Date()` returns wall-clock which differs between peers and
// breaks the AND-endorsement read-write set match check.
function txTimeISO(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    // ts.seconds is a Long. Use toNumber() if present (older Fabric SDK),
    // otherwise treat as a plain number.
    const seconds = (ts.seconds && typeof ts.seconds.toNumber === 'function')
        ? ts.seconds.toNumber()
        : Number(ts.seconds);
    const millis = Math.floor(Number(ts.nanos || 0) / 1e6);
    return new Date(seconds * 1000 + millis).toISOString();
}

/**
 * Sanitize an error reason string for on-chain storage:
 *   - strip control characters (keep printable ASCII + common punctuation)
 *   - collapse whitespace
 *   - truncate to MAX_ERROR_REASON_LEN with a trailing marker
 *
 * Forensic-friendly. Does not leak raw stack traces or user text.
 */
function sanitizeErrorReason(s) {
    if (s == null) return '';
    let r = String(s);
    // remove non-printable control characters
    r = r.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // collapse whitespace
    r = r.replace(/\s+/g, ' ').trim();
    if (r.length > MAX_ERROR_REASON_LEN) {
        r = r.slice(0, MAX_ERROR_REASON_LEN - 12) + '...truncated';
    }
    return r;
}
 
/**
 * v1.0.2 helper: returns true if a state is a terminal success
 * (either the new RECORDED_AND_LINKED or the grandfathered LINKED).
 */
function isLinkedTerminal(state) {
    return state === STATE_LINKED || state === STATE_RECORDED_AND_LINKED;
}
 

class SkillAuditRegistryContract extends Contract {

    // ==========================================================================
    // INITIALIZATION
    // ==========================================================================

    async InitLedger(ctx) {
        console.log('============= START : InitLedger (skill-audit-registry) ===========');

        const txTimestamp = ctx.stub.getTxTimestamp();
        const timestamp = new Date(txTimestamp.seconds.toNumber() * 1000).toISOString();

        const initEvent = {
            type: 'AUDIT_LEDGER_INITIALIZED',
            timestamp,
            initiator: ctx.clientIdentity.getMSPID(),
            chaincode: 'skill-audit-registry',
            endorsementModel: 'AND(Org1MSP.peer, Org2MSP.peer)',
        };

        const eventId = this._generateEventId(ctx);
        await ctx.stub.putState(
            `${PREFIX_EVENT}${eventId}`,
            Buffer.from(JSON.stringify(initEvent))
        );

        console.log('============= END : InitLedger (skill-audit-registry) ===========');
        return JSON.stringify({ success: true, message: 'skill-audit-registry initialized' });
    }

    // ==========================================================================
    // RECORD A SKILL DECISION
    // ==========================================================================

    /**
     * Record an LLM-mediated decision envelope on-chain.
     *
     * @param {string} envelopeJson - JSON-stringified envelope from the gateway.
     *
     * Returns: { success, decisionId, txId, state, recordedAt, eventId }
     */
    async RecordSkillDecision(ctx, envelopeJson) {
        const callerMsp = ctx.clientIdentity.getMSPID();
        this._validateMSP(callerMsp);

        const envelope = JSON.parse(envelopeJson);
        this._validateEnvelope(envelope);

        const decisionId = envelope.decisionId;

        // Reject duplicate decisionIds (replay protection).
        const existing = await ctx.stub.getState(`${PREFIX_DECISION}${decisionId}`);
        if (existing && existing.length > 0) {
            throw new Error(`Decision ${decisionId} already recorded`);
        }

        // Identity-binding guard:
        // the envelope's submittingOrg must equal the MSP of the caller,
        // OR be one of VALID_MSPS recorded as gateway-authoritative.
        // For now: caller-MSP must equal submittingOrg.
        // (When dual endorsement is OR-only at the Fabric level, the second org
        //  re-endorses the same write — and the proposal text is identical, so
        //  this check still holds.)
        if (envelope.submittingOrg !== callerMsp) {
            throw new Error(
                `submittingOrg ${envelope.submittingOrg} does not match caller MSP ${callerMsp}`
            );
        }

        const recordedAt = txTimeISO(ctx);
        const txId = ctx.stub.getTxID();

        // Initial audit state depends on decision type.
        let state;
        if (envelope.decisionType === 'INVOKE') {
            state = STATE_RECORDED;       // awaits LinkAnchorTx
        } else {
            state = STATE_REJECTED_RECORD; // terminal (no anchor write expected)
        }

        const record = {
            // primary id
            decisionId,
            txId,
            state,

            // skill provenance
            skillId: envelope.skillId,
            skillVersion: envelope.skillVersion,
            skillManifestHash: envelope.skillManifestHash,

            // LLM provenance
            llmProvider: envelope.llmProvider,
            llmModel: envelope.llmModel,
            llmCallId: envelope.llmCallId || null,
            llmFinishReason: envelope.llmFinishReason || null,
            llmLatencyMs: envelope.llmLatencyMs || null,
            llmUsage: envelope.llmUsage || null,
            tokenEstimate: envelope.tokenEstimate || null,
            levelsLoaded: envelope.levelsLoaded || null,

            // request fingerprints (hashes only)
            intentHash: envelope.intentHash,
            contextHash: envelope.contextHash,
            argumentHash: envelope.argumentHash,

            // decision result
            decisionType: envelope.decisionType,
            selectedChaincode: envelope.selectedChaincode || '',
            selectedFunction: envelope.selectedFunction || '',
            riskLevel: envelope.riskLevel || null,
            requiresConfirmation: envelope.requiresConfirmation === true,
            shouldInvoke: envelope.shouldInvoke === true,

            // validation outcome (gateway-supplied)
            schemaValidation: envelope.schemaValidation || null,
            policyValidation: envelope.policyValidation || null,
            policyReasoning: envelope.policyReasoning || null,
            errors: envelope.errors || [],

            // identity
            submittingOrg: envelope.submittingOrg,
            gatewayId: envelope.gatewayId,
            callerMsp,

            // timestamps
            timestamp: envelope.timestamp,   // when runtime created envelope
            recordedAt,                       // when chaincode commits

            // link to anchor-registry (filled by LinkAnchorTx)
            linkedAnchorTxId: null,
            finalState: null,
            linkedAt: null,
        };

        await ctx.stub.putState(
            `${PREFIX_DECISION}${decisionId}`,
            Buffer.from(JSON.stringify(record))
        );

        // Index by submitting-org's contextHash for ListDecisionsByContext style queries.
        // (ListDecisionsByAnchor uses an anchor-level index instead — populated by LinkAnchorTx.)

        const eventId = this._emitEvent(ctx, 'SKILL_DECISION_RECORDED', {
            decisionId,
            skillVersion: envelope.skillVersion,
            skillManifestHash: envelope.skillManifestHash,
            decisionType: envelope.decisionType,
            selectedFunction: envelope.selectedFunction || '',
            submittingOrg: envelope.submittingOrg,
            state,
        });

        return JSON.stringify({
            success: true,
            decision_id: decisionId,
            tx_id: txId,
            state,
            recorded_at: recordedAt,
            event_id: eventId,
        });
    }

    // ==========================================================================
    // LINK TO ANCHOR-REGISTRY TX
    // ==========================================================================

    /**
     * Attach the anchor-registry fabric tx id (and resulting state) to a recorded
     * decision. Called by the gateway AFTER it has successfully invoked
     * anchor-registry on behalf of an INVOKE decision.
     *
     * @param {string} decisionId
     * @param {string} anchorTxId         - the Fabric tx ID returned by anchor-registry invoke
     * @param {string} finalState         - e.g. PROPOSED, ENDORSED_ORG1, ACTIVE, REVOKE_PENDING
     * @param {string} [assetId]          - optional: anchor assetId for fast lookup (recommended)
     */
    async LinkAnchorTx(ctx, decisionId, anchorTxId, finalState, assetId) {
        const callerMsp = ctx.clientIdentity.getMSPID();
        this._validateMSP(callerMsp);

        if (!decisionId) throw new Error('decisionId required');
        if (!anchorTxId) throw new Error('anchorTxId required');
        if (!finalState) throw new Error('finalState required');

        const key = `${PREFIX_DECISION}${decisionId}`;
        const raw = await ctx.stub.getState(key);
        if (!raw || raw.length === 0) {
            throw new Error(`Decision ${decisionId} not found`);
        }

        const record = JSON.parse(raw.toString());

        // Idempotency: allow re-link to the SAME anchorTxId, reject contradicting linkage.
        if (record.linkedAnchorTxId) {
            if (record.linkedAnchorTxId === anchorTxId) {
                return JSON.stringify({
                    success: true,
                    decision_id: decisionId,
                    state: record.state,
                    note: 'already linked (idempotent)',
                });
            }
            throw new Error(
                `Decision ${decisionId} already linked to ${record.linkedAnchorTxId}; cannot relink to ${anchorTxId}`
            );
        }

        if (record.decisionType !== 'INVOKE') {
            throw new Error(
                `Cannot link a ${record.decisionType} decision to an anchor tx`
            );
        }

        const linkedAt = txTimeISO(ctx);
        record.linkedAnchorTxId = anchorTxId;
        record.finalState = finalState;
        record.linkedAt = linkedAt;
        record.state = STATE_LINKED;

        await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));

        // Index by anchor (assetId is the natural key for anchor-registry).
        const anchorKey = assetId || record.selectedFunction; // fallback for non-asset queries
        if (anchorKey) {
            const indexKey = `${PREFIX_ANCHOR_INDEX}${anchorKey}`;
            const existingIndex = await ctx.stub.getState(indexKey);
            const list = existingIndex && existingIndex.length > 0
                ? JSON.parse(existingIndex.toString())
                : [];
            if (!list.includes(decisionId)) {
                list.push(decisionId);
                await ctx.stub.putState(indexKey, Buffer.from(JSON.stringify(list)));
            }
        }

        const eventId = this._emitEvent(ctx, 'SKILL_DECISION_LINKED', {
            decisionId,
            anchorTxId,
            finalState,
            assetId: assetId || null,
        });

        return JSON.stringify({
            success: true,
            decision_id: decisionId,
            state: STATE_LINKED,
            linked_anchor_tx_id: anchorTxId,
            final_state: finalState,
            linked_at: linkedAt,
            event_id: eventId,
        });
    }

    /**
     * Update an audit record to a v1.0.2 terminal outcome.
     *
     * Allowed:
     *   STATE_RECORDED → STATE_RECORDED_AND_LINKED     (success path)
     *   STATE_RECORDED → STATE_RECORDED_FAILED_ATTEMPT (chaincode rejected)
     *
     * Identity-bound via the existing _validateMSP check (same as RecordSkillDecision
     * and LinkAnchorTx). Idempotent on same outcome + same payload.
     *
     * Called by the gateway in /skills/execute, AFTER the anchor-registry invoke
     * resolves (either to success or to a chaincode-side rejection).
     *
     * NOTE: LinkAnchorTx still works and is still called for the success path
     * in v1.0.2 (for backward compatibility). UpdateDecisionOutcome is the new
     * canonical entry point for the failure path. Gateways may also call it on
     * the success path; in that case it produces the same effect as LinkAnchorTx
     * but with state=RECORDED_AND_LINKED instead of LINKED.
     *
     * @param {Context} ctx
     * @param {string} decisionId
     * @param {string} outcome             'RECORDED_AND_LINKED' | 'RECORDED_FAILED_ATTEMPT'
     * @param {string} [anchorTxId]        required when outcome=RECORDED_AND_LINKED
     * @param {string} [errorReason]       required when outcome=RECORDED_FAILED_ATTEMPT
     * @returns {string} JSON-stringified updated record
     */
    async UpdateDecisionOutcome(ctx, decisionId, outcome, anchorTxId, errorReason) {
        const callerMsp = ctx.clientIdentity.getMSPID();
        this._validateMSP(callerMsp);
 
        // Validate outcome
        const validOutcomes = [STATE_RECORDED_AND_LINKED, STATE_RECORDED_FAILED_ATTEMPT];
        if (!validOutcomes.includes(outcome)) {
            throw new Error(
                `Invalid outcome '${outcome}'. Must be one of: ${validOutcomes.join(', ')}`
            );
        }
 
        // Outcome-specific arg requirements
        if (outcome === STATE_RECORDED_AND_LINKED) {
            if (!anchorTxId || typeof anchorTxId !== 'string' || anchorTxId.length === 0) {
                throw new Error('anchorTxId is required when outcome is RECORDED_AND_LINKED');
            }
        } else { // RECORDED_FAILED_ATTEMPT
            if (!errorReason || typeof errorReason !== 'string' || errorReason.length === 0) {
                throw new Error('errorReason is required when outcome is RECORDED_FAILED_ATTEMPT');
            }
        }
 
        // Fetch the record
        const key = `${PREFIX_DECISION}${decisionId}`;
        const raw = await ctx.stub.getState(key);
        if (!raw || raw.length === 0) {
            throw new Error(`Decision ${decisionId} not found`);
        }
        const record = JSON.parse(raw.toString());
 
        // Idempotency: already terminal?
        if (TERMINAL_STATES.has(record.state)) {
            // Same outcome + same payload → no-op, return existing record.
            // Treat LINKED + RECORDED_AND_LINKED as equivalent for this check.
            const sameOutcome =
                record.state === outcome ||
                (record.state === STATE_LINKED && outcome === STATE_RECORDED_AND_LINKED);
 
            if (sameOutcome) {
                if (outcome === STATE_RECORDED_AND_LINKED) {
                    if (record.linkedAnchorTxId !== anchorTxId) {
                        throw new Error(
                            `Decision ${decisionId} already in ${record.state} with different anchorTxId`
                        );
                    }
                } else { // RECORDED_FAILED_ATTEMPT
                    const sanitized = sanitizeErrorReason(errorReason);
                    if (record.errorReason !== sanitized) {
                        throw new Error(
                            `Decision ${decisionId} already in RECORDED_FAILED_ATTEMPT with different reason`
                        );
                    }
                }
                // Idempotent no-op
                return JSON.stringify({
                    success: true,
                    decision_id: decisionId,
                    state: record.state,
                    note: 'already terminal (idempotent)',
                });
            }
 
            // Different terminal outcome → conflict
            throw new Error(
                `Decision ${decisionId} is already in terminal state ${record.state}; ` +
                `cannot transition to ${outcome}`
            );
        }
 
        // Only RECORDED is a valid source state for v1.0.2 transitions
        if (record.state !== STATE_RECORDED) {
            throw new Error(
                `Decision ${decisionId} is in state ${record.state}; ` +
                `UpdateDecisionOutcome requires state ${STATE_RECORDED}`
            );
        }
 
        // Apply the transition
        const terminalAt = txTimeISO(ctx);
        record.state = outcome;
        record.terminalAt = terminalAt;
        record.terminalBy = callerMsp;
 
        if (outcome === STATE_RECORDED_AND_LINKED) {
            record.linkedAnchorTxId = anchorTxId;
            record.errorReason = null;
        } else { // RECORDED_FAILED_ATTEMPT
            record.errorReason = sanitizeErrorReason(errorReason);
            record.linkedAnchorTxId = null;
        }
 
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));
 
        const eventId = this._emitEvent(ctx, 'SKILL_DECISION_OUTCOME_UPDATED', {
            decisionId,
            outcome,
            terminalAt,
            terminalBy: callerMsp,
        });
 
        return JSON.stringify({
            success: true,
            decision_id: decisionId,
            state: outcome,
            terminal_at: terminalAt,
            terminal_by: callerMsp,
            event_id: eventId,
        });
    }

    // ==========================================================================
    // READS
    // ==========================================================================

    /**
     * Return a single audit record.
     */
    async QuerySkillDecision(ctx, decisionId) {
        if (!decisionId) throw new Error('decisionId required');
        const raw = await ctx.stub.getState(`${PREFIX_DECISION}${decisionId}`);
        if (!raw || raw.length === 0) {
            throw new Error(`Decision ${decisionId} not found`);
        }
        return raw.toString();
    }

    /**
     * Return all decisionIds for a given asset (set by LinkAnchorTx).
     */
    async ListDecisionsByAnchor(ctx, assetId) {
        if (!assetId) throw new Error('assetId required');
        const raw = await ctx.stub.getState(`${PREFIX_ANCHOR_INDEX}${assetId}`);
        if (!raw || raw.length === 0) {
            return JSON.stringify({ assetId, decisionIds: [] });
        }
        return JSON.stringify({ assetId, decisionIds: JSON.parse(raw.toString()) });
    }

    /**
     * Reconstruct the full causal chain for a decision.
     * Returns the audit record plus every SKILL_EVENT row that mentions
     * its decisionId. This is the on-chain demonstration of property P2.
     */
    async ReplayDecision(ctx, decisionId) {
        if (!decisionId) throw new Error('decisionId required');
        const decisionRaw = await ctx.stub.getState(`${PREFIX_DECISION}${decisionId}`);
        if (!decisionRaw || decisionRaw.length === 0) {
            throw new Error(`Decision ${decisionId} not found`);
        }
        const decision = JSON.parse(decisionRaw.toString());

        // Walk events with matching decisionId.
        const events = [];
        const iterator = await ctx.stub.getStateByRange(
            `${PREFIX_EVENT}`,
            `${PREFIX_EVENT}~`
        );
        try {
            let result = await iterator.next();
            while (!result.done) {
                if (result.value && result.value.value && result.value.value.length > 0) {
                    try {
                        const evt = JSON.parse(result.value.value.toString());
                        if (evt && evt.decisionId === decisionId) {
                            events.push(evt);
                        }
                    } catch (_) { /* skip non-JSON */ }
                }
                result = await iterator.next();
            }
        } finally {
            await iterator.close();
        }

        // Sort events by timestamp so the chain is chronologically ordered.
        events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

        return JSON.stringify({
            decisionId,
            decision,
            events,
            replayable: this._isReplayable(decision),
        });
    }

    /**
     * Return total decision count, by state and decisionType.
     * Useful for paper-side aggregate stats; cheap to compute on a small ledger
     * but DO NOT call this on huge ledgers — use ListDecisionsByAnchor for scope.
     */
    async GetAuditStats(ctx) {
        const iterator = await ctx.stub.getStateByRange(
            `${PREFIX_DECISION}`,
            `${PREFIX_DECISION}~`
        );
        const stats = {
            total: 0,
            byState: {},
            byDecisionType: {},
            bySelectedFunction: {},
            byProvider: {},
        };
        try {
            let r = await iterator.next();
            while (!r.done) {
                if (r.value && r.value.value && r.value.value.length > 0) {
                    try {
                        const d = JSON.parse(r.value.value.toString());
                        stats.total++;
                        stats.byState[d.state] = (stats.byState[d.state] || 0) + 1;
                        stats.byDecisionType[d.decisionType] = (stats.byDecisionType[d.decisionType] || 0) + 1;
                        if (d.selectedFunction) {
                            stats.bySelectedFunction[d.selectedFunction] =
                                (stats.bySelectedFunction[d.selectedFunction] || 0) + 1;
                        }
                        if (d.llmProvider) {
                            stats.byProvider[d.llmProvider] = (stats.byProvider[d.llmProvider] || 0) + 1;
                        }
                    } catch (_) { /* skip */ }
                }
                r = await iterator.next();
            }
        } finally {
            await iterator.close();
        }
        return JSON.stringify(stats);
    }

    // ==========================================================================
    // HELPERS
    // ==========================================================================

    _validateMSP(mspId) {
        if (!VALID_MSPS.includes(mspId)) {
            throw new Error(`Invalid MSP: ${mspId}. Must be one of: ${VALID_MSPS.join(', ')}`);
        }
    }

    _validateEnvelope(env) {
        if (!env || typeof env !== 'object') {
            throw new Error('envelope must be a JSON object');
        }
        for (const f of REQUIRED_ENVELOPE_FIELDS) {
            if (!(f in env) || env[f] === null || env[f] === '' || env[f] === undefined) {
                throw new Error(`envelope missing required field: ${f}`);
            }
        }
        if (!ALLOWED_DECISION_TYPES.includes(env.decisionType)) {
            throw new Error(
                `decisionType must be one of ${ALLOWED_DECISION_TYPES.join(', ')}, got ${env.decisionType}`
            );
        }
        if (env.riskLevel && !ALLOWED_RISK_LEVELS.includes(env.riskLevel)) {
            throw new Error(
                `riskLevel must be one of ${ALLOWED_RISK_LEVELS.join(', ')}, got ${env.riskLevel}`
            );
        }
        if (!VALID_MSPS.includes(env.submittingOrg)) {
            throw new Error(
                `submittingOrg must be one of ${VALID_MSPS.join(', ')}, got ${env.submittingOrg}`
            );
        }
        // Required hash fields must match the sha256:<64hex> shape.
        for (const f of ['skillManifestHash', 'intentHash', 'contextHash', 'argumentHash']) {
            if (!HASH_RE.test(env[f])) {
                throw new Error(`${f} must match sha256:<64-hex>, got ${env[f]}`);
            }
        }
        // Refuse anything that looks like a credential leak.
        const stringy = JSON.stringify(env);
        if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(stringy)) {
            throw new Error('envelope contains a private key; refusing to record');
        }
        if (/sk-[A-Za-z0-9]{20,}/.test(stringy)) {
            throw new Error('envelope contains what looks like an API key; refusing to record');
        }
    }

    _isReplayable(decision) {
        // A decision is replayable if all the inputs needed to redo the validation
        // step are present. The actual replay (re-running the validator against the
        // original skill version) happens off-chain — this just affirms the inputs
        // are intact.
        return (
            HASH_RE.test(decision.skillManifestHash) &&
            HASH_RE.test(decision.intentHash) &&
            HASH_RE.test(decision.contextHash) &&
            HASH_RE.test(decision.argumentHash) &&
            !!decision.skillVersion &&
            !!decision.decisionType
        );
    }

    _hashPayload(payload) {
        return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }

    _generateEventId(ctx) {
        const txId = ctx.stub.getTxID();
        if (!ctx._auditEventSuffix) {
            ctx._auditEventSuffix = 0;
        }
        ctx._auditEventSuffix++;
        return `${txId}:${ctx._auditEventSuffix}`;
    }

    _emitEvent(ctx, eventType, data) {
        const eventId = this._generateEventId(ctx);
        const timestamp = txTimeISO(ctx);
        const event = {
            eventId,
            type: eventType,
            timestamp,
            ...data,
        };
        ctx.stub.putState(
            `${PREFIX_EVENT}${eventId}`,
            Buffer.from(JSON.stringify(event))
        );
        ctx.stub.setEvent(eventType, Buffer.from(JSON.stringify(event)));
        return eventId;
    }
}

module.exports = SkillAuditRegistryContract;
