#!/bin/bash
# ==============================================================================
# annotation_smoke_test.sh - Annotation Lifecycle Smoke Test v3
# Fix: properly escape JSON arguments in invoke/query helpers
# ==============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Absolute paths
PROJECT_DIR="/Users/jhossai3/work/MR-Anchor-Registry"
FABRIC_SAMPLES_DIR="/Users/jhossai3/work/fabric-samples"
CRYPTO_DIR="$PROJECT_DIR/network/crypto-config"

export PATH="$FABRIC_SAMPLES_DIR/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES_DIR/config"

CHANNEL_NAME="anchorchannel"
CC_NAME="anchor-registry"
ORDERER_CA="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/msp/tlscacerts/tlsca.anchor-registry.com-cert.pem"

setOrg1() {
    export CORE_PEER_LOCALMSPID="Org1MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/users/Admin@org1.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:7051"
    export CORE_PEER_TLS_ENABLED=true
}

setOrg2() {
    export CORE_PEER_LOCALMSPID="Org2MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/users/Admin@org2.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:9051"
    export CORE_PEER_TLS_ENABLED=true
}

# Helper: invoke chaincode — ESCAPES inner quotes properly
invoke() {
    local FUNC=$1
    shift
    local ARGS_JSON="["
    local FIRST=true
    for arg in "$@"; do
        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            ARGS_JSON+=","
        fi
        # Escape any double quotes inside the argument
        local escaped="${arg//\"/\\\"}"
        ARGS_JSON+="\"$escaped\""
    done
    ARGS_JSON+="]"

    local CMD_JSON="{\"function\":\"$FUNC\",\"Args\":$ARGS_JSON}"

    peer chaincode invoke \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        -C "$CHANNEL_NAME" \
        -n "$CC_NAME" \
        --tls \
        --cafile "$ORDERER_CA" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        -c "$CMD_JSON" \
        --waitForEvent 2>&1
}

# Helper: query chaincode — ESCAPES inner quotes properly
query() {
    local FUNC=$1
    shift
    local ARGS_JSON="["
    local FIRST=true
    for arg in "$@"; do
        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            ARGS_JSON+=","
        fi
        local escaped="${arg//\"/\\\"}"
        ARGS_JSON+="\"$escaped\""
    done
    ARGS_JSON+="]"

    local CMD_JSON="{\"function\":\"$FUNC\",\"Args\":$ARGS_JSON}"

    peer chaincode query \
        -C "$CHANNEL_NAME" \
        -n "$CC_NAME" \
        -c "$CMD_JSON" 2>&1
}

PASS=0; FAIL=0; TOTAL=0

check() {
    TOTAL=$((TOTAL + 1))
    if echo "$2" | grep -q "$3"; then
        echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $1"
        echo -e "    Expected: ${CYAN}$3${NC}"
        echo -e "    Got: ${YELLOW}$(echo "$2" | tail -2)${NC}"
        FAIL=$((FAIL + 1))
    fi
}

check_error() {
    TOTAL=$((TOTAL + 1))
    if echo "$2" | grep -qi "error\|Error\|failed\|FAIL"; then
        echo -e "  ${GREEN}✓${NC} $1 (expected error)"; PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $1 (expected error but got success)"
        echo -e "    Got: ${YELLOW}$(echo "$2" | tail -2)${NC}"
        FAIL=$((FAIL + 1))
    fi
}

# ==============================================================================
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Annotation Lifecycle Smoke Test v3                         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# PREFLIGHT
echo -e "${YELLOW}Preflight...${NC}"
if ! command -v peer &> /dev/null; then
    echo -e "  ${RED}✗ peer not found${NC}"; exit 1
fi
echo -e "  ${GREEN}✓${NC} peer: $(which peer)"

setOrg1
PF=$(query GetSnapshot)
if echo "$PF" | grep -q '"success":true'; then
    echo -e "  ${GREEN}✓${NC} Chaincode reachable"
else
    echo -e "  ${RED}✗ Chaincode unreachable:${NC} $PF"; exit 1
fi
if echo "$PF" | grep -q '"annotations"'; then
    echo -e "  ${GREEN}✓${NC} v2.0 annotation support"
else
    echo -e "  ${RED}✗ No annotation support${NC}"; exit 1
fi

TS=$$
A_ADV="TAG_ADV_$TS"; A_GOV="TAG_GOV_$TS"; A_REJ="TAG_REJ_$TS"; A_REV="TAG_REV_$TS"; A_NONE="TAG_NONE_$TS"
echo -e "  IDs: *_$TS"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 1: Create active anchors ---${NC}"
# ==============================================================================

POSE='{"position":{"x":1,"y":2,"z":3},"rotation":{"qw":1,"qx":0,"qy":0,"qz":0}}'
QUAL='{"stability_rms":0.02,"confidence_mean":0.9}'
OK=0

for A in $A_ADV $A_GOV $A_REJ $A_REV; do
    setOrg1
    R=$(invoke ProposeAnchor "$A" "$POSE" "$QUAL")
    if ! echo "$R" | grep -q "PROPOSED"; then
        echo -e "  ${RED}✗ Propose $A:${NC} $(echo "$R" | tail -1)"; continue
    fi

    setOrg1
    R=$(invoke EndorseClaim "$A")
    if ! echo "$R" | grep -q "endorsed_by"; then
        echo -e "  ${RED}✗ Org1 endorse $A:${NC} $(echo "$R" | tail -1)"; continue
    fi

    setOrg2
    R=$(invoke EndorseClaim "$A")
    if ! echo "$R" | grep -q "ACTIVE\|is_fully_endorsed"; then
        echo -e "  ${RED}✗ Org2 endorse $A:${NC} $(echo "$R" | tail -1)"; continue
    fi

    setOrg1
    R=$(query GetActiveAnchor "$A")
    if echo "$R" | grep -q '"found":true'; then
        echo -e "  ${GREEN}✓${NC} $A → ACTIVE"; OK=$((OK + 1))
    else
        echo -e "  ${RED}✗ $A not active${NC}"
    fi
done

if [ $OK -lt 4 ]; then
    echo -e "\n  ${RED}Only $OK/4 anchors. Aborting.${NC}"; exit 1
fi
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 2: ADVISORY (auto-approve) ---${NC}"
# ==============================================================================

setOrg1
R=$(invoke ProposeAnnotation "$A_ADV" "This is a laptop. Common workspace device." "ADVISORY" '{"className":"laptop","confidence":0.92}' "mock-v1" "mock-template-v1")
check "2.1 ADVISORY → ANN_ACTIVE" "$R" "ANN_ACTIVE"

R=$(query GetAnnotation "$A_ADV")
check "2.2 State ANN_ACTIVE" "$R" "ANN_ACTIVE"
check "2.3 Content present" "$R" "This is a laptop"
check "2.4 AUTO_APPROVE" "$R" "AUTO_APPROVE"

R=$(query GetActiveAnnotation "$A_ADV")
check "2.5 Active found" "$R" '"found":true'

R=$(query GetAllActiveAnnotations)
check "2.6 Count >= 1" "$R" '"count":'
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 3: GOVERNED (dual endorsement) ---${NC}"
# ==============================================================================

setOrg1
R=$(invoke ProposeAnnotation "$A_GOV" "Operational note for keyboard." "GOVERNED" '{"className":"keyboard","confidence":0.85}' "mock-v1" "mock-template-v1")
check "3.1 GOVERNED → ANN_PROPOSED" "$R" "ANN_PROPOSED"

R=$(query GetAnnotation "$A_GOV")
check "3.2 State ANN_PROPOSED" "$R" "ANN_PROPOSED"

setOrg1
R=$(invoke EndorseAnnotation "$A_GOV")
check "3.3 Org1 → ANN_ENDORSED_ORG1" "$R" "ANN_ENDORSED_ORG1"

setOrg2
R=$(invoke EndorseAnnotation "$A_GOV")
check "3.4 Org2 → ANN_ACTIVE" "$R" "ANN_ACTIVE"

setOrg1
R=$(query GetActiveAnnotation "$A_GOV")
check "3.5 Active found" "$R" '"found":true'
check "3.6 Content" "$R" "Operational note for keyboard"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 4: Rejection ---${NC}"
# ==============================================================================

setOrg1
R=$(invoke ProposeAnnotation "$A_REJ" "Test annotation to reject." "GOVERNED" '{"className":"mouse","confidence":0.88}' "mock-v1" "mock-template-v1")
check "4.1 Proposed" "$R" "ANN_PROPOSED"

setOrg2
R=$(invoke RejectAnnotation "$A_REJ" "Content is inaccurate")
check "4.2 → ANN_REJECTED" "$R" "ANN_REJECTED"

setOrg1
R=$(query GetAnnotation "$A_REJ")
check "4.3 State ANN_REJECTED" "$R" "ANN_REJECTED"

setOrg1
R=$(invoke EndorseAnnotation "$A_REJ")
check_error "4.4 Endorse rejected → error" "$R"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 5: Revocation ---${NC}"
# ==============================================================================

setOrg1
R=$(invoke ProposeAnnotation "$A_REV" "Advisory to be revoked." "ADVISORY" '{"className":"cup","confidence":0.91}' "mock-v1" "mock-template-v1")
check "5.1 Auto-activated" "$R" "ANN_ACTIVE"

setOrg1
R=$(invoke RevokeAnnotation "$A_REV" "No longer relevant")
check "5.2 → ANN_REVOKED" "$R" "ANN_REVOKED"

setOrg1
R=$(query GetActiveAnnotation "$A_REV")
check "5.3 Not found" "$R" '"found":false'
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 6: Validation errors ---${NC}"
# ==============================================================================

setOrg1
R=$(invoke ProposeAnnotation "$A_NONE" "Should fail." "ADVISORY" '{"className":"test","confidence":0.5}' "mock-v1" "mock-template-v1")
check_error "6.1 No anchor → error" "$R"

setOrg1
LONG="This text is intentionally very long to test the 280 character limit enforcement in the chaincode. It keeps going and going to make sure we exceed the limit. Adding more words here to push past the boundary. Almost there now just a few more characters needed to cross it definitely and surely."
R=$(invoke ProposeAnnotation "$A_ADV" "$LONG" "ADVISORY" '{"className":"test","confidence":0.5}' "mock-v1" "mock-template-v1")
check_error "6.2 >280 chars → error" "$R"

setOrg1
R=$(invoke ProposeAnnotation "$A_ADV" "Test." "INVALID_TIER" '{"className":"test","confidence":0.5}' "mock-v1" "mock-template-v1")
check_error "6.3 Bad tier → error" "$R"

setOrg1
R=$(invoke ProposeAnnotation "$A_ADV" "Duplicate." "ADVISORY" '{"className":"test","confidence":0.5}' "mock-v1" "mock-template-v1")
check_error "6.4 Duplicate → error" "$R"
echo ""

# ==============================================================================
echo -e "${YELLOW}--- Phase 7: Snapshot ---${NC}"
# ==============================================================================

setOrg1
R=$(query GetSnapshot)
check "7.1 Has annotations" "$R" '"annotations":'
check "7.2 Has assets" "$R" '"assets":'
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