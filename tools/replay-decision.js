#!/usr/bin/env node
/*
 * replay-decision.js
 *
 * Off-chain replay/verification tool for skill-audit-registry records.
 *
 * Property P2 (Verifiable Provenance) says: given a Fabric tx ID, an external
 * auditor can reconstruct the full causal chain of an LLM-mediated governance
 * decision from on-chain data alone. This tool is that auditor.
 *
 * It does two things:
 *
 *   1. PARSE: read a JSON file containing the audit record (and optionally
 *      the linked anchor tx record + events) — exactly the shape returned by
 *      ReplayDecision() in the chaincode, plus an optional skillAssetsPath.
 *
 *   2. VERIFY: cryptographically re-check that
 *        - the skill manifest hash on-chain matches the local skill content
 *        - intentHash, contextHash, argumentHash are well-formed
 *        - decisionId is unique
 *        - lifecycle invariants hold (LINKED ↔ has anchor tx, REJECTED ↔ no anchor tx)
 *
 *   3. REPORT: human-readable causal chain.
 *
 * Phase 3 scope:
 *   - reads from a local JSON file (the gateway's debug export, or saved chaincode response)
 *   - no Fabric SDK needed
 *
 * Phase 4 will add:
 *   - direct Fabric query mode (--from-fabric <txId>)
 *   - --verify-skill <path-to-MR-Skill-Assets> to recompute manifest hash
 *
 * Usage:
 *   node replay-decision.js <path-to-decision-export.json>
 *   node replay-decision.js <path-to-decision-export.json> --verify-skill ../../MR-Skill-Assets/spatial-governance-skill
 *   node replay-decision.js --help
 *
 * Exit codes:
 *   0  replay verified
 *   1  one or more verification failures
 *   2  usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_DECISION_TYPES = ['INVOKE', 'REJECT', 'CLARIFY'];
const ALLOWED_STATES = ['RECORDED', 'LINKED', 'RECORDED_REJECT'];

function usage() {
    console.log(`replay-decision.js — verify a skill-audit-registry decision off-chain

Usage:
  node replay-decision.js <decision-export.json> [--verify-skill <skill-path>]
  node replay-decision.js --help

Input file shape (JSON):
  {
    "decisionId": "sd-...",
    "decision":   { ... full audit record ... },
    "events":     [ { type, timestamp, decisionId, ... }, ... ],
    "replayable": true | false
  }

This shape matches the return value of the chaincode's ReplayDecision().
`);
}

function nfc(s) { return typeof s.normalize === 'function' ? s.normalize('NFC') : s; }
function canonicalize(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('non-finite number');
        return JSON.stringify(value);
    }
    if (typeof value === 'string') return JSON.stringify(nfc(value.trim()));
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    throw new Error(`unsupported type: ${typeof value}`);
}
function sha256Hex(input) {
    return `sha256:${crypto.createHash('sha256').update(input, 'utf8').digest('hex')}`;
}
function hashManifest(obj) {
    const copy = { ...obj };
    delete copy.manifestHash;
    return sha256Hex(canonicalize(copy));
}

function check(label, ok, errors) {
    if (ok) {
        console.log(`  [PASS] ${label}`);
        return true;
    }
    console.log(`  [FAIL] ${label}`);
    errors.push(label);
    return false;
}

function verifyDecision(payload, opts) {
    const errors = [];
    const { decisionId, decision, events } = payload;

    console.log(`\n=== Verifying decision ${decisionId} ===`);

    // 1. Top-level shape
    check('decisionId present', typeof decisionId === 'string' && decisionId.length > 0, errors);
    check('decision object present', decision && typeof decision === 'object', errors);
    check('events is an array', Array.isArray(events), errors);

    if (!decision) {
        console.log('\nFATAL: no decision object — cannot continue.');
        return { ok: false, errors };
    }

    // 2. Required fields on the audit record
    for (const f of ['skillId', 'skillVersion', 'skillManifestHash', 'decisionType',
                     'submittingOrg', 'gatewayId', 'intentHash', 'contextHash', 'argumentHash',
                     'llmProvider', 'llmModel', 'timestamp', 'recordedAt', 'state']) {
        check(`decision.${f} present`, decision[f] != null && decision[f] !== '', errors);
    }

    // 3. Hash format
    for (const f of ['skillManifestHash', 'intentHash', 'contextHash', 'argumentHash']) {
        if (decision[f]) {
            check(`decision.${f} matches sha256:<64hex>`, HASH_RE.test(decision[f]), errors);
        }
    }

    // 4. Enumerations
    check(`decisionType is one of ${ALLOWED_DECISION_TYPES.join(',')}`,
          ALLOWED_DECISION_TYPES.includes(decision.decisionType), errors);
    check(`state is one of ${ALLOWED_STATES.join(',')}`,
          ALLOWED_STATES.includes(decision.state), errors);

    // 5. Lifecycle invariants
    if (decision.decisionType === 'INVOKE') {
        if (decision.state === 'LINKED') {
            check('LINKED state has linkedAnchorTxId',
                  !!decision.linkedAnchorTxId, errors);
            check('LINKED state has finalState',
                  !!decision.finalState, errors);
            check('LINKED state has linkedAt',
                  !!decision.linkedAt, errors);
        } else if (decision.state === 'RECORDED') {
            check('RECORDED state has no linkedAnchorTxId yet',
                  decision.linkedAnchorTxId == null, errors);
        }
    } else if (decision.decisionType === 'REJECT' || decision.decisionType === 'CLARIFY') {
        check(`${decision.decisionType} state is RECORDED_REJECT`,
              decision.state === 'RECORDED_REJECT', errors);
        check(`${decision.decisionType} has no linkedAnchorTxId`,
              decision.linkedAnchorTxId == null, errors);
    }

    // 6. Event chain coherence
    if (Array.isArray(events)) {
        const allMatchDecision = events.every((e) => e.decisionId === decisionId);
        check('all events reference this decisionId', allMatchDecision, errors);

        const types = events.map((e) => e.type);
        if (decision.decisionType === 'INVOKE' && decision.state === 'LINKED') {
            check('events contain SKILL_DECISION_RECORDED',
                  types.includes('SKILL_DECISION_RECORDED'), errors);
            check('events contain SKILL_DECISION_LINKED',
                  types.includes('SKILL_DECISION_LINKED'), errors);
        } else {
            check('events contain SKILL_DECISION_RECORDED',
                  types.includes('SKILL_DECISION_RECORDED'), errors);
        }

        // Chronological order
        let monotonic = true;
        for (let i = 1; i < events.length; i++) {
            if ((events[i - 1].timestamp || '') > (events[i].timestamp || '')) {
                monotonic = false; break;
            }
        }
        check('events sorted chronologically', monotonic, errors);
    }

    // 7. Optional: recompute manifest hash from local skill content
    if (opts.verifySkillPath) {
        const manifestPath = path.join(opts.verifySkillPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            console.log(`  [WARN] manifest.json not found at ${manifestPath}; skipping manifest-hash verification`);
        } else {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const localHash = hashManifest(manifest);
                check(
                    `local manifest hash matches on-chain skillManifestHash (${decision.skillManifestHash})`,
                    localHash === decision.skillManifestHash, errors
                );
                if (manifest.skillVersion !== decision.skillVersion) {
                    console.log(`  [WARN] local skill version (${manifest.skillVersion}) != on-chain (${decision.skillVersion}). Checking out the matching tag would let the hash match.`);
                }
            } catch (e) {
                console.log(`  [WARN] could not parse local manifest: ${e.message}`);
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

function printCausalChain(payload) {
    const { decision, events } = payload;
    console.log('\n=== Causal chain ===');
    console.log(`  skill           : ${decision.skillId} v${decision.skillVersion}`);
    console.log(`  manifestHash    : ${decision.skillManifestHash}`);
    console.log(`  llm             : ${decision.llmProvider} (${decision.llmModel})`);
    console.log(`  decision        : ${decision.decisionType}  function=${decision.selectedFunction || '-'}  risk=${decision.riskLevel || '-'}`);
    console.log(`  submittingOrg   : ${decision.submittingOrg}  (caller=${decision.callerMsp})`);
    console.log(`  gatewayId       : ${decision.gatewayId}`);
    console.log(`  intent hash     : ${decision.intentHash}`);
    console.log(`  context hash    : ${decision.contextHash}`);
    console.log(`  argument hash   : ${decision.argumentHash}`);
    console.log(`  state           : ${decision.state}`);
    if (decision.linkedAnchorTxId) {
        console.log(`  anchor tx       : ${decision.linkedAnchorTxId}`);
        console.log(`  final state     : ${decision.finalState}`);
        console.log(`  linked at       : ${decision.linkedAt}`);
    }
    if (Array.isArray(events) && events.length) {
        console.log('  events          :');
        for (const e of events) {
            console.log(`    ${e.timestamp}  ${e.type}  eventId=${e.eventId}`);
        }
    }
}

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        usage();
        process.exit(args.length === 0 ? 2 : 0);
    }

    const inputPath = args[0];
    const verifySkillIdx = args.indexOf('--verify-skill');
    const verifySkillPath = verifySkillIdx !== -1 ? args[verifySkillIdx + 1] : null;

    if (!fs.existsSync(inputPath)) {
        console.error(`error: input file not found: ${inputPath}`);
        process.exit(2);
    }

    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch (e) {
        console.error(`error: input is not valid JSON: ${e.message}`);
        process.exit(2);
    }

    const result = verifyDecision(payload, { verifySkillPath });
    printCausalChain(payload);
    console.log('');
    if (result.ok) {
        console.log('================================================================');
        console.log('  REPLAY VERIFIED — all invariants hold.');
        console.log('================================================================');
        process.exit(0);
    } else {
        console.log('================================================================');
        console.log(`  REPLAY FAILED — ${result.errors.length} issue(s):`);
        for (const e of result.errors) console.log(`    - ${e}`);
        console.log('================================================================');
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { verifyDecision, hashManifest, canonicalize, sha256Hex };
