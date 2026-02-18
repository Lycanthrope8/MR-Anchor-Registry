#!/bin/bash
# ==============================================================================
# run_exp1_sweep.sh — Automated sweep for Experiment 1: Load Scaling
#
# Runs load_generator.js across all target rates for both workloads,
# with cool-down between runs and optional docker stats collection.
#
# PREREQUISITES:
#   1. Gateway running: cd gateway && node src/server.js
#   2. For lifecycle workload: endorser_bot.js running in another terminal
#      node endorser_bot.js --gateway http://localhost:3000 --run_id exp1-sweep --mode two-step
#
# USAGE:
#   chmod +x run_exp1_sweep.sh
#   ./run_exp1_sweep.sh                           # defaults
#   ./run_exp1_sweep.sh --gateway http://host:3000 # custom gateway
#   RATES="1 5 10" WORKLOADS="propose" ./run_exp1_sweep.sh  # subset
# ==============================================================================

set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:3000}"
RATES="${RATES:-1 5 10 20 50}"
WORKLOADS="${WORKLOADS:-propose lifecycle}"
DURATION="${DURATION:-60}"
WARMUP="${WARMUP:-5}"
COOLDOWN="${COOLDOWN:-15}"
DOCKER_STATS="${DOCKER_STATS:-false}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --gateway)    GATEWAY="$2"; shift 2;;
        --rates)      RATES="$2"; shift 2;;
        --workloads)  WORKLOADS="$2"; shift 2;;
        --duration)   DURATION="$2"; shift 2;;
        --warmup)     WARMUP="$2"; shift 2;;
        --cooldown)   COOLDOWN="$2"; shift 2;;
        --docker)     DOCKER_STATS="true"; shift;;
        --tag)        TAG="$2"; shift 2;;
        --help)
            echo "Usage: $0 [options]"
            echo "  --gateway <url>     Gateway URL (default: http://localhost:3000)"
            echo "  --rates <list>      Space-separated rates in quotes (default: '1 5 10 20 50')"
            echo "  --workloads <list>  'propose', 'lifecycle', or both (default: 'propose lifecycle')"
            echo "  --duration <sec>    Test duration per rate point (default: 60)"
            echo "  --warmup <sec>      Warmup per run (default: 5)"
            echo "  --cooldown <sec>    Cool-down between runs (default: 15)"
            echo "  --docker            Enable docker stats collection"
            echo "  --tag <str>         Tag for run IDs (default: timestamp)"
            exit 0;;
        *) echo "Unknown option: $1"; exit 1;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOAD_GEN="${SCRIPT_DIR}/load_generator.js"

if [[ ! -f "$LOAD_GEN" ]]; then
    echo "ERROR: load_generator.js not found at $LOAD_GEN"
    exit 1
fi

DOCKER_FLAG=""
[[ "$DOCKER_STATS" == "true" ]] && DOCKER_FLAG="--docker_stats"

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Experiment 1 Sweep — Load Scaling                          ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo "  Gateway:    $GATEWAY"
echo "  Rates:      $RATES"
echo "  Workloads:  $WORKLOADS"
echo "  Duration:   ${DURATION}s + ${WARMUP}s warmup"
echo "  Cooldown:   ${COOLDOWN}s between runs"
echo "  Tag:        $TAG"
echo "  Docker:     $DOCKER_STATS"
echo ""

echo "Checking gateway health..."
if ! curl -sf "${GATEWAY}/health" > /dev/null 2>&1; then
    echo "ERROR: Gateway not reachable at $GATEWAY"
    exit 1
fi
echo "✓ Gateway healthy"
echo ""

RUN_COUNT=0
TOTAL_RUNS=0
for W in $WORKLOADS; do for R in $RATES; do TOTAL_RUNS=$((TOTAL_RUNS + 1)); done; done

declare -a RESULTS_INDEX

for W in $WORKLOADS; do
    W_SHORT="w1"
    [[ "$W" == "lifecycle" ]] && W_SHORT="w2"

    for R in $RATES; do
        RUN_COUNT=$((RUN_COUNT + 1))
        RUN_ID="exp1-${W_SHORT}-r${R}-${TAG}"

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  Run ${RUN_COUNT}/${TOTAL_RUNS}: workload=${W}, rate=${R} ops/sec"
        echo "  Run ID: ${RUN_ID}"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        node "$LOAD_GEN" \
            --gateway "$GATEWAY" \
            --run_id "$RUN_ID" \
            --rate "$R" \
            --duration "$DURATION" \
            --workload "$W" \
            --warmup "$WARMUP" \
            --lane A \
            $DOCKER_FLAG || echo "WARNING: Run ${RUN_ID} exited with non-zero"

        RESULTS_INDEX+=("$RUN_ID")

        if [[ $RUN_COUNT -lt $TOTAL_RUNS ]]; then
            echo ""
            echo "Cool-down: ${COOLDOWN}s..."
            sleep "$COOLDOWN"
        fi
        echo ""
    done
done

echo "═══════════════════════════════════════════════════════════════"
echo "  SWEEP COMPLETE — ${#RESULTS_INDEX[@]} runs"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Run IDs:"
for RID in "${RESULTS_INDEX[@]}"; do
    SUMMARY="${SCRIPT_DIR}/runs/${RID}/load_generator_summary.json"
    if [[ -f "$SUMMARY" ]]; then
        METRICS=$(node -e "
            const s = require('${SUMMARY}');
            const r = s.propose_rtt || {};
            console.log('rate=' + s.throughput.target_ops +
                ' tput=' + s.throughput.actual_throughput_ops.toFixed(1) +
                ' p50=' + (r.p50||'-') + 'ms' +
                ' p95=' + (r.p95||'-') + 'ms' +
                ' ok=' + s.counts.success_rate_pct + '%');
        " 2>/dev/null || echo "(parse error)")
        echo "    ${RID}: ${METRICS}"
    else
        echo "    ${RID}: (no summary)"
    fi
done
echo ""
echo "Results: ${SCRIPT_DIR}/runs/"
echo "═══════════════════════════════════════════════════════════════"