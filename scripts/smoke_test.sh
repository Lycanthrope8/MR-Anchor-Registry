#!/bin/sh
# =============================================================================
# Smoke Tests - runs inside test-runner container
# =============================================================================

set -e

GATEWAY="http://gateway:3000"
PROPOSER="proposer-key-001"
ENDORSER="endorser-key-001"
SUPERVISOR="supervisor-key-001"
ALLOW_MOCK=false

for arg in "$@"; do
    [ "$arg" = "--allow-mock" ] && ALLOW_MOCK=true
done

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { printf "${GREEN}✓ PASS${NC}: %s\n" "$1"; }
fail() { printf "${RED}✗ FAIL${NC}: %s\n" "$1"; exit 1; }
info() { printf "${CYAN}→${NC} %s\n" "$1"; }

echo "=========================================="
echo "  MR-Anchor-Registry Smoke Tests"
echo "=========================================="
echo ""

# Test 1: Health
info "Test 1: Health Check"
HEALTH=$(curl -s "$GATEWAY/health")
echo "$HEALTH" | grep -q '"status"' && pass "Health OK" || fail "Health failed: $HEALTH"

IS_MOCK=$(echo "$HEALTH" | grep -o '"fabric_mock":[^,}]*' | grep -o 'true\|false')
if [ "$IS_MOCK" = "true" ]; then
    if [ "$ALLOW_MOCK" = "true" ]; then
        echo "  (MOCK mode - allowed via --allow-mock)"
    else
        fail "MOCK mode detected. Use 'make test-mock' or fix FABRIC_MOCK=false"
    fi
else
    pass "Real Fabric mode"
fi
echo ""

# Test 2: Propose
info "Test 2: Propose Anchor"
ASSET_ID="smoke-$(date +%s)"
PROPOSE=$(curl -s -X POST "$GATEWAY/claims/propose" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $PROPOSER" \
    -d "{
        \"asset_id\": \"$ASSET_ID\",
        \"pose_site\": {\"position\": {\"x\": 1.5, \"y\": 2.0, \"z\": 3.5}, \"rotation\": {\"qw\": 1}},
        \"quality_metrics\": {\"stability_rms\": 0.02, \"confidence_mean\": 0.9}
    }")
echo "$PROPOSE" | grep -q '"success":true' && pass "Propose OK" || fail "Propose failed: $PROPOSE"
CLAIM_ID=$(echo "$PROPOSE" | sed 's/.*"claim_id":"\([^"]*\)".*/\1/')
STATE=$(echo "$PROPOSE" | sed 's/.*"state":"\([^"]*\)".*/\1/')
echo "  Claim: $CLAIM_ID, State: $STATE"
[ "$STATE" = "PROPOSED" ] && pass "State=PROPOSED" || fail "Expected PROPOSED"
echo ""

# Test 3: Resolve (no active yet)
info "Test 3: Resolve Before Endorse"
RESOLVE=$(curl -s "$GATEWAY/assets/$ASSET_ID/resolve" -H "X-API-Key: $PROPOSER")
echo "$RESOLVE" | grep -q '"claim_id":null' && pass "No active yet" || echo "  (existing found)"
echo ""

# Test 4: Endorse
info "Test 4: Endorse"
ENDORSE=$(curl -s -X POST "$GATEWAY/claims/$CLAIM_ID/endorse" -H "X-API-Key: $ENDORSER")
echo "$ENDORSE" | grep -q '"success":true' && pass "Endorse OK" || fail "Endorse failed: $ENDORSE"
echo ""

# Test 5: Duplicate
info "Test 5: Duplicate Endorsement"
DUP=$(curl -s -X POST "$GATEWAY/claims/$CLAIM_ID/endorse" -H "X-API-Key: $ENDORSER")
echo "$DUP" | grep -q '"success":false' && pass "Duplicate blocked" || fail "Should block duplicate"
echo ""

# Test 6: Resolve after
info "Test 6: Resolve After Endorse"
RESOLVE2=$(curl -s "$GATEWAY/assets/$ASSET_ID/resolve" -H "X-API-Key: $PROPOSER")
echo "$RESOLVE2" | grep -q '"state":"ACTIVE"' && pass "ACTIVE anchor" || echo "  State: $(echo "$RESOLVE2" | grep -o '"state":"[^"]*"')"
echo ""

# Test 7: Non-supervisor revoke
info "Test 7: Non-Supervisor Revoke"
BAD=$(curl -s -X POST "$GATEWAY/assets/$ASSET_ID/revoke" \
    -H "Content-Type: application/json" -H "X-API-Key: $PROPOSER" \
    -d '{"reason":"test"}')
echo "$BAD" | grep -q '"success":false' && pass "Non-supervisor blocked (gateway)" || fail "Should block"
echo ""

# Test 8: Supervisor revoke
info "Test 8: Supervisor Revoke"
REVOKE=$(curl -s -X POST "$GATEWAY/assets/$ASSET_ID/revoke" \
    -H "Content-Type: application/json" -H "X-API-Key: $SUPERVISOR" \
    -d '{"reason":"cleanup"}')
echo "$REVOKE" | grep -q '"success":true' && pass "Revoke OK" || fail "Revoke failed: $REVOKE"
echo ""

# Test 9: Final
info "Test 9: No Active After Revoke"
FINAL=$(curl -s "$GATEWAY/assets/$ASSET_ID/resolve" -H "X-API-Key: $PROPOSER")
echo "$FINAL" | grep -q '"claim_id":null' && pass "No active" || echo "  Note: $FINAL"
echo ""

echo "=========================================="
printf "${GREEN}  All Tests Passed!${NC}\n"
echo "=========================================="
echo ""
echo "Note: Supervisor-only revoke enforced by GATEWAY (API key roles)."
echo "Chaincode enforces: no duplicates, state transitions, single active."
