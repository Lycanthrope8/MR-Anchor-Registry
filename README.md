# MR-Anchor-Registry

Blockchain-based spatial anchor registry for multi-user mixed reality.

## Quick Start

```bash
make up      # Start services (~2-3 min first time)
make deploy  # Deploy chaincode (~1 min)
make test    # Run smoke tests
```

## Architecture

- **Single-org Fabric network** (Org1MSP)
- **Channel Participation API** (no system channel)
- **Gateway enforces roles** (proposer/endorser/supervisor via API keys)
- **Chaincode enforces** business logic (no duplicates, state transitions)

## API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | - | Health check |
| `/claims/propose` | POST | proposer | Create proposal |
| `/claims/{id}/endorse` | POST | endorser | Endorse |
| `/assets/{id}/resolve` | GET | any | Get active |
| `/assets/{id}/revoke` | POST | supervisor | Revoke |

## API Keys

| Key | Role |
|-----|------|
| `proposer-key-001` | proposer |
| `endorser-key-001` | endorser |
| `supervisor-key-001` | supervisor |

## Notes

- **Supervisor-only revoke** enforced by **gateway** (API key check)
- Chaincode doesn't do MSP-based role checks (works with cryptogen)
- Use `make test-mock` for development without Fabric

## Commands

```bash
make up        # Start all
make deploy    # Deploy chaincode
make test      # Smoke tests (real Fabric)
make test-mock # Smoke tests (mock mode)
make down      # Stop
make clean     # Remove all data
make logs      # View logs
```
