#!/bin/bash
# =============================================================================
# MR-Anchor-Registry - Shutdown Script (down.sh)
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

export WORK_DIR="${WORK_DIR:-$HOME/work}"
export MR_ANCHOR_DIR="${MR_ANCHOR_DIR:-$WORK_DIR/MR-Anchor-Registry}"
export FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$WORK_DIR/fabric-samples}"
export TEST_NETWORK_DIR="$FABRIC_SAMPLES_DIR/test-network"

SHUTDOWN_FABRIC=false
FORCE=false

for arg in "$@"; do
    case $arg in
        --fabric)
            SHUTDOWN_FABRIC=true
            ;;
        --force|-f)
            FORCE=true
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --fabric    Also shutdown Fabric test-network"
            echo "  --force     Force kill processes"
            echo "  --help      Show this help"
            exit 0
            ;;
    esac
done

echo -e "${CYAN}=========================================="
echo "  MR-Anchor-Registry - Shutdown"
echo -e "==========================================${NC}"
echo ""

# Stop Gateway
echo -e "${YELLOW}[1/3] Shutting down Gateway...${NC}"
if [ -f "$MR_ANCHOR_DIR/gateway.pid" ]; then
    PID=$(cat "$MR_ANCHOR_DIR/gateway.pid")
    if ps -p $PID > /dev/null 2>&1; then
        kill $PID 2>/dev/null || true
        sleep 2
        echo -e "${GREEN}  ✓ Gateway stopped${NC}"
    else
        echo -e "${YELLOW}  ⚠ Gateway was not running${NC}"
    fi
    rm -f "$MR_ANCHOR_DIR/gateway.pid"
else
    pkill -f "node.*registry-gateway" 2>/dev/null && \
        echo -e "${GREEN}  ✓ Gateway stopped${NC}" || \
        echo -e "${YELLOW}  ⚠ Gateway was not running${NC}"
fi

# Stop PostgreSQL
echo -e "${YELLOW}[2/3] Shutting down PostgreSQL...${NC}"
if docker ps | grep -q mr-anchor-postgres; then
    docker stop mr-anchor-postgres > /dev/null 2>&1
    docker rm mr-anchor-postgres > /dev/null 2>&1
    echo -e "${GREEN}  ✓ PostgreSQL stopped${NC}"
else
    echo -e "${YELLOW}  ⚠ PostgreSQL was not running${NC}"
fi

# Stop Fabric (optional)
if [ "$SHUTDOWN_FABRIC" = true ]; then
    echo -e "${YELLOW}[3/3] Shutting down Fabric test-network...${NC}"
    if [ -d "$TEST_NETWORK_DIR" ]; then
        cd "$TEST_NETWORK_DIR"
        ./network.sh down
        echo -e "${GREEN}  ✓ Fabric network stopped${NC}"
    fi
else
    echo -e "${YELLOW}[3/3] Skipping Fabric shutdown (use --fabric to include)${NC}"
fi

echo ""
echo -e "${CYAN}=========================================="
echo "  Shutdown Complete"
echo -e "==========================================${NC}"
echo ""
echo "To restart: ./up.sh"
echo ""
