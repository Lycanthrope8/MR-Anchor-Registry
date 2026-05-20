# Phase 4 — Gateway integration for LLM-mediated governance

Wires `MR-Skill-Runtime` (edge) to `anchor-registry` + `skill-audit-registry` (cloud) through the gateway, with human-in-the-loop confirmation.

## What this delivers

Adds 6 new files to `MR-Anchor-Registry/gateway/src/` and modifies 2 existing files via documented patches:

```
MR-Anchor-Registry/
├── gateway/src/
│   ├── routes/
│   │   └── skills.js                       NEW — /skills/* endpoints
│   ├── services/
│   │   ├── skillRuntimeClient.js           NEW — HTTP client to edge runtime
│   │   ├── skillManifestAllowlist.js       NEW — trusted skill-hash list
│   │   ├── decisionStore.js                NEW — pending decisions with WAL
│   │   ├── fabricFunctionMap.js            NEW — skill names → FabricClient methods
│   │   ├── fabricClient.PATCH.md           PATCH — add 5 audit methods
│   │   └── fabricClient.js                 (existing — apply PATCH.md)
│   ├── validators/
│   │   └── policyValidator.js              NEW — independent re-validation
│   ├── server.PATCH.md                     PATCH — mount /skills routes
│   └── server.js                           (existing — apply PATCH.md)
├── tests/
│   └── phase4-unit.test.js                 NEW — 31 offline tests
├── scripts/
│   └── verify-phase4.sh                    NEW — 14-check verifier
└── docs/
    └── phase4_setup_and_verification.md    NEW — setup + verification guide
```

## Quick start

```bash
cd ~/work/MR-Anchor-Registry
tar -xzf MR-Anchor-Registry-Phase4-v0.1.0.tar.gz

# Apply the two PATCH.md inserts (see each file for line-numbered instructions):
$EDITOR gateway/src/services/fabricClient.PATCH.md gateway/src/services/fabricClient.js
$EDITOR gateway/src/server.PATCH.md gateway/src/server.js

# Confirm patches stuck
grep -q AUDIT_CHAINCODE_NAME gateway/src/services/fabricClient.js && echo OK
grep -q "require('./routes/skills')" gateway/src/server.js && echo OK

# Set runtime URL
export SKILL_RUNTIME_URL=http://localhost:5100

# Restart gateways
./down.sh && ./up.sh

# Verify
./scripts/verify-phase4.sh ./MR-Anchor-Registry ./MR-Skill-Runtime
```

See `docs/phase4_setup_and_verification.md` for the full guide.

## Design decisions baked in

- **Human-in-the-loop only** — `/skills/interpret` parks the decision; user must explicitly POST `/skills/execute` to invoke chaincode
- **Runtime on edge box** — gateway is HTTP-only proxy, no LLM credentials on cloud side
- **v0.1.2 hash only** in allowlist — runtime running an old version is rejected
- **Identity bound at gateway** — `audit.orgMsp` always equals the gateway's fixed MSP, never user-controlled
- **Audit-first ordering** — `RecordSkillDecision` is written *before* `anchor-registry` invoke, so attempts to subvert are recorded even when they fail

## Independence from runtime

The gateway's `policyValidator.js` re-implements all the validation logic the runtime does. This is intentional: it's the dual-layer property (§V of the proposal). A compromised or bug-ridden runtime cannot tunnel a malformed decision through the gateway.

Look at `policyValidator.FUNCTION_SPEC` — it's a hand-maintained table that mirrors `MR-Skill-Assets/chaincode_interface.json` but lives in code, not config. To allow a new function, you edit both. That friction is the safety property.

## Audit chain shape

For every decision that reaches `/skills/execute`:

```
on-chain:
  SKILL_DECISION::<decisionId>  -> { state: LINKED, linkedAnchorTxId: <atx>, finalState: <anchor-side state>, ... }
  SKILL_EVENT::<txid>:1         -> SKILL_DECISION_RECORDED { decisionId, manifestHash, function, ... }
  SKILL_EVENT::<txid>:2         -> SKILL_DECISION_LINKED   { decisionId, anchorTxId, finalState }
  SKILL_DECISION_BY_ANCHOR::<assetId> -> [decisionId, ...]
  <anchor-registry state for that assetId>

off-chain via /skills/audit/:decisionId:
  { replayable: true,
    decision: { ... },
    events: [ RECORDED, LINKED ] }
```

External auditors verify by calling `/skills/audit/:decisionId`, piping into `tools/replay-decision.js`, and (optionally) `--verify-skill` against the tagged `MR-Skill-Assets` checkout. Manifest hash must match byte-exact.

## License

Apache 2.0.
