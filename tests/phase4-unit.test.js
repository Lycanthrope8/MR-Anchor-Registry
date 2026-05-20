#!/usr/bin/env node
/**
 * Offline test suite for Phase 4 gateway services.
 *
 * Covers everything that doesn't need a live Fabric peer or a real runtime:
 *   - skillManifestAllowlist  (allow / reject / format checks)
 *   - decisionStore           (put / peek / consume / TTL / WAL replay)
 *   - fabricFunctionMap       (resolution, args mapping, state capture)
 *   - policyValidator         (all 8 validation gates)
 *
 * Run from gateway/ directory:  node ../../tests/phase4-unit.test.js
 * Or, if dropped into gateway/tests/:    node tests/phase4-unit.test.js
 *
 * Exit codes:
 *   0  all pass
 *   1  one or more failed
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Allow this test to live in different locations; let the caller specify the
// gateway src root via env if needed.
const SRC = process.env.GATEWAY_SRC || path.resolve(__dirname, '..', 'gateway', 'src');

const allowlist = require(path.join(SRC, 'services', 'skillManifestAllowlist'));
const DecisionStore = require(path.join(SRC, 'services', 'decisionStore'));
const fnMap = require(path.join(SRC, 'services', 'fabricFunctionMap'));
const { validateEnvelope } = require(path.join(SRC, 'validators', 'policyValidator'));

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
    try { fn(); pass++; console.log(`  [PASS] ${name}`); }
    catch (e) { fail++; failures.push({ name, msg: e.message }); console.log(`  [FAIL] ${name}: ${e.message}`); }
}
function eq(a, b, msg) {
    const aj = JSON.stringify(a), bj = JSON.stringify(b);
    if (aj !== bj) throw new Error(`${msg || 'not equal'}: ${aj} vs ${bj}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function bad(v, msg) { if (v) throw new Error(msg || 'expected falsy'); }
function throws(fn, re) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`); }
    if (!threw) throw new Error('expected to throw');
}

const V012_HASH = 'sha256:57bd7e555de7394bbef06592d2293238224459d0dc0f08a9ca4e3b5ee8c0c3a1';
const FAKE_HASH = 'sha256:' + 'a'.repeat(64);

// =====================================================================
// skillManifestAllowlist
// =====================================================================
console.log('\n== skillManifestAllowlist ==');
t('v0.1.2 hash is in allowlist', () => {
    const r = allowlist.check(V012_HASH);
    ok(r.ok, JSON.stringify(r));
    eq(r.entry.skillVersion, '0.1.2');
});
t('unknown hash rejected', () => {
    const r = allowlist.check(FAKE_HASH);
    bad(r.ok);
    ok(/not in allowlist/.test(r.reason));
});
t('malformed hash rejected', () => {
    const r = allowlist.check('not-a-hash');
    bad(r.ok);
});
t('null hash rejected', () => {
    const r = allowlist.check(null);
    bad(r.ok);
});
t('v0.1.1 hash REJECTED (Phase 4 = v0.1.2 only)', () => {
    const v011 = 'sha256:d13c991c46ab4637fa4335699b43c165ab7b2648c00cf4bc7e723d1e5ce1f79e';
    const r = allowlist.check(v011);
    bad(r.ok, 'v0.1.1 should be rejected per Phase 4 decision');
});

// =====================================================================
// decisionStore
// =====================================================================
console.log('\n== decisionStore ==');
function makeStore() {
    const wal = path.join(os.tmpdir(), `phase4-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wal`);
    return { wal, store: new DecisionStore({ walPath: wal, ttlMs: 60000 }) };
}

t('newDecisionId is unique and well-formed', () => {
    const a = DecisionStore.newDecisionId();
    const b = DecisionStore.newDecisionId();
    ok(/^sd-[0-9a-f]{24}$/.test(a), `bad format: ${a}`);
    ok(a !== b);
});

t('put / peek / consume round-trip', () => {
    const { store, wal } = makeStore();
    try {
        store.put('sd-test-1', { hello: 'world' });
        eq(store.peek('sd-test-1'), { hello: 'world' });
        eq(store.consume('sd-test-1'), { hello: 'world' });
        eq(store.consume('sd-test-1'), null);  // second consume → null
    } finally { store.close(); fs.unlinkSync(wal); }
});

t('peek does not consume', () => {
    const { store, wal } = makeStore();
    try {
        store.put('sd-test-2', { x: 1 });
        store.peek('sd-test-2');
        store.peek('sd-test-2');
        eq(store.consume('sd-test-2'), { x: 1 });
    } finally { store.close(); fs.unlinkSync(wal); }
});

t('expired entries return null via peek', () => {
    const wal = path.join(os.tmpdir(), `phase4-ttl-${Date.now()}.wal`);
    const store = new DecisionStore({ walPath: wal, ttlMs: 10 });
    try {
        store.put('sd-ttl', { v: 1 });
        const wait = Date.now() + 50;
        while (Date.now() < wait) {}  // busy-wait 50ms
        eq(store.peek('sd-ttl'), null);
    } finally { store.close(); fs.unlinkSync(wal); }
});

t('WAL replay restores entries on restart', () => {
    const wal = path.join(os.tmpdir(), `phase4-wal-${Date.now()}.wal`);
    let store = new DecisionStore({ walPath: wal, ttlMs: 60000 });
    store.put('sd-persist', { y: 2 });
    store.close();
    store = new DecisionStore({ walPath: wal, ttlMs: 60000 });
    try {
        eq(store.peek('sd-persist'), { y: 2 });
    } finally { store.close(); fs.unlinkSync(wal); }
});

t('WAL replay drops expired entries', () => {
    const wal = path.join(os.tmpdir(), `phase4-walexp-${Date.now()}.wal`);
    let store = new DecisionStore({ walPath: wal, ttlMs: 10 });
    store.put('sd-stale', { z: 3 });
    store.close();
    const wait = Date.now() + 50;
    while (Date.now() < wait) {}
    store = new DecisionStore({ walPath: wal, ttlMs: 10 });
    try {
        eq(store.peek('sd-stale'), null);
    } finally { store.close(); fs.unlinkSync(wal); }
});

// =====================================================================
// fabricFunctionMap
// =====================================================================
console.log('\n== fabricFunctionMap ==');
t('resolves all seven anchor functions', () => {
    for (const name of ['ProposeAnchor', 'EndorseClaim', 'RevokeAnchor', 'EndorseRevoke', 'GetClaim', 'GetClaimHistory', 'GetSnapshot']) {
        const m = fnMap.resolve(name);
        ok(m, `missing: ${name}`);
        ok(typeof m.fabricMethod === 'string');
        ok(typeof m.mapArgs === 'function');
        ok(typeof m.captureState === 'function');
    }
});
t('rejects unknown function name', () => {
    eq(fnMap.resolve('ForceActivate'), null);
});
t('rejects v0.1.1-style names (EndorseAnchor)', () => {
    eq(fnMap.resolve('EndorseAnchor'), null);
});
t('EndorseClaim maps to (assetId,)', () => {
    const m = fnMap.resolve('EndorseClaim');
    eq(m.mapArgs({ assetId: 'TAG_001' }), ['TAG_001']);
});
t('RevokeAnchor maps to (assetId, reason)', () => {
    const m = fnMap.resolve('RevokeAnchor');
    eq(m.mapArgs({ assetId: 'TAG_001', reason: 'misplaced' }), ['TAG_001', 'misplaced']);
});
t('GetSnapshot takes no args', () => {
    const m = fnMap.resolve('GetSnapshot');
    eq(m.mapArgs({}), []);
});
t('captureState reads chaincode response state field', () => {
    const m = fnMap.resolve('EndorseClaim');
    eq(m.captureState({ state: 'ACTIVE' }), 'ACTIVE');
    eq(m.captureState({}), 'ENDORSED');
});

// =====================================================================
// policyValidator
// =====================================================================
console.log('\n== policyValidator ==');
function freshRuntimeEnvelope(overrides = {}) {
    const ts = new Date().toISOString();
    return {
        ok: true,
        errors: [],
        decision: {
            decisionType: 'INVOKE',
            intent: 'register an anchor',
            selectedChaincode: 'anchor-registry',
            selectedFunction: 'ProposeAnchor',
            riskLevel: 'WRITE_GOVERNED',
            requiresConfirmation: true,
            arguments: { assetId: 'TAG_017', poseHash: FAKE_HASH, metadataHash: FAKE_HASH },
            policyReasoning: 'ok',
            shouldInvoke: true,
            ...(overrides.decision || {}),
        },
        audit: {
            skillId: 'spatial-governance-skill',
            skillVersion: '0.1.2',
            skillManifestHash: V012_HASH,
            llmProvider: 'parley',
            llmModel: 'gpt-5.1',
            llmCallId: 'mock-1',
            intentHash:   FAKE_HASH,
            contextHash:  FAKE_HASH,
            argumentHash: FAKE_HASH,
            orgMsp: 'Org1MSP',
            timestamp: ts,
            ...(overrides.audit || {}),
        },
    };
}
const ctx = { gatewayMsp: 'Org1MSP', allowlist };

t('valid INVOKE ProposeAnchor', () => {
    const r = validateEnvelope(freshRuntimeEnvelope(), ctx);
    ok(r.ok, r.errors && r.errors.join('; '));
});

t('rejects runtime ok=false', () => {
    const env = freshRuntimeEnvelope();
    env.ok = false;
    env.errors = ['runtime broke'];
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
});

t('rejects bad skillManifestHash (allowlist)', () => {
    const env = freshRuntimeEnvelope({ audit: { skillManifestHash: FAKE_HASH } });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('allowlist')));
});

t('rejects orgMsp mismatch (identity binding)', () => {
    const env = freshRuntimeEnvelope({ audit: { orgMsp: 'Org2MSP' } });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('identity')));
});

t('rejects unknown selectedFunction', () => {
    const env = freshRuntimeEnvelope({ decision: { selectedFunction: 'ForceActivate' } });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('not an approved')));
});

t('rejects old v0.1.1 function name EndorseAnchor', () => {
    const env = freshRuntimeEnvelope({
        decision: { selectedFunction: 'EndorseAnchor', arguments: { claimId: 'CLAIM_1' } }
    });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
});

t('rejects riskLevel mismatch with function tier', () => {
    const env = freshRuntimeEnvelope({
        decision: { selectedFunction: 'GetSnapshot', riskLevel: 'WRITE_GOVERNED', arguments: {}, requiresConfirmation: false }
    });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
});

t('rejects bad assetId pattern', () => {
    const env = freshRuntimeEnvelope({
        decision: { arguments: { assetId: "TAG_017'; DROP TABLE--", poseHash: FAKE_HASH, metadataHash: FAKE_HASH } }
    });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('pattern')));
});

t('rejects reason that is too short', () => {
    const env = freshRuntimeEnvelope({
        decision: {
            selectedFunction: 'RevokeAnchor',
            arguments: { assetId: 'TAG_001', reason: 'x' },
            riskLevel: 'WRITE_GOVERNED',
            requiresConfirmation: true,
        }
    });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('reason')));
});

t('rejects stale envelope (> 10 min old)', () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const env = freshRuntimeEnvelope({ audit: { timestamp: stale } });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
    ok(r.errors.some((e) => e.includes('stale')));
});

t('accepts REJECT decision', () => {
    const env = freshRuntimeEnvelope({
        decision: {
            decisionType: 'REJECT',
            selectedFunction: '',
            riskLevel: 'FORBIDDEN',
            requiresConfirmation: false,
            arguments: {},
            shouldInvoke: false,
        }
    });
    const r = validateEnvelope(env, ctx);
    ok(r.ok, r.errors && r.errors.join('; '));
});

t('accepts CLARIFY decision with question', () => {
    const env = freshRuntimeEnvelope({
        decision: {
            decisionType: 'CLARIFY',
            selectedFunction: '',
            riskLevel: 'WRITE_GOVERNED',
            requiresConfirmation: false,
            arguments: {},
            shouldInvoke: false,
            clarificationQuestion: 'Which anchor?',
        }
    });
    const r = validateEnvelope(env, ctx);
    ok(r.ok, r.errors && r.errors.join('; '));
});

t('rejects CLARIFY without question', () => {
    const env = freshRuntimeEnvelope({
        decision: {
            decisionType: 'CLARIFY',
            selectedFunction: '',
            riskLevel: 'WRITE_GOVERNED',
            requiresConfirmation: false,
            arguments: {},
            shouldInvoke: false,
        }
    });
    const r = validateEnvelope(env, ctx);
    bad(r.ok);
});

// =====================================================================
// Final
// =====================================================================
console.log('');
console.log('==================================================================');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('==================================================================');
if (fail) {
    console.log('\nFailure details:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
    process.exit(1);
}
process.exit(0);
