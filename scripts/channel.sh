#!/bin/bash
# =============================================================================
# Create and join channel using Channel Participation API
# SINGLE ORG ONLY (Org1) - NO Org2 references
# =============================================================================

set -e

CHANNEL_NAME=mychannel
CHANNEL_DIR=/opt/gopath/src/github.com/hyperledger/fabric/peer/channel-artifacts

echo "=========================================="
echo "  Creating Channel: $CHANNEL_NAME"
echo "  (Using Channel Participation API)"
echo "=========================================="

# Check if genesis block exists
if [ ! -f "$CHANNEL_DIR/mychannel.block" ]; then
    echo "ERROR: Genesis block not found at $CHANNEL_DIR/mychannel.block"
    echo "Run 'make generate' first"
    exit 1
fi

# Check if orderer already has the channel
echo "[1/3] Checking if channel exists on orderer..."
CHANNELS=$(osnadmin channel list -o orderer.example.com:7053 --no-status 2>/dev/null || echo "")
if echo "$CHANNELS" | grep -q "$CHANNEL_NAME"; then
    echo "Channel already exists on orderer"
else
    echo "Joining orderer to channel via osnadmin..."
    osnadmin channel join \
        --channelID "$CHANNEL_NAME" \
        --config-block "$CHANNEL_DIR/mychannel.block" \
        -o orderer.example.com:7053 \
        --no-status
    echo "  ✓ Orderer joined channel"
fi

sleep 3

# Check if peer already joined
echo ""
echo "[2/3] Checking if peer is on channel..."
PEER_CHANNELS=$(peer channel list 2>/dev/null || echo "")
if echo "$PEER_CHANNELS" | grep -q "$CHANNEL_NAME"; then
    echo "Peer already on channel"
else
    echo "Joining peer to channel..."
    peer channel join -b "$CHANNEL_DIR/mychannel.block"
    echo "  ✓ Peer joined channel"
fi

echo ""
echo "[3/3] Verifying..."
peer channel list

echo ""
echo "=========================================="
echo "  Channel Created Successfully"
echo "=========================================="
