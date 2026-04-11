#!/bin/bash
# ==============================================================================
# annotation_gateway_test.sh - Week 2 Gateway Integration Test
#
# Tests the full annotation pipeline through the gateway REST API:
#   Mock generator → Gateway → Fabric chaincode → SSE
#
# Prerequisites:
#   1. Fabric network running with v2.0 chaincode (Week 1)
#   2. Mock annotation service running on port 5001
#   3. Org1 gateway running on port 3000
#   4. Org2 gateway running on port 3001
#
# Usage:
#   ./annotation_gateway_test.sh
# ==============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

GW1="http://localhost:3000"
GW2="http://localhost:3001"
MOCK="http://localhost:5001"

PASS=0; FAIL=0; TOTAL=0

check() {
    TOTAL=$((TOTAL + 1))
    if echo "$2" | grep -q "$3"; then
        echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $1"
        echo -e "    Expected: ${CYAN}$3${NC}"
        echo -e "    Got: ${YELLOW}$(echo "$2" | head -2)${NC}"
        FAIL=$((FAIL + 1))
    fi
}

check_error() {
    TOTAL=$((TOTAL + 1))
    if echo "$2" | grep -qi "error\|Error\|failed"; then
        echo -e "  ${GREEN}✓${NC} $1 (expected error)"; PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $1 (expected error but got success)"
        echo -e "    Got: ${YELLOW}$(echo "$2" | head -2)${NC}"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Week 2: Gateway Annotation Integration Test                ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ==============================================================================
echo -e "${YELLOW}Preflight checks...${NC}"
# ==============================================================================

R=$(curl -s "$GW1/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Org1 gateway (port 3000)"
else
    echo -e "  ${RED}✗ Org1 gateway not reachable${NC}: $R"
    echo -e "  Start with: cd gateway && ORG=org1 PORT=3000 npm start"
    exit 1
fi

R=$(curl -s "$GW2/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Org2 gateway (port 3001)"
else
    echo -e "  ${RED}✗ Org2 gateway not reachable${NC}: $R"
    echo -e "  Start with: cd gateway && ORG=org2 PORT=3001 npm start"
    exit 1
fi

R=$(curl -s "$MOCK/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Mock annotation service (port 5001)"
else
    echo -e "  ${RED}✗ Mock annotation service not reachable${NC}: $R"
    echo -e "  Start with: cd annotation-service && python server.py"
    exit 1
fi

# Check snapshot for annotation support
R=$(curl -s "$GW1/events/snapshot" 2>&1)
if echo "$R" | grep -q '"annotations"'; then
    echo -e "  ${GREEN}✓${NC} Chaincode v2.0 (annotations in snapshot)"
else
    echo -e "  ${RED}✗ Chaincode v2.0 not deployed (no annotations in snapshot)${NC}"
    exit 1
fi

TS=$$
A_ADV="TAG_GW_ADV_$TS"
A_GOV="TAG_GW_GOV_$TS"
A_REJ="TAG_GW_REJ_$TS"
A_REV="TAG_GW_REV_$TS"
echo -e "  Test assets: TAG_GW_*_$TS"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 1: Create active anchors via gateway ---${NC}"
# ==============================================================================

for A in $A_ADV $A_GOV $A_REJ $A_REV; do
    # Propose via Org1
    R=$(curl -s -X POST "$GW1/claims/propose" \
        -H "Content-Type: application/json" \
        -d "{\"asset_id\":\"$A\",\"pose_site\":{\"position\":{\"x\":1,\"y\":2,\"z\":3},\"rotation\":{\"qw\":1,\"qx\":0,\"qy\":0,\"qz\":0}},\"quality_metrics\":{\"stability_rms\":0.02,\"confidence_mean\":0.9}}")
    if ! echo "$R" | grep -q "PROPOSED"; then
        echo -e "  ${RED}✗ Propose $A failed:${NC} $(echo "$R" | head -1)"
        continue
    fi

    # Endorse from Org1
    R=$(curl -s -X POST "$GW1/claims/endorse" \
        -H "Content-Type: application/json" \
        -d "{\"asset_id\":\"$A\"}")

    # Endorse from Org2 (activates)
    R=$(curl -s -X POST "$GW2/claims/endorse" \
        -H "Content-Type: application/json" \
        -d "{\"asset_id\":\"$A\"}")

    if echo "$R" | grep -q "is_fully_endorsed"; then
        echo -e "  ${GREEN}✓${NC} $A → ACTIVE"
    else
        echo -e "  ${RED}✗ $A activation failed${NC}"
    fi
done
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 2: ADVISORY annotation via gateway ---${NC}"
# ==============================================================================

echo "  2.1: POST /annotations/request (ADVISORY)"
R=$(curl -s -X POST "$GW1/annotations/request" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_ADV\",\"tier\":\"ADVISORY\",\"class_name\":\"laptop\",\"confidence\":0.92}")
check "ADVISORY → ANN_ACTIVE" "$R" "ANN_ACTIVE"
check "Has annotation_id" "$R" "annotation_id"

echo "  2.2: GET /annotations/:assetId"
R=$(curl -s "$GW1/annotations/$A_ADV")
check "GetAnnotation found" "$R" '"found":true'
check "State ANN_ACTIVE" "$R" "ANN_ACTIVE"
check "Content text present" "$R" "laptop"
check "AUTO_APPROVE" "$R" "AUTO_APPROVE"

echo "  2.3: GET /annotations/:assetId/active"
R=$(curl -s "$GW1/annotations/$A_ADV/active")
check "Active annotation found" "$R" '"found":true'
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 3: GOVERNED annotation via gateway (dual endorse) ---${NC}"
# ==============================================================================

echo "  3.1: POST /annotations/request (GOVERNED)"
R=$(curl -s -X POST "$GW1/annotations/request" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\",\"tier\":\"GOVERNED\",\"class_name\":\"keyboard\",\"confidence\":0.85}")
check "GOVERNED → ANN_PROPOSED" "$R" "ANN_PROPOSED"

echo "  3.2: Verify state via GET"
R=$(curl -s "$GW1/annotations/$A_GOV")
check "State ANN_PROPOSED" "$R" "ANN_PROPOSED"

echo "  3.3: Endorse from Org1 gateway"
R=$(curl -s -X POST "$GW1/annotations/endorse" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\"}")
check "Org1 → ANN_ENDORSED_ORG1" "$R" "ANN_ENDORSED_ORG1"

echo "  3.4: Endorse from Org2 gateway (should activate)"
R=$(curl -s -X POST "$GW2/annotations/endorse" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\"}")
check "Org2 → ANN_ACTIVE" "$R" "ANN_ACTIVE"
check "Fully endorsed" "$R" "is_fully_endorsed"

echo "  3.5: Verify active via GET"
R=$(curl -s "$GW1/annotations/$A_GOV/active")
check "Active found after dual endorse" "$R" '"found":true'
check "Content present" "$R" "keyboard"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 4: Rejection via gateway ---${NC}"
# ==============================================================================

echo "  4.1: Propose GOVERNED annotation"
R=$(curl -s -X POST "$GW1/annotations/request" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\",\"tier\":\"GOVERNED\",\"class_name\":\"mouse\",\"confidence\":0.88}")
check "Proposed for rejection" "$R" "ANN_PROPOSED"

echo "  4.2: Reject from Org2 gateway"
R=$(curl -s -X POST "$GW2/annotations/reject" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\",\"reason\":\"Content is inaccurate\"}")
check "→ ANN_REJECTED" "$R" "ANN_REJECTED"

echo "  4.3: Verify rejected"
R=$(curl -s "$GW1/annotations/$A_REJ")
check "State ANN_REJECTED" "$R" "ANN_REJECTED"

echo "  4.4: Cannot endorse rejected"
R=$(curl -s -X POST "$GW1/annotations/endorse" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\"}")
check_error "Endorse rejected → error" "$R"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 5: Revocation via gateway ---${NC}"
# ==============================================================================

echo "  5.1: Request ADVISORY annotation"
R=$(curl -s -X POST "$GW1/annotations/request" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REV\",\"tier\":\"ADVISORY\",\"class_name\":\"cup\",\"confidence\":0.91}")
check "Auto-activated" "$R" "ANN_ACTIVE"

echo "  5.2: Revoke from Org1 gateway"
R=$(curl -s -X POST "$GW1/annotations/revoke" \
    -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REV\",\"reason\":\"No longer relevant\"}")
check "→ ANN_REVOKED" "$R" "ANN_REVOKED"

echo "  5.3: Verify active removed"
R=$(curl -s "$GW1/annotations/$A_REV/active")
check "Not found after revoke" "$R" '"found":false'
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 6: Mock annotation service direct test ---${NC}"
# ==============================================================================

echo "  6.1: Direct call to mock service"
R=$(curl -s -X POST "$MOCK/annotate" \
    -H "Content-Type: application/json" \
    -d '{"asset_id":"test","tier":"ADVISORY","class_name":"monitor","confidence":0.95}')
check "Returns annotation_text" "$R" "annotation_text"
check "Generator is mock-v1" "$R" "mock-v1"
check "Has content_hash" "$R" "content_hash"

echo "  6.2: GOVERNED template"
R=$(curl -s -X POST "$MOCK/annotate" \
    -H "Content-Type: application/json" \
    -d '{"asset_id":"test","tier":"GOVERNED","class_name":"printer","confidence":0.82}')
check "GOVERNED has operational note" "$R" "Operational note"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 7: Snapshot includes annotations ---${NC}"
# ==============================================================================

echo "  7.1: Snapshot from Org1 gateway"
R=$(curl -s "$GW1/events/snapshot")
check "Has annotations field" "$R" '"annotations":'
check "Has assets field" "$R" '"assets":'

echo "  7.2: Snapshot from Org2 gateway"
R=$(curl -s "$GW2/events/snapshot")
check "Org2 also has annotations" "$R" '"annotations":'
echo ""

# ==============================================================================
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "  Total:  $TOTAL"
echo -e "  Passed: ${GREEN}$PASS${NC}"
echo -e "  Failed: ${RED}$FAIL${NC}"
if [ $FAIL -eq 0 ]; then
    echo -e "  ${GREEN}✓ ALL TESTS PASSED${NC}"
else
    echo -e "  ${RED}✗ SOME TESTS FAILED${NC}"
fi
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"

