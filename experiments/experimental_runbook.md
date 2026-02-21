# ICCCN Track 3 — Complete Experiment Runbook
## MR-Anchor-Registry: Two-Gateway Architecture

**Version**: 2.0 (post security-fix, two-gateway model)
**Last updated**: Feb 2026

> **Convention**: All shell blocks assume the working directory is the
> project root (`MR-Anchor-Registry-main/`). Every command is absolute
> from that root unless otherwise noted. Terminal labels (T1–T4) indicate
> which terminal window to use.

---

## Table of Contents

1. [Run-ID Naming Scheme](#1-run-id-naming-scheme)
2. [Environment Prerequisites](#2-environment-prerequisites)
3. [Pre-Run Preparation](#3-pre-run-preparation)
4. [Standard Start / Stop / Restart Procedures](#4-standard-start--stop--restart-procedures)
5. [Verification Protocol](#5-verification-protocol)
6. [Reset & Restart Strategy](#6-reset--restart-strategy)
7. [Phase 1 — Exp 2 Fabric-Side (Dataset Scaling)](#7-phase-1--exp-2-fabric-side)
8. [Phase 2 — Exp 1 W1 Fabric-Side (Propose-Only)](#8-phase-2--exp-1-w1-fabric-side)
9. [Phase 3 — Exp 1 W2 Fabric-Side (Full Lifecycle)](#9-phase-3--exp-1-w2-fabric-side)
10. [Phase 4 — Exp 2 Device-Side (Quest 3 Reads)](#10-phase-4--exp-2-device-side)
11. [Phase 5 — Quest 3 BT=2s (Exp 1 Device + Exp 3 FPS + Exp 4)](#11-phase-5--quest-3-bt2s)
12. [Phase 6 — Quest 3 BT=500ms (Exp 4 Comparison)](#12-phase-6--quest-3-bt500ms)
13. [Phase 7 — Idle Baseline (Exp 3)](#13-phase-7--idle-baseline)
14. [Phase 8 — Final Verification](#14-phase-8--final-verification)
15. [Troubleshooting](#15-troubleshooting)
16. [Per-Stage Tick-Off Checklist](#16-per-stage-tick-off-checklist)

---

## 1. Run-ID Naming Scheme

Every run-ID encodes exactly what produced it, so that after all experiments you
can glob/sort/plot without ambiguity.

### Format

```
{experiment}{perspective}-{param}-t{trial}
```

| Field | Values | Meaning |
|---|---|---|
| `experiment` | `exp1`, `exp2`, `exp3`, `q3` | Which experiment |
| `perspective` | `f` = Fabric-side (localhost), `d` = Device-side (Quest 3) | Where the client ran |
| `param` | Rate, tier, workload, or config variant | The independent variable |
| `t{trial}` | `t1`, `t2`, `t3` | Trial number |

### Complete Run-ID Table

The sweep script generates IDs as `exp1-{w1|w2}-r{rate}-{TAG}`. We pass `--tag t{N}`
so IDs become `exp1-w1-r5-t1`, `exp1-w2-r20-t3`, etc.

| Run ID pattern | Example | Experiment | What |
|---|---|---|---|
| **Exp 1 W1 (sweep)** | | | |
| `exp1-w1-r{R}-t{N}` | `exp1-w1-r1-t1` | Exp 1 | W1 propose-only, rate=R |
| | `exp1-w1-r50-t3` | Exp 1 | W1 propose-only, rate=50, trial 3 |
| **Exp 1 W2 (sweep)** | | | |
| `exp1-w2-r{R}-t{N}` | `exp1-w2-r5-t1` | Exp 1 | W2 lifecycle, rate=R |
| | `exp1-w2-r20-t2` | Exp 1 | W2 lifecycle, rate=20, trial 2 |
| **Exp 2 Fabric (manual)** | | | |
| `exp2f-t{N}` | `exp2f-t1` | Exp 2 | Fill tiers 10→1000 + read |
| **Exp 2 Device (manual)** | | | |
| `exp2d-n{NNNN}-t{N}` | `exp2d-n0100-t1` | Exp 2 | Quest 3 reads at N |
| `exp2d-fill-n{NNNN}` | `exp2d-fill-n0100` | Exp 2 | Laptop fill logs (one per tier) |
| **Quest 3 BT=2s (manual)** | | | |
| `q3-r{RR}-bt2s-t{N}` | `q3-r10-bt2s-t1` | Exp 1/3/4 | rate, BT=2s |
| **Quest 3 BT=500ms (manual)** | | | |
| `q3-r10-bt500-t{N}` | `q3-r10-bt500-t2` | Exp 4 | BT comparison |
| **Idle (manual)** | | | |
| `exp3-idle` | `exp3-idle` | Exp 3 | Baseline |
| **Endorser bot logs** (always separate from experiment output) | | | |
| `exp2f-bot-t{N}` | `exp2f-bot-t1` | Exp 2 | Bot during Fabric fill |
| `exp1-w2-bot-t{N}` | `exp1-w2-bot-t1` | Exp 1 | Bot during W2 sweep |
| `exp2d-bot` | `exp2d-bot` | Exp 2 | Bot during device fill |
| `q3-bt2s-bot-t{N}` | `q3-bt2s-bot-t1` | Q3 | Bot during BT=2s runs |
| `q3-bt500-bot-t{N}` | `q3-bt500-bot-t1` | Q3 | Bot during BT=500ms runs |

**Rates in sweep IDs** use the raw number (1, 5, 10, 20, 50) — not zero-padded.
**Rates in Quest 3 IDs** use compact form (r02=0.2, r10=1.0, r20=2.0).

### Why no timestamp in the run-ID?

Timestamps create long, unsortable IDs. Instead, every `*_summary.json` and
`*_config.json` contains the ISO timestamp. The run-ID encodes the *experimental
coordinates* (experiment + workload + independent variable + trial); the timestamp
is metadata inside the output files. This keeps folder names short, tab-completable,
and `ls`-sortable.

### Mapping run-ID → output folder → paper tables

```
Run ID                   → Folder path                                → Paper figure/table
─────────────────────────────────────────────────────────────────────────────────────────────
exp1-w1-r5-t1            → experiments/runs/exp1-w1-r5-t1/            → Table II (W1 throughput)
exp1-w2-r10-t2           → experiments/runs/exp1-w2-r10-t2/           → Table III (W2 lifecycle)
exp2f-t1                 → experiments/runs/exp2f-t1/                 → Fig. 4 (read latency vs N)
exp2d-n0500-t1           → experiments/runs/exp2d-n0500-t1/           → Fig. 4 (device overlay)
q3-r10-bt2s-t1           → experiments/runs/q3-r10-bt2s-t1/           → Fig. 5 (AGOT decomposition)
q3-r10-bt500-t3          → experiments/runs/q3-r10-bt500-t3/          → Fig. 6 (BT comparison)
exp3-idle                → experiments/runs/exp3-idle/                → Table IV (resource baseline)
```

**Analysis script pattern** — iterate over trials and aggregate:

```python
# Example: collect W2 activation rates across trials
import json, glob

for rate in [1, 5, 10, 20, 50]:
    trials = []
    for path in sorted(glob.glob(f'experiments/runs/exp1-w2-r{rate}-t*/load_generator_summary.json')):
        s = json.load(open(path))
        trials.append(s['activation']['activation_success_rate_pct'])
    print(f'rate={rate}: activation={trials} mean={sum(trials)/len(trials):.1f}%')
```

### Comparison Matrix — what gets compared against what

After all runs, the analysis should produce these key comparisons:

**Exp 1: W1 vs W2 at each rate (Fabric-side)**

| Rate | W1 p50 (mean±std of 3 trials) | W2 p50 (mean±std) | W1 AGPS | W2 AGPS |
|---|---|---|---|---|
| 1 | `exp1-w1-r1-t{1,2,3}` | `exp1-w2-r1-t{1,2,3}` | ... | ... |
| 5 | ... | ... | ... | ... |
| 10, 20, 50 | ... | ... | ... | ... |

**Exp 1: Fabric-side vs Device-side (same rate)**

| Rate | AGOT_fabric (W2, mean of 3) | AGOT_device (Q3, mean of 3) | Δ (network overhead) |
|---|---|---|---|
| 1.0 | from `exp1-w2-r1-t{1,2,3}` | from `q3-r10-bt2s-t{1,2,3}` | device − fabric |

**Exp 2: Read latency vs dataset size (Fabric vs Device)**

| N | Snap p50_fabric (3 trials) | Snap p50_device | Δ | Payload size |
|---|---|---|---|---|
| 10 | `exp2f-t{1,2,3}` tier 10 | `exp2d-n0010-t1` | ... | ~2 KB |
| 100 | ... | ... | ... | ~20 KB |
| 500 | ... | ... | ... | ~100 KB |
| 1000 | ... | ... | ... | ~200 KB |

**Exp 4: Rate comparison (BT=2s) and BatchTimeout comparison**

| Rate | AGOT p50 (3 trials) | HTTP RTT | Endorse cycle | SSE delivery |
|---|---|---|---|---|
| 0.2 | `q3-r02-bt2s-t{1,2,3}` | ... | ... | ... |
| 1.0 | `q3-r10-bt2s-t{1,2,3}` | ... | ... | ... |
| 2.0 | `q3-r20-bt2s-t{1,2,3}` | ... | ... | ... |

| BT | AGOT p50 at rate=1.0 (3 trials) | Reduction vs 2s |
|---|---|---|
| 2s | `q3-r10-bt2s-t{1,2,3}` | baseline |
| 500ms | `q3-r10-bt500-t{1,2,3}` | X% less |

**Exp 3: FPS + Docker stats**

| Rate | Idle CPU/mem | Active CPU/mem | FPS baseline | FPS active | Δ FPS |
|---|---|---|---|---|---|
| idle | `exp3-idle` | — | — | — | — |
| 0.2 | — | `exp1-w1-r1-t1` docker_stats | `q3-r02` frame_logs | ... | ... |
| 1.0 | — | `exp1-w1-r5-t1` docker_stats | `q3-r10` frame_logs | ... | ... |

> **Under-load docker stats**: The `--docker` flag on sweep runs automatically
> captures `docker_stats.jsonl` alongside each load_generator run. This means
> every Exp 1 run folder contains both latency data AND resource consumption
> data. The idle baseline (Phase 7) provides the "no load" reference point.
> To plot CPU vs rate, iterate `exp1-w{1,2}-r*-t*/docker_stats.jsonl`.

### Mapping run-ID → output folder → analysis

```
experiments/runs/
  ├── exp1-w1-r5-t1/                    ← Exp 1 W1 (from sweep)
  │   ├── load_generator_summary.json
  │   ├── load_generator_requests.jsonl
  │   ├── load_generator_sse.jsonl
  │   ├── load_generator_config.json
  │   └── docker_stats.jsonl            ← Exp 3 (under-load)
  ├── exp1-w2-r5-t1/                    ← Exp 1 W2 (from sweep)
  │   └── (same structure)
  ├── exp1-w2-bot-t1/                   ← Bot logs (separate!)
  │   └── endorser_actions.jsonl
  ├── exp2f-t1/                         ← Exp 2 Fabric
  │   ├── dataset_scaling_summary.json
  │   ├── dataset_scaling_fill.jsonl
  │   ├── dataset_scaling_reads.jsonl
  │   └── dataset_scaling_config.json
  ├── exp2f-bot-t1/                     ← Bot logs
  │   └── endorser_actions.jsonl
  ├── exp2d-fill-n0100/                 ← Exp 2 device fill (per-tier)
  │   ├── dataset_scaling_summary.json
  │   └── dataset_scaling_fill.jsonl
  ├── exp2d-n0100-t1/                   ← Quest 3 read data (uploaded)
  ├── q3-r10-bt2s-t1/                   ← Quest 3 benchmark (uploaded)
  ├── q3-bt2s-bot-t1/                   ← Bot logs
  │   └── endorser_actions.jsonl
  └── exp3-idle/                        ← Idle baseline
      └── docker_stats_idle.tsv
```

---

## 2. Environment Prerequisites

Run this checklist once before starting:

```bash
# Docker running?
docker info > /dev/null 2>&1 && echo "✓ Docker OK" || echo "✗ Docker not running"

# Node.js version (need 18+)
node --version   # expect v18.x or v20.x

# Ports free?
lsof -i :3000 -i :3001 | grep LISTEN && echo "✗ Ports in use" || echo "✓ Ports 3000/3001 free"

# Project root exists?
ls up.sh down.sh gateway/src/server.js experiments/load_generator.js > /dev/null 2>&1 \
  && echo "✓ Project structure OK" || echo "✗ Missing files"

# Scripts executable?
chmod +x experiments/run_exp1_sweep.sh
chmod +x up.sh down.sh scripts/*.sh
```

---

## 3. Pre-Run Preparation

### 3a. Archive and clean previous data

```bash
# From project root
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Archive (optional but recommended)
if [ -d experiments/runs ] && [ "$(ls -A experiments/runs 2>/dev/null)" ]; then
  tar czf "experiments/runs-backup-${TIMESTAMP}.tar.gz" experiments/runs/
  echo "✓ Archived to experiments/runs-backup-${TIMESTAMP}.tar.gz"
fi

# Clean
rm -rf experiments/runs
mkdir -p experiments/runs
echo "✓ experiments/runs/ is empty"
```

### 3b. Install gateway dependencies (if needed)

```bash
cd gateway && npm install && cd ..
```

---

## 4. Standard Start / Stop / Restart Procedures

These are reusable blocks. Every phase references them by name.

`up.sh` is the **single source of truth** for bringing up the system. It performs
all of the following in one shot: generate crypto → start Docker containers →
create channel → deploy chaincode → launch **both** gateways (Org1:3000, Org2:3001).
Over SSH it uses tmux; on macOS GUI it opens Terminal windows.

`down.sh` tears down everything: kills gateways, stops/removes Docker containers
and volumes, cleans crypto and channel artifacts.

### FULL-RESTART

The canonical "clean slate" is just two commands plus a bot kill:

```bash
pkill -f "endorser_bot.js" 2>/dev/null || true   # stop bot if running
./down.sh                                          # tear down everything
./up.sh                                            # bring up everything fresh
sleep 5                                            # extra settle time
```

After this, both gateways are already running. **Do not start gateways manually**
unless `up.sh` failed — they are launched as the final step of `up.sh`.

### If running over SSH: tmux gateway session

`up.sh` automatically creates a **tmux session named `mr-gateways`** with two
panes (Org1 and Org2 logs). Useful commands:

```bash
# Attach to see both gateway logs
tmux attach -t mr-gateways

# Inside tmux:
#   Ctrl-b then ←/→   switch between panes
#   Ctrl-b then d      detach (gateways keep running)
#   Ctrl-b then [      scroll mode (q to exit)

# Verify the session exists
tmux ls
# Expected: mr-gateways: 1 windows (created ...)
```

If you need to restart gateways without restarting Fabric (rare):
```bash
tmux kill-session -t mr-gateways 2>/dev/null
```

### START-BOT

```bash
cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id <BOT_RUN_ID> \
  --mode two-step \
  --max_inflight 10 &
BOT_PID=$!
sleep 3
```

Replace `<BOT_RUN_ID>` with the bot-scoped run-ID for the current phase (see
[Run-ID table](#1-run-id-naming-scheme)). Bot logs go to
`experiments/runs/<BOT_RUN_ID>/endorser_actions.jsonl` — separate from
load-generator output folders so they never collide.

---

## 5. Verification Protocol

Run this after every FULL-RESTART, before starting any experiment phase.

### 5a. Health check both gateways

```bash
echo "--- Gateway Org1 ---"
curl -s http://localhost:3000/health | python3 -m json.tool
# EXPECTED: "org": "org1", "mspId": "Org1MSP", "connected": true

echo "--- Gateway Org2 ---"
curl -s http://localhost:3001/health | python3 -m json.tool
# EXPECTED: "org": "org2", "mspId": "Org2MSP", "connected": true
```

**FAIL-FAST**: If either shows `"connected": false`, check Fabric container logs:
```bash
docker logs peer0.org1.example.com --tail 20
```

### 5b. SSE sanity (both gateways see ledger events)

```bash
# Terminal A: listen on Org1 SSE
curl -N -H "Accept: text/event-stream" http://localhost:3000/events/stream &
SSE1_PID=$!

# Terminal B: listen on Org2 SSE
curl -N -H "Accept: text/event-stream" http://localhost:3001/events/stream &
SSE2_PID=$!

# Wait briefly for connections
sleep 2

# Propose a test anchor via Org1
curl -s -X POST http://localhost:3000/claims/propose \
  -H "Content-Type: application/json" \
  -d '{
    "asset_id": "smoke-test-001",
    "pose_site": {"position":{"x":0,"y":0,"z":0},"rotation":{"qw":1,"qx":0,"qy":0,"qz":0}},
    "quality_metrics": {"stability_rms":0.02,"confidence_mean":0.9,"observation_count":10}
  }' | python3 -m json.tool

# EXPECTED: Both SSE streams show a CLAIM_PROPOSED event
# Wait 3 seconds, then kill SSE listeners
sleep 3
kill $SSE1_PID $SSE2_PID 2>/dev/null
```

### 5c. Smoke test: full lifecycle (only when bot is running)

```bash
# Propose
curl -s -X POST http://localhost:3000/claims/propose \
  -H "Content-Type: application/json" \
  -d '{
    "asset_id": "lifecycle-smoke-001",
    "pose_site": {"position":{"x":1,"y":0,"z":0},"rotation":{"qw":1,"qx":0,"qy":0,"qz":0}},
    "quality_metrics": {"stability_rms":0.02,"confidence_mean":0.9,"observation_count":10}
  }' | python3 -m json.tool

# Wait for bot to endorse (watch bot terminal for "→ ACTIVATED")
sleep 10

# Check state
curl -s http://localhost:3000/claims/lifecycle-smoke-001 | python3 -m json.tool
# EXPECTED: "state": "ACTIVE"
```

**FAIL-FAST**: If state is not ACTIVE after 30 seconds, check:
1. Is the endorser bot running? (`ps aux | grep endorser_bot`)
2. Is it connected to SSE? (bot terminal should show "✓ SSE connected")
3. Are both gateways healthy?

---

## 6. Reset & Restart Strategy

| Transition | What to restart | Why |
|---|---|---|
| Between Exp 2 trials | FULL-RESTART | Cumulative fills require empty ledger |
| Between Exp 1 W1 trials | FULL-RESTART | Rate-50 proposals accumulate 3000+ anchors |
| Between Exp 1 W2 trials | FULL-RESTART + new bot | Same reason + bot dedup sets fill up |
| W1 group → W2 group | FULL-RESTART + start bot | W1 doesn't use bot; W2 needs it |
| Between Quest 3 trial sets | FULL-RESTART + new bot | Clean ledger for each trial |
| Phase 6 (BT=500ms) | Config change + FULL-RESTART | Different BatchTimeout |
| Phase 7 (idle baseline) | Config revert + FULL-RESTART | Measure idle after BT reverted |

**Within a sweep trial** (e.g., rates 1→5→10→20→50): No restart needed. The sweep
script uses unique asset prefixes per rate and cools down 15s between rates. The
cumulative state (~3000 anchors across 5 rates) is negligible for a 2-org Fabric.

**Cooldown guidance**: `up.sh` already waits for Fabric readiness internally.
The additional `sleep 5` after `./up.sh` is a buffer for gateway connections.
Between rate points within a sweep, the script's built-in 15s cooldown is sufficient.

### Confirming a clean ledger

```bash
curl -s http://localhost:3000/admin/anchors | python3 -c "
import sys, json
d = json.load(sys.stdin)
n = d.get('count', len(d.get('anchors', [])))
print(f'Active anchors: {n}')
assert n == 0, f'LEDGER NOT CLEAN — found {n} anchors!'
print('✓ Ledger is clean')
"
```

---

## 7. Phase 1 — Exp 2 Fabric-Side

**Purpose**: Fill ledger to tiers 10→100→500→1000, benchmark reads at each tier.
**Time**: ~2 hours (3 trials × ~40 min; activation wait dominates)
**Needs bot**: Yes (to activate anchors during fill)

### Trial 1

```bash
# ─── PHASE 1, TRIAL 1 ───────────────────────────────
# FULL-RESTART
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

# Verify gateways
curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected'], 'Org1 unhealthy'; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected'], 'Org2 unhealthy'; print('✓ Org2 OK')"

# Start endorser bot
cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp2f-bot-t1 \
  --mode two-step \
  --max_inflight 10 &
BOT_PID=$!
sleep 3

# Run dataset scaling
node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2f-t1 \
  --tiers "10,100,500,1000" \
  --reads 20 \
  --fill_rate 5

# Verify output
ls -la runs/exp2f-t1/
# EXPECTED: dataset_scaling_summary.json, _config.json, _fill.jsonl, _reads.jsonl

kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 2

```bash
# ─── PHASE 1, TRIAL 2 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp2f-bot-t2 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2f-t2 \
  --tiers "10,100,500,1000" \
  --reads 20 --fill_rate 5

ls -la runs/exp2f-t2/
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 3

```bash
# ─── PHASE 1, TRIAL 3 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp2f-bot-t3 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2f-t3 \
  --tiers "10,100,500,1000" \
  --reads 20 --fill_rate 5

ls -la runs/exp2f-t3/
kill $BOT_PID 2>/dev/null
cd ..
```

### Phase 1 Checkpoint

```bash
echo "=== Phase 1 Complete: Exp 2 Fabric-Side ==="
for t in t1 t2 t3; do
  f="experiments/runs/exp2f-${t}/dataset_scaling_summary.json"
  if [ -f "$f" ]; then
    echo "--- exp2f-${t} ---"
    python3 -c "
import json
s = json.load(open('${f}'))
for t in s['tier_results']:
    snap = t.get('snapshot') or {}
    lat = snap.get('latency') or {}
    pay = snap.get('payload_bytes') or {}
    print(f\"  N={t['target_n']:4d}  actual={t['actual_n']:4d}  snap_p50={lat.get('p50','-')}ms  size={pay.get('mean',0):.0f}B\")
"
  else
    echo "  ✗ exp2f-${t} MISSING!"
  fi
done
```

**✓ Proceed only if**: All 3 trials show consistent results; actual_n ≈ target_n at each tier.

---

## 8. Phase 2 — Exp 1 W1 Fabric-Side

**Purpose**: Propose-only throughput/latency across rates 1, 5, 10, 20, 50 ops/s.
**Time**: ~30 min (3 trials × ~10 min)
**Needs bot**: NO — do NOT start the endorser bot.

### Trial 1

```bash
# ─── PHASE 2, TRIAL 1 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments

# NO endorser bot for W1!
WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t1

ls runs/exp1-w1-r*-t1/
cd ..
```

### Trial 2

```bash
# ─── PHASE 2, TRIAL 2 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t2

ls runs/exp1-w1-r*-t2/
cd ..
```

### Trial 3

```bash
# ─── PHASE 2, TRIAL 3 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t3

ls runs/exp1-w1-r*-t3/
cd ..
```

### Phase 2 Checkpoint

```bash
echo "=== Phase 2 Complete: Exp 1 W1 Fabric-Side ==="
for tag in t1 t2 t3; do
  echo "--- tag=${tag} ---"
  for r in 1 5 10 20 50; do
    dir="experiments/runs/exp1-w1-r${r}-${tag}"
    if [ -f "$dir/load_generator_summary.json" ]; then
      python3 -c "
import json
s = json.load(open('$dir/load_generator_summary.json'))
rtt = s.get('propose_rtt') or {}
print(f'  r={$r:>2d}  tput={s[\"throughput\"][\"actual_throughput_ops\"]:.1f}  p50={rtt.get(\"p50\",\"-\")}ms  p95={rtt.get(\"p95\",\"-\")}ms  ok={s[\"counts\"][\"success_rate_pct\"]}%')
"
    else
      echo "  r=$r  MISSING!"
    fi
  done
done
```

**✓ Expected**: ~100% success at all rates. If gateway crashes at rate=50 in later trials, that is a valid finding — record which rate.

---

## 9. Phase 3 — Exp 1 W2 Fabric-Side

**Purpose**: Full lifecycle (Propose + Endorse×2 → ACTIVE) across same rates.
**Time**: ~45–60 min (3 trials × ~15–20 min; activation overhead from bot)
**Needs bot**: YES — start endorser bot before each sweep.

### Trial 1

```bash
# ─── PHASE 3, TRIAL 1 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments

# Start endorser bot
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp1-w2-bot-t1 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

WORKLOADS="lifecycle" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t1

ls runs/exp1-w2-r*-t1/
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 2

```bash
# ─── PHASE 3, TRIAL 2 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp1-w2-bot-t2 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

WORKLOADS="lifecycle" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t2

ls runs/exp1-w2-r*-t2/
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 3

```bash
# ─── PHASE 3, TRIAL 3 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org1' and d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['org']=='org2' and d['connected']; print('✓ Org2 OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp1-w2-bot-t3 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

WORKLOADS="lifecycle" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --docker --tag t3

ls runs/exp1-w2-r*-t3/
kill $BOT_PID 2>/dev/null
cd ..
```

### Phase 3 Checkpoint

```bash
echo "=== Phase 3 Complete: Exp 1 W2 Fabric-Side ==="
for tag in t1 t2 t3; do
  echo "--- tag=${tag} ---"
  for r in 1 5 10 20 50; do
    dir="experiments/runs/exp1-w2-r${r}-${tag}"
    if [ -f "$dir/load_generator_summary.json" ]; then
      python3 -c "
import json
s = json.load(open('$dir/load_generator_summary.json'))
rtt = s.get('propose_rtt') or {}
act = s.get('activation') or {}
print(f'  r={$r:>2d}  tput={s[\"throughput\"][\"actual_throughput_ops\"]:.1f}  p50={rtt.get(\"p50\",\"-\")}ms  activated={act.get(\"activated_count\",\"-\")}/{act.get(\"propose_ok_count\",\"-\")}  act_rate={act.get(\"activation_success_rate_pct\",\"-\")}%  ok={s[\"counts\"][\"success_rate_pct\"]}%')
"
    else
      echo "  r=$r  MISSING!"
    fi
  done
done
```

**✓ Expected**: High activation rate at r1–r20. Some degradation at r50 is expected and worth discussing. If activation_success_rate drops below 50% at any rate, check bot logs for MVCC conflicts.

---

## 10. Phase 4 — Exp 2 Device-Side

**Purpose**: Quest 3 reads at tiers 10/100/500/1000 over WAN (ngrok).
**Time**: ~40–50 min (fill to 1000 anchors + Quest 3 reads at each tier)
**Needs bot**: Yes (for fill phase)

> **Important**: Each tier uses a separate `--run_id` so fill logs and summaries
> don't overwrite each other. The incremental fill still works because
> `dataset_scaling.js` counts existing anchors on the ledger (via `/admin/anchors`),
> not from output files. So the second call detects the 10 anchors from the first
> call and only proposes the remaining 90.

```bash
# ─── PHASE 4 ─────────────────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

# Verify
curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ Org2 OK')"

# Start endorser bot
cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id exp2d-bot \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3

# Ensure ngrok is running: ngrok http 3000
```

**For each tier**: fill from laptop, then trigger Quest 3 read benchmark.

```bash
# ── Tier 10 ──
node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2d-fill-n0010 --tiers "10" --reads 5 --fill_rate 5
# [Quest 3] ReadBenchmarkController: runId=exp2d-n0010-t1, iterations=20
# Wait for "READ BENCHMARK COMPLETE"

# ── Tier 100 (adds 90 more — detects 10 existing on ledger) ──
node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2d-fill-n0100 --tiers "100" --reads 5 --fill_rate 5
# [Quest 3] runId=exp2d-n0100-t1, iterations=20

# ── Tier 500 (adds 400 more — detects 100 existing) ──
node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2d-fill-n0500 --tiers "500" --reads 5 --fill_rate 5
# [Quest 3] runId=exp2d-n0500-t1, iterations=20

# ── Tier 1000 (adds 500 more — detects 500 existing) ──
node dataset_scaling.js \
  --gateway http://localhost:3000 \
  --run_id exp2d-fill-n1000 --tiers "1000" --reads 5 --fill_rate 5
# [Quest 3] runId=exp2d-n1000-t1, iterations=20
```

> **Verify actual counts**: Each call prints "Verified active anchor count: N".
> Check that N matches the target tier (10, 100, 500, 1000) before starting the
> Quest 3 read.

```bash
# Verify Quest 3 uploads arrived
ls experiments/runs/exp2d-n*/

# Verify fill logs exist (one folder per tier)
ls experiments/runs/exp2d-fill-n*/

kill $BOT_PID 2>/dev/null
cd ..
```

---

## 11. Phase 5 — Quest 3 BT=2s

**Purpose**: Device-side lifecycle latency (Exp 1), FPS (Exp 3), AGOT decomposition (Exp 4).
**Time**: ~90 min (3 trials × 3 rates; rate=0.2 at count=100 takes ~8.5 min each)
**Needs bot**: Yes
**BatchTimeout**: 2s (default)

### Low-rate duration rule

At rate=0.2 ops/sec, a 60s run produces only 12 proposals — too few for p95/p99.
**Enforce**: `proposalCount >= 100` at rate=0.2, so the run takes ~500s (~8.5 min).
For rate ≥ 1.0, `proposalCount = 50–60` (60s at rate=1.0) is sufficient.

| Rate | proposalCount | warmupCount | Approx duration |
|------|---------------|-------------|-----------------|
| 0.2  | 100           | 5           | ~525s (8.75 min) |
| 1.0  | 60            | 5           | ~65s |
| 2.0  | 60            | 5           | ~32s |

### Trial 1

```bash
# ─── PHASE 5, TRIAL 1 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ Org1 OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ Org2 OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id q3-bt2s-bot-t1 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3
# Ensure ngrok: ngrok http 3000
```

**[Quest 3] BenchmarkModeController:**

| Run | runId | rate | count | warmup | baselineSeconds |
|-----|-------|------|-------|--------|-----------------|
| A | `q3-r02-bt2s-t1` | 0.2 | 100 | 5 | 30 |
| B | `q3-r10-bt2s-t1` | 1.0 | 60 | 5 | 30 |
| C | `q3-r20-bt2s-t1` | 2.0 | 60 | 5 | 30 |

Run A, B, C sequentially. Wait for "BENCHMARK COMPLETE" between each.

```bash
ls runs/q3-r*-bt2s-t1*/
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 2

```bash
# ─── PHASE 5, TRIAL 2 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id q3-bt2s-bot-t2 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3
```

**[Quest 3]**: Same settings, trial 2 IDs: `q3-r02-bt2s-t2`, `q3-r10-bt2s-t2`, `q3-r20-bt2s-t2`

```bash
ls runs/q3-r*-bt2s-t2*/
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 3

Same pattern with `-t3` IDs.

```bash
# ─── PHASE 5, TRIAL 3 ───────────────────────────────
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5

curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id q3-bt2s-bot-t3 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3
```

**[Quest 3]**: `q3-r02-bt2s-t3`, `q3-r10-bt2s-t3`, `q3-r20-bt2s-t3`

```bash
ls runs/q3-r*-bt2s-t3*/
kill $BOT_PID 2>/dev/null
cd ..
```

### Phase 5 Checkpoint

```bash
echo "=== Phase 5 Complete: Quest 3 BT=2s ==="
echo "Expected: 9 run dirs (3 rates × 3 trials)"
ls -d experiments/runs/q3-r*-bt2s-t*/ 2>/dev/null | wc -l
ls -d experiments/runs/q3-r*-bt2s-t*/
```

---

## 12. Phase 6 — Quest 3 BT=500ms

**Purpose**: Exp 4 BatchTimeout comparison at rate=1.0 only.
**Time**: ~30 min (3 trials)

### Config change

```bash
# Stop everything
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh

# Edit BatchTimeout BEFORE restarting
# In: network/configtx/configtx.yaml
# Change: BatchTimeout: 2s → BatchTimeout: 500ms
nano network/configtx/configtx.yaml

# Restart with new config (up.sh regenerates crypto + channel artifacts)
./up.sh
sleep 5
```

### Trial 1

```bash
# Verify gateways (already started by up.sh)
curl -sf http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['connected']; print('✓ OK')"

cd experiments
node endorser_bot.js \
  --gateway_org1 http://localhost:3000 \
  --gateway_org2 http://localhost:3001 \
  --run_id q3-bt500-bot-t1 \
  --mode two-step --max_inflight 10 &
BOT_PID=$!
sleep 3
```

**[Quest 3]**: `runId=q3-r10-bt500-t1`, rate=1.0, count=60, warmup=5, baseline=30

```bash
kill $BOT_PID 2>/dev/null
cd ..
```

### Trial 2 & 3

Repeat with FULL-RESTART (keeping BT=500ms config), IDs: `q3-r10-bt500-t2`, `q3-r10-bt500-t3`.

```bash
# Trial 2
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5
# Verify health, start bot with --run_id q3-bt500-bot-t2, run Quest 3 with q3-r10-bt500-t2

# Trial 3
pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 5
# Verify health, start bot with --run_id q3-bt500-bot-t3, run Quest 3 with q3-r10-bt500-t3
```

### Phase 6 Checkpoint

```bash
echo "=== Phase 6 Complete ==="
ls -d experiments/runs/q3-r10-bt500-t*/
```

**IMPORTANT**: Revert `BatchTimeout: 500ms` → `BatchTimeout: 2s` in configtx.yaml now.

---

## 13. Phase 7 — Idle Baseline

**Purpose**: Docker resource stats with no load (Exp 3 baseline).
**Time**: ~2 min

```bash
# Revert BatchTimeout to 2s (if not done already)
nano network/configtx/configtx.yaml   # BatchTimeout: 2s

pkill -f "endorser_bot.js" 2>/dev/null || true
./down.sh && ./up.sh
sleep 10   # extra settle time for idle measurement

mkdir -p experiments/runs/exp3-idle

echo "Capturing 30s idle baseline (15 samples × 2s)..."
for i in $(seq 1 15); do
  TS=$(python3 -c 'import time; print(int(time.time()*1000))')
  docker stats --no-stream --format \
    "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" | \
    while IFS=$'\t' read -r name cpu mem net block; do
      echo -e "${TS}\t${name}\t${cpu}\t${mem}\t${net}\t${block}"
    done >> experiments/runs/exp3-idle/docker_stats_idle.tsv
  echo "  Sample $i/15"
  sleep 2
done

echo "✓ Idle baseline saved"
wc -l experiments/runs/exp3-idle/docker_stats_idle.tsv

# Stop gateways (no need to restart — experiments are done)
for PORT in 3000 3001; do
  PID=$(lsof -ti:${PORT} 2>/dev/null || true)
  [ -n "$PID" ] && kill -9 $PID 2>/dev/null
done
```

---

## 14. Phase 8 — Final Verification

```bash
echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║          FINAL DATA INVENTORY                                ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

cd experiments

echo "=== Exp 2 Fabric-Side (3 trials × 4 tiers) ==="
for t in t1 t2 t3; do
  f="runs/exp2f-${t}/dataset_scaling_summary.json"
  [ -f "$f" ] && echo "  ✓ exp2f-${t}" || echo "  ✗ exp2f-${t} MISSING!"
done

echo ""
echo "=== Exp 2 Device-Side — Reads (4 tiers) ==="
for n in n0010 n0100 n0500 n1000; do
  dir="runs/exp2d-${n}-t1"
  [ -d "$dir" ] && echo "  ✓ exp2d-${n}-t1" || echo "  ✗ exp2d-${n}-t1 MISSING"
done

echo ""
echo "=== Exp 2 Device-Side — Fills (4 tiers) ==="
for n in n0010 n0100 n0500 n1000; do
  dir="runs/exp2d-fill-${n}"
  [ -d "$dir" ] && echo "  ✓ exp2d-fill-${n}" || echo "  ✗ exp2d-fill-${n} MISSING"
done

echo ""
echo "=== Endorser Bot Logs (spot check) ==="
BOT_COUNT=$(ls -d runs/*bot*/ 2>/dev/null | wc -l)
echo "  Bot log directories: ${BOT_COUNT}"
ls -d runs/*bot*/ 2>/dev/null | head -5

echo ""
echo "=== Exp 1 W1 Fabric-Side (3 trials × 5 rates = 15) ==="
W1_COUNT=0
for t in t1 t2 t3; do
  for r in 1 5 10 20 50; do
    [ -f "runs/exp1-w1-r${r}-${t}/load_generator_summary.json" ] && W1_COUNT=$((W1_COUNT+1))
  done
done
echo "  Found: ${W1_COUNT}/15"

echo ""
echo "=== Exp 1 W2 Fabric-Side (3 trials × 5 rates = 15) ==="
W2_COUNT=0
for t in t1 t2 t3; do
  for r in 1 5 10 20 50; do
    [ -f "runs/exp1-w2-r${r}-${t}/load_generator_summary.json" ] && W2_COUNT=$((W2_COUNT+1))
  done
done
echo "  Found: ${W2_COUNT}/15"

echo ""
echo "=== Quest 3 BT=2s (3 trials × 3 rates = 9) ==="
Q3_COUNT=$(ls -d runs/q3-r*-bt2s-t*/ 2>/dev/null | wc -l)
echo "  Found: ${Q3_COUNT}/9"

echo ""
echo "=== Quest 3 BT=500ms (3 trials) ==="
Q3B_COUNT=$(ls -d runs/q3-r10-bt500-t*/ 2>/dev/null | wc -l)
echo "  Found: ${Q3B_COUNT}/3"

echo ""
echo "=== Exp 3 Idle Baseline ==="
[ -f "runs/exp3-idle/docker_stats_idle.tsv" ] && echo "  ✓ exp3-idle" || echo "  ✗ MISSING"

echo ""
TOTAL=$((W1_COUNT + W2_COUNT + Q3_COUNT + Q3B_COUNT + 3 + 4 + 1 + 1))
echo "═══════════════════════════════════════════════════════════════"
echo "  Total run directories expected: ~48"
echo "  Verified data files: ${TOTAL}"
echo "═══════════════════════════════════════════════════════════════"

cd ..
```

---

## 15. Troubleshooting

### Gateway shows "connected: false"

```bash
docker ps | grep peer   # Is the peer container running?
docker logs peer0.org1.example.com --tail 30
# Common fix: FULL-RESTART
```

### Endorser bot: "SSE connection failed"

```bash
# Check if SSE endpoint responds
curl -s -N -H "Accept: text/event-stream" http://localhost:3000/events/stream | head -c 100
# If nothing: gateway may need restart
# If data: bot has a bug, check --verbose output
```

### Anchors stuck in PROPOSED (never ACTIVE)

1. Is the bot running? `ps aux | grep endorser_bot`
2. Is the bot connected to SSE? Look for "✓ SSE connected" in bot output
3. Are BOTH gateways up? `curl -s http://localhost:3001/health`
4. Check bot queue: look for `[queue]` lines — is `inflight` > 0?

### MVCC_READ_CONFLICT errors at high rates

Expected at rate ≥ 20 with concurrent endorsements. The bot retries automatically.
If error rate exceeds 30%, try `--max_inflight 5` to reduce contention.

### "Port already in use" on restart

```bash
for PORT in 3000 3001; do
  PID=$(lsof -ti:${PORT} 2>/dev/null || true)
  [ -n "$PID" ] && kill -9 $PID && echo "Killed $PID on port $PORT"
done
```

---

## Time Budget

| Phase | What | Restarts | Approx Time |
|---|---|---|---|
| 0 | Prep + clean | 0 | 5 min |
| 1 | Exp 2 Fabric (3 trials) | 3 | 2 hours |
| 2 | Exp 1 W1 Fabric (3 trials) | 3 | 30 min |
| 3 | Exp 1 W2 Fabric (3 trials) | 3 | 45–60 min |
| 4 | Exp 2 Device (1 trial) | 1 | 40–50 min |
| 5 | Quest 3 BT=2s (3×3) | 3 | 90 min |
| 6 | Quest 3 BT=500ms (3×1) | 3 + config | 30 min |
| 7 | Idle baseline | 1 + revert | 5 min |
| 8 | Verification | 0 | 5 min |
| **Total** | | **17** | **~6–7 hours** |

> **Phase 1 dominates**: filling 1000 anchors per trial takes ~3 min, but waiting
> for endorser bot activations at `--max_inflight 10` adds 10–20 min per trial
> (MVCC conflicts and sequential Fabric txns). Observed: ~40 min/trial on a laptop.
>
> **Phase 3 is slower than Phase 2**: W2 lifecycle runs include activation overhead
> from the endorser bot; W1 propose-only has no bot wait.
>
> **Phase 5**: rate=0.2 at count=100 takes ~8.5 min per run.

Natural break points between any two phases. If splitting across days,
Phase 1→2 or Phase 3→4 or Phase 5→6 are ideal break points.

---

## 16. Per-Stage Tick-Off Checklist

Print this section and check off each item as you go. **FAIL-FAST**: if any
item marked ⚡ fails, STOP and do a FULL-RESTART (`./down.sh && ./up.sh`) before retrying.

### Phase 0 — Prep
- [ ] Old `experiments/runs/` archived or deleted
- [ ] `experiments/runs/` directory exists and is empty
- [ ] Scripts present: `load_generator.js`, `dataset_scaling.js`, `endorser_bot.js`, `run_exp1_sweep.sh`
- [ ] `run_exp1_sweep.sh` is executable (`chmod +x`)
- [ ] Docker is running (`docker info`)
- [ ] `./down.sh` runs without errors

### Phase 1 — Exp 2 Fabric-Side (repeat for each trial)
- [ ] ⚡ FULL-RESTART: `./down.sh && ./up.sh` completed
- [ ] ⚡ Org1 health: `"org": "org1", "connected": true`
- [ ] ⚡ Org2 health: `"org": "org2", "connected": true`
- [ ] ⚡ Ledger is clean (0 active anchors)
- [ ] Endorser bot started with `--run_id exp2f-bot-t{N}` and `--max_inflight 10`
- [ ] Bot shows "✓ SSE connected" in console
- [ ] `dataset_scaling.js` ran to completion (all 4 tiers)
- [ ] Console shows "Verified active anchor count" ≈ target at each tier
- [ ] `runs/exp2f-t{N}/dataset_scaling_summary.json` exists
- [ ] Summary has 4 entries in `tier_results[]`
- [ ] actual_n ≈ target_n at each tier (within 5%)
- [ ] Bot stopped

### Phase 2 — Exp 1 W1 Fabric-Side (repeat for each trial)
- [ ] ⚡ FULL-RESTART completed
- [ ] ⚡ Both gateways healthy
- [ ] NO endorser bot running (W1 only!)
- [ ] Sweep ran with `WORKLOADS="propose" --tag t{N}`
- [ ] 5 run directories created: `exp1-w1-r{1,5,10,20,50}-t{N}`
- [ ] Each has `load_generator_summary.json`
- [ ] `success_rate_pct` ≥ 95% at rates 1–20
- [ ] ⚡ If gateway crashed mid-sweep: note which rate, restart from that rate

### Phase 3 — Exp 1 W2 Fabric-Side (repeat for each trial)
- [ ] ⚡ FULL-RESTART completed
- [ ] ⚡ Both gateways healthy
- [ ] Endorser bot started with `--run_id exp1-w2-bot-t{N}` and `--max_inflight 10`
- [ ] Bot shows "✓ SSE connected"
- [ ] Sweep ran with `WORKLOADS="lifecycle" --tag t{N}`
- [ ] 5 run directories created: `exp1-w2-r{1,5,10,20,50}-t{N}`
- [ ] Each has `load_generator_summary.json`
- [ ] Summary has non-null `activation` section
- [ ] `activation.activated_count > 0` at all rates
- [ ] `activation.activation_success_rate_pct > 50%` at rates 1–20
- [ ] ⚡ If activation rate < 30% at any rate: check bot logs in `runs/exp1-w2-bot-t{N}/`
- [ ] Bot stopped

### Phase 4 — Exp 2 Device-Side
- [ ] ⚡ FULL-RESTART completed
- [ ] ⚡ Both gateways healthy + ledger clean
- [ ] Endorser bot started with `--run_id exp2d-bot`
- [ ] ngrok tunnel running and Quest 3 can reach gateway
- [ ] For each tier (10, 100, 500, 1000):
  - [ ] Fill completed with `--run_id exp2d-fill-n{NNNN}` (console shows correct count)
  - [ ] Quest 3 read benchmark completed ("READ BENCHMARK COMPLETE")
  - [ ] Run data uploaded to gateway
- [ ] 4 Quest 3 run directories exist: `exp2d-n{0010,0100,0500,1000}-t1`
- [ ] 4 fill directories exist: `exp2d-fill-n{0010,0100,0500,1000}`
- [ ] Bot stopped

### Phase 5 — Quest 3 BT=2s (repeat for each trial)
- [ ] ⚡ FULL-RESTART completed
- [ ] ⚡ Both gateways healthy
- [ ] Endorser bot started with `--run_id q3-bt2s-bot-t{N}`
- [ ] ngrok tunnel running
- [ ] Rate 0.2: count=100, "BENCHMARK COMPLETE" on Quest 3
- [ ] Rate 1.0: count=60, "BENCHMARK COMPLETE" on Quest 3
- [ ] Rate 2.0: count=60, "BENCHMARK COMPLETE" on Quest 3
- [ ] 3 run directories created: `q3-r{02,10,20}-bt2s-t{N}`
- [ ] Bot stopped

### Phase 6 — Quest 3 BT=500ms (repeat for each trial)
- [ ] `./down.sh` completed (stop first, then edit config)
- [ ] BatchTimeout changed to 500ms in configtx.yaml
- [ ] `./up.sh` completed (regenerates with new config)
- [ ] ⚡ Both gateways healthy
- [ ] Endorser bot started with `--run_id q3-bt500-bot-t{N}`
- [ ] Quest 3 benchmark at rate=1.0, count=60
- [ ] Run directory: `q3-r10-bt500-t{N}`
- [ ] ⚡ After all 3 trials: revert BatchTimeout to 2s

### Phase 7 — Idle Baseline
- [ ] BatchTimeout reverted to 2s
- [ ] ⚡ FULL-RESTART completed
- [ ] 15 docker stats samples captured
- [ ] `runs/exp3-idle/docker_stats_idle.tsv` exists and has ≥ 60 lines

### Phase 8 — Final Verification
- [ ] Run the Phase 8 verification script
- [ ] W1 count = 15/15
- [ ] W2 count = 15/15
- [ ] Q3 BT=2s count = 9/9
- [ ] Q3 BT=500ms count = 3/3
- [ ] Exp 2 Fabric = 3/3
- [ ] Exp 2 Device reads = 4/4
- [ ] Exp 2 Device fills = 4/4
- [ ] Bot log directories present (spot-check: `ls runs/*bot*/`)
- [ ] Idle baseline present
- [ ] **Archive everything**: `tar czf experiments-final-$(date +%Y%m%d).tar.gz experiments/runs/`

### Fail-Fast Decision Tree

```
Gateway health check fails?
  → FULL-RESTART (./down.sh && ./up.sh), retry. If fails 3×, check docker/Fabric logs.

Bot SSE connection fails?
  → Check gateways first. If gateways OK, restart bot only.

Activation rate < 30% at rate ≤ 10?
  → STOP. Check bot logs (runs/exp1-w2-bot-t{N}/). Try --max_inflight 5.
  → If persists, FULL-RESTART.

Sweep exits with non-zero on one rate?
  → Check which rate failed. If gateway crashed, note it as data.
  → If Fabric crashed, FULL-RESTART and redo entire trial.

Quest 3 benchmark hangs (no "COMPLETE" after 15 min)?
  → Check ngrok tunnel. Check bot console for activity.
  → If tunnel died, restart ngrok, redo that run only.
```