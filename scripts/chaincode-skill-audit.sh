#!/bin/bash
# ==============================================================================
# chaincode-skill-audit.sh - Skill Audit Chaincode lifecycle
# Sibling to chaincode.sh; same channel (anchorchannel), STRICTER endorsement.
#
# Endorsement policy: AND('Org1MSP.peer','Org2MSP.peer')
#   Stricter than anchor-registry's OR — agent provenance must be jointly attested.
#
# Usage:
#   ./chaincode-skill-audit.sh package
#   ./chaincode-skill-audit.sh install
#   ./chaincode-skill-audit.sh approve
#   ./chaincode-skill-audit.sh commit
#   ./chaincode-skill-audit.sh init
#   ./chaincode-skill-audit.sh deploy      # all of the above
#   ./chaincode-skill-audit.sh test        # quick invoke smoke test
# ==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
CHANNEL_NAME="anchorchannel"
CC_NAME="skill-audit-registry"
CC_VERSION="1.0"
CC_SEQUENCE=1
CC_SRC_PATH="../chaincode/skill-audit-registry"
CC_RUNTIME_LANGUAGE="node"

# Endorsement policy: STRICTER than anchor-registry — both orgs required.
CC_END_POLICY="AND('Org1MSP.peer','Org2MSP.peer')"

# Paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NETWORK_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CRYPTO_DIR="$NETWORK_DIR/network/crypto-config"

FABRIC_SAMPLES="${NETWORK_DIR}/../fabric-samples"
if [ -d "$FABRIC_SAMPLES/bin" ]; then
    export PATH="$FABRIC_SAMPLES/bin:$PATH"
fi
export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"

# Environment setup helpers (identical to chaincode.sh)
setOrg1Env() {
    export CORE_PEER_LOCALMSPID="Org1MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/users/Admin@org1.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:7051"
    export CORE_PEER_TLS_ENABLED=true
}

setOrg2Env() {
    export CORE_PEER_LOCALMSPID="Org2MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/users/Admin@org2.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:9051"
    export CORE_PEER_TLS_ENABLED=true
}

setOrdererEnv() {
    export ORDERER_CA="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/msp/tlscacerts/tlsca.anchor-registry.com-cert.pem"
}

# Package
packageChaincode() {
    echo -e "${YELLOW}Packaging skill-audit-registry chaincode...${NC}"
    cd "$NETWORK_DIR/chaincode/skill-audit-registry"
    if [ -f "package.json" ]; then
        echo -e "${YELLOW}  Installing npm dependencies...${NC}"
        npm install
    fi
    cd "$SCRIPT_DIR"
    peer lifecycle chaincode package ${CC_NAME}.tar.gz \
        --path "$CC_SRC_PATH" \
        --lang "$CC_RUNTIME_LANGUAGE" \
        --label "${CC_NAME}_${CC_VERSION}"
    echo -e "${GREEN}✓ Packaged: ${CC_NAME}.tar.gz${NC}"
}

# Install
installChaincode() {
    local ORG=$1
    echo -e "${YELLOW}Installing on $ORG...${NC}"
    if [ "$ORG" == "Org1" ]; then setOrg1Env; else setOrg2Env; fi
    peer lifecycle chaincode install ${CC_NAME}.tar.gz
    echo -e "${GREEN}✓ Installed on $ORG${NC}"
}

# Get installed package id
getInstalledPackageId() {
    local ORG=$1
    if [ "$ORG" == "Org1" ]; then setOrg1Env; else setOrg2Env; fi
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json \
        | jq -r ".installed_chaincodes[] | select(.label == \"${CC_NAME}_${CC_VERSION}\") | .package_id")
    echo "$PACKAGE_ID"
}

# Approve
approveChaincode() {
    local ORG=$1
    local PACKAGE_ID=$2
    echo -e "${YELLOW}Approving from $ORG...${NC}"
    if [ "$ORG" == "Org1" ]; then setOrg1Env; else setOrg2Env; fi
    setOrdererEnv
    peer lifecycle chaincode approveformyorg \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --tls --cafile "$ORDERER_CA" \
        --channelID "$CHANNEL_NAME" \
        --name "$CC_NAME" \
        --version "$CC_VERSION" \
        --package-id "$PACKAGE_ID" \
        --sequence "$CC_SEQUENCE" \
        --signature-policy "$CC_END_POLICY"
    echo -e "${GREEN}✓ Approved from $ORG${NC}"
}

# Commit
commitChaincode() {
    echo -e "${YELLOW}Committing chaincode definition...${NC}"
    setOrg1Env
    setOrdererEnv
    peer lifecycle chaincode commit \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --tls --cafile "$ORDERER_CA" \
        --channelID "$CHANNEL_NAME" \
        --name "$CC_NAME" \
        --version "$CC_VERSION" \
        --sequence "$CC_SEQUENCE" \
        --signature-policy "$CC_END_POLICY" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        --peerAddresses localhost:9051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"
    echo -e "${GREEN}✓ Committed${NC}"
}

# Init ledger
initLedger() {
    echo -e "${YELLOW}Invoking InitLedger...${NC}"
    setOrg1Env
    setOrdererEnv
    peer chaincode invoke \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --tls --cafile "$ORDERER_CA" \
        -C "$CHANNEL_NAME" \
        -n "$CC_NAME" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        --peerAddresses localhost:9051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt" \
        -c '{"function":"InitLedger","Args":[]}'
    echo -e "${GREEN}✓ InitLedger invoked${NC}"
}

# Smoke test: record a fake decision and read it back
smokeTest() {
    echo -e "${YELLOW}Smoke test: record + query a fake decision...${NC}"
    setOrg1Env
    setOrdererEnv

    local FAKE_HASH="sha256:0000000000000000000000000000000000000000000000000000000000000000"
    local ENV='{"decisionId":"sd-smoke-001","skillId":"spatial-governance-skill","skillVersion":"0.1.1","skillManifestHash":"'$FAKE_HASH'","decisionType":"INVOKE","selectedChaincode":"anchor-registry","selectedFunction":"ProposeAnchor","riskLevel":"WRITE_GOVERNED","requiresConfirmation":true,"shouldInvoke":true,"llmProvider":"parley","llmModel":"gpt-5.1","intentHash":"'$FAKE_HASH'","contextHash":"'$FAKE_HASH'","argumentHash":"'$FAKE_HASH'","submittingOrg":"Org1MSP","gatewayId":"org1-gateway","timestamp":"2026-05-18T00:00:00.000Z"}'

    peer chaincode invoke \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --tls --cafile "$ORDERER_CA" \
        -C "$CHANNEL_NAME" \
        -n "$CC_NAME" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        --peerAddresses localhost:9051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt" \
        -c "{\"function\":\"RecordSkillDecision\",\"Args\":[\"$(echo "$ENV" | sed 's/"/\\"/g')\"]}"

    sleep 2

    echo -e "${YELLOW}Querying back...${NC}"
    peer chaincode query -C "$CHANNEL_NAME" -n "$CC_NAME" -c '{"function":"QuerySkillDecision","Args":["sd-smoke-001"]}'

    echo -e "${GREEN}✓ Smoke test complete${NC}"
}

# Full deploy
deployAll() {
    packageChaincode
    installChaincode Org1
    installChaincode Org2
    PKG_ID=$(getInstalledPackageId Org1)
    echo -e "${YELLOW}Package ID: $PKG_ID${NC}"
    approveChaincode Org1 "$PKG_ID"
    approveChaincode Org2 "$PKG_ID"
    commitChaincode
    sleep 3
    initLedger
    echo -e "${GREEN}✓ skill-audit-registry deployed and initialized.${NC}"
}

# Dispatch
case "$1" in
    package) packageChaincode ;;
    install) installChaincode Org1; installChaincode Org2 ;;
    approve)
        PKG_ID=$(getInstalledPackageId Org1)
        approveChaincode Org1 "$PKG_ID"
        approveChaincode Org2 "$PKG_ID"
        ;;
    commit) commitChaincode ;;
    init)   initLedger ;;
    deploy) deployAll ;;
    test)   smokeTest ;;
    *)
        echo "Usage: $0 {package|install|approve|commit|init|deploy|test}"
        exit 1
        ;;
esac
