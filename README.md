# MR Anchor Registry - Two Organization Hyperledger Fabric Setup

A complete Hyperledger Fabric blockchain solution for managing Mixed Reality anchor claims with a two-organization endorsement model.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           MR Anchor Registry                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐                              ┌──────────────┐         │
│  │   Unity      │                              │   Unity      │         │
│  │   Client     │                              │   Client     │         │
│  │   (Org1)     │                              │   (Org2)     │         │
│  └──────┬───────┘                              └──────┬───────┘         │
│         │                                             │                  │
│         ▼                                             ▼                  │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Gateway Server (Node.js)                   │       │
│  │  ┌────────────┐                      ┌────────────┐          │       │
│  │  │ Org1 Admin │                      │ Org2 Admin │          │       │
│  │  │   Panel    │                      │   Panel    │          │       │
│  │  └────────────┘                      └────────────┘          │       │
│  │                                                               │       │
│  │  ┌────────────┐                      ┌────────────┐          │       │
│  │  │   Org1     │                      │   Org2     │          │       │
│  │  │  Identity  │                      │  Identity  │          │       │
│  │  └────────────┘                      └────────────┘          │       │
│  └──────────────────────────┬───────────────────────────────────┘       │
│                             │                                            │
│                             ▼                                            │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │              Hyperledger Fabric Network                       │       │
│  │                                                               │       │
│  │  ┌──────────┐    ┌──────────┐    ┌──────────┐               │       │
│  │  │ Orderer  │    │  Peer0   │    │  Peer0   │               │       │
│  │  │          │    │  Org1    │    │  Org2    │               │       │
│  │  └──────────┘    └──────────┘    └──────────┘               │       │
│  │                                                               │       │
│  │  ┌──────────────────────────────────────────────────┐        │       │
│  │  │           anchor-registry Chaincode              │        │       │
│  │  │  Endorsement Policy: AND(Org1MSP, Org2MSP)      │        │       │
│  │  └──────────────────────────────────────────────────┘        │       │
│  └──────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Claim Lifecycle

```
                    ┌──────────────┐
                    │   PROPOSED   │◄──────── Org1 or Org2 proposes
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌──────────┐              ┌──────────┐
       │  ACTIVE  │              │ REJECTED │
       └────┬─────┘              └──────────┘
            │
            │ Either org initiates revoke
            ▼
    ┌───────────────┐
    │ REVOKE_PENDING│◄─── Requires other org's endorsement
    └───────┬───────┘
            │
   ┌────────┴────────┐
   │                 │
   ▼                 ▼
┌──────────┐   ┌──────────┐
│ REVOKED  │   │  ACTIVE  │◄─── Revoke rejected, back to ACTIVE
└──────────┘   └──────────┘
```

## Directory Structure

```
MR-Anchor-Registry/
├── network/
│   ├── crypto-config.yaml          # Org1 + Org2 certificate config
│   ├── configtx/
│   │   └── configtx.yaml           # Channel & endorsement policies
│   ├── docker/
│   │   └── docker-compose.yaml     # Network containers
│   ├── crypto-config/              # Generated certificates (after ./scripts/generate.sh)
│   └── channel-artifacts/          # Generated channel files
│
├── chaincode/
│   └── anchor-registry/
│       ├── lib/
│       │   └── anchor-registry.js  # Smart contract with revocation logic
│       ├── index.js
│       └── package.json
│
├── gateway/
│   ├── src/
│   │   ├── server.js               # Express server with dual-org support
│   │   ├── services/
│   │   │   ├── fabricClient.js     # Fabric Gateway client
│   │   │   └── logger.js
│   │   └── routes/
│   │       ├── claims.js           # Propose/endorse/reject endpoints
│   │       ├── admin.js            # Revocation workflow endpoints
│   │       └── events.js           # SSE stream + snapshot
│   ├── config/
│   │   ├── connection-org1.json    # Org1 connection profile
│   │   └── connection-org2.json    # Org2 connection profile
│   └── admin-panel/
│       ├── org1/                   # Blue-themed Org1 admin UI
│       └── org2/                   # Green-themed Org2 admin UI
│
├── unity/
│   └── Gateway/
│       ├── GatewayClient.cs        # REST client with revocation methods
│       ├── GatewayConfig.cs        # Config with org identity
│       ├── GatewaySync.cs          # Main orchestrator
│       └── AnchorClaimState.cs     # State models with REVOKE_PENDING
│
└── scripts/
    ├── generate.sh                 # Generate crypto & channel artifacts
    ├── channel.sh                  # Create/join channel
    └── chaincode.sh                # Deploy chaincode
```

## Prerequisites

1. **Docker & Docker Compose**
2. **Node.js 16+**
3. **Hyperledger Fabric binaries** (from fabric-samples)

Ensure `fabric-samples` is at the same level as this project:
```
parent-directory/
├── fabric-samples/
│   ├── bin/
│   │   ├── cryptogen
│   │   ├── configtxgen
│   │   ├── peer
│   │   └── ...
│   └── config/
└── MR-Anchor-Registry/
```

## Quick Start

### 1. Generate Crypto Materials

```bash
cd MR-Anchor-Registry
chmod +x scripts/*.sh
./scripts/generate.sh
```

### 2. Start the Network

```bash
cd network/docker
docker-compose up -d
```

### 3. Create Channel & Join Peers

```bash
./scripts/channel.sh all
```

### 4. Deploy Chaincode

```bash
./scripts/chaincode.sh deploy
```

### 5. Start Gateway Server

```bash
cd gateway
npm install
npm start
```

### 6. Access Admin Panels

- **Org1 Admin:** http://localhost:3000/admin-panel/org1
- **Org2 Admin:** http://localhost:3000/admin-panel/org2

## API Endpoints

### Claims (Unity Client)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/claims/propose` | Propose new anchor |
| POST | `/claims/endorse` | Endorse pending claim |
| POST | `/claims/reject` | Reject pending claim |
| GET | `/claims/:assetId` | Get claim details |

### Admin (Revocation Workflow)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/revoke` | Initiate revocation |
| POST | `/admin/endorse-revoke` | Endorse revocation |
| POST | `/admin/reject-revoke` | Reject revocation |
| GET | `/admin/pending-revocations` | List all pending |
| GET | `/admin/pending-revocations/for-me` | List requiring my action |
| GET | `/admin/anchors` | List active anchors |

### Events (SSE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events/stream` | SSE event stream |
| GET | `/events/snapshot` | Current state snapshot |

## Revocation Workflow

### 1. Org1 Initiates Revocation

```javascript
// From Unity (Org1)
GatewaySync.Instance.RevokeAnchor("asset_123", "Quality degraded");

// Or via HTTP
POST /admin/revoke
Headers: x-org-id: org1
Body: { "asset_id": "asset_123", "reason": "Quality degraded" }
```

### 2. State Changes to REVOKE_PENDING

The chaincode sets:
- `state` → `REVOKE_PENDING`
- `revokeInitiatedBy` → `Org1MSP`
- `requiredEndorser` → `Org2MSP`

### 3. Org2 Must Respond

**Option A: Endorse (Complete Revocation)**
```javascript
// From Unity (Org2)
GatewaySync.Instance.EndorseRevoke("asset_123");
```
Result: Anchor is **REVOKED** and **deleted** from active registry.

**Option B: Reject (Keep Active)**
```javascript
// From Unity (Org2)
GatewaySync.Instance.RejectRevoke("asset_123", "Anchor still needed");
```
Result: Anchor returns to **ACTIVE** state.

## Unity Integration

### Setup

1. Copy files from `unity/Gateway/` to your Unity project
2. Create a `GatewayConfig` ScriptableObject:
   - Assets → Create → AR Detection → Gateway Config
3. Configure:
   - Gateway URL
   - Organization ID (`org1` or `org2`)
   - API Key

### Usage

```csharp
// Propose anchor
GatewaySync.Instance.ProposeAnchor(
    assetId: "asset_123",
    worldPose: currentPose,
    confidence: 0.95f,
    stabilityRms: 0.02f,
    observationCount: 50
);

// Initiate revocation (as current org)
GatewaySync.Instance.RevokeAnchor("asset_123", "Reason");

// Respond to revocation (from other org)
GatewaySync.Instance.EndorseRevoke("asset_123");
// or
GatewaySync.Instance.RejectRevoke("asset_123", "Keep it");

// Check pending revocations
foreach (var state in GatewaySync.Instance.GetPendingRevocationsRequiringMyAction())
{
    Debug.Log($"Need to respond to: {state.assetId}");
}
```

### Events

```csharp
void Start()
{
    GatewaySync.Instance.OnRevokePending.AddListener(OnRevokePending);
    GatewaySync.Instance.OnRevokeCompleted.AddListener(OnRevokeCompleted);
}

void OnRevokePending(string assetId, string initiatedBy)
{
    Debug.Log($"Revocation pending for {assetId}, initiated by {initiatedBy}");
}

void OnRevokeCompleted(string assetId)
{
    // Remove anchor visualization
}
```

## Endorsement Policy

The chaincode uses **AND** endorsement policy:
```
AND('Org1MSP.peer', 'Org2MSP.peer')
```

This means:
- **Proposals** require both orgs to endorse (Org1 proposes → Org2 endorses)
- **Revocations** require both orgs to agree (One initiates → Other endorses)

## Security Notes

1. API keys should be rotated and kept secure
2. In production, use proper certificate management
3. Consider enabling TLS for all connections
4. Implement proper RBAC in admin panels

## Troubleshooting

### Chaincode Issues
```bash
docker logs peer0.org1.anchor-registry.com
docker logs peer0.org2.anchor-registry.com
```

### Network Issues
```bash
docker ps -a
docker-compose -f network/docker/docker-compose.yaml logs
```

### Reset Everything
```bash
cd network/docker
docker-compose down -v
cd ../..
rm -rf network/crypto-config network/channel-artifacts
./scripts/generate.sh
```

## License

Apache 2.0
