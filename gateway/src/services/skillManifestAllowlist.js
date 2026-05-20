/**
 * ==============================================================================
 * skillManifestAllowlist.js
 *
 * Trusted skillManifestHash values that the gateway will execute decisions
 * against. Hashes are matched byte-exact against the runtime's reported
 * `skillManifestHash` in each interpret envelope.
 *
 * Phase 4 scope: v0.1.2 ONLY (the journal-correct version with anchor-registry
 * function names + assetId args). Adding v0.1.1 here would let GPT-5.1 return
 * `EndorseAnchor(claimId)` which the function-name mapper cannot route.
 *
 * To add a new skill version:
 *   1. tag MR-Skill-Assets <new version>
 *   2. compute hash: node scripts/hash_intent.js --manifest spatial-governance-skill/manifest.json
 *   3. append the hash + note to ALLOWLIST below
 *   4. commit + redeploy the gateway
 *
 * This list is intentionally code, not config — adding a hash should be a
 * code review event, not an environment variable change.
 * ==============================================================================
 */

const ALLOWLIST = Object.freeze({
    'sha256:57bd7e555de7394bbef06592d2293238224459d0dc0f08a9ca4e3b5ee8c0c3a1': {
        skillId: 'spatial-governance-skill',
        skillVersion: '0.1.2',
        addedOn: '2026-05-19',
        note: 'Function names aligned with real anchor-registry chaincode (EndorseClaim/RevokeAnchor/EndorseRevoke/GetClaim/GetClaimHistory). All args use assetId.',
        tag: 'MR-Skill-Assets@v0.1.2',
    },
});

/**
 * @param {string} manifestHash - the runtime's reported skillManifestHash
 * @returns {{ok: boolean, entry?: object, reason?: string}}
 */
function check(manifestHash) {
    if (!manifestHash || typeof manifestHash !== 'string') {
        return { ok: false, reason: 'skillManifestHash missing or not a string' };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(manifestHash)) {
        return { ok: false, reason: 'skillManifestHash format invalid (expected sha256:<64hex>)' };
    }
    const entry = ALLOWLIST[manifestHash];
    if (!entry) {
        return {
            ok: false,
            reason: `skillManifestHash not in allowlist. Got ${manifestHash}. ` +
                    `Allowed: ${Object.keys(ALLOWLIST).join(', ') || '(none)'}`,
        };
    }
    return { ok: true, entry };
}

function list() {
    return Object.entries(ALLOWLIST).map(([hash, entry]) => ({ hash, ...entry }));
}

module.exports = { check, list, ALLOWLIST };
