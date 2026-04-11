#!/bin/bash
# ==============================================================================
# week3_admin_test.sh - Week 3 Admin Panel Integration Test
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
echo -e "${CYAN}║  Week 3: Admin Panel Routes Test                            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Preflight — check each service individually (no colon splitting)
echo -e "${YELLOW}Preflight...${NC}"

R=$(curl -s "$GW1/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Org1 gateway (port 3000)"
else
    echo -e "  ${RED}✗ Org1 gateway unreachable${NC}: $R"; exit 1
fi

R=$(curl -s "$GW2/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Org2 gateway (port 3001)"
else
    echo -e "  ${RED}✗ Org2 gateway unreachable${NC}: $R"; exit 1
fi

R=$(curl -s "$MOCK/health" 2>&1)
if echo "$R" | grep -q '"status":"healthy"'; then
    echo -e "  ${GREEN}✓${NC} Mock annotation service (port 5001)"
else
    echo -e "  ${RED}✗ Mock service unreachable${NC}: $R"; exit 1
fi

TS=$$
A_GOV="TAG_AP_GOV_$TS"
A_ADV="TAG_AP_ADV_$TS"
A_REJ="TAG_AP_REJ_$TS"
A_REV="TAG_AP_REV_$TS"
echo -e "  Test assets: TAG_AP_*_$TS"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 1: Create anchors via gateway ---${NC}"
# ==============================================================================

for A in $A_GOV $A_ADV $A_REJ $A_REV; do
    R=$(curl -s -X POST "$GW1/claims/propose" -H "Content-Type: application/json" \
        -d "{\"asset_id\":\"$A\",\"pose_site\":{\"position\":{\"x\":1,\"y\":2,\"z\":3},\"rotation\":{\"qw\":1,\"qx\":0,\"qy\":0,\"qz\":0}},\"quality_metrics\":{\"stability_rms\":0.02,\"confidence_mean\":0.9}}")
    R=$(curl -s -X POST "$GW1/claims/endorse" -H "Content-Type: application/json" -d "{\"asset_id\":\"$A\"}")
    R=$(curl -s -X POST "$GW2/claims/endorse" -H "Content-Type: application/json" -d "{\"asset_id\":\"$A\"}")
    if echo "$R" | grep -q "is_fully_endorsed"; then
        echo -e "  ${GREEN}✓${NC} $A → ACTIVE"
    else
        echo -e "  ${RED}✗${NC} $A failed: $(echo "$R" | head -1)"; exit 1
    fi
done
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 2: GOVERNED annotation via admin endorse ---${NC}"
# ==============================================================================

echo "  2.1: Request GOVERNED annotation"
R=$(curl -s -X POST "$GW1/annotations/request" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\",\"tier\":\"GOVERNED\",\"class_name\":\"monitor\",\"confidence\":0.88}")
check "GOVERNED → ANN_PROPOSED" "$R" "ANN_PROPOSED"

echo "  2.2: Endorse via admin (Org1)"
R=$(curl -s -X POST "$GW1/admin/endorse-annotation" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\"}")
check "Org1 admin endorse → ANN_ENDORSED_ORG1" "$R" "ANN_ENDORSED_ORG1"

echo "  2.3: Endorse via admin (Org2) — should activate"
R=$(curl -s -X POST "$GW2/admin/endorse-annotation" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_GOV\"}")
check "Org2 admin endorse → ANN_ACTIVE" "$R" "ANN_ACTIVE"
check "Fully endorsed" "$R" "is_fully_endorsed"

echo "  2.4: GET /admin/annotations shows it"
R=$(curl -s "$GW1/admin/annotations")
check "Active annotations list" "$R" "$A_GOV"

echo "  2.5: GET /admin/annotations/:assetId"
R=$(curl -s "$GW1/admin/annotations/$A_GOV")
check "Annotation details found" "$R" '"found":true'
check "State ANN_ACTIVE" "$R" "ANN_ACTIVE"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 3: Reject annotation via admin ---${NC}"
# ==============================================================================

echo "  3.1: Request GOVERNED annotation for rejection"
R=$(curl -s -X POST "$GW1/annotations/request" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\",\"tier\":\"GOVERNED\",\"class_name\":\"keyboard\",\"confidence\":0.85}")
check "Proposed for rejection" "$R" "ANN_PROPOSED"

echo "  3.2: Reject via admin (Org2)"
R=$(curl -s -X POST "$GW2/admin/reject-annotation" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\",\"reason\":\"Inaccurate content\"}")
check "Admin reject → ANN_REJECTED" "$R" "ANN_REJECTED"

echo "  3.3: Verify rejected"
R=$(curl -s "$GW1/admin/annotations/$A_REJ")
check "State ANN_REJECTED" "$R" "ANN_REJECTED"

echo "  3.4: Cannot endorse rejected"
R=$(curl -s -X POST "$GW1/admin/endorse-annotation" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REJ\"}")
check_error "Endorse rejected → error" "$R"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 4: Revoke annotation via admin ---${NC}"
# ==============================================================================

echo "  4.1: Request ADVISORY annotation"
R=$(curl -s -X POST "$GW1/annotations/request" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REV\",\"tier\":\"ADVISORY\",\"class_name\":\"cup\",\"confidence\":0.91}")
check "ADVISORY auto-activated" "$R" "ANN_ACTIVE"

echo "  4.2: Revoke via admin (Org1)"
R=$(curl -s -X POST "$GW1/admin/revoke-annotation" -H "Content-Type: application/json" \
    -d "{\"asset_id\":\"$A_REV\",\"reason\":\"No longer relevant\"}")
check "Admin revoke → ANN_REVOKED" "$R" "ANN_REVOKED"

echo "  4.3: Verify revoked"
R=$(curl -s "$GW1/admin/annotations/$A_REV")
check "State ANN_REVOKED" "$R" "ANN_REVOKED"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 5: Admin panel pages load ---${NC}"
# ==============================================================================

echo "  5.1: Org1 admin panel HTML"
R=$(curl -s -o /dev/null -w "%{http_code}" "$GW1/admin-panel/org1/index.html")
check "Org1 panel returns 200" "$R" "200"

echo "  5.2: Org2 admin panel HTML"
R=$(curl -s -o /dev/null -w "%{http_code}" "$GW2/admin-panel/org2/index.html")
check "Org2 panel returns 200" "$R" "200"

echo "  5.3: Org1 JS loads"
R=$(curl -s -o /dev/null -w "%{http_code}" "$GW1/admin-panel/org1/org1.js")
check "Org1 JS returns 200" "$R" "200"

echo "  5.4: Org2 JS loads"
R=$(curl -s -o /dev/null -w "%{http_code}" "$GW2/admin-panel/org2/org2.js")
check "Org2 JS returns 200" "$R" "200"

echo "  5.5: Org1 panel has annotation sections"
R=$(curl -s "$GW1/admin-panel/org1/index.html")
check "Org1 HTML has Pending Annotations" "$R" "Pending Annotations"
check "Org1 HTML has Active Annotations" "$R" "Active Annotations"

echo "  5.6: Org2 panel has annotation sections"
R=$(curl -s "$GW2/admin-panel/org2/index.html")
check "Org2 HTML has Pending Annotations" "$R" "Pending Annotations"
check "Org2 HTML has Active Annotations" "$R" "Active Annotations"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 6: Snapshot includes annotations ---${NC}"
# ==============================================================================

echo "  6.1: Snapshot from Org1"
R=$(curl -s "$GW1/events/snapshot")
check "Has annotations" "$R" '"annotations":'
check "Has active annotation" "$R" "$A_GOV"

echo "  6.2: Snapshot from Org2"
R=$(curl -s "$GW2/events/snapshot")
check "Org2 has annotations" "$R" '"annotations":'
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


