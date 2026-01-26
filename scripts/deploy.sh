#!/bin/bash
# =============================================================================
# Deploy Chaincode - Single Org (Org1 only)
# NO Org2 references - clean single-org deployment
# =============================================================================

set -e

CC_NAME=anchorregistry
CC_VERSION=1.0
CC_SEQUENCE=1
CC_PATH=/opt/gopath/src/github.com/hyperledger/fabric/peer/chaincode/anchor-registry
CHANNEL_NAME=mychannel

echo "=========================================="
echo "  Deploying Chaincode: $CC_NAME"
echo "  Single Org (Org1MSP only)"
echo "=========================================="

# Verify chaincode exists
if [ ! -f "$CC_PATH/package.json" ]; then
    echo "ERROR: Chaincode not found at $CC_PATH"
    ls -la /opt/gopath/src/github.com/hyperledger/fabric/peer/chaincode/ 2>/dev/null || true
    exit 1
fi

echo "[1/7] Installing npm dependencies..."
cd "$CC_PATH"
npm install --production 2>/dev/null || npm install
cd /opt/gopath/src/github.com/hyperledger/fabric/peer

echo ""
echo "[2/7] Packaging chaincode..."
peer lifecycle chaincode package /tmp/${CC_NAME}.tar.gz \
    --path "$CC_PATH" \
    --lang node \
    --label ${CC_NAME}_${CC_VERSION}

echo ""
echo "[3/7] Installing on peer0.org1..."
peer lifecycle chaincode install /tmp/${CC_NAME}.tar.gz

echo ""
echo "[4/7] Getting package ID..."
CC_PACKAGE_ID=$(peer lifecycle chaincode queryinstalled 2>&1 | grep "${CC_NAME}_${CC_VERSION}" | sed -n 's/.*Package ID: \(.*\), Label.*/\1/p')
if [ -z "$CC_PACKAGE_ID" ]; then
    echo "ERROR: Could not get package ID"
    peer lifecycle chaincode queryinstalled
    exit 1
fi
echo "  Package ID: $CC_PACKAGE_ID"

echo ""
echo "[5/7] Approving for Org1..."
peer lifecycle chaincode approveformyorg \
    -o orderer.example.com:7050 \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" \
    --package-id "$CC_PACKAGE_ID"

echo ""
echo "[6/7] Committing chaincode (Org1 only)..."
# SINGLE ORG: Only peer0.org1, no Org2 peer addresses
peer lifecycle chaincode commit \
    -o orderer.example.com:7050 \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" \
    --peerAddresses peer0.org1.example.com:7051

echo ""
echo "[7/7] Verifying committed..."
peer lifecycle chaincode querycommitted --channelID "$CHANNEL_NAME" --name "$CC_NAME"

echo ""
echo "Initializing ledger..."
sleep 3
peer chaincode invoke \
    -o orderer.example.com:7050 \
    -C "$CHANNEL_NAME" \
    -n "$CC_NAME" \
    -c '{"function":"InitLedger","Args":[]}' \
    --waitForEvent

echo ""
echo "Testing query..."
sleep 2
peer chaincode query -C "$CHANNEL_NAME" -n "$CC_NAME" -c '{"function":"GetConfig","Args":[]}'

echo ""
echo "=========================================="
echo "  Chaincode Deployed Successfully"
echo "=========================================="
