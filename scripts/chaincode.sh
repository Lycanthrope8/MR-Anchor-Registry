#!/bin/bash
# ==============================================================================
# chaincode.sh - Chaincode lifecycle operations for two organizations
# MR Anchor Registry
# ==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
CHANNEL_NAME="anchorchannel"
CC_NAME="anchor-registry"
CC_VERSION="1.0"
CC_SEQUENCE=1
CC_SRC_PATH="../chaincode/anchor-registry"
CC_RUNTIME_LANGUAGE="node"

# Endorsement policy: Either org can endorse blockchain transactions
# NOTE: Multi-org approval is handled at APPLICATION level in chaincode logic
# (Org1 proposes -> Org2 endorses claim -> claim becomes ACTIVE)
CC_END_POLICY="OR('Org1MSP.peer','Org2MSP.peer')"

# Paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NETWORK_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CRYPTO_DIR="$NETWORK_DIR/network/crypto-config"

# Set fabric binaries path
FABRIC_SAMPLES="${NETWORK_DIR}/../fabric-samples"
if [ -d "$FABRIC_SAMPLES/bin" ]; then
    export PATH="$FABRIC_SAMPLES/bin:$PATH"
fi

export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"

# Environment setup for Org1
setOrg1Env() {
    export CORE_PEER_LOCALMSPID="Org1MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/users/Admin@org1.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:7051"
    export CORE_PEER_TLS_ENABLED=true
}

# Environment setup for Org2
setOrg2Env() {
    export CORE_PEER_LOCALMSPID="Org2MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/users/Admin@org2.anchor-registry.com/msp"
    export CORE_PEER_ADDRESS="localhost:9051"
    export CORE_PEER_TLS_ENABLED=true
}

# Orderer environment
setOrdererEnv() {
    export ORDERER_CA="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/msp/tlscacerts/tlsca.anchor-registry.com-cert.pem"
}

# Package chaincode
packageChaincode() {
    echo -e "${YELLOW}Packaging chaincode...${NC}"
    
    cd "$NETWORK_DIR/chaincode/anchor-registry"
    
    if [ -f "package.json" ]; then
        echo -e "${YELLOW}  Installing npm dependencies...${NC}"
        npm install
    fi
    
    cd "$SCRIPT_DIR"
    
    peer lifecycle chaincode package ${CC_NAME}.tar.gz \
        --path "$CC_SRC_PATH" \
        --lang "$CC_RUNTIME_LANGUAGE" \
        --label "${CC_NAME}_${CC_VERSION}"
    
    echo -e "${GREEN}✓ Chaincode packaged: ${CC_NAME}.tar.gz${NC}"
}

# Install chaincode on a peer
installChaincode() {
    local ORG=$1
    
    echo -e "${YELLOW}Installing chaincode on $ORG...${NC}"
    
    if [ "$ORG" == "Org1" ]; then
        setOrg1Env
    else
        setOrg2Env
    fi
    
    peer lifecycle chaincode install ${CC_NAME}.tar.gz
    
    echo -e "${GREEN}✓ Chaincode installed on $ORG${NC}"
}

# Get package ID
getPackageId() {
    local ORG=$1
    
    if [ "$ORG" == "Org1" ]; then
        setOrg1Env
    else
        setOrg2Env
    fi
    
    peer lifecycle chaincode queryinstalled --output json | \
        jq -r ".installed_chaincodes[] | select(.label==\"${CC_NAME}_${CC_VERSION}\") | .package_id"
}

# Approve chaincode for organization
approveChaincode() {
    local ORG=$1
    
    echo -e "${YELLOW}Approving chaincode for $ORG...${NC}"
    
    if [ "$ORG" == "Org1" ]; then
        setOrg1Env
    else
        setOrg2Env
    fi
    
    setOrdererEnv
    
    PACKAGE_ID=$(getPackageId "$ORG")
    
    if [ -z "$PACKAGE_ID" ]; then
        echo -e "${RED}✗ Could not find package ID for $ORG${NC}"
        exit 1
    fi
    
    echo -e "${YELLOW}  Package ID: $PACKAGE_ID${NC}"
    echo -e "${YELLOW}  Endorsement Policy: $CC_END_POLICY${NC}"
    
    peer lifecycle chaincode approveformyorg \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --channelID $CHANNEL_NAME \
        --name $CC_NAME \
        --version $CC_VERSION \
        --package-id $PACKAGE_ID \
        --sequence $CC_SEQUENCE \
        --signature-policy "$CC_END_POLICY" \
        --tls \
        --cafile "$ORDERER_CA"
    
    echo -e "${GREEN}✓ Chaincode approved for $ORG${NC}"
}

# Check commit readiness
checkCommitReadiness() {
    echo -e "${YELLOW}Checking commit readiness...${NC}"
    
    setOrg1Env
    setOrdererEnv
    
    peer lifecycle chaincode checkcommitreadiness \
        --channelID $CHANNEL_NAME \
        --name $CC_NAME \
        --version $CC_VERSION \
        --sequence $CC_SEQUENCE \
        --signature-policy "$CC_END_POLICY" \
        --output json
}

# Commit chaincode
commitChaincode() {
    echo -e "${YELLOW}Committing chaincode definition...${NC}"
    
    setOrg1Env
    setOrdererEnv
    
    peer lifecycle chaincode commit \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        --channelID $CHANNEL_NAME \
        --name $CC_NAME \
        --version $CC_VERSION \
        --sequence $CC_SEQUENCE \
        --signature-policy "$CC_END_POLICY" \
        --tls \
        --cafile "$ORDERER_CA" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        --peerAddresses localhost:9051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org2.anchor-registry.com/peers/peer0.org2.anchor-registry.com/tls/ca.crt"
    
    echo -e "${GREEN}✓ Chaincode committed${NC}"
}

# Query committed chaincode
queryCommitted() {
    echo -e "${YELLOW}Querying committed chaincode...${NC}"
    
    setOrg1Env
    
    peer lifecycle chaincode querycommitted \
        --channelID $CHANNEL_NAME \
        --name $CC_NAME
}

# Initialize chaincode
initChaincode() {
    echo -e "${YELLOW}Initializing chaincode...${NC}"
    
    setOrg1Env
    setOrdererEnv
    
    peer chaincode invoke \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        -C $CHANNEL_NAME \
        -n $CC_NAME \
        --tls \
        --cafile "$ORDERER_CA" \
        --peerAddresses localhost:7051 \
        --tlsRootCertFiles "$CRYPTO_DIR/peerOrganizations/org1.anchor-registry.com/peers/peer0.org1.anchor-registry.com/tls/ca.crt" \
        -c '{"function":"InitLedger","Args":[]}'
    
    echo -e "${GREEN}✓ Chaincode initialized${NC}"
}

# Test invoke
testInvoke() {
    echo -e "${YELLOW}Testing chaincode invocation...${NC}"
    
    setOrg1Env
    setOrdererEnv
    
    echo -e "${YELLOW}  Testing GetSnapshot...${NC}"
    peer chaincode query \
        -C $CHANNEL_NAME \
        -n $CC_NAME \
        -c '{"function":"GetSnapshot","Args":[]}'
    
    echo -e "${GREEN}✓ Chaincode test successful${NC}"
}

# Full deployment
deployAll() {
    echo -e "${GREEN}=============================================${NC}"
    echo -e "${GREEN}Full Chaincode Deployment${NC}"
    echo -e "${GREEN}=============================================${NC}"
    echo -e "${YELLOW}Endorsement Policy: $CC_END_POLICY${NC}"
    echo -e "${GREEN}=============================================${NC}"
    
    packageChaincode
    
    installChaincode "Org1"
    installChaincode "Org2"
    
    approveChaincode "Org1"
    approveChaincode "Org2"
    
    checkCommitReadiness
    
    commitChaincode
    
    queryCommitted
    
    sleep 3
    initChaincode
    
    sleep 2
    testInvoke
    
    echo -e "${GREEN}=============================================${NC}"
    echo -e "${GREEN}Deployment Complete!${NC}"
    echo -e "${GREEN}=============================================${NC}"
}

# Main
case "$1" in
    package)
        packageChaincode
        ;;
    install)
        if [ -n "$2" ]; then
            installChaincode "$2"
        else
            installChaincode "Org1"
            installChaincode "Org2"
        fi
        ;;
    approve)
        if [ -n "$2" ]; then
            approveChaincode "$2"
        else
            approveChaincode "Org1"
            approveChaincode "Org2"
        fi
        ;;
    check)
        checkCommitReadiness
        ;;
    commit)
        commitChaincode
        ;;
    query)
        queryCommitted
        ;;
    init)
        initChaincode
        ;;
    test)
        testInvoke
        ;;
    deploy)
        deployAll
        ;;
    *)
        echo "Usage: $0 {package|install|approve|check|commit|query|init|test|deploy}"
        exit 1
        ;;
esac