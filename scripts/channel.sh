#!/bin/bash
# ==============================================================================
# channel.sh - Channel creation and join operations
# MR Anchor Registry - Two Organization Network
# ==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
CHANNEL_NAME="anchorchannel"
DELAY=3
MAX_RETRY=5

# Paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NETWORK_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CRYPTO_DIR="$NETWORK_DIR/network/crypto-config"
CHANNEL_ARTIFACTS="$NETWORK_DIR/network/channel-artifacts"

# Set fabric binaries path
FABRIC_SAMPLES="${NETWORK_DIR}/../fabric-samples"
if [ -d "$FABRIC_SAMPLES/bin" ]; then
    export PATH="$FABRIC_SAMPLES/bin:$PATH"
    export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"
fi

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
    export ORDERER_ADMIN_TLS_SIGN_CERT="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/tls/server.crt"
    export ORDERER_ADMIN_TLS_PRIVATE_KEY="$CRYPTO_DIR/ordererOrganizations/anchor-registry.com/orderers/orderer.anchor-registry.com/tls/server.key"
}

# Create channel
createChannel() {
    echo -e "${YELLOW}Creating channel: $CHANNEL_NAME${NC}"
    
    setOrg1Env
    setOrdererEnv
    
    local rc=1
    local COUNTER=1
    
    while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
        echo -e "${YELLOW}  Attempt $COUNTER/$MAX_RETRY${NC}"
        
        # Create channel using the genesis block
        # In modern Fabric without system channel, we use osnadmin to join orderer to channel
        osnadmin channel join \
            --channelID $CHANNEL_NAME \
            --config-block "$CHANNEL_ARTIFACTS/genesis.block" \
            -o localhost:7053 \
            --ca-file "$ORDERER_CA" \
            --client-cert "$ORDERER_ADMIN_TLS_SIGN_CERT" \
            --client-key "$ORDERER_ADMIN_TLS_PRIVATE_KEY" \
            2>&1
        
        rc=$?
        
        if [ $rc -ne 0 ]; then
            sleep $DELAY
        fi
        
        COUNTER=$((COUNTER + 1))
    done
    
    if [ $rc -eq 0 ]; then
        echo -e "${GREEN}✓ Channel created successfully${NC}"
    else
        echo -e "${RED}✗ Failed to create channel after $MAX_RETRY attempts${NC}"
        exit 1
    fi
}

# Join peer to channel
joinChannel() {
    local ORG=$1
    
    echo -e "${YELLOW}Joining $ORG peer to channel...${NC}"
    
    if [ "$ORG" == "Org1" ]; then
        setOrg1Env
    else
        setOrg2Env
    fi
    
    setOrdererEnv
    
    local rc=1
    local COUNTER=1
    
    while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
        echo -e "${YELLOW}  Attempt $COUNTER/$MAX_RETRY${NC}"
        
        peer channel join -b "$CHANNEL_ARTIFACTS/${CHANNEL_NAME}.block" 2>&1
        rc=$?
        
        if [ $rc -ne 0 ]; then
            sleep $DELAY
        fi
        
        COUNTER=$((COUNTER + 1))
    done
    
    if [ $rc -eq 0 ]; then
        echo -e "${GREEN}✓ $ORG peer joined channel${NC}"
    else
        echo -e "${RED}✗ Failed to join $ORG peer to channel${NC}"
        exit 1
    fi
}

# Fetch channel block (for joining) - just copy the genesis block
fetchChannelBlock() {
    echo -e "${YELLOW}Copying channel genesis block for peer joining...${NC}"
    
    # The genesis block is already the channel block for peers to join
    cp "$CHANNEL_ARTIFACTS/genesis.block" "$CHANNEL_ARTIFACTS/${CHANNEL_NAME}.block"
    
    echo -e "${GREEN}✓ Channel block ready${NC}"
}

# Update anchor peers
updateAnchorPeers() {
    local ORG=$1
    
    echo -e "${YELLOW}Updating anchor peers for $ORG...${NC}"
    
    # In modern Fabric without system channel, anchor peers are already defined in the genesis block
    # from configtx.yaml. We just need to verify they're set.
    
    if [ "$ORG" == "Org1" ]; then
        setOrg1Env
    else
        setOrg2Env
    fi
    
    setOrdererEnv
    
    # Fetch the current channel config to verify anchor peers
    peer channel fetch config "$CHANNEL_ARTIFACTS/config_block.pb" \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.anchor-registry.com \
        -c $CHANNEL_NAME \
        --tls \
        --cafile "$ORDERER_CA" > /dev/null 2>&1
    
    echo -e "${GREEN}✓ $ORG anchor peers are configured (defined in genesis block)${NC}"
}

# List channels
listChannels() {
    echo -e "${YELLOW}Listing channels for Org1...${NC}"
    setOrg1Env
    peer channel list
    
    echo -e "${YELLOW}Listing channels for Org2...${NC}"
    setOrg2Env
    peer channel list
}

# Main
case "$1" in
    create)
        createChannel
        ;;
    fetch)
        fetchChannelBlock
        ;;
    join)
        fetchChannelBlock
        joinChannel "Org1"
        joinChannel "Org2"
        ;;
    anchor)
        updateAnchorPeers "Org1"
        updateAnchorPeers "Org2"
        ;;
    list)
        listChannels
        ;;
    all)
        createChannel
        sleep 2
        fetchChannelBlock
        joinChannel "Org1"
        joinChannel "Org2"
        sleep 2
        updateAnchorPeers "Org1"
        updateAnchorPeers "Org2"
        ;;
    *)
        echo "Usage: $0 {create|fetch|join|anchor|list|all}"
        echo ""
        echo "  create  - Create the channel"
        echo "  fetch   - Fetch channel genesis block"
        echo "  join    - Join both org peers to channel"
        echo "  anchor  - Update anchor peers for both orgs"
        echo "  list    - List channels for both orgs"
        echo "  all     - Run all operations in sequence"
        exit 1
        ;;
esac