# Phase 3 — Skill Audit Registry Chaincode

Adds the `skill-audit-registry` chaincode to your existing `MR-Anchor-Registry` repository, alongside the existing `anchor-registry`. Records on-chain provenance of every LLM-mediated governance decision the runtime emits.

> **Design principle:** *The LLM prepares. The gateway validates. The chaincode enforces. **The ledger records.*** This is the *records* part. It's the novel artifact of the journal extension and the empirical basis for **property P2 — verifiable provenance**.

---

## What this delivers

```
MR-Anchor-Registry/                          (your existing repo)
├── chaincode/
│   ├── anchor-registry/                     (unchanged)
│   └── skill-audit-registry/                ← NEW
│       ├── index.js
│       ├── package.json
│       ├── lib/skill-audit-registry.js
│       └── test/skill-audit-registry.test.js
├── scripts/
│   ├── chaincode.sh                         (unchanged)
│   └── chaincode-skill-audit.sh             ← NEW
└── tools/                                   ← NEW directory
    └── replay-decision.js                   ← NEW: property-P2 demonstration
```

Plus a `gateway/` integration that's reserved for Phase 4 — Phase 3 is the chaincode itself, its unit tests, the deploy script, and the off-chain replay/verification tool. No gateway code yet.

---

## Architectural fit

Same `anchorchannel`. Same Fabric network. Same MSPs. Same conventions as `anchor-registry`:

| Concern | Mirrors anchor-registry |
|---|---|
| Class structure | Single `Contract` subclass exporting one contract |
| Identity | `ctx.clientIdentity.getMSPID()` validated against `VALID_MSPS = ['Org1MSP', 'Org2MSP']` |
| Event IDs | TxID + per-tx suffix (no global counters → no MVCC conflicts) |
| Key prefixes | `SKILL_DECISION::`, `SKILL_EVENT::`, `SKILL_DECISION_BY_ANCHOR::` |
| Event helper | `_emitEvent(ctx, eventType, data)` |
| Hash helper | `_hashPayload({...})` |
| Test stack | mocha + chai + sinon, run via `npm test` |
| Package manager | npm with `fabric-contract-api ^2.5.0` and `fabric-shim ^2.5.0` |

**The one deliberate difference:** endorsement policy is **stricter**.

| Chaincode | Endorsement |
|---|---|
| `anchor-registry` | `OR('Org1MSP.peer','Org2MSP.peer')` — single-org commits, app-level dual enforcement |
| `skill-audit-registry` | `AND('Org1MSP.peer','Org2MSP.peer')` — both orgs must endorse every write |

This is deliberate. Per §7.3 of the proposal: *agent provenance must be jointly attested.* If either organization alone could write the audit record, the record could be forged by a compromised single gateway. AND endorsement means audit forgery requires compromising both orgs simultaneously — the same trust assumption Fabric itself relies on.

---

## What the chaincode stores

Per decision (one record per call to `RecordSkillDecision`):

```
SKILL_DECISION::<decisionId> -> {
  decisionId, txId, state,
  skillId, skillVersion, skillManifestHash,
  llmProvider, llmModel, llmCallId, llmFinishReason,
  llmLatencyMs, llmUsage, tokenEstimate, levelsLoaded,
  intentHash, contextHash, argumentHash,    ← hashes only, never raw text
  decisionType, selectedChaincode, selectedFunction,
  riskLevel, requiresConfirmation, shouldInvoke,
  schemaValidation, policyValidation, policyReasoning, errors,
  submittingOrg, gatewayId, callerMsp,
  timestamp, recordedAt,
  linkedAnchorTxId, finalState, linkedAt
}
```

Plus events `SKILL_EVENT::<txId>:<suffix>` for `SKILL_DECISION_RECORDED` and `SKILL_DECISION_LINKED`, and an index `SKILL_DECISION_BY_ANCHOR::<assetId> -> [decisionId,...]` for fast per-asset lookup.

**Never stored on-chain:** raw user text, raw LLM output, raw poses, scene data, credentials. The chaincode actively refuses envelopes that look like they contain API keys (matches `sk-[A-Za-z0-9]{20,}`) or PEM-encoded private keys.

---

## Functions

| Function | Type | Purpose |
|---|---|---|
| `InitLedger` | write | Initialize ledger, emit `AUDIT_LEDGER_INITIALIZED` event |
| `RecordSkillDecision(envelopeJson)` | write | Persist a decision envelope, return `decisionId` + `txId` |
| `LinkAnchorTx(decisionId, anchorTxId, finalState, assetId)` | write | After gateway invokes anchor-registry, attach the anchor tx id |
| `QuerySkillDecision(decisionId)` | read | Single record by ID |
| `ListDecisionsByAnchor(assetId)` | read | All decisionIds linked to an asset |
| `ReplayDecision(decisionId)` | read | Full causal chain: decision + all events, chronologically |
| `GetAuditStats()` | read | Aggregate counts by state, decisionType, function, provider |

The state machine for an audit record:

```
RecordSkillDecision(INVOKE)  ─▶  RECORDED  ──LinkAnchorTx──▶  LINKED   (terminal)
RecordSkillDecision(REJECT)  ─▶  RECORDED_REJECT                        (terminal)
RecordSkillDecision(CLARIFY) ─▶  RECORDED_REJECT                        (terminal)
```

---

## Running the unit tests locally — no Fabric needed

```bash
cd MR-Anchor-Registry/chaincode/skill-audit-registry
npm install
npm test
```

Expected output:

```
SkillAuditRegistryContract
  InitLedger
    ✔ writes an init event and returns success
  RecordSkillDecision — validation
    ✔ rejects an envelope missing required fields
    ✔ rejects an envelope with bad hash format
    ✔ rejects unknown decisionType
    ✔ rejects unknown submittingOrg
    ✔ rejects cross-org submission (caller MSP != submittingOrg)
    ✔ rejects envelope containing what looks like a private key
    ✔ rejects envelope containing what looks like an API key
  RecordSkillDecision — happy path
    ✔ records an INVOKE decision and sets state=RECORDED
    ✔ records a REJECT decision with state=RECORDED_REJECT (terminal)
    ✔ rejects duplicate decisionId (replay protection)
  LinkAnchorTx
    ✔ attaches an anchorTxId + finalState to a recorded INVOKE decision
    ✔ is idempotent: re-linking the same tx returns success
    ✔ rejects re-linking with a contradicting anchorTxId
    ✔ rejects linking a REJECT decision (no anchor tx expected)
    ✔ rejects linking an unknown decisionId
  Reads
    ✔ QuerySkillDecision returns the stored record
    ✔ QuerySkillDecision throws for missing decisionId
    ✔ ListDecisionsByAnchor returns linked decisionIds in order
    ✔ ListDecisionsByAnchor returns empty list for unknown asset
    ✔ ReplayDecision returns decision + all matching events
    ✔ ReplayDecision: replayable=true requires all hash fields valid
    ✔ GetAuditStats aggregates by state, decisionType, function, provider
  Identity enforcement
    ✔ rejects record/link calls from an unknown MSP

24 passing
```

All 24 tests run in ~50 ms. No Fabric, no network calls.

---

## Off-chain replay tool

`tools/replay-decision.js` reads a decision export (the JSON returned by `ReplayDecision`) and verifies:

- All required fields present
- All hashes match `sha256:<64hex>` format
- `decisionType` and `state` are in allowed sets
- Lifecycle invariants: `LINKED ↔ has anchor tx`, `REJECT ↔ no anchor tx`
- Events all reference the same `decisionId` and are chronologically ordered
- (Optional, with `--verify-skill <path>`) Recompute manifest hash from local content and confirm it matches the on-chain value

```bash
# Basic verification of an exported decision record
node tools/replay-decision.js path/to/decision-export.json

# Full verification including manifest-hash recomputation
node tools/replay-decision.js path/to/decision-export.json \
    --verify-skill ../MR-Skill-Assets/spatial-governance-skill
```

Exit codes:
- `0` — replay verified, all invariants hold
- `1` — one or more verification failures (errors listed)
- `2` — usage error

**This tool is property P2 made operational.** An external auditor (or a reviewer of your journal paper) can:
1. Pick any committed Fabric transaction.
2. Call `ReplayDecision(decisionId)` to get the audit chain.
3. Run `replay-decision.js --verify-skill <tagged-MR-Skill-Assets>` to confirm the on-chain hash matches the actual content that was deployed.

If all three steps succeed, the agent's decision is cryptographically reproducible.

---

## Deployment (requires Fabric — Phase 0 prerequisite)

When your cloud server is back online and Phase 0 is verified:

```bash
cd MR-Anchor-Registry/scripts
chmod +x chaincode-skill-audit.sh
./chaincode-skill-audit.sh deploy   # package + install + approve + commit + init
./chaincode-skill-audit.sh test     # quick smoke: invoke + query
```

The script mirrors `chaincode.sh` exactly except:
- `CC_NAME=skill-audit-registry` (different name)
- `CC_END_POLICY="AND('Org1MSP.peer','Org2MSP.peer')"` (stricter policy)
- `CC_SRC_PATH=../chaincode/skill-audit-registry`

It deploys to the **same channel** (`anchorchannel`) the existing `anchor-registry` already runs on. No new channel needed.

---

## Integration points for Phase 4

The gateway will need to:

1. **Generate `decisionId`** (UUID is fine; the chaincode just requires uniqueness).
2. **Build the audit envelope** from the runtime's `Decision` object plus gateway-side fields (`gatewayId`, `schemaValidation`, `policyValidation`).
3. **Call `RecordSkillDecision`** *before* invoking `anchor-registry`. This way the audit record exists even if the anchor invocation later fails.
4. **Call `LinkAnchorTx`** *after* `anchor-registry` succeeds, passing the returned `fabricTxId`, the resulting state, and the `assetId` for indexing.
5. **Allowlist enforcement** — reject decisions whose `skillManifestHash` is not in the gateway's known-good set (each `MR-Skill-Assets` tag's hash is added through change-controlled deployment).

The chaincode is opaque to anchor-registry's function names. If the skill says `selectedFunction: "EndorseAnchor"` but the real chaincode is `EndorseClaim`, the audit chaincode happily records `"EndorseAnchor"` — but that's a discrepancy the **gateway** should reconcile via a name mapping (or, cleaner, via a v0.1.2 patch to `MR-Skill-Assets` that aligns names with reality). See "Outstanding tasks" below.

---

## Outstanding tasks

| Tag | Owner | Description |
|---|---|---|
| MR-Skill-Assets v0.1.2 | content | Align `chaincode_interface.json` function names with the real `anchor-registry` chaincode: `EndorseClaim` (not `EndorseAnchor`), `RevokeAnchor` (not `ProposeRevocation`), `EndorseRevoke` (not `EndorseRevocation`), `GetClaim`/`GetActiveAnchor`/`GetSnapshot` for reads. Args use `assetId`, not `claimId`. **Must precede Phase 4.** |
| MR-Skill-Assets v0.1.x | content | Decide whether the skill should also govern annotations (the ADVISORY/GOVERNED tier system in `anchor-registry`). The conference paper may not have included this — if the journal extension covers annotations too, the skill needs a second supported chaincode interface. **Discuss with professor.** |
| Phase 4 | runtime + gateway | Wire `/skills/interpret` (runtime) → `/skills/execute` (gateway) → `RecordSkillDecision` → `anchor-registry` invoke → `LinkAnchorTx`. |

---

## License

Apache 2.0 (matches the parent project).
