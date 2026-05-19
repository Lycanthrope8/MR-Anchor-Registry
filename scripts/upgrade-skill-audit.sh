#!/bin/bash
# ==============================================================================
# upgrade-skill-audit.sh - Upgrade skill-audit-registry to v1.0.1
# ==============================================================================
# Phase 3 v1.0.0 had non-deterministic timestamp calls that broke AND-endorsement
# RW-set matching. v1.0.1 uses ctx.stub.getTxTimestamp() everywhere.
#
# This script:
#   1. Detects the next sequence number from querycommitted
#   2. Re-packages the chaincode with version 1.0.1
#   3. Installs on both orgs
#   4. Approves the new sequence with the same AND policy
#   5. Commits
#
# NOTE: existing audit records are preserved. The new chaincode is a logic
# upgrade only — no state migration needed.
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CHANNEL_NAME="anchorchannel"
CC_NAME="skill-audit-registry"
CC_NEW_VERSION="1.0.1"
CC_SRC_PATH="../chaincode/skill-audit-registry"
CC_RUNTIME_LANGUAGE="node"
CC_END_POLICY="AND('Org1MSP.peer','Org2MSP.peer')"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NETWORK_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CRYPTO_DIR="$NETWORK_DIR/network/crypto-config"

FABRIC_SAMPLES="${NETWORK_DIR}/../fabric-samples"
[ -d "$FABRIC_SAMPLES/bin" ] && export PATH="$FABRIC_SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"

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
ORDERER_CA="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/msp/tlscacerts/tlsca.anchor-registry.com-cert.pem"
ORG1_TLS="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt"
ORG2_TLS="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"

# 1. Detect current sequence and pick next
echo -e "${YELLOW}[1/5] Detecting current sequence...${NC}"
setOrg1
CURRENT_SEQ=$(peer lifecycle chaincode querycommitted -C "$CHANNEL_NAME" -n "$CC_NAME" --output json 2>/dev/null \
    | jq -r '.sequence' 2>/dev/null)
if [ -z "$CURRENT_SEQ" ] || [ "$CURRENT_SEQ" = "null" ]; then
    echo -e "${RED}Could not detect current sequence. Is the chaincode committed?${NC}"
    exit 1
fi
NEXT_SEQ=$((CURRENT_SEQ + 1))
echo -e "${GREEN}  Current: $CURRENT_SEQ → New: $NEXT_SEQ${NC}"

# 2. Package new version
echo -e "${YELLOW}[2/5] Packaging $CC_NAME $CC_NEW_VERSION...${NC}"
cd "$NETWORK_DIR/chaincode/skill-audit-registry"
npm install --silent
cd "$SCRIPT_DIR"
peer lifecycle chaincode package "${CC_NAME}-${CC_NEW_VERSION}.tar.gz" \
    --path "$CC_SRC_PATH" \
    --lang "$CC_RUNTIME_LANGUAGE" \
    --label "${CC_NAME}_${CC_NEW_VERSION}"
echo -e "${GREEN}  ✓ Packaged${NC}"

# 3. Install on both orgs
echo -e "${YELLOW}[3/5] Installing on both orgs...${NC}"
for ORG in Org1 Org2; do
    if [ "$ORG" = "Org1" ]; then setOrg1; else setOrg2; fi
    peer lifecycle chaincode install "${CC_NAME}-${CC_NEW_VERSION}.tar.gz"
    echo -e "${GREEN}  ✓ Installed on $ORG${NC}"
done

# Capture package id (same on both orgs since label+content is identical)
setOrg1
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json \
    | jq -r ".installed_chaincodes[] | select(.label == \"${CC_NAME}_${CC_NEW_VERSION}\") | .package_id")
echo -e "${YELLOW}  Package ID: $PACKAGE_ID${NC}"

# 4. Approve from both orgs (with the SAME AND policy)
echo -e "${YELLOW}[4/5] Approving sequence $NEXT_SEQ from both orgs...${NC}"
for ORG in Org1 Org2; do
    if [ "$ORG" = "Org1" ]; then setOrg1; else setOrg2; fi
    peer lifecycle chaincode approveformyorg \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --tls --cafile "$ORDERER_CA" \
        --channelID "$CHANNEL_NAME" \
        --name "$CC_NAME" \
        --version "$CC_NEW_VERSION" \
        --package-id "$PACKAGE_ID" \
        --sequence "$NEXT_SEQ" \
        --signature-policy "$CC_END_POLICY"
    echo -e "${GREEN}  ✓ Approved from $ORG${NC}"
done

# 5. Commit
echo -e "${YELLOW}[5/5] Committing sequence $NEXT_SEQ...${NC}"
setOrg1
peer lifecycle chaincode commit \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.anchor-registry.com \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_NEW_VERSION" \
    --sequence "$NEXT_SEQ" \
    --signature-policy "$CC_END_POLICY" \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_TLS"
echo -e "${GREEN}  ✓ Committed${NC}"

echo ""
echo -e "${GREEN}✓ Upgrade to skill-audit-registry v$CC_NEW_VERSION complete.${NC}"
echo "  Existing audit records are preserved."
echo "  Re-run verify-phase3-v2.sh to confirm AND-endorsement now works end-to-end."
