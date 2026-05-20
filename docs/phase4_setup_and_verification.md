# Phase 4 — Setup & Verification Guide

For `MR-Anchor-Registry` gateway integration v0.1.0. Adds LLM-mediated governance routes that proxy to `MR-Skill-Runtime`, validate decisions, and record on-chain audit envelopes.

**Prerequisites:**
- ✅ Phase 1 (`MR-Skill-Assets` **v0.1.2**) tagged
- ✅ Phase 2 (`MR-Skill-Runtime` v0.1.0) tagged, running on edge box
- ✅ Phase 3 (`skill-audit-registry` v1.0.1) deployed on `anchorchannel` with AND endorsement
- Both gateway instances running (Org1:3000, Org2:3001)
- `node`, `jq`, `curl` installed

---

## Part A — Setup

### A.1 Apply Phase 4 patches to `MR-Anchor-Registry`

```bash
cd ~/work/MR-Anchor-Registry
tar -xzf /path/to/MR-Anchor-Registry-Phase4-v0.1.0.tar.gz
ls gateway/src/routes/skills.js                       # new file
ls gateway/src/services/skillRuntimeClient.js         # new file
ls gateway/src/services/skillManifestAllowlist.js     # new file
ls gateway/src/services/decisionStore.js              # new file
ls gateway/src/services/fabricFunctionMap.js          # new file
ls gateway/src/validators/policyValidator.js          # new file
ls tests/phase4-unit.test.js                          # new test file
ls scripts/verify-phase4.sh                           # new verifier
```

### A.2 Apply the two manual patches

Two of your existing files need small inserts. Both patches are documented inside the tarball:

**`gateway/src/services/fabricClient.js`** — open `gateway/src/services/fabricClient.PATCH.md` and apply the four marked inserts:

1. Add `const AUDIT_CHAINCODE_NAME = 'skill-audit-registry';` near the existing `CHAINCODE_NAME`
2. Add `this.auditContract = null;` in the constructor
3. Bind it in `connect()`: `this.auditContract = this.network.getContract(AUDIT_CHAINCODE_NAME);`
4. Add the 5 new methods at the end of the class: `recordSkillDecision`, `linkAnchorTx`, `querySkillDecision`, `replayDecision`, `listDecisionsByAnchor`

**`gateway/src/server.js`** — open `gateway/src/server.PATCH.md` and apply:

1. `const skillsRoutes = require('./routes/skills');` alongside the other routes
2. `app.use('/skills', skillsRoutes);` alongside the other `app.use` lines

After both patches are applied:

```bash
cd ~/work/MR-Anchor-Registry/gateway
grep -q "AUDIT_CHAINCODE_NAME" src/services/fabricClient.js && echo "fabricClient.js patched"
grep -q "require('./routes/skills')" src/server.js && echo "server.js patched"
```

### A.3 Apply the v0.1.2 patch to MR-Skill-Assets (if not done already)

```bash
cd ~/code/journal-extension/MR-Skill-Assets
tar -xzf /path/to/MR-Skill-Assets-v0.1.2-patch.tar.gz
node spatial-governance-skill/scripts/hash_intent.js \
  --manifest spatial-governance-skill/manifest.json
# expected: sha256:57bd7e555de7394bbef06592d2293238224459d0dc0f08a9ca4e3b5ee8c0c3a1
git add . && git commit -m "v0.1.2 patch" && git tag v0.1.2 && git push origin main v0.1.2
```

If the hash differs from `57bd7e55...`, stop here — the v0.1.2 patch didn't apply cleanly and the gateway's allowlist (which has that exact hash baked in) will reject every decision.

### A.4 Start MR-Skill-Runtime with v0.1.2

```bash
cd ~/code/journal-extension/MR-Skill-Runtime
# Point at the v0.1.2 checkout
sed -i 's|SKILL_ASSETS_PATH=.*|SKILL_ASSETS_PATH=../MR-Skill-Assets/spatial-governance-skill|' .env
# Verify it loads v0.1.2
node -e "
const { loadSkill } = require('./src/skillLoader');
require('dotenv').config();
const s = loadSkill(process.env.SKILL_ASSETS_PATH);
console.log('skillVersion:', s.skillVersion);
console.log('skillManifestHash:', s.skillManifestHash);
"
# Expected output:
#   skillVersion: 0.1.2
#   skillManifestHash: sha256:57bd7e555de7394bbef06592d2293238224459d0dc0f08a9ca4e3b5ee8c0c3a1
node src/server.js   # or run in tmux/background
```

### A.5 Configure the gateway to reach the runtime

In your repo's gateway environment (typically `.env` or shell exports before `up.sh`):

```bash
# Gateway → runtime URL. If MR-Skill-Runtime is on the same machine, use localhost.
# If on a separate edge box (as the proposal specifies), use that box's address.
export SKILL_RUNTIME_URL=http://localhost:5100         # or http://edge.local:5100

# Optional: timeout for runtime calls
export SKILL_RUNTIME_TIMEOUT_MS=30000

# Optional: WAL file location (default is gateway/data/skill-decisions-org1.wal etc.)
# export SKILL_DECISION_WAL=/var/lib/mr/skill-decisions-org1.wal
```

### A.6 Restart both gateway instances

```bash
cd ~/work/MR-Anchor-Registry
./down.sh   # if anything was running
./up.sh
# Wait for "Server running on port 3000" AND "Skill routes: /skills/*" lines in both logs
tail -n 30 logs/gateway_org1.log
tail -n 30 logs/gateway_org2.log
```

---

## Part B — Verify Phase 4

### B.1 Run the verifier

```bash
cd ~/work
chmod +x ./MR-Anchor-Registry/scripts/verify-phase4.sh
cp ./MR-Anchor-Registry/scripts/verify-phase4.sh ./verify-phase4.sh
./verify-phase4.sh ./MR-Anchor-Registry ./MR-Skill-Runtime
```

Expected tail of output:

```
================================================================
  Phase 4 verification: 22 passed, 0 failed
================================================================
```

### B.2 The 14 checks

1. **Source files present** — all 6 new files exist in gateway/src/
2. **server.js mounts /skills** — require + app.use are in place
3. **fabricClient.js has audit hooks** — AUDIT_CHAINCODE_NAME, auditContract, 4 new methods
4. **Offline unit tests pass** — 31 tests across allowlist, decisionStore, function map, validator
5. **Both gateways live** — /health responds for Org1 and Org2
6. **/skills/health** — gateway sees the runtime, allowlist contains the v0.1.2 hash
7. **/skills/interpret returns decision_id** — write intent → parked envelope + decisionId
8. **/skills/decision/:id peek** — admin panel can fetch the parked envelope
9. **/skills/execute end-to-end** — runs the chaincode + records audit + links
10. **/skills/audit replay** — full causal chain comes back with `replayable=true`, `state=LINKED`
11. **REJECT path** — adversarial input goes straight to a recorded REJECT (no execute step)
12. **Stale envelope** — covered by offline test (timestamp >10min old → rejected)
13. **Cross-org spoofing** — Org1 gateway always stamps `audit.orgMsp=Org1MSP` (identity bound at gateway)
14. **Forged hash** — allowlist rejects any hash not equal to v0.1.2's

### B.3 What "Phase 4 complete" means

When `verify-phase4.sh` shows `0 failed`, all of:

- [x] Gateway exposes `/skills/interpret`, `/skills/decision/:id`, `/skills/execute`, `/skills/audit/:id`
- [x] Gateway proxies to runtime on the edge (no LLM calls cross the gateway)
- [x] Every decision validates against the gateway's independent policy validator
- [x] Allowlist enforced: only v0.1.2 of MR-Skill-Assets is executable
- [x] Identity bound at the gateway (caller cannot impersonate another org)
- [x] Stale envelopes (>10 min) rejected at execute time
- [x] Audit record written **before** the anchor invoke (audit attempts even on failure)
- [x] Audit record linked to anchor tx after success
- [x] All transactions human-in-the-loop (no auto-execute)
- [x] Both REJECT and successful flows leave on-chain traces
- [x] Property P2 (verifiable provenance) operational end-to-end

### B.4 Record the result

```bash
cat >> ~/code/journal-extension/phase-log.md <<EOF

## Phase 4  $(date -u +%Y-%m-%dT%H:%M:%SZ)
- gateway endpoints: /skills/interpret /skills/decision/:id /skills/execute /skills/audit/:id
- runtime URL: ${SKILL_RUNTIME_URL:-not set}
- allowlist: MR-Skill-Assets v0.1.2 only (sha256:57bd7e55...)
- offline tests: 31/31
- end-to-end verify: $(./verify-phase4.sh ./MR-Anchor-Registry ./MR-Skill-Runtime 2>&1 | tail -1)
EOF
```

### B.5 Tag

```bash
cd ~/work/MR-Anchor-Registry
git add gateway/src/routes/skills.js \
        gateway/src/services/{skillRuntimeClient,skillManifestAllowlist,decisionStore,fabricFunctionMap}.js \
        gateway/src/validators/policyValidator.js \
        gateway/src/services/fabricClient.js \
        gateway/src/server.js \
        tests/phase4-unit.test.js \
        scripts/verify-phase4.sh
git commit -m "Phase 4: gateway integration for LLM-mediated governance"
git tag -a phase4-v0.1.0 -m "Phase 4 closed: skill→gateway→audit pipeline operational"
git push origin main phase4-v0.1.0
```

---

## Quick manual test (besides the verifier)

```bash
# 1. Interpret a write intent
curl -sX POST http://localhost:3000/skills/interpret \
  -H 'content-type: application/json' \
  -d '{"userText":"Register this anchor",
       "context":{"focusedAssetId":"TAG_TEST_01",
                  "poseHash":"sha256:'"$(printf '0%.0s' {1..64})"'",
                  "metadataHash":"sha256:'"$(printf '1%.0s' {1..64})"'"}}' \
  | jq

# Copy the decision_id from the output:
DID="sd-..."

# 2. Peek at it (what the admin panel would show)
curl -s http://localhost:3000/skills/decision/$DID | jq

# 3. Execute (user confirms)
curl -sX POST http://localhost:3000/skills/execute \
  -H 'content-type: application/json' \
  -d "{\"decision_id\":\"$DID\",\"confirm\":true}" | jq

# 4. Replay the audit chain
sleep 3   # wait for commit
curl -s http://localhost:3000/skills/audit/$DID | jq

# 5. List all decisions linked to that asset
curl -s http://localhost:3000/skills/audit/anchor/TAG_TEST_01 | jq
```

---

## Troubleshooting

**`/skills/health` shows `runtimeReachable: false`.** The gateway can't reach `SKILL_RUNTIME_URL`. From the gateway machine, `curl $SKILL_RUNTIME_URL/health` directly. If that fails, fix network/firewall first. If it succeeds, restart the gateway process (env vars are read at startup).

**`/skills/interpret` returns 503 "SKILL_RUNTIME_URL not configured".** The env var wasn't set when the gateway started. Set it in your shell or in `up.sh` itself, then restart the gateway.

**Every `/skills/execute` returns 422 with "skill-allowlist: not in allowlist".** The runtime is loading the wrong skill version. Check `node src/cli.js --no-llm "test"` from MR-Skill-Runtime — it should report `skillVersion: 0.1.2` and the v0.1.2 hash. If it reports v0.1.1, your `SKILL_ASSETS_PATH` is pointing at a stale checkout.

**`/skills/execute` returns `ProposalResponsePayloads do not match`.** This is the same non-determinism issue we fixed in Phase 3 v1.0.1, but now in your existing `anchor-registry` chaincode. Check if `anchor-registry.js` has any `new Date()` calls outside `txTimestamp`. If yes, that's a separate chaincode upgrade.

**Decision store grows without bound.** Decisions are TTL'd to 5 minutes. If you see >1000 pending decisions in `/skills/health`, the janitor is broken or you're putting at >>1Hz. Check `gateway/data/skill-decisions-org1.wal` size and `tail` it.

**`audit_link_tx: null` after execute.** The anchor invoke succeeded but LinkAnchorTx failed. The audit record exists in state RECORDED (not LINKED). External replay will still work but the per-anchor index won't include this decision. This is recoverable: manually call `linkAnchorTx(decisionId, anchorTxId, finalState, assetId)` from a one-off Node script.

---

## Next: Phase 5

Phase 5 expands the benchmark corpus from 50 intent cases to 1500–2500 stratified cases, plus 1000–1500 adversarial cases (per the §3 contribution-strength revision after dropping the user study). It's pure authoring work — no Fabric, no runtime changes. The Phase 4 pipeline you just built is what Phase 5's eval feeds into for the cross-provider table (E3).
