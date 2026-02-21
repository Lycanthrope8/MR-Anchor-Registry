#!/bin/bash
# ==============================================================================
# up.sh - Complete startup of MR Anchor Registry
# Starts Fabric network, deploys chaincode, and launches gateway with admin panels
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         MR Anchor Registry - Complete Startup                ║${NC}"
echo -e "${BLUE}║         Two-Organization Blockchain Network                  ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Track start time
START_TIME=$(date +%s)

# ==============================================================================
# Pre-flight Checks
# ==============================================================================
echo -e "${YELLOW}[Pre-flight] Checking requirements...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed${NC}"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi

# Check if port 3000 is already in use
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}Warning: Port 3000 is in use. Stopping existing process...${NC}"
    kill -9 $(lsof -ti:3000) 2>/dev/null || true
    sleep 2
fi

# Check if port 3001 is already in use (Org2 gateway)
if lsof -Pi :3001 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}Warning: Port 3001 is in use. Stopping existing process...${NC}"
    kill -9 $(lsof -ti:3001) 2>/dev/null || true
    sleep 2
fi

echo -e "${GREEN}  ✓ All requirements met${NC}"
echo ""

# ==============================================================================
# 1. Generate Crypto Materials
# ==============================================================================
echo -e "${YELLOW}[1/4] Generating crypto materials...${NC}"

if [ -f "scripts/generate.sh" ]; then
    chmod +x scripts/generate.sh
    ./scripts/generate.sh
    echo -e "${GREEN}  ✓ Crypto materials generated${NC}"
else
    echo -e "${RED}Error: scripts/generate.sh not found${NC}"
    exit 1
fi
echo ""

# ==============================================================================
# 2. Start Docker Network
# ==============================================================================
echo -e "${YELLOW}[2/4] Starting Docker containers...${NC}"

if [ -f "network/docker/docker-compose.yaml" ]; then
    cd network/docker
    docker-compose up -d
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}  ✓ Docker containers started${NC}"
else
    echo -e "${RED}Error: network/docker/docker-compose.yaml not found${NC}"
    exit 1
fi

echo "  Waiting for containers to be ready..."

  # Wait for orderer admin port to be ready (port 7053)
  MAX_RETRIES=30
  DELAY=2
  echo "  Waiting for orderer to initialize Raft consensus..."
  for i in $(seq 1 $MAX_RETRIES); do
    if docker logs orderer.anchor-registry.com 2>&1 | grep -q "Beginning to serve requests\|Raft leader changed"; then
      echo "  ✓ Orderer is ready (attempt $i/$MAX_RETRIES)"
      break
    fi
    if [ "$i" -eq "$MAX_RETRIES" ]; then
      echo "  ✗ Orderer did not become ready in time"
      exit 1
    fi
    sleep $DELAY
  done

  # Extra buffer for admin API to bind
  sleep 2
  echo "  ✓ All containers running"

# ==============================================================================
# 3. Create Channel
# ==============================================================================
echo -e "${YELLOW}[3/4] Creating and joining channel...${NC}"

if [ -f "scripts/channel.sh" ]; then
    chmod +x scripts/channel.sh
    ./scripts/channel.sh all
    echo -e "${GREEN}  ✓ Channel created and peers joined${NC}"
else
    echo -e "${RED}Error: scripts/channel.sh not found${NC}"
    exit 1
fi
echo ""

# ==============================================================================
# 4. Deploy Chaincode
# ==============================================================================
echo -e "${YELLOW}[4/4] Deploying chaincode...${NC}"

if [ -f "scripts/chaincode.sh" ]; then
    chmod +x scripts/chaincode.sh
    ./scripts/chaincode.sh deploy
    echo -e "${GREEN}  ✓ Chaincode deployed${NC}"
else
    echo -e "${RED}Error: scripts/chaincode.sh not found${NC}"
    exit 1
fi
echo ""

# ==============================================================================
# Calculate elapsed time
# ==============================================================================
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

# ==============================================================================
# Summary
# ==============================================================================
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Network Ready!                                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Network setup completed in ${YELLOW}${MINUTES}m ${SECONDS}s${NC}"
echo ""
echo -e "${BLUE}┌──────────────────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  Access Points (after gateway starts)                        │${NC}"
echo -e "${BLUE}├──────────────────────────────────────────────────────────────┤${NC}"
echo -e "${BLUE}│${NC}  Gateway API:     ${GREEN}http://localhost:3000${NC}                     ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}  Org1 Admin:      ${GREEN}http://localhost:3000/admin/org1${NC}          ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}  Org2 Admin:      ${GREEN}http://localhost:3000/admin/org2${NC}          ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}  SSE Events:      ${GREEN}http://localhost:3000/events/stream${NC}       ${BLUE}│${NC}"
echo -e "${BLUE}└──────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "${BLUE}┌──────────────────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  Workflow                                                    │${NC}"
echo -e "${BLUE}├──────────────────────────────────────────────────────────────┤${NC}"
echo -e "${BLUE}│${NC}  1. Unity client proposes anchor    → ${YELLOW}PROPOSED${NC}              ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}  2. Org1 Admin endorses             → ${YELLOW}ENDORSED_ORG1${NC}         ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}  3. Org2 Admin endorses             → ${GREEN}ACTIVE${NC}                ${BLUE}│${NC}"
echo -e "${BLUE}└──────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "To expose externally (for Unity): ${YELLOW}ngrok http 3000${NC}"
echo -e "To shutdown: ${YELLOW}./down.sh${NC}"
echo ""
echo -e "${YELLOW}Starting Gateway Server... (Press Ctrl+C to stop)${NC}"
echo ""

# ==============================================================================
# 5. Start BOTH Gateway Servers (Org1 + Org2)
# ==============================================================================
echo -e "${YELLOW}Starting BOTH Gateway Servers (Org1:3000, Org2:3001)...${NC}"
echo ""

GATEWAY_DIR="$SCRIPT_DIR/gateway"

# If running over SSH (no GUI), AppleScript will fail (-10810). Use tmux (preferred) or background.
if [[ -n "$SSH_CONNECTION" || -n "$SSH_TTY" ]]; then
    echo -e "${YELLOW}SSH session detected (no macOS GUI). Launching gateways via tmux...${NC}"

    if command -v tmux >/dev/null 2>&1; then
        # restart cleanly if session already exists
        tmux has-session -t mr-gateways 2>/dev/null && tmux kill-session -t mr-gateways

        tmux new-session -d -s mr-gateways "cd \"$GATEWAY_DIR\" && npm run start:org1"
        tmux split-window -h "cd \"$GATEWAY_DIR\" && npm run start:org2"
        tmux select-layout even-horizontal

        echo -e "${GREEN}  ✓ Gateways started inside tmux session: mr-gateways${NC}"
        echo -e "Attach with: ${YELLOW}tmux attach -t mr-gateways${NC}"
        echo -e "Detach with: ${YELLOW}Ctrl+b then d${NC}"
        exit 0
    fi

    # Fallback if tmux isn't installed
    echo -e "${YELLOW}tmux not found. Starting both gateways in background (logs/)...${NC}"
    mkdir -p "$SCRIPT_DIR/logs"

    ( cd "$GATEWAY_DIR" && ORG=org1 PORT=3000 npm start ) > "$SCRIPT_DIR/logs/gateway_org1.log" 2>&1 &
    ( cd "$GATEWAY_DIR" && ORG=org2 PORT=3001 npm start ) > "$SCRIPT_DIR/logs/gateway_org2.log" 2>&1 &

    echo -e "${GREEN}  ✓ Org1 log: logs/gateway_org1.log${NC}"
    echo -e "${GREEN}  ✓ Org2 log: logs/gateway_org2.log${NC}"
    echo -e "Tail logs: ${YELLOW}tail -f logs/gateway_org1.log${NC}  |  ${YELLOW}tail -f logs/gateway_org2.log${NC}"
    exit 0
fi

# macOS local GUI: open two Terminal windows/tabs automatically
if [[ "$OSTYPE" == "darwin"* ]] && command -v osascript >/dev/null 2>&1; then
    echo -e "${GREEN}  ✓ Detected macOS GUI session. Opening two Terminal windows for gateways...${NC}"

    # Ensure Terminal is launched
    open -a Terminal >/dev/null 2>&1 || true

    osascript <<EOF
tell application id "com.apple.Terminal"
    activate
    do script "cd \"$GATEWAY_DIR\" && npm run start:org1"
    delay 0.3
    do script "cd \"$GATEWAY_DIR\" && npm run start:org2"
end tell
EOF

    echo ""
    echo -e "${GREEN}Gateways launched:${NC}"
    echo -e "  Org1 Gateway: ${GREEN}http://localhost:3000${NC}"
    echo -e "  Org2 Gateway: ${GREEN}http://localhost:3001${NC}"
    echo ""
    echo -e "${YELLOW}up.sh completed. Stop gateways in their Terminal windows (Ctrl+C).${NC}"
    exit 0
fi

# Last-resort fallback (non-macOS local)
echo -e "${YELLOW}No macOS Terminal automation detected. Starting both gateways in background (logs/)...${NC}"
mkdir -p "$SCRIPT_DIR/logs"
( cd "$GATEWAY_DIR" && ORG=org1 PORT=3000 npm start ) > "$SCRIPT_DIR/logs/gateway_org1.log" 2>&1 &
( cd "$GATEWAY_DIR" && ORG=org2 PORT=3001 npm start ) > "$SCRIPT_DIR/logs/gateway_org2.log" 2>&1 &
echo -e "${GREEN}  ✓ Org1 log: logs/gateway_org1.log${NC}"
echo -e "${GREEN}  ✓ Org2 log: logs/gateway_org2.log${NC}"