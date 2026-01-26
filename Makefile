# =============================================================================
# MR-Anchor-Registry Makefile
# =============================================================================
# CORRECT ORDER: generate crypto FIRST, then start orderer/peer
# =============================================================================

.PHONY: up down deploy test test-mock clean help generate channel

SHELL := /bin/bash

# =============================================================================
# MAIN WORKFLOW
# =============================================================================

## up: Start all services (correct order)
up: check-docker
	@echo "=========================================="
	@echo "  MR-Anchor-Registry - Starting"
	@echo "=========================================="
	@if [ ! -f .env ]; then cp .env.example .env 2>/dev/null || true; fi
	@mkdir -p network/organizations network/channel-artifacts
	@echo ""
	@echo "[1/6] Generating crypto materials (FIRST, before any services)..."
	@$(MAKE) -s generate
	@echo ""
	@echo "[2/6] Starting orderer..."
	@docker compose up -d orderer.example.com
	@echo "Waiting for orderer to start (10s)..."
	@sleep 10
	@echo ""
	@echo "[3/6] Starting peer..."
	@docker compose up -d peer0.org1.example.com
	@echo "Waiting for peer to start (10s)..."
	@sleep 10
	@echo ""
	@echo "[4/6] Creating and joining channel..."
	@$(MAKE) -s channel
	@echo ""
	@echo "[5/6] Starting PostgreSQL..."
	@docker compose up -d postgres
	@echo "Waiting for PostgreSQL (10s)..."
	@sleep 10
	@echo ""
	@echo "[6/6] Starting Gateway and test-runner..."
	@docker compose up -d gateway test-runner
	@echo "Waiting for Gateway (30s)..."
	@sleep 30
	@echo ""
	@echo "=========================================="
	@echo "  All services started!"
	@echo "  Gateway: http://localhost:$${GATEWAY_PORT:-3000}"
	@echo "=========================================="
	@echo ""
	@echo "Next: make deploy"

## generate: Generate crypto and channel artifacts using CLI container
generate:
	@if [ -f network/organizations/.generated ]; then \
		echo "Crypto already exists. Use 'make clean' to regenerate."; \
	else \
		echo "Starting CLI container for crypto generation..."; \
		docker compose up -d cli; \
		sleep 3; \
		echo "Running cryptogen and configtxgen..."; \
		docker compose exec -T cli bash /opt/gopath/src/github.com/hyperledger/fabric/peer/scripts/generate.sh; \
	fi

## channel: Create channel and join peer (using osnadmin for channel participation)
channel:
	@docker compose up -d cli
	@sleep 2
	@docker compose exec -T cli bash /opt/gopath/src/github.com/hyperledger/fabric/peer/scripts/channel.sh

## deploy: Deploy chaincode (single org - Org1 only)
deploy:
	@echo "=========================================="
	@echo "  Deploying Chaincode"
	@echo "=========================================="
	@docker compose exec -T cli bash /opt/gopath/src/github.com/hyperledger/fabric/peer/scripts/deploy.sh
	@echo ""
	@echo "Next: make test"

## test: Run smoke tests (real Fabric mode)
test:
	@echo "=========================================="
	@echo "  Running Smoke Tests"
	@echo "=========================================="
	@docker compose exec -T test-runner sh /scripts/smoke_test.sh

## test-mock: Run smoke tests (mock mode allowed)
test-mock:
	@echo "=========================================="
	@echo "  Running Smoke Tests (MOCK MODE)"
	@echo "=========================================="
	@docker compose exec -T test-runner sh /scripts/smoke_test.sh --allow-mock

## down: Stop all services
down:
	@echo "Stopping services..."
	@docker compose down
	@echo "Done"

## clean: Remove all data for fresh start
clean:
	@echo "Cleaning everything..."
	@docker compose down -v --remove-orphans 2>/dev/null || true
	@rm -rf network/organizations network/channel-artifacts
	@mkdir -p network/organizations network/channel-artifacts
	@echo "Clean. Run 'make up' for fresh start."

# =============================================================================
# UTILITIES
# =============================================================================

check-docker:
	@docker info > /dev/null 2>&1 || (echo "ERROR: Docker not running" && exit 1)

logs:
	@docker compose logs -f

logs-gateway:
	@docker compose logs -f gateway

logs-peer:
	@docker compose logs -f peer0.org1.example.com

logs-orderer:
	@docker compose logs -f orderer.example.com

status:
	@docker compose ps

shell-cli:
	@docker compose exec cli bash

query-config:
	@docker compose exec -T cli peer chaincode query -C mychannel -n anchorregistry -c '{"function":"GetConfig","Args":[]}'

help:
	@echo ""
	@echo "MR-Anchor-Registry"
	@echo ""
	@echo "  make up        - Start all services"
	@echo "  make deploy    - Deploy chaincode"
	@echo "  make test      - Run smoke tests"
	@echo "  make down      - Stop services"
	@echo "  make clean     - Remove all data"
	@echo ""
	@echo "Quick Start: make up && make deploy && make test"
	@echo ""
