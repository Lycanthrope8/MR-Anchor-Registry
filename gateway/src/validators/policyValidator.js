/**
 * ==============================================================================
 * policyValidator.js
 *
 * Gateway-side re-check of a Decision envelope before any chaincode call.
 *
 * The runtime already validates against SKILL.md and the schemas, but the
 * gateway MUST re-validate independently. The runtime's word is never enough —
 * a compromised runtime, a model that bypassed its instructions, or a buggy
 * runtime version must all fail closed here.
 *
 * Specifically validated:
 *
 *   1. ENVELOPE STRUCTURE: required fields present, hashes match sha256:<64hex>
 *
 *   2. SKILL ALLOWLIST: skillManifestHash must be in the gateway allowlist.
 *      A runtime running an unapproved skill version is rejected even if its
 *      envelope is otherwise well-formed.
 *
 *   3. IDENTITY BINDING: envelope.orgMsp must equal the gateway's fixed MSP.
 *      User text can't override identity; runtime can't lie about identity.
 *
 *   4. DECISION TYPE: only INVOKE proceeds. REJECT and CLARIFY are recorded
 *      but never invoked.
 *
 *   5. FUNCTION ALLOWLIST: selectedFunction must be a known anchor-registry
 *      function name (the v0.1.2 spelling — EndorseClaim, not EndorseAnchor).
 *
 *   6. RISK CONSISTENCY: declared riskLevel must match the function's tier.
 *      A function in WRITE_GOVERNED that comes back tagged READ_ONLY is a bug.
 *
 *   7. ARGUMENT SCHEMA: arguments object matches the function's required keys
 *      and pattern constraints (assetId pattern, hash patterns, reason length).
 *
 *   8. FRESHNESS: envelope.timestamp must be within FRESHNESS_WINDOW_MS of now.
 *      An envelope replayed hours later is rejected even if the user is online.
 *
 * On any failure, the gateway records a REJECT audit record (so the attempt
 * is on-chain) and returns 422 to the client. Phase 4 records rejections too:
 * a bypass attempt MUST leave a trace.
 *
 * This validator is intentionally NOT shared code with the runtime — they
 * implement the same logic independently. That's the "dual-layer" property
 * the proposal §V relies on.
 * ==============================================================================
 */

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ASSETID_RE = /^[A-Za-z0-9_\-:]+$/;
const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes

/**
 * Authoritative spec of the seven anchor-registry functions (v0.1.2 names).
 * Mirrors MR-Skill-Assets v0.1.2 chaincode_interface.json but maintained
 * independently here so the gateway doesn't trust the runtime.
 */
const FUNCTION_SPEC = {
    ProposeAnchor:   { risk: 'WRITE_GOVERNED', requiredArgs: ['assetId', 'poseHash', 'metadataHash'], reads: false, requiresConfirmation: true },
    EndorseClaim:    { risk: 'WRITE_GOVERNED', requiredArgs: ['assetId'],                              reads: false, requiresConfirmation: true },
    RevokeAnchor:    { risk: 'WRITE_GOVERNED', requiredArgs: ['assetId', 'reason'],                    reads: false, requiresConfirmation: true },
    EndorseRevoke:   { risk: 'WRITE_GOVERNED', requiredArgs: ['assetId'],                              reads: false, requiresConfirmation: true },
    GetClaim:        { risk: 'READ_ONLY',      requiredArgs: ['assetId'],                              reads: true,  requiresConfirmation: false },
    GetClaimHistory: { risk: 'READ_ONLY',      requiredArgs: ['assetId'],                              reads: true,  requiresConfirmation: false },
    GetSnapshot:     { risk: 'READ_ONLY',      requiredArgs: [],                                       reads: true,  requiresConfirmation: false },
};

const ALLOWED_DECISION_TYPES = ['INVOKE', 'REJECT', 'CLARIFY'];

/**
 * @param {object} envelope     - the runtime's interpret result (envelope.decision + envelope.audit)
 * @param {object} ctx
 * @param {string} ctx.gatewayMsp   - this gateway's fixed MSP (Org1MSP or Org2MSP)
 * @param {object} ctx.allowlist    - skillManifestAllowlist module
 * @returns {{ok: boolean, errors: string[], decision?: object, audit?: object, fn?: object}}
 */
function validateEnvelope(envelope, ctx) {
    const errors = [];

    if (!envelope || typeof envelope !== 'object') {
        return { ok: false, errors: ['envelope is not an object'] };
    }

    // The runtime returns { ok, errors, decision, audit }. We need ok=true
    // AND a sound decision/audit; either failure path is a reject.
    if (envelope.ok !== true) {
        const runtimeErrors = Array.isArray(envelope.errors) ? envelope.errors : ['runtime reported failure'];
        return { ok: false, errors: runtimeErrors.map((e) => `runtime: ${e}`) };
    }

    const decision = envelope.decision;
    const audit = envelope.audit;
    if (!decision || typeof decision !== 'object') errors.push('envelope.decision missing');
    if (!audit || typeof audit !== 'object')       errors.push('envelope.audit missing');
    if (errors.length) return { ok: false, errors };

    // 1. Audit-side required fields
    for (const f of ['skillId', 'skillVersion', 'skillManifestHash',
                     'llmProvider', 'llmModel', 'intentHash', 'contextHash', 'argumentHash',
                     'orgMsp', 'timestamp']) {
        if (audit[f] == null || audit[f] === '') errors.push(`audit.${f} missing`);
    }
    for (const f of ['skillManifestHash', 'intentHash', 'contextHash', 'argumentHash']) {
        if (audit[f] && !HASH_RE.test(audit[f])) errors.push(`audit.${f} not sha256:<64hex>`);
    }

    // 2. Skill allowlist (gateway-side enforcement)
    const allowlistResult = ctx.allowlist.check(audit.skillManifestHash);
    if (!allowlistResult.ok) {
        errors.push(`skill-allowlist: ${allowlistResult.reason}`);
    }

    // 3. Identity binding
    if (audit.orgMsp !== ctx.gatewayMsp) {
        errors.push(`identity: audit.orgMsp=${audit.orgMsp} but gateway is ${ctx.gatewayMsp}`);
    }

    // 4. Decision type
    if (!ALLOWED_DECISION_TYPES.includes(decision.decisionType)) {
        errors.push(`decisionType ${decision.decisionType} not allowed`);
    }

    // For non-INVOKE decisions, we stop after structural validation.
    // The caller (skillsRoutes) will still record a REJECT audit so the
    // attempt is on-chain, but we don't need function/arg checks.
    if (decision.decisionType !== 'INVOKE') {
        if (decision.decisionType === 'CLARIFY' && !decision.clarificationQuestion) {
            errors.push('CLARIFY missing clarificationQuestion');
        }
        if (decision.shouldInvoke !== false) {
            errors.push(`${decision.decisionType} must have shouldInvoke=false`);
        }
        return { ok: errors.length === 0, errors, decision, audit };
    }

    // 5. Function allowlist (INVOKE path)
    const fn = FUNCTION_SPEC[decision.selectedFunction];
    if (!fn) {
        errors.push(`selectedFunction '${decision.selectedFunction}' is not an approved anchor-registry function`);
        return { ok: false, errors, decision, audit };
    }

    // 6. Risk consistency
    if (decision.riskLevel !== fn.risk) {
        errors.push(`riskLevel ${decision.riskLevel} does not match function tier ${fn.risk}`);
    }
    if (typeof decision.requiresConfirmation === 'boolean' &&
        decision.requiresConfirmation !== fn.requiresConfirmation) {
        errors.push(`requiresConfirmation ${decision.requiresConfirmation} does not match function spec ${fn.requiresConfirmation}`);
    }
    if (decision.shouldInvoke !== true) {
        errors.push('INVOKE must have shouldInvoke=true');
    }

    // 7. Argument schema
    const args = decision.arguments || {};
    if (typeof args !== 'object' || Array.isArray(args)) {
        errors.push('arguments must be an object');
    } else {
        for (const k of fn.requiredArgs) {
            if (!(k in args) || args[k] === null || args[k] === '') {
                errors.push(`arguments.${k} missing or empty`);
            }
        }
        // Argument-specific pattern checks (subset of v0.1.2 schemas — gateway is strict).
        if ('assetId' in args && typeof args.assetId === 'string') {
            if (!ASSETID_RE.test(args.assetId)) {
                errors.push(`arguments.assetId fails pattern ${ASSETID_RE}`);
            }
            if (args.assetId.length > 128) errors.push('arguments.assetId exceeds maxLength 128');
        }
        if ('poseHash' in args && typeof args.poseHash === 'string' && !HASH_RE.test(args.poseHash)) {
            errors.push('arguments.poseHash not sha256:<64hex>');
        }
        if ('metadataHash' in args && typeof args.metadataHash === 'string' && !HASH_RE.test(args.metadataHash)) {
            errors.push('arguments.metadataHash not sha256:<64hex>');
        }
        if ('reason' in args && typeof args.reason === 'string') {
            if (args.reason.length < 4)  errors.push('arguments.reason shorter than minLength 4');
            if (args.reason.length > 280) errors.push('arguments.reason exceeds maxLength 280');
        }
    }

    // 8. Freshness
    const tsMs = Date.parse(audit.timestamp);
    if (Number.isNaN(tsMs)) {
        errors.push(`audit.timestamp not parseable: ${audit.timestamp}`);
    } else {
        const ageMs = Date.now() - tsMs;
        if (ageMs > FRESHNESS_WINDOW_MS) {
            errors.push(`envelope is stale (age=${Math.round(ageMs / 1000)}s > ${FRESHNESS_WINDOW_MS / 1000}s)`);
        }
        if (ageMs < -60000) {
            // Allow 60s of clock skew but flag larger future drift.
            errors.push(`envelope timestamp is in the future by ${Math.round(-ageMs / 1000)}s`);
        }
    }

    return { ok: errors.length === 0, errors, decision, audit, fn };
}

module.exports = { validateEnvelope, FUNCTION_SPEC, FRESHNESS_WINDOW_MS, HASH_RE, ASSETID_RE };
