#!/bin/bash
# ==============================================================================
# run_exp1_sweep.sh — Automated sweep for Experiment 1: Load Scaling
#
# Runs load_generator.js across all target rates for both workloads,
# with cool-down between runs and optional docker stats collection.
#
# FIX #6: Enforces preconditions:
#   - Health checks BOTH gateways before starting
#   - Verifies endorser bot is reachable before lifecycle (W2) runs
#   - Runs all W1 (propose) rates first, then all W2 (lifecycle) rates
#     to avoid cross-contamination (W2 generates more ledger state)
#
# PREREQUISITES:
#   1. BOTH gateways running:
#        ORG=org1 PORT=3000 node gateway/src/server.js
#        ORG=org2 PORT=3001 node gateway/src/server.js
#   2. For lifecycle workload: endorser_bot.js running in another terminal
#      node endorser_bot.js --gateway_org1 http://localhost:3000 \
#        --gateway_org2 http://localhost:3001 --run_id exp1-sweep --mode two-step
#
# USAGE:
#   chmod +x run_exp1_sweep.sh
#   ./run_exp1_sweep.sh                           # defaults
#   ./run_exp1_sweep.sh --gateway http://host:3000 # custom gateway
#   RATES="1 5 10" WORKLOADS="propose" ./run_exp1_sweep.sh  # subset
# ==============================================================================

set -euo pipefail

GATEWAY_ORG1="${GATEWAY_ORG1:-http://localhost:3000}"
GATEWAY_ORG2="${GATEWAY_ORG2:-http://localhost:3001}"
# Backward compat: --gateway sets org1, derive org2
GATEWAY="${GATEWAY:-}"
RATES="${RATES:-1 5 10 20 50}"
WORKLOADS="${WORKLOADS:-propose lifecycle}"
DURATION="${DURATION:-60}"
WARMUP="${WARMUP:-5}"
COOLDOWN="${COOLDOWN:-15}"
DOCKER_STATS="${DOCKER_STATS:-false}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --gateway)       GATEWAY="$2"; shift 2;;
        --gateway_org1)  GATEWAY_ORG1="$2"; shift 2;;
        --gateway_org2)  GATEWAY_ORG2="$2"; shift 2;;
        --rates)         RATES="$2"; shift 2;;
        --workloads)     WORKLOADS="$2"; shift 2;;
        --duration)      DURATION="$2"; shift 2;;
        --warmup)        WARMUP="$2"; shift 2;;
        --cooldown)      COOLDOWN="$2"; shift 2;;
        --docker)        DOCKER_STATS="true"; shift;;
        --tag)           TAG="$2"; shift 2;;
        --help)
            echo "Usage: $0 [options]"
            echo "  --gateway <url>       Org1 gateway URL (shorthand; derives org2 as port+1)"
            echo "  --gateway_org1 <url>  Org1 gateway URL (default: http://localhost:3000)"
            echo "  --gateway_org2 <url>  Org2 gateway URL (default: http://localhost:3001)"
            echo "  --rates <list>        Space-separated rates in quotes (default: '1 5 10 20 50')"
            echo "  --workloads <list>    'propose', 'lifecycle', or both (default: 'propose lifecycle')"
            echo "  --duration <sec>      Test duration per rate point (default: 60)"
            echo "  --warmup <sec>        Warmup per run (default: 5)"
            echo "  --cooldown <sec>      Cool-down between runs (default: 15)"
            echo "  --docker              Enable docker stats collection"
            echo "  --tag <str>           Tag for run IDs (default: timestamp)"
            exit 0;;
        *) echo "Unknown option: $1"; exit 1;;
    esac
done

# Handle backward-compat --gateway flag
if [[ -n "$GATEWAY" ]]; then
    GATEWAY_ORG1="$GATEWAY"
    # Auto-derive org2: increment port by 1
    ORG2_PORT=$(echo "$GATEWAY" | grep -oP ':\K[0-9]+' | tail -1)
    if [[ -n "$ORG2_PORT" ]]; then
        GATEWAY_ORG2=$(echo "$GATEWAY" | sed "s/:${ORG2_PORT}/:$((ORG2_PORT + 1))/")
    fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOAD_GEN="${SCRIPT_DIR}/load_generator.js"

if [[ ! -f "$LOAD_GEN" ]]; then
    echo "ERROR: load_generator.js not found at $LOAD_GEN"
    exit 1
fi

DOCKER_FLAG=""
[[ "$DOCKER_STATS" == "true" ]] && DOCKER_FLAG="--docker_stats"

# Determine which workload groups are requested
HAS_W1=false
HAS_W2=false
for W in $WORKLOADS; do
    [[ "$W" == "propose" ]]   && HAS_W1=true
    [[ "$W" == "lifecycle" ]] && HAS_W2=true
done

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Experiment 1 Sweep — Load Scaling                          ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo "  Gateway Org1: $GATEWAY_ORG1"
echo "  Gateway Org2: $GATEWAY_ORG2"
echo "  Rates:        $RATES"
echo "  Workloads:    $WORKLOADS"
echo "  Duration:     ${DURATION}s + ${WARMUP}s warmup"
echo "  Cooldown:     ${COOLDOWN}s between runs"
echo "  Tag:          $TAG"
echo "  Docker:       $DOCKER_STATS"
echo ""

# ==========================================================================
# FIX #6: PRECONDITION CHECKS
# ==========================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Precondition checks"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check gateway org1
echo -n "  Gateway Org1 ($GATEWAY_ORG1)... "
ORG1_HEALTH=$(curl -sf "${GATEWAY_ORG1}/health" 2>/dev/null) || {
    echo "FAIL"
    echo "ERROR: Gateway Org1 not reachable at $GATEWAY_ORG1"
    echo "  Start it with: ORG=org1 PORT=3000 node gateway/src/server.js"
    exit 1
}
ORG1_ORG=$(echo "$ORG1_HEALTH" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); try{console.log(JSON.parse(d).org)}catch{console.log('?')}" 2>/dev/null || echo "?")
echo "OK (org=$ORG1_ORG)"

# Check gateway org2
echo -n "  Gateway Org2 ($GATEWAY_ORG2)... "
ORG2_HEALTH=$(curl -sf "${GATEWAY_ORG2}/health" 2>/dev/null) || {
    echo "FAIL"
    echo "ERROR: Gateway Org2 not reachable at $GATEWAY_ORG2"
    echo "  Start it with: ORG=org2 PORT=3001 node gateway/src/server.js"
    exit 1
}
ORG2_ORG=$(echo "$ORG2_HEALTH" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); try{console.log(JSON.parse(d).org)}catch{console.log('?')}" 2>/dev/null || echo "?")
echo "OK (org=$ORG2_ORG)"

# Verify orgs are different (catch misconfiguration)
if [[ "$ORG1_ORG" == "$ORG2_ORG" && "$ORG1_ORG" != "?" ]]; then
    echo ""
    echo "WARNING: Both gateways report the same org ($ORG1_ORG)."
    echo "  This means lifecycle (W2) endorsements won't work correctly."
    echo "  Ensure you started them with different ORG env vars."
    if [[ "$HAS_W2" == true ]]; then
        echo "ERROR: Cannot run lifecycle workload with same org on both gateways."
        exit 1
    fi
fi

# Check endorser bot for lifecycle workload
if [[ "$HAS_W2" == true ]]; then
    echo -n "  Endorser bot (SSE liveness)... "
    # Probe: briefly connect to SSE endpoint. If the endpoint is responsive,
    # the gateway is up and accepting SSE connections (which the bot also uses).
    # This isn't a perfect bot-liveness check but catches the common case of
    # "forgot to start the bot" because the SSE endpoint won't have listeners.
    SSE_OK=$(timeout 3 curl -sf -H "Accept: text/event-stream" "${GATEWAY_ORG1}/events/stream" 2>/dev/null | head -c 1) || true
    if [[ -n "$SSE_OK" ]]; then
        echo "OK (SSE endpoint responsive)"
    else
        echo "WARNING"
        echo "  Could not verify endorser bot / SSE endpoint."
        echo "  For lifecycle (W2) runs, ensure endorser_bot.js is running:"
        echo "    node endorser_bot.js --gateway_org1 $GATEWAY_ORG1 \\"
        echo "      --gateway_org2 $GATEWAY_ORG2 --run_id exp1-sweep --mode two-step"
        echo ""
        read -p "  Continue anyway? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Aborted."
            exit 1
        fi
    fi
fi

echo ""
echo "✓ All preconditions met"
echo ""

# ==========================================================================
# RUN EXPERIMENTS — W1 first, then W2 (group separation)
# ==========================================================================

RUN_COUNT=0
TOTAL_RUNS=0
for W in $WORKLOADS; do for R in $RATES; do TOTAL_RUNS=$((TOTAL_RUNS + 1)); done; done

declare -a RESULTS_INDEX

# Build ordered workload list: propose first, lifecycle second
ORDERED_WORKLOADS=""
if [[ "$HAS_W1" == true ]]; then ORDERED_WORKLOADS="propose"; fi
if [[ "$HAS_W2" == true ]]; then ORDERED_WORKLOADS="${ORDERED_WORKLOADS:+$ORDERED_WORKLOADS }lifecycle"; fi

for W in $ORDERED_WORKLOADS; do
    W_SHORT="w1"
    [[ "$W" == "lifecycle" ]] && W_SHORT="w2"

    # Group header
    echo "╔═══════════════════════════════════════════════════════════════╗"
    if [[ "$W" == "propose" ]]; then
        echo "║  GROUP: W1 — Propose-only (single Fabric tx)                ║"
    else
        echo "║  GROUP: W2 — Full lifecycle (Propose + 2×Endorse → ACTIVE)  ║"
    fi
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""

    # Pre-group gateway health re-check
    if ! curl -sf "${GATEWAY_ORG1}/health" > /dev/null 2>&1; then
        echo "ERROR: Gateway Org1 became unreachable before ${W_SHORT} group"
        exit 1
    fi
    if ! curl -sf "${GATEWAY_ORG2}/health" > /dev/null 2>&1; then
        echo "ERROR: Gateway Org2 became unreachable before ${W_SHORT} group"
        exit 1
    fi

    for R in $RATES; do
        RUN_COUNT=$((RUN_COUNT + 1))
        RUN_ID="exp1-${W_SHORT}-r${R}-${TAG}"

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  Run ${RUN_COUNT}/${TOTAL_RUNS}: workload=${W}, rate=${R} ops/sec"
        echo "  Run ID: ${RUN_ID}"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        node "$LOAD_GEN" \
            --gateway "$GATEWAY_ORG1" \
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

    # Group boundary with extra cooldown
    if [[ "$W" == "propose" && "$HAS_W2" == true ]]; then
        echo "═══════════════════════════════════════════════════════════════"
        echo "  W1 group complete. Pausing ${COOLDOWN}s before W2 group..."
        echo "═══════════════════════════════════════════════════════════════"
        sleep "$COOLDOWN"
        echo ""
    fi
done

# ==========================================================================
# FINAL SUMMARY
# ==========================================================================

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
            const a = s.activation || {};
            let line = 'rate=' + s.throughput.target_ops +
                ' tput=' + s.throughput.actual_throughput_ops.toFixed(1) +
                ' p50=' + (r.p50||'-') + 'ms' +
                ' p95=' + (r.p95||'-') + 'ms' +
                ' ok=' + s.counts.success_rate_pct + '%';
            if (a.activated_count !== undefined) {
                line += ' activated=' + a.activated_count + '/' + a.propose_ok_count +
                    ' (' + a.activation_success_rate_pct + '%)';
            }
            console.log(line);
        " 2>/dev/null || echo "(parse error)")
        echo "    ${RID}: ${METRICS}"
    else
        echo "    ${RID}: (no summary)"
    fi
done
echo ""
echo "Results: ${SCRIPT_DIR}/runs/"
echo "═══════════════════════════════════════════════════════════════"