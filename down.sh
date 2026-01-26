#!/bin/bash
# =============================================================================
# MR-Anchor-Registry - Shutdown Script (down.sh)
# =============================================================================
# This script safely shuts down all components in the correct order:
# 1. Gateway (REST API)
# 2. PostgreSQL (off-chain storage)
# 3. Fabric Network (optional - use --fabric flag)
# =============================================================================

# ./down.sh              # Stop gateway + postgres (keep Fabric)
# ./down.sh --fabric     # Stop everything including Fabric
# ./down.sh --force      # Force kill without graceful shutdown

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
WORK_DIR="${WORK_DIR:-$HOME/work}"
MR_ANCHOR_DIR="${MR_ANCHOR_DIR:-$WORK_DIR/MR-Anchor-Registry}"
FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$WORK_DIR/fabric-samples}"
TEST_NETWORK_DIR="$FABRIC_SAMPLES_DIR/test-network"

# Parse arguments
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
            echo "  --fabric    Also shutdown Fabric test-network (default: keep running)"
            echo "  --force     Force kill processes without graceful shutdown"
            echo "  --help      Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0              # Shutdown gateway and postgres only"
            echo "  $0 --fabric     # Shutdown everything including Fabric"
            exit 0
            ;;
    esac
done

echo -e "${CYAN}=========================================="
echo "  MR-Anchor-Registry - Shutdown"
echo -e "==========================================${NC}"
echo ""

# -----------------------------------------------------------------------------
# Step 1: Shutdown Gateway
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[1/3] Shutting down Gateway...${NC}"

if [ -f "$MR_ANCHOR_DIR/gateway.pid" ]; then
    PID=$(cat "$MR_ANCHOR_DIR/gateway.pid")
    if ps -p $PID > /dev/null 2>&1; then
        if [ "$FORCE" = true ]; then
            kill -9 $PID 2>/dev/null || true
        else
            kill $PID 2>/dev/null || true
            # Wait for graceful shutdown
            sleep 2
            # Force kill if still running
            if ps -p $PID > /dev/null 2>&1; then
                kill -9 $PID 2>/dev/null || true
            fi
        fi
        echo -e "${GREEN}  ✓ Gateway stopped (PID: $PID)${NC}"
    else
        echo -e "${YELLOW}  ⚠ Gateway was not running${NC}"
    fi
    rm -f "$MR_ANCHOR_DIR/gateway.pid"
else
    # Try to find and kill by process name
    pkill -f "node.*registry-gateway" 2>/dev/null && \
        echo -e "${GREEN}  ✓ Gateway stopped${NC}" || \
        echo -e "${YELLOW}  ⚠ Gateway was not running${NC}"
fi

# -----------------------------------------------------------------------------
# Step 2: Shutdown PostgreSQL
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[2/3] Shutting down PostgreSQL...${NC}"

if docker ps | grep -q mr-anchor-postgres; then
    docker stop mr-anchor-postgres > /dev/null 2>&1
    echo -e "${GREEN}  ✓ PostgreSQL stopped${NC}"
else
    echo -e "${YELLOW}  ⚠ PostgreSQL was not running${NC}"
fi

# Remove container (keeps volume for data persistence)
if docker ps -a | grep -q mr-anchor-postgres; then
    docker rm mr-anchor-postgres > /dev/null 2>&1
    echo -e "${GREEN}  ✓ PostgreSQL container removed${NC}"
fi

# -----------------------------------------------------------------------------
# Step 3: Shutdown Fabric (optional)
# -----------------------------------------------------------------------------
if [ "$SHUTDOWN_FABRIC" = true ]; then
    echo -e "${YELLOW}[3/3] Shutting down Fabric test-network...${NC}"
    
    if [ -d "$TEST_NETWORK_DIR" ]; then
        cd "$TEST_NETWORK_DIR"
        ./network.sh down
        echo -e "${GREEN}  ✓ Fabric network stopped${NC}"
    else
        echo -e "${RED}  ✗ Fabric test-network directory not found${NC}"
        echo -e "${RED}    Expected: $TEST_NETWORK_DIR${NC}"
    fi
else
    echo -e "${YELLOW}[3/3] Skipping Fabric shutdown (use --fabric to include)${NC}"
    echo -e "      Fabric network is still running for other uses"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo -e "${CYAN}=========================================="
echo "  Shutdown Complete"
echo -e "==========================================${NC}"
echo ""
echo "Services stopped:"
echo "  • Gateway (REST API)"
echo "  • PostgreSQL (off-chain storage)"
if [ "$SHUTDOWN_FABRIC" = true ]; then
    echo "  • Fabric test-network"
fi
echo ""
echo "To restart, run: ./up.sh"
echo ""
