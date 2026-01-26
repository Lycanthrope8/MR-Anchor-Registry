#!/bin/bash
# =============================================================================
# Generate crypto materials and genesis block
# Single-org network with channel participation API
# =============================================================================

set -e

PEER_DIR=/opt/gopath/src/github.com/hyperledger/fabric/peer
ORG_DIR=$PEER_DIR/organizations
CHANNEL_DIR=$PEER_DIR/channel-artifacts
CONFIGTX_DIR=$PEER_DIR/configtx
CRYPTO_CONFIG=$PEER_DIR/crypto-config.yaml

echo "=========================================="
echo "  Generating Crypto Materials"
echo "=========================================="

if [ -f "$ORG_DIR/.generated" ]; then
    echo "Already generated. Skipping."
    exit 0
fi

if [ ! -f "$CRYPTO_CONFIG" ]; then
    echo "ERROR: crypto-config.yaml not found at $CRYPTO_CONFIG"
    exit 1
fi

if [ ! -f "$CONFIGTX_DIR/configtx.yaml" ]; then
    echo "ERROR: configtx.yaml not found at $CONFIGTX_DIR/configtx.yaml"
    exit 1
fi

echo "[1/3] Running cryptogen..."
cryptogen generate --config="$CRYPTO_CONFIG" --output="$ORG_DIR"

echo ""
echo "Verifying orderer MSP was created..."
if [ ! -d "$ORG_DIR/ordererOrganizations/example.com/orderers/orderer.example.com/msp" ]; then
    echo "ERROR: Orderer MSP not generated!"
    exit 1
fi
echo "  ✓ Orderer MSP exists"

if [ ! -d "$ORG_DIR/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/msp" ]; then
    echo "ERROR: Peer MSP not generated!"
    exit 1
fi
echo "  ✓ Peer MSP exists"

echo ""
echo "[2/3] Generating genesis block for channel (channel participation API)..."
export FABRIC_CFG_PATH="$CONFIGTX_DIR"
configtxgen -profile SingleOrgApplicationGenesis \
    -outputBlock "$CHANNEL_DIR/mychannel.block" \
    -channelID mychannel

if [ ! -f "$CHANNEL_DIR/mychannel.block" ]; then
    echo "ERROR: Genesis block not created!"
    exit 1
fi
echo "  ✓ Genesis block created: mychannel.block"

echo ""
echo "[3/3] Marking complete..."
touch "$ORG_DIR/.generated"

echo ""
echo "=========================================="
echo "  Crypto Generation Complete"
echo "=========================================="
echo ""
echo "Organizations:"
ls -la "$ORG_DIR"
echo ""
echo "Channel artifacts:"
ls -la "$CHANNEL_DIR"
