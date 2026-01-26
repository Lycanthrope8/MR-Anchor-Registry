#!/bin/bash
# =============================================================================
# MR-Anchor-Registry - Startup Script (up.sh)
# =============================================================================
# This script starts all components in the correct order:
# 1. Fabric Network (if not already running)
# 2. Deploy/Verify Chaincode
# 3. PostgreSQL (off-chain storage)
# 4. Gateway (REST API)
# =============================================================================

# ./up.sh                    # Full startup
# ./up.sh --skip-fabric      # Skip Fabric (if already running)
# ./up.sh --skip-chaincode   # Skip chaincode check
# ./up.sh --force-deploy     # Force redeploy chaincode


set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# =============================================================================
# CONFIGURATION - Modify these variables for your environment
# =============================================================================

# Directory paths
export WORK_DIR="${WORK_DIR:-$HOME/work}"
export MR_ANCHOR_DIR="${MR_ANCHOR_DIR:-$WORK_DIR/MR-Anchor-Registry}"
export FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$WORK_DIR/fabric-samples}"
export TEST_NETWORK_DIR="$FABRIC_SAMPLES_DIR/test-network"

# Fabric configuration
export FABRIC_CHANNEL="${FABRIC_CHANNEL:-mychannel}"
export FABRIC_CHAINCODE="${FABRIC_CHAINCODE:-anchorregistry}"
export FABRIC_MSP_ID="${FABRIC_MSP_ID:-Org1MSP}"

# Gateway configuration
export GATEWAY_PORT="${GATEWAY_PORT:-3000}"
export NODE_ENV="${NODE_ENV:-production}"

# PostgreSQL configuration
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"
export POSTGRES_DB="${POSTGRES_DB:-anchor_registry}"
export POSTGRES_USER="${POSTGRES_USER:-anchor_admin}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-anchor_secret_2025}"

# Fabric connection (for gateway)
export FABRIC_PEER_ENDPOINT="${FABRIC_PEER_ENDPOINT:-localhost:7051}"
export FABRIC_ORDERER_ENDPOINT="${FABRIC_ORDERER_ENDPOINT:-localhost:7050}"
export FABRIC_CRYPTO_PATH="${FABRIC_CRYPTO_PATH:-$TEST_NETWORK_DIR/organizations}"
export FABRIC_TLS_ENABLED="${FABRIC_TLS_ENABLED:-true}"
export FABRIC_PEER_TLS_CERT="${FABRIC_PEER_TLS_CERT:-$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt}"

# Mock mode - MUST be false for real Fabric
export FABRIC_MOCK="${FABRIC_MOCK:-false}"

# Endorsement configuration
export ENDORSEMENT_THRESHOLD="${ENDORSEMENT_THRESHOLD:-1}"

# API Keys (format: key:role:name,key:role:name,...)
export API_KEYS="${API_KEYS:-proposer-key-001:proposer:Alice,endorser-key-001:endorser:Carlos,supervisor-key-001:supervisor:Eva}"
export SUPERVISOR_IDS="${SUPERVISOR_IDS:-supervisor-key-001}"

# =============================================================================
# SETUP PATH FOR COMMON TOOLS
# =============================================================================

# Add common Node.js installation paths (Homebrew on macOS)
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Source nvm if available (common on macOS)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
fi

# Try to find node in common locations if not in PATH
if ! command -v node &> /dev/null; then
    # Check Homebrew locations
    if [ -x "/opt/homebrew/bin/node" ]; then
        export PATH="/opt/homebrew/bin:$PATH"
    elif [ -x "/usr/local/bin/node" ]; then
        export PATH="/usr/local/bin:$PATH"
    fi
    
    # Check nvm installations
    if [ -d "$HOME/.nvm/versions/node" ]; then
        LATEST_NODE=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)
        if [ -n "$LATEST_NODE" ]; then
            export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
        fi
    fi
fi

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}Error: $1 is required but not installed or not in PATH.${NC}"
        echo ""
        echo "Installation suggestions:"
        case $1 in
            node|npm)
                echo "  macOS (Homebrew): brew install node"
                echo "  macOS (nvm):      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
                echo "                    source ~/.nvm/nvm.sh && nvm install 20"
                ;;
            docker)
                echo "  macOS: brew install --cask docker"
                echo "  or:    Download from https://docker.com"
                ;;
        esac
        echo ""
        echo "If already installed, check your PATH or run:"
        echo "  which node"
        echo "  echo \$PATH"
        exit 1
    fi
}

wait_for_port() {
    local port=$1
    local timeout=${2:-30}
    local count=0
    
    while ! nc -z localhost $port 2>/dev/null; do
        sleep 1
        count=$((count + 1))
        if [ $count -ge $timeout ]; then
            return 1
        fi
    done
    return 0
}

# =============================================================================
# PARSE ARGUMENTS
# =============================================================================

SKIP_FABRIC=false
SKIP_CHAINCODE=false
FORCE_DEPLOY=false

for arg in "$@"; do
    case $arg in
        --skip-fabric)
            SKIP_FABRIC=true
            ;;
        --skip-chaincode)
            SKIP_CHAINCODE=true
            ;;
        --force-deploy)
            FORCE_DEPLOY=true
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --skip-fabric      Skip Fabric network startup (assume already running)"
            echo "  --skip-chaincode   Skip chaincode deployment check"
            echo "  --force-deploy     Force redeploy chaincode even if already deployed"
            echo "  --help             Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  WORK_DIR           Base work directory (default: ~/work)"
            echo "  GATEWAY_PORT       Gateway port (default: 3000)"
            echo "  POSTGRES_PORT      PostgreSQL port (default: 5433)"
            echo "  POSTGRES_PASSWORD  PostgreSQL password (default: anchor_secret_2025)"
            echo ""
            exit 0
            ;;
    esac
done

# =============================================================================
# PRE-FLIGHT CHECKS
# =============================================================================

echo -e "${CYAN}=========================================="
echo "  MR-Anchor-Registry - Startup"
echo -e "==========================================${NC}"
echo ""
echo "Configuration:"
echo "  WORK_DIR:        $WORK_DIR"
echo "  MR_ANCHOR_DIR:   $MR_ANCHOR_DIR"
echo "  FABRIC_SAMPLES:  $FABRIC_SAMPLES_DIR"
echo "  GATEWAY_PORT:    $GATEWAY_PORT"
echo "  POSTGRES_PORT:   $POSTGRES_PORT"
echo "  FABRIC_MOCK:     $FABRIC_MOCK"
echo ""

# Check required commands
echo -e "${YELLOW}Checking prerequisites...${NC}"
check_command docker
check_command node
check_command npm

# Check directories exist
if [ ! -d "$MR_ANCHOR_DIR" ]; then
    echo -e "${RED}Error: MR-Anchor-Registry directory not found: $MR_ANCHOR_DIR${NC}"
    exit 1
fi

if [ ! -d "$TEST_NETWORK_DIR" ]; then
    echo -e "${RED}Error: Fabric test-network directory not found: $TEST_NETWORK_DIR${NC}"
    exit 1
fi

echo -e "${GREEN}  ✓ Prerequisites OK${NC}"
echo ""

# =============================================================================
# STEP 1: FABRIC NETWORK
# =============================================================================

echo -e "${YELLOW}[1/5] Checking Fabric Network...${NC}"

FABRIC_RUNNING=false
if docker ps | grep -q "peer0.org1.example.com"; then
    FABRIC_RUNNING=true
    echo -e "${GREEN}  ✓ Fabric network is already running${NC}"
fi

if [ "$FABRIC_RUNNING" = false ] && [ "$SKIP_FABRIC" = false ]; then
    echo "  Starting Fabric test-network..."
    cd "$TEST_NETWORK_DIR"
    
    # Start network and create channel
    ./network.sh up createChannel -c $FABRIC_CHANNEL
    
    echo -e "${GREEN}  ✓ Fabric network started${NC}"
    FABRIC_RUNNING=true
elif [ "$FABRIC_RUNNING" = false ]; then
    echo -e "${RED}  ✗ Fabric network not running and --skip-fabric specified${NC}"
    exit 1
fi

# =============================================================================
# STEP 2: DEPLOY CHAINCODE
# =============================================================================

echo -e "${YELLOW}[2/5] Checking Chaincode...${NC}"

# Set up Fabric environment
export PATH="${FABRIC_SAMPLES_DIR}/bin:$PATH"
export FABRIC_CFG_PATH="${FABRIC_SAMPLES_DIR}/config/"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="${TEST_NETWORK_DIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="${TEST_NETWORK_DIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051

CHAINCODE_DEPLOYED=false
if [ "$SKIP_CHAINCODE" = false ]; then
    # Check if chaincode is already deployed
    if peer lifecycle chaincode querycommitted -C $FABRIC_CHANNEL -n $FABRIC_CHAINCODE 2>/dev/null | grep -q "Version:"; then
        CHAINCODE_DEPLOYED=true
        echo -e "${GREEN}  ✓ Chaincode already deployed${NC}"
        
        # Show current version
        peer lifecycle chaincode querycommitted -C $FABRIC_CHANNEL -n $FABRIC_CHAINCODE 2>/dev/null | head -1
    fi
    
    if [ "$CHAINCODE_DEPLOYED" = false ] || [ "$FORCE_DEPLOY" = true ]; then
        echo "  Deploying chaincode..."
        cd "$TEST_NETWORK_DIR"
        
        # Get current sequence number
        SEQUENCE=1
        if [ "$CHAINCODE_DEPLOYED" = true ]; then
            CURRENT_SEQ=$(peer lifecycle chaincode querycommitted -C $FABRIC_CHANNEL -n $FABRIC_CHAINCODE 2>/dev/null | grep -o "Sequence: [0-9]*" | grep -o "[0-9]*")
            SEQUENCE=$((CURRENT_SEQ + 1))
        fi
        
        ./network.sh deployCC \
            -c $FABRIC_CHANNEL \
            -ccn $FABRIC_CHAINCODE \
            -ccp "$MR_ANCHOR_DIR/chaincode/anchor-registry" \
            -ccl javascript \
            -ccs $SEQUENCE
        
        echo -e "${GREEN}  ✓ Chaincode deployed (sequence: $SEQUENCE)${NC}"
        
        # Initialize ledger
        echo "  Initializing ledger..."
        peer chaincode invoke \
            -o localhost:7050 \
            --ordererTLSHostnameOverride orderer.example.com \
            --tls \
            --cafile "${TEST_NETWORK_DIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" \
            -C $FABRIC_CHANNEL \
            -n $FABRIC_CHAINCODE \
            --peerAddresses localhost:7051 \
            --tlsRootCertFiles "${TEST_NETWORK_DIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
            --peerAddresses localhost:9051 \
            --tlsRootCertFiles "${TEST_NETWORK_DIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
            -c '{"function":"InitLedger","Args":[]}' \
            2>&1 | grep -v "^$"
        
        echo -e "${GREEN}  ✓ Ledger initialized${NC}"
    fi
else
    echo -e "${YELLOW}  ⚠ Skipping chaincode check (--skip-chaincode)${NC}"
fi

# =============================================================================
# STEP 3: POSTGRESQL
# =============================================================================

echo -e "${YELLOW}[3/5] Starting PostgreSQL...${NC}"

# Check if already running
if docker ps | grep -q mr-anchor-postgres; then
    echo -e "${GREEN}  ✓ PostgreSQL already running${NC}"
else
    # Remove old container if exists
    docker rm mr-anchor-postgres 2>/dev/null || true
    
    # Start PostgreSQL
    docker run -d \
        --name mr-anchor-postgres \
        --network fabric_test \
        -p ${POSTGRES_PORT}:5432 \
        -e POSTGRES_USER=${POSTGRES_USER} \
        -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} \
        -e POSTGRES_DB=${POSTGRES_DB} \
        -v "${MR_ANCHOR_DIR}/storage/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
        postgres:15-alpine \
        > /dev/null
    
    echo "  Waiting for PostgreSQL to be ready..."
    sleep 5
    
    # Wait for PostgreSQL to be ready
    for i in {1..30}; do
        if docker exec mr-anchor-postgres pg_isready -U $POSTGRES_USER -d $POSTGRES_DB > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    
    echo -e "${GREEN}  ✓ PostgreSQL started on port $POSTGRES_PORT${NC}"
fi

# =============================================================================
# STEP 4: INSTALL GATEWAY DEPENDENCIES
# =============================================================================

echo -e "${YELLOW}[4/5] Checking Gateway dependencies...${NC}"

cd "$MR_ANCHOR_DIR/gateway/registry-gateway"

if [ ! -d "node_modules" ] || [ "$FORCE_DEPLOY" = true ]; then
    echo "  Installing npm packages..."
    npm install --silent
    echo -e "${GREEN}  ✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}  ✓ Dependencies already installed${NC}"
fi

# =============================================================================
# STEP 5: START GATEWAY
# =============================================================================

echo -e "${YELLOW}[5/5] Starting Gateway...${NC}"

# Kill existing gateway if running
if [ -f "$MR_ANCHOR_DIR/gateway.pid" ]; then
    OLD_PID=$(cat "$MR_ANCHOR_DIR/gateway.pid")
    if ps -p $OLD_PID > /dev/null 2>&1; then
        kill $OLD_PID 2>/dev/null || true
        sleep 2
    fi
fi
pkill -f "node.*registry-gateway" 2>/dev/null || true

# Export all environment variables for gateway
export PORT=$GATEWAY_PORT

# Start gateway in background
cd "$MR_ANCHOR_DIR/gateway/registry-gateway"
nohup node src/index.js > "$MR_ANCHOR_DIR/gateway.log" 2>&1 &
echo $! > "$MR_ANCHOR_DIR/gateway.pid"

echo "  Waiting for Gateway to be ready..."
sleep 5

# Wait for gateway to be ready
for i in {1..30}; do
    if curl -s http://localhost:$GATEWAY_PORT/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Verify gateway is running
if curl -s http://localhost:$GATEWAY_PORT/health | grep -q "healthy"; then
    echo -e "${GREEN}  ✓ Gateway started on port $GATEWAY_PORT${NC}"
else
    echo -e "${RED}  ✗ Gateway failed to start. Check logs: $MR_ANCHOR_DIR/gateway.log${NC}"
    exit 1
fi

# =============================================================================
# SUMMARY
# =============================================================================

echo ""
echo -e "${CYAN}=========================================="
echo "  Startup Complete!"
echo -e "==========================================${NC}"
echo ""
echo "Services running:"
echo "  • Fabric Network (test-network)"
echo "    - Orderer: localhost:7050"
echo "    - Peer Org1: localhost:7051"
echo "    - Peer Org2: localhost:9051"
echo "  • Chaincode: $FABRIC_CHAINCODE on channel $FABRIC_CHANNEL"
echo "  • PostgreSQL: localhost:$POSTGRES_PORT"
echo "  • Gateway: http://localhost:$GATEWAY_PORT"
echo ""
echo "Health check:"
curl -s http://localhost:$GATEWAY_PORT/health | python3 -m json.tool 2>/dev/null || \
    curl -s http://localhost:$GATEWAY_PORT/health
echo ""
echo -e "${GREEN}Ready for requests!${NC}"
echo ""
echo "Quick test:"
echo "  curl http://localhost:$GATEWAY_PORT/health"
echo ""
echo "Logs:"
echo "  tail -f $MR_ANCHOR_DIR/gateway.log"
echo ""
echo "To shutdown:"
echo "  ./down.sh           # Keep Fabric running"
echo "  ./down.sh --fabric  # Shutdown everything"
echo ""
