# Experiment Runbook — ICCCN Paper

## "Blockchain-Based Spatial Registry and Management in Multi-User Mixed Reality"

---

# Part A: System & Setup Table (for the paper)

Include this as a table in Section V of the paper, following AIGC-CM Table III.

| Parameter           | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Blockchain          | Hyperledger Fabric v2.4, Raft orderer                                       |
| Organizations       | 2 (Org1, Org2), 1 peer each                                                 |
| State Database      | CouchDB (per peer)                                                          |
| BatchTimeout        | 2s (default), 500ms (tuned)                                                 |
| MaxMessageCount     | 10                                                                          |
| Endorsement Policy  | Fabric tx: OR(Org1MSP, Org2MSP); Governance: dual-org approval in chaincode |
| Chaincode           | anchor-registry, ~800 LOC JavaScript                                        |
| Gateway             | Node.js, Express, Fabric Gateway SDK, SSE broadcast                         |
| Client Device       | Meta Quest 3, Unity 2022 LTS                                                |
| Server              | MacBook (Apple Silicon), 8GB Docker allocation                              |
| Network (Exp 1,2,3) | localhost (laptop → gateway → Fabric)                                     |
| Network (Exp 4)     | ngrok tunnel (Quest 3 → WAN → gateway → Fabric)                          |
| Operations          | ProposeAnchor, EndorseClaim, RevokeAnchor, EndorseRevoke                    |
| Repetitions         | 3 per configuration (minimum)                                               |

---

# Part B: Experiment Procedures

---

## Experiment 1 — Load Scaling (Write-Path)

**Research question:** "What throughput can the system sustain, and how does latency behave as offered load increases?"

**What it proves to reviewers:** The system handles realistic MR anchor rates (1–10 ops/sec) with 100% success and bounded latency. At high load the gateway becomes the bottleneck, revealing the system's saturation point.

**Analogous to:** AIGC-CM Fig 6(a) OPPS vs OPRR, Fig 6(b) OPT vs OPRR

### Setup

**Terminals required:** 2 for W1 (propose-only), 3 for W2 (lifecycle)

| Terminal | Process                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| T1       | Gateway Org1:`ORG=org1 PORT=3000 node gateway/src/server.js`                                                                |
| T2       | Gateway Org2:`ORG=org2 PORT=3001 node gateway/src/server.js`                                                                |
| T3       | Load generator (runs from `experiments/` directory)                                                                         |
| T4       | Endorser bot (W2 only):`node endorser_bot.js --gateway_org1 http://localhost:3000 --gateway_org2 http://localhost:3001 ...` |

### Workload W1 — Propose-Only

This isolates Fabric write throughput without endorsement overhead.

**Step 1.** Start both gateways (T1 and T2):

```bash
# T1:
ORG=org1 PORT=3000 node gateway/src/server.js

# T2:
ORG=org2 PORT=3001 node gateway/src/server.js
```

**Step 2.** Verify no endorser bot is running (important — bot contaminates propose-only latency).

**Step 3.** Run the sweep (T2):

```bash
cd experiments
WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh --gateway http://localhost:3000 --docker --tag w1-trial1
```

**Step 4.** Repeat 2 more times with different tags:

```bash
WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh --gateway http://localhost:3000 --docker --tag w1-trial2

WORKLOADS="propose" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh --gateway http://localhost:3000 --docker --tag w1-trial3
```

**Step 5.** If gateway crashes during a sweep (expected at high rates), note which rate it crashed at. This is a finding. Restart gateway before next trial.

### Workload W2 — Full Lifecycle (Propose → Endorse×2 → Active)

Run this as a **separate sweep** from W1 to avoid backlog contamination.

**Step 1.** Restart gateways fresh:

```bash
# T1: ORG=org1 PORT=3000 node gateway/src/server.js
# T2: ORG=org2 PORT=3001 node gateway/src/server.js
```

**Step 2.** Start endorser bot (T3):

```bash
cd experiments
node endorser_bot.js --gateway_org1 http://localhost:3000 --gateway_org2 http://localhost:3001 --run_id exp1-w2 --mode two-step
```

**Step 3.** Run lifecycle sweep (T2):

```bash
cd experiments
WORKLOADS="lifecycle" RATES="1 5 10 20 50" DURATION=60 WARMUP=5 \
  ./run_exp1_sweep.sh --gateway http://localhost:3000 --docker --tag w2-trial1
```

**Step 4.** Stop endorser bot (Ctrl+C). Restart gateway. Start fresh endorser bot. Repeat for trial2, trial3.

### Metrics Collected

| Metric                         | Source                      | Unit    |
| ------------------------------ | --------------------------- | ------- |
| Throughput (successful tx/sec) | load_generator_summary.json | ops/sec |
| Propose RTT (p50, p95, p99)    | load_generator_summary.json | ms      |
| Commit-confirmed latency (W2)  | load_generator_summary.json | ms      |
| Success rate                   | load_generator_summary.json | %       |
| Error categories               | load_generator_summary.json | count   |
| Peak in-flight concurrency     | load_generator_summary.json | count   |
| Docker CPU/mem per container   | docker_stats.jsonl          | %, MiB  |

### Plots for the Paper

1. **Throughput vs offered load** — x: target rate (1,5,10,20,50), y: actual throughput. Two lines: W1 (propose) and W2 (lifecycle). Error bars from 3 trials.
2. **Latency (p50/p95) vs offered load** — x: target rate, y: latency in ms. Shows when system saturates.
3. **Success rate vs offered load** — x: target rate, y: %. Shows graceful vs cliff degradation.

### Key Paper Sentences

- "Load scaling experiments were conducted from a laptop client to isolate Fabric throughput from device network variability."
- Report the natural saturation point (gateway crash) as: "The system sustains N ops/sec for full lifecycle governance; beyond this, the Node.js gateway exhausts Fabric peer connections."
- At 50 ops/sec: "CouchDB reached 83% CPU utilization, identifying the state database as the primary scalability bottleneck."

---

## Experiment 2 — Dataset Scaling (Read-Path)

**Research question:** "Does read performance degrade as anchors accumulate on the ledger?"

**What it proves:** A joining MR device can catch up to the shared state in bounded time even at scale.

**Analogous to:** AIGC-CM Fig 6(c) OPT vs dataset size

### Prerequisites

Write a pre-fill script (adapt from load_generator.js) that proposes + endorses N anchors to ACTIVE state.

### Procedure

**Step 1.** Start gateway + endorser bot.

**Step 2.** Pre-fill to target N. Between each tier, benchmark reads:

| Tier | Active Anchors | Pre-fill Needed |
| ---- | -------------- | --------------- |
| T1   | 10             | 10 new          |
| T2   | 100            | 90 more         |
| T3   | 500            | 400 more        |
| T4   | 1000           | 500 more        |

**Step 3.** At each tier, benchmark read endpoints (20 iterations each):

```bash
# Snapshot (GET /events/snapshot)
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total}\n" http://localhost:3000/events/snapshot
done

# All anchors (GET /admin/anchors)
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total}\n" http://localhost:3000/admin/anchors
done
```

Also record response payload size at each tier.

**Step 4.** Repeat the full sequence 3 times (requires clearing ledger or using different prefixes).

### Metrics Collected

| Metric                                | Unit  |
| ------------------------------------- | ----- |
| Snapshot latency (p50, p95) at each N | ms    |
| Snapshot payload size at each N       | KB    |
| All-anchors query latency at each N   | ms    |
| Bytes per anchor (payload / N)        | bytes |

### Plots

1. **Read latency vs anchor count** — x: N (10,100,500,1000), y: latency. Two lines: snapshot and anchors query.
2. **Payload size vs anchor count** — x: N, y: KB. Should show linear growth (~215 bytes/anchor from Run 2 data).

### Key Paper Sentence

- "Snapshot catch-up latency grows linearly at ~215 bytes per anchor. At 1000 anchors, a joining device retrieves the complete shared state in <Xms with a ~215KB payload."

---

## Experiment 3 — Resource Overhead ("Cost of Trust")

**Research question:** "What resource overhead does blockchain governance impose on the MR device and server infrastructure?"

**What it proves:** Governance adds zero measurable FPS impact. Server costs are bounded and CouchDB is the bottleneck.

**Analogous to:** AIGC-CM Fig 8 (resource consumption). Your FPS data has no analogue in AIGC-CM — this is novel.

### Device-Side (Quest 3) — Already Collected in Run 2

| Metric        | Baseline      | Active           | p-value |
| ------------- | ------------- | ---------------- | ------- |
| FPS           | 69.06 ± 1.35 | 69.32 ± 1.48    | 0.432   |
| Memory growth | —            | ~1.6 MB over 94s | —      |

This data comes from Experiment 4 runs. No additional Quest 3 runs needed unless you want more trials.

### Server-Side — Collected During Exp 1

Docker stats are already captured in Exp 1 runs (`docker_stats.jsonl`). Extract:

| Container      | Idle CPU | CPU at 1 ops/s | CPU at 10 ops/s | CPU at 50 ops/s |
| -------------- | -------- | -------------- | --------------- | --------------- |
| CouchDB (org1) | —       | —             | —              | 81.6%           |
| CouchDB (org2) | —       | —             | —              | 83.4%           |
| Peer (org1)    | —       | —             | —              | 34.5%           |
| Peer (org2)    | —       | —             | —              | 36.7%           |
| Orderer        | —       | —             | —              | 15.3%           |

### Additional Data Needed

**Idle baseline:** Run docker stats for 30 seconds with gateway running but no load, to establish idle resource consumption.

```bash
# 30-second idle baseline
for i in $(seq 1 15); do
  docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" >> idle_baseline.tsv
  sleep 2
done
```

### Plots

1. **FPS: Baseline vs Active** — bar chart with error bars, p-value annotation. Headline result.
2. **Server CPU vs load level** — grouped bar chart: containers × load levels (idle, 1, 10, 50 ops/sec). Shows CouchDB as bottleneck.
3. **Server memory vs load level** — same structure.

### Key Paper Sentences

- "Blockchain governance imposes zero measurable FPS impact on Meta Quest 3 (p = 0.432, two-sample t-test)."
- "At 50 ops/sec, CouchDB state database utilization reached 83%, identifying it as the primary scalability ceiling."

---

## Experiment 4 — Commit-Confirmed Latency (End-to-End from Quest 3)

**Research question:** "How long from when a Quest 3 user places an anchor until it is globally confirmed on the blockchain?"

**What it proves:** End-to-end latency is bounded and predictable, dominated by a tunable Fabric parameter (BatchTimeout). This is your strongest experiment — real device data that AIGC-CM doesn't have.

**Analogous to:** AIGC-CM Fig 7(c) OPT CDF

### Existing Data (Run 2, BatchTimeout=2s, 1 ops/sec)

| Metric             | Value           |
| ------------------ | --------------- |
| Commit-confirm p50 | 5,332 ms        |
| Commit-confirm p95 | 6,295 ms        |
| HTTP propose RTT   | 1,235 ± 613 ms |
| Endorsement cycle  | 4,121 ± 25 ms  |
| SSE delivery       | 4 ± 6 ms       |
| Baseline FPS       | 69.06 ± 1.35   |
| Active FPS         | 69.32 ± 1.48   |

### Procedure — Multi-Rate Runs (BatchTimeout = 2s)

All runs from Quest 3 via ngrok tunnel.

**Step 1.** Start gateway, endorser bot.

**Step 2.** On Quest 3, configure BenchmarkModeController:

- `proposalRate = 0.2`, `proposalCount = 20`, `runId = "exp4-r02-trial1"`
- Run benchmark. Wait for upload.

**Step 3.** Repeat at rate 1.0 (count=50) and rate 2.0 (count=100).

**Step 4.** Repeat each rate 3 times with different runId.

### Procedure — BatchTimeout = 500ms

**Step 5.** Stop Fabric network.

**Step 6.** Edit `network/configtx/configtx.yaml`:

```yaml
Orderer:
    BatchTimeout: 500ms    # was 2s
```

**Step 7.** Regenerate channel artifacts and restart Fabric network. Verify with a test proposal.

**Step 8.** Run at rate 1.0 ops/sec (count=50), 3 trials.

### Procedure — Observer Device (Optional, P2)

**Step 9.** Start second Quest 3 (or Unity Editor) with BenchmarkObserverController, same runId, lane B.

**Step 10.** Run benchmark on Device A (lane A). Device B logs when it receives each CLAIM_ACTIVATED via SSE. This gives true cross-device time-to-consistency.

### Metrics Collected

| Metric                                        | Source                                |
| --------------------------------------------- | ------------------------------------- |
| Commit-confirmed latency (send → SSE ACTIVE) | device_sse_event_logs.jsonl           |
| HTTP propose RTT                              | device_request_logs.jsonl             |
| Endorsement cycle time                        | SSE PROPOSED → ACTIVATED delta       |
| SSE delivery latency                          | device logs                           |
| FPS baseline vs active                        | device_frame_logs.jsonl               |
| Latency decomposition                         | cross-reference gateway + device logs |

### Plots

1. **CDF of commit-confirmed latency** — one line per rate (0.2, 1.0, 2.0 ops/sec), all at BatchTimeout=2s.
2. **Latency decomposition stacked bar** — HTTP RTT | Endorse Org1 | Endorse Org2, showing BatchTimeout dominance.
3. **BatchTimeout comparison** — CDF or bar chart: 2s vs 500ms at 1 ops/sec. This turns a weakness ("5.3s is slow") into a strength ("latency is tunable").
4. **FPS baseline vs active** — bar chart with p-value (shared with Exp 3).

### Key Paper Sentences

- "End-to-end commit-confirmed latency at 1 ops/sec is 5.3s (p50), decomposing into 1.2s HTTP round-trip and 4.1s endorsement cycle (2× Fabric BatchTimeout)."
- "Reducing BatchTimeout from 2s to 500ms decreases commit-confirmed latency to ~Xs, demonstrating that governance latency is a tunable deployment parameter, not a fundamental limitation."
- "The endorsement cycle exhibits remarkably low variance (σ = 25ms), confirming that latency is deterministic and predictable for MR applications."

---

# Part C: Updated Experiment Assessment

## Status After Exp 1 Sweep

| Experiment                         | Before This Work | After Sweep   | Remaining                                                                           |
| ---------------------------------- | ---------------- | ------------- | ----------------------------------------------------------------------------------- |
| **Exp 1: Load Scaling**      | 20%              | **75%** | Re-run W1 without endorser bot (3 trials), re-run W2 (2 more trials for statistics) |
| **Exp 2: Dataset Scaling**   | 30%              | 30%           | Write pre-fill script, run full benchmark                                           |
| **Exp 3: Resource Overhead** | 40%              | **60%** | Docker stats captured in Exp 1; need idle baseline + analysis                       |
| **Exp 4: Commit-Confirmed**  | 70%              | 70%           | Multi-rate from Quest 3, BatchTimeout=500ms run                                     |

## What the W2-Clean Sweep Confirmed

The lifecycle results are clean and show an excellent story:

| Rate | Throughput | Success | Commit-Confirm p50 | Activations  |
| ---- | ---------- | ------- | ------------------ | ------------ |
| 1    | 0.96       | 100%    | 8,180 ms           | 60/60 ✓     |
| 5    | 4.98       | 100%    | 2,048 ms           | 300/300 ✓   |
| 10   | 9.27       | 99.8%   | 2,044 ms           | 599/599 ✓   |
| 20   | 19.35      | 100%    | 2,025 ms           | 1200/1200 ✓ |
| 50   | 48.64      | 100%    | 2,017 ms*          | 262/3000 ⚠  |

*r50 commit-confirm based on only 16 measured activations (endorser bot backlog) — report this honestly.

**Key finding:** Commit-confirm latency *decreases* from 8.2s at 1 ops/sec to 2.0s at 20+ ops/sec. This is because batch aggregation becomes efficient — at higher rates, proposals and endorsements land in the same block window, eliminating wait time. This is a genuinely interesting result for the paper.

---

# Part D: Next 3 Things To Do (Priority Order)

### 1. Write the Pre-Fill Script for Experiment 2 (~30 min coding)

**Why first:** This is the only experiment with zero usable data and it needs a new script. Adapt from `load_generator.js` — propose N anchors and wait for all to reach ACTIVE (use endorser bot). Then benchmark read endpoints at each tier (10, 100, 500, 1000 anchors).

**Deliverable:** `prefill_and_benchmark.js` that does both the filling and the read benchmarking in one run.

### 2. Run Experiment 4 Multi-Rate + BatchTimeout from Quest 3 (~1 hour)

**Why second:** This is your strongest experiment and it's 70% done. You need:

- Run at 0.2 and 2.0 ops/sec (5 min each)
- Change BatchTimeout to 500ms, re-run at 1.0 ops/sec (20 min including config change)
- Repeat each config 2 more times (30 min)

**Deliverable:** 9+ device log files ready for analysis.

### 3. Run Clean Exp 1 W1 (Propose-Only Without Endorser Bot) (~20 min)

**Why third:** Your current W1 data has the endorser bot contaminating rate=1 results (p50=4,089ms instead of expected ~2,000ms). One clean sweep with endorser bot OFF gives you the correct propose-only baseline.

```bash
# Make sure NO endorser bot is running!
WORKLOADS="propose" RATES="1 5 10 20 50" \
  ./run_exp1_sweep.sh --gateway http://localhost:3000 --docker --tag w1-clean
```

**Deliverable:** Clean W1 data with rate=1 showing p50 ≈ 2,000ms (1× BatchTimeout).

---

After these 3 items, you'll have enough data for all 4 experiments. The remaining work is analysis and plot generation.