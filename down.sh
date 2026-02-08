#!/bin/bash
# ==============================================================================
# down.sh - Complete shutdown and cleanup of MR Anchor Registry
# Stops all containers, removes volumes, and cleans generated files
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║         MR Anchor Registry - Complete Shutdown               ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ==============================================================================
# 1. Stop Gateway Server (if running)
# ==============================================================================
echo -e "${YELLOW}[1/5] Stopping Gateway Server...${NC}"

# Find and kill any node process running the gateway
GATEWAY_PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$GATEWAY_PID" ]; then
    echo "  Killing gateway process on port 3000 (PID: $GATEWAY_PID)"
    kill -9 $GATEWAY_PID 2>/dev/null || true
    echo -e "${GREEN}  ✓ Gateway stopped${NC}"
else
    echo "  Gateway not running on port 3000"
fi

# ==============================================================================
# 2. Stop Docker Containers
# ==============================================================================
echo -e "${YELLOW}[2/5] Stopping Docker containers...${NC}"

# Try docker-compose down from network/docker directory
if [ -f "network/docker/docker-compose.yaml" ]; then
    cd network/docker
    docker-compose down --volumes --remove-orphans 2>/dev/null || true
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}  ✓ Docker containers stopped${NC}"
else
    echo "  docker-compose.yaml not found, trying to stop containers manually..."
    # Stop containers by name pattern
    docker stop $(docker ps -aq --filter "name=peer0.org1" --filter "name=peer0.org2" --filter "name=orderer" --filter "name=anchor-registry") 2>/dev/null || true
    docker rm $(docker ps -aq --filter "name=peer0.org1" --filter "name=peer0.org2" --filter "name=orderer" --filter "name=anchor-registry") 2>/dev/null || true
fi

# ==============================================================================
# 3. Remove Docker Volumes
# ==============================================================================
echo -e "${YELLOW}[3/5] Removing Docker volumes...${NC}"

# Remove named volumes
docker volume rm docker_orderer.anchor-registry.com 2>/dev/null || true
docker volume rm docker_peer0.org1.anchor-registry.com 2>/dev/null || true
docker volume rm docker_peer0.org2.anchor-registry.com 2>/dev/null || true

# Also try without 'docker_' prefix (depends on docker-compose version)
docker volume rm orderer.anchor-registry.com 2>/dev/null || true
docker volume rm peer0.org1.anchor-registry.com 2>/dev/null || true
docker volume rm peer0.org2.anchor-registry.com 2>/dev/null || true

# Remove any dangling volumes related to our network
docker volume ls -q | grep -E "(anchor-registry|org1|org2|orderer)" | xargs docker volume rm 2>/dev/null || true

echo -e "${GREEN}  ✓ Docker volumes removed${NC}"

# ==============================================================================
# 4. Remove Chaincode Docker Images
# ==============================================================================
echo -e "${YELLOW}[4/5] Removing chaincode Docker images...${NC}"

# Remove chaincode containers
docker rm -f $(docker ps -aq --filter "name=dev-peer") 2>/dev/null || true

# Remove chaincode images
docker rmi -f $(docker images -q "dev-peer*") 2>/dev/null || true
docker rmi -f $(docker images -q "*anchor-registry*") 2>/dev/null || true

echo -e "${GREEN}  ✓ Chaincode images removed${NC}"

# ==============================================================================
# 5. Clean Generated Files
# ==============================================================================
echo -e "${YELLOW}[5/5] Cleaning generated files...${NC}"

# Remove crypto material
if [ -d "network/crypto-config" ]; then
    rm -rf network/crypto-config
    echo "  Removed network/crypto-config/"
fi

# Remove channel artifacts
if [ -d "network/channel-artifacts" ]; then
    rm -rf network/channel-artifacts
    echo "  Removed network/channel-artifacts/"
fi

# Remove gateway wallet
if [ -d "gateway/wallet" ]; then
    rm -rf gateway/wallet
    echo "  Removed gateway/wallet/"
fi

# Remove chaincode packages
rm -f chaincode/*.tar.gz 2>/dev/null || true
rm -f *.tar.gz 2>/dev/null || true
echo "  Removed chaincode packages"

# Remove log files
rm -f gateway.log 2>/dev/null || true
rm -f gateway/*.log 2>/dev/null || true
echo "  Removed log files"

echo -e "${GREEN}  ✓ Generated files cleaned${NC}"

# ==============================================================================
# Summary
# ==============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Shutdown Complete!                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "All components have been stopped and cleaned:"
echo "  • Gateway server stopped"
echo "  • Docker containers removed"
echo "  • Docker volumes removed"
echo "  • Chaincode images removed"
echo "  • Generated crypto/artifacts cleaned"
echo ""
echo -e "Run ${YELLOW}./up.sh${NC} to start fresh."