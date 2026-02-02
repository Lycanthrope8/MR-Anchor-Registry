# MR-Anchor-Registry

Blockchain-based spatial anchor registry for multi-user mixed reality with on-chain governance and real-time supervisor UI.

## Features

- **On-Chain Reject**: Supervisors can reject claims with auditable reason, timestamp, and identity recorded on the blockchain
- **Real-Time SSE Updates**: Server-Sent Events for instant UI updates without polling
- **Complete Audit Trail**: Full history of all claim state changes on Hyperledger Fabric
- **Role-Based Access**: Proposer, Endorser, and Supervisor roles with API key authentication
- **Off-Chain Payload Storage**: Large pose data stored in PostgreSQL with hash verification on-chain

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SUPERVISOR WEB UI                            │
│                    /admin/ (SSE real-time)                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      GATEWAY (Node.js)                          │
│                      localhost:3000                             │
│  • REST API for claims/assets                                   │
│  • SSE endpoint for real-time updates                           │
│  • Role-based authentication                                    │
└───────────┬─────────────────────────────────┬───────────────────┘
            │                                 │
┌───────────▼───────────┐       ┌─────────────▼───────────────────┐
│     FABRIC NETWORK    │       │         POSTGRESQL              │
│   (test-network)      │       │     localhost:5433              │
│                       │       │                                 │
│  • Orderer :7050      │       │  Off-chain payload storage      │
│  • Peer Org1 :7051    │       │  (pose_site, quality_metrics)   │
│  • Peer Org2 :9051    │       │                                 │
│                       │       │                                 │
│  Chaincode:           │       │                                 │
│  - ProposeAnchor      │       │                                 │
│  - EndorseAnchor      │       │                                 │
│  - RejectClaim (NEW)  │       │                                 │
│  - RevokeAnchor       │       │                                 │
│  - ReopenClaim (NEW)  │       │                                 │
└───────────────────────┘       └─────────────────────────────────┘
```

## Claim Lifecycle States

```
                    ┌─────────────┐
                    │  PROPOSED   │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │  ACTIVE  │    │ REJECTED │    │ CONFLICT │
    └────┬─────┘    └────┬─────┘    └──────────┘
         │               │
         ▼               ▼
    ┌──────────┐    ┌──────────┐
    │ REVOKED  │    │ PROPOSED │ (via Reopen)
    └──────────┘    └──────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js >= 18
- Fabric samples at `../fabric-samples` (relative to this project)

### Step-by-Step Backend Bring-Up

```bash
# 1. Ensure fabric-samples is in place
cd ~/work
ls fabric-samples/test-network  # Should exist

# 2. Navigate to this project
cd MR-Anchor-Registry

# 3. Start everything (Fabric + Chaincode + PostgreSQL + Gateway)
./up.sh

# Expected output:
# ==========================================
#   Backend Started Successfully!
# ==========================================
# Services running:
#   • Fabric Network (test-network)
#   • Chaincode: anchorregistry on channel mychannel
#   • PostgreSQL: localhost:5433
#   • Gateway: http://localhost:3000
```

### Verify Health

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "healthy",
  "postgres": "connected",
  "fabric": "connected",
  "fabric_mock": false,
  "sse_clients": 0,
  "version": "2.0.0"
}
```

### Using the CLI (Proposer Tasks)

```bash
# Check health
node scripts/cli.js health

# Propose a new anchor claim
node scripts/cli.js propose my-desk --x=1.5 --y=2.0 --z=0.5

# List claims for an asset
node scripts/cli.js list my-desk

# Get active anchor
node scripts/cli.js resolve my-desk

# Get claim details
node scripts/cli.js get claim-abc123456789

# Get claim history (audit trail)
node scripts/cli.js history claim-abc123456789
```

### Using the Supervisor UI

1. Open in browser: `http://localhost:3000/admin/`
2. Enter supervisor API key: `supervisor-key-001`
3. Enter asset ID (e.g., `my-desk`)
4. Click "Load"
5. Click "Connect SSE" for real-time updates
6. Use buttons to:
   - **Approve**: Endorse a PROPOSED claim (may activate it)
   - **Reject**: Reject with reason (recorded on-chain)
   - **Revoke**: Revoke an ACTIVE anchor
   - **Details**: View full claim info and history

### Shutdown

```bash
# Stop gateway and PostgreSQL (keep Fabric running)
./down.sh

# Stop everything including Fabric
./down.sh --fabric
```

## API Reference

### Authentication

All endpoints (except `/health`) require `x-api-key` header.

| API Key                | Role       | Permissions                         |
| ---------------------- | ---------- | ----------------------------------- |
| `proposer-key-001`   | proposer   | Create claims                       |
| `endorser-key-001`   | endorser   | Endorse claims                      |
| `supervisor-key-001` | supervisor | All actions including reject/revoke |

### Endpoints

#### Health

```
GET /health
```

#### Claims

```bash
# Propose a new claim
POST /claims/propose
Content-Type: application/json
x-api-key: proposer-key-001

{
  "asset_id": "my-desk",
  "pose_site": {
    "position": {"x": 1.5, "y": 2.0, "z": 0.5},
    "rotation": {"qx": 0, "qy": 0, "qz": 0, "qw": 1}
  },
  "quality_metrics": {
    "stability_rms": 0.02,
    "confidence_mean": 0.9
  }
}

# Endorse a claim
POST /claims/{claim_id}/endorse
x-api-key: endorser-key-001

# Reject a claim (ON-CHAIN - supervisor only)
POST /claims/{claim_id}/reject
x-api-key: supervisor-key-001
Content-Type: application/json

{
  "reason": "Pose accuracy below threshold"
}

# Reopen a rejected claim (supervisor only)
POST /claims/{claim_id}/reopen
x-api-key: supervisor-key-001

{
  "reason": "Re-review after corrections"
}

# Get claim details
GET /claims/{claim_id}
x-api-key: proposer-key-001

# Get claim history
GET /claims/{claim_id}/history
x-api-key: proposer-key-001
```

#### Assets

```bash
# Resolve active anchor
GET /assets/{asset_id}/resolve
x-api-key: proposer-key-001

# List all claims for asset
GET /assets/{asset_id}/claims
x-api-key: proposer-key-001

# Revoke active anchor (supervisor only)
POST /assets/{asset_id}/revoke
x-api-key: supervisor-key-001
Content-Type: application/json

{
  "reason": "Asset relocated"
}

# Get audit log for asset
GET /assets/{asset_id}/audit?limit=100
x-api-key: proposer-key-001
```

#### Admin/Supervisor API

```bash
# SSE event stream (real-time updates)
GET /admin/api/events/stream?asset_id=my-desk
x-api-key: supervisor-key-001

# Get recent events (polling fallback)
GET /admin/api/events?limit=50
x-api-key: supervisor-key-001

# Get complete asset data
GET /admin/api/asset/{asset_id}
x-api-key: supervisor-key-001

# Approve via admin API
POST /admin/api/decision/{asset_id}/approve
x-api-key: supervisor-key-001

{
  "claim_id": "claim-abc123",
  "reason": "Approved by supervisor"
}

# Reject via admin API (ON-CHAIN)
POST /admin/api/decision/{asset_id}/reject
x-api-key: supervisor-key-001

{
  "claim_id": "claim-abc123",
  "reason": "Quality metrics insufficient"
}

# Revoke via admin API
POST /admin/api/decision/{asset_id}/revoke
x-api-key: supervisor-key-001

{
  "reason": "Asset decommissioned"
}
```

## Curl Examples

### Complete Workflow Example

```bash
# 1. Check health
curl -s http://localhost:3000/health | jq

# 2. Propose a claim
curl -s -X POST http://localhost:3000/claims/propose \
  -H "Content-Type: application/json" \
  -H "x-api-key: proposer-key-001" \
  -d '{
    "asset_id": "test-chair",
    "pose_site": {"position": {"x": 1, "y": 2, "z": 3}, "rotation": {"qw": 1}},
    "quality_metrics": {"stability_rms": 0.02, "confidence_mean": 0.9}
  }' | jq

# Save the claim_id from response, e.g., claim-abc123

# 3. List claims
curl -s http://localhost:3000/assets/test-chair/claims \
  -H "x-api-key: proposer-key-001" | jq

# 4. Supervisor approves (endorses) - this activates if threshold met
curl -s -X POST http://localhost:3000/claims/CLAIM_ID_HERE/endorse \
  -H "x-api-key: supervisor-key-001" | jq

# 5. Check active anchor
curl -s http://localhost:3000/assets/test-chair/resolve \
  -H "x-api-key: proposer-key-001" | jq

# 6. (Alternative) Supervisor rejects instead
curl -s -X POST http://localhost:3000/claims/CLAIM_ID_HERE/reject \
  -H "Content-Type: application/json" \
  -H "x-api-key: supervisor-key-001" \
  -d '{"reason": "Position not accurate enough"}' | jq

# 7. Supervisor revokes active anchor
curl -s -X POST http://localhost:3000/assets/test-chair/revoke \
  -H "Content-Type: application/json" \
  -H "x-api-key: supervisor-key-001" \
  -d '{"reason": "Asset removed from space"}' | jq

# 8. View claim history (audit trail)
curl -s http://localhost:3000/claims/CLAIM_ID_HERE/history \
  -H "x-api-key: proposer-key-001" | jq
```

## On-Chain Reject Details

When a supervisor rejects a claim, the following is recorded on the blockchain:

```json
{
  "claimId": "claim-abc123",
  "state": "REJECTED",
  "rejectedAt": "2025-02-01T12:34:56.789Z",
  "rejectedBy": "supervisor-key-001",
  "rejectionReason": "Quality metrics below threshold",
  "rejectionTxId": "tx-xyz789..."
}
```

This data is:

- **Immutable**: Cannot be altered after recording
- **Auditable**: Full history available via `GetClaimHistory`
- **Timestamped**: Uses blockchain transaction timestamp
- **Attributed**: Records supervisor identity

A rejected claim **cannot** be endorsed/activated unless explicitly reopened by a supervisor using the `ReopenClaim` function.

## File Structure

```
MR-Anchor-Registry/
├── chaincode/
│   └── anchor-registry/
│       ├── index.js
│       ├── package.json
│       └── lib/
│           └── anchorRegistry.js      # Chaincode with REJECT support
├── gateway/
│   └── registry-gateway/
│       ├── Dockerfile
│       ├── package.json
│       └── src/
│           ├── index.js               # Main entry point
│           ├── config.js              # Configuration
│           ├── admin/
│           │   ├── routes.js          # Admin API with SSE
│           │   └── public/
│           │       ├── index.html     # Supervisor UI
│           │       ├── styles.css
│           │       └── app.js         # UI with SSE client
│           ├── db/
│           │   └── postgres.js        # PostgreSQL client
│           ├── fabric/
│           │   └── client.js          # Fabric Gateway client
│           ├── middleware/
│           │   ├── auth.js            # Authentication
│           │   └── errorHandler.js
│           ├── routes/
│           │   ├── claims.js          # Claims API
│           │   ├── assets.js          # Assets API
│           │   └── health.js          # Health check
│           └── utils/
│               ├── hash.js            # Payload hashing
│               ├── logger.js          # Winston logger
│               └── sseEventBus.js     # SSE event system
├── scripts/
│   └── cli.js                         # CLI tool
├── storage/
│   └── init.sql                       # PostgreSQL schema
├── up.sh                              # Start script
├── down.sh                            # Stop script
└── README.md                          # This file
```

## Environment Variables

| Variable               | Default                          | Description                   |
| ---------------------- | -------------------------------- | ----------------------------- |
| `WORK_DIR`           | `~/work`                       | Base directory                |
| `MR_ANCHOR_DIR`      | `$WORK_DIR/MR-Anchor-Registry` | Project directory             |
| `FABRIC_SAMPLES_DIR` | `$WORK_DIR/fabric-samples`     | Fabric samples                |
| `GATEWAY_PORT`       | `3000`                         | Gateway HTTP port             |
| `POSTGRES_PORT`      | `5433`                         | PostgreSQL port               |
| `POSTGRES_DB`        | `anchor_registry`              | Database name                 |
| `POSTGRES_USER`      | `anchor_admin`                 | Database user                 |
| `POSTGRES_PASSWORD`  | `anchor_secret_2025`           | Database password             |
| `FABRIC_CHANNEL`     | `mychannel`                    | Fabric channel                |
| `FABRIC_CHAINCODE`   | `anchorregistry`               | Chaincode name                |
| `FABRIC_MOCK`        | `false`                        | Must be false for real Fabric |
| `API_KEYS`           | (see config.js)                  | API key mappings              |
| `SUPERVISOR_IDS`     | `supervisor-key-001`           | Supervisor keys               |

## Troubleshooting

### Gateway won't start

```bash
# Check if Fabric is running
docker ps | grep peer0.org1

# Check logs
tail -f gateway.log
```

### Chaincode errors

```bash
# Check chaincode is deployed
export PATH=$HOME/work/fabric-samples/bin:$PATH
export FABRIC_CFG_PATH=$HOME/work/fabric-samples/config/
peer lifecycle chaincode querycommitted -C mychannel -n anchorregistry
```

### PostgreSQL connection issues

```bash
# Check PostgreSQL is running
docker ps | grep mr-anchor-postgres

# Check logs
docker logs mr-anchor-postgres
```

### SSE not connecting

- Ensure you're using the correct API key
- Check browser console for errors
- Try the polling fallback: `GET /admin/api/events`

## License

MIT