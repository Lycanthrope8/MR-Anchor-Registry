# MR-Anchor-Registry: Complete Technical Documentation

## A Beginner's Guide to Blockchain-Based Spatial Anchor Management

**Version 1.0 | January 2026**

---

# Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Hyperledger Fabric Fundamentals](#3-hyperledger-fabric-fundamentals)
4. [Architecture Deep Dive](#4-architecture-deep-dive)
5. [File Structure Explained](#5-file-structure-explained)
6. [How Data Flows Through the System](#6-how-data-flows-through-the-system)
7. [Chaincode (Smart Contract) Explained](#7-chaincode-smart-contract-explained)
8. [Gateway API Explained](#8-gateway-api-explained)
9. [Commands Reference](#9-commands-reference)
10. [Troubleshooting Guide](#10-troubleshooting-guide)
11. [Glossary](#11-glossary)

---

# 1. Introduction

## What is MR-Anchor-Registry?

MR-Anchor-Registry is a blockchain-based system for managing **spatial anchors** in **Mixed Reality (MR)** environments. In multi-user MR applications, multiple people wearing headsets need to see virtual objects in the same physical location. This requires a trusted, tamper-proof registry of "anchors" - coordinate systems that tie virtual content to real-world positions.

## Why Blockchain?

Traditional databases have a single point of control. One administrator could secretly change an anchor's position, causing confusion or security issues. Blockchain provides:

- **Immutability**: Once recorded, data cannot be secretly altered
- **Consensus**: Multiple parties must agree before changes are accepted
- **Audit Trail**: Complete history of all changes
- **Decentralization**: No single point of failure or control

## What You'll Learn

This documentation teaches you:
1. How Hyperledger Fabric works
2. How each component of MR-Anchor-Registry functions
3. What every file and command does
4. How to troubleshoot common issues

---

# 2. System Overview

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           YOUR APPLICATION                                  │
│                    (Unity, Unreal, Web App, etc.)                           │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ REST API (HTTP)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GATEWAY                                        │
│                         (Node.js Express)                                   │
│                                                                             │
│  • Receives HTTP requests from applications                                 │
│  • Validates API keys and roles (proposer/endorser/supervisor)              │
│  • Translates REST calls to blockchain transactions                         │
│  • Stores large payloads in PostgreSQL                                      │
│  • Returns JSON responses                                                   │
└──────────┬──────────────────────────────────────────┬───────────────────────┘
           │ gRPC (TLS)                               │ SQL
           ▼                                          ▼
┌──────────────────────────────────┐    ┌─────────────────────────────────────┐
│     HYPERLEDGER FABRIC           │    │           POSTGRESQL                │
│     (Blockchain Network)         │    │        (Off-chain Storage)          │
│                                  │    │                                     │
│  ┌─────────────────────────────┐ │    │  Stores:                            │
│  │       ORDERER               │ │    │  • Full pose data(position/rotation)│
│  │   (Transaction Sequencing)  │ │    │  • Quality metrics                  │
│  └─────────────────────────────┘ │    │  • Raw JSON payloads                │
│                                  │    │                                     │
│  ┌─────────────┐ ┌─────────────┐ │    │  Why off-chain?                     │
│  │  PEER ORG1  │ │  PEER ORG2  │ │    │  • Blockchain storage is expensive  │
│  │  (Company A)│ │  (Company B)│ │    │  • Only hash stored on-chain        │
│  │             │ │             │ │    │  • Hash verifies data integrity     │
│  │ ┌─────────┐ │ │ ┌─────────┐ │ │    └─────────────────────────────────────┘
│  │ │CHAINCODE│ │ │ │CHAINCODE│ │ │
│  │ │(Smart   │ │ │ │(Smart   │ │ │
│  │ │Contract)│ │ │ │Contract)│ │ │
│  │ └─────────┘ │ │ └─────────┘ │ │
│  └─────────────┘ └─────────────┘ │
│                                  │
│  ┌─────────────────────────────┐ │
│  │        LEDGER               │ │
│  │  (Blockchain + World State) │ │
│  └─────────────────────────────┘ │
└──────────────────────────────────┘
```

## What Each Component Does

| Component | Purpose | Technology |
|-----------|---------|------------|
| **Gateway** | REST API for applications | Node.js + Express |
| **PostgreSQL** | Stores large data off-chain | PostgreSQL 15 |
| **Orderer** | Orders transactions, creates blocks | Hyperledger Fabric |
| **Peer** | Executes chaincode, maintains ledger | Hyperledger Fabric |
| **Chaincode** | Business logic (smart contract) | JavaScript/Node.js |
| **Ledger** | Immutable transaction history | LevelDB + Blockchain |

---

# 3. Hyperledger Fabric Fundamentals

## What is Hyperledger Fabric?

Hyperledger Fabric is a **permissioned blockchain** framework. Unlike Bitcoin or Ethereum:

- **Permissioned**: Only authorized participants can join
- **No cryptocurrency**: No mining, no coins
- **High performance**: Thousands of transactions per second
- **Privacy**: Channels allow private communication between parties
- **Modular**: Pluggable consensus, identity management

## Key Concepts

### Organizations (Orgs)

An organization is a member of the network. In our test-network:
- **Org1MSP**: First organization (like Company A)
- **Org2MSP**: Second organization (like Company B)
- **OrdererMSP**: The ordering service organization

Each org has its own:
- Certificate Authority (CA)
- Peers
- Users and Admins

### Membership Service Provider (MSP)

MSP is how Fabric handles identity. It uses **X.509 certificates** (like HTTPS certificates):

```
organizations/
├── peerOrganizations/
│   └── org1.example.com/
│       ├── ca/                    # Certificate Authority
│       ├── msp/                   # Organization MSP
│       ├── peers/
│       │   └── peer0.org1.example.com/
│       │       ├── msp/           # Peer's identity
│       │       └── tls/           # TLS certificates
│       └── users/
│           └── Admin@org1.example.com/
│               └── msp/           # Admin user's identity
└── ordererOrganizations/
    └── example.com/
        └── orderers/
            └── orderer.example.com/
                ├── msp/           # Orderer's identity
                └── tls/           # TLS certificates
```

### Channels

A channel is a private subnet within Fabric. Only members of a channel can see its transactions.

- **mychannel**: Our application's channel
- Org1 and Org2 are both members
- Transactions on mychannel are invisible to non-members

### Peers

Peers are the workhorses of Fabric:

1. **Store the ledger**: Complete copy of blockchain
2. **Execute chaincode**: Run smart contract code
3. **Endorse transactions**: Sign to approve changes

### Orderer

The orderer's job:

1. **Receive transactions** from all peers
2. **Order them** into a sequence
3. **Create blocks** of transactions
4. **Distribute blocks** to all peers

The orderer does NOT execute chaincode or validate business logic.

### Chaincode (Smart Contracts)

Chaincode is code that runs on peers:

```javascript
// Example: Store a value
async PutValue(ctx, key, value) {
    await ctx.stub.putState(key, Buffer.from(value));
}

// Example: Read a value
async GetValue(ctx, key) {
    const data = await ctx.stub.getState(key);
    return data.toString();
}
```

### Ledger

The ledger has two parts:

1. **Blockchain**: Chain of blocks containing transactions (append-only)
2. **World State**: Current values of all keys (like a database)

```
Blockchain:                    World State:
┌─────────┐                   ┌─────────────────┐
│ Block 0 │ (Genesis)         │ anchor:desk →   │
├─────────┤                   │   {active:true} │
│ Block 1 │ → TX: Create      │                 │
├─────────┤     anchor        │ claim:123 →     │
│ Block 2 │ → TX: Endorse     │   {state:ACTIVE}│
├─────────┤     anchor        │                 │
│ Block 3 │ → TX: Revoke      │ config →        │
└─────────┘     anchor        │   {threshold:1} │
                              └─────────────────┘
```

### Transaction Flow

How a transaction gets committed:

```
1. PROPOSE: Client sends transaction proposal to peers
   Client ──proposal──▶ Peer1, Peer2

2. SIMULATE: Each peer executes chaincode (doesn't commit yet)
   Peer1: Execute chaincode → Read/Write Set
   Peer2: Execute chaincode → Read/Write Set

3. ENDORSE: Peers sign if they agree
   Peer1 ──signature──▶ Client
   Peer2 ──signature──▶ Client

4. SUBMIT: Client sends endorsed transaction to orderer
   Client ──endorsed TX──▶ Orderer

5. ORDER: Orderer creates block
   Orderer: Add TX to Block N

6. DISTRIBUTE: Orderer sends block to all peers
   Orderer ──Block N──▶ Peer1, Peer2

7. VALIDATE & COMMIT: Peers validate and commit
   Peer1: Validate → Commit to Ledger
   Peer2: Validate → Commit to Ledger
```

### Endorsement Policy

An endorsement policy defines WHO must sign a transaction:

- `AND('Org1MSP.peer', 'Org2MSP.peer')`: Both orgs must sign
- `OR('Org1MSP.peer', 'Org2MSP.peer')`: Either org can sign
- `OutOf(2, 'Org1MSP.peer', 'Org2MSP.peer', 'Org3MSP.peer')`: Any 2 of 3

Our chaincode uses the default policy requiring endorsement from both Org1 and Org2.

---

# 4. Architecture Deep Dive

## Network Topology

```
                    ┌──────────────────────────────────┐
                    │         DOCKER NETWORK           │
                    │         (fabric_test)            │
                    └──────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│   ORDERER     │          │   PEER ORG1   │          │   PEER ORG2   │
│               │          │               │          │               │
│ Port: 7050    │◀───────▶│ Port: 7051    │◀───────▶│ Port: 9051    │
│ Admin: 7053   │  gossip  │ CC: 7052      │  gossip  │ CC: 9052      │
│               │          │               │          │               │
│ Orders TXs    │          │ Runs CC       │          │ Runs CC       │
│ Creates blocks│          │ Stores ledger │          │ Stores ledger │
└───────────────┘          └───────┬───────┘          └───────────────┘
                                   │
                                   │ gRPC + TLS
                                   ▼
                          ┌───────────────┐
                          │    GATEWAY    │
                          │               │
                          │ Port: 3000    │
                          │               │
                          │ REST API      │
                          │ Auth (API key)│
                          │ Fabric client │
                          └───────┬───────┘
                                  │
                                  │ SQL
                                  ▼
                          ┌───────────────┐
                          │  POSTGRESQL   │
                          │               │
                          │ Port: 5433    │
                          │               │
                          │ Off-chain     │
                          │ payload store │
                          └───────────────┘
```

## Port Reference

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Orderer | 7050 | gRPC | Transaction ordering |
| Orderer Admin | 7053 | gRPC | Channel management |
| Peer Org1 | 7051 | gRPC | Chaincode execution |
| Peer Org1 CC | 7052 | gRPC | Chaincode container comms |
| Peer Org2 | 9051 | gRPC | Chaincode execution |
| Peer Org2 CC | 9052 | gRPC | Chaincode container comms |
| Gateway | 3000 | HTTP | REST API |
| PostgreSQL | 5433 | TCP | Database |

## TLS (Transport Layer Security)

All Fabric communication uses TLS encryption:

```
Gateway ──TLS──▶ Peer

To connect, Gateway needs:
1. Peer's TLS CA certificate (to verify peer)
2. User's signing certificate (to authenticate)
3. User's private key (to sign transactions)
```

Certificate locations:
```
organizations/peerOrganizations/org1.example.com/
├── peers/peer0.org1.example.com/
│   └── tls/
│       └── ca.crt                    # Peer's TLS CA cert
└── users/Admin@org1.example.com/
    └── msp/
        ├── signcerts/
        │   └── cert.pem              # User's signing cert
        └── keystore/
            └── xxxxx_sk              # User's private key
```

---

# 5. File Structure Explained

## Complete Directory Structure

```
MR-Anchor-Registry/
├── chaincode/                        # Blockchain smart contract
│   └── anchor-registry/
│       ├── package.json              # Node.js dependencies
│       ├── index.js                  # Entry point
│       └── lib/
│           └── anchorRegistry.js     # Main contract code
│
├── gateway/                          # REST API server
│   └── registry-gateway/
│       ├── Dockerfile                # Container build instructions
│       ├── package.json              # Node.js dependencies
│       └── src/
│           ├── index.js              # Express app entry point
│           ├── config.js             # Configuration from env vars
│           ├── fabric/
│           │   └── client.js         # Fabric SDK wrapper
│           ├── db/
│           │   └── postgres.js       # PostgreSQL client
│           ├── routes/
│           │   ├── health.js         # GET /health
│           │   ├── claims.js         # POST /claims/*
│           │   └── assets.js         # GET/POST /assets/*
│           ├── middleware/
│           │   ├── auth.js           # API key validation
│           │   └── errorHandler.js   # Error formatting
│           └── utils/
│               ├── hash.js           # SHA256 hashing (RFC 8785)
│               └── logger.js         # Winston logging
│
├── storage/
│   └── init.sql                      # PostgreSQL schema
│
├── .env                              # Environment variables
├── up.sh                             # Startup script
├── down.sh                           # Shutdown script
└── gateway.log                       # Gateway log file (created at runtime)
```

## File-by-File Explanation

### chaincode/anchor-registry/package.json

```json
{
  "name": "anchor-registry-chaincode",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "fabric-chaincode-node start"  // Fabric runs this
  },
  "dependencies": {
    "fabric-contract-api": "2.5.4",  // Chaincode programming model
    "fabric-shim": "2.5.4"           // Low-level Fabric interface
  }
}
```

### chaincode/anchor-registry/index.js

```javascript
// This file tells Fabric which contracts to load
const AnchorRegistryContract = require('./lib/anchorRegistry');
module.exports.contracts = [AnchorRegistryContract];
```

### chaincode/anchor-registry/lib/anchorRegistry.js

This is the smart contract. Key sections:

```javascript
// State machine for anchor claims
const States = {
    PROPOSED: 'PROPOSED',   // Newly created, needs endorsement
    ACTIVE: 'ACTIVE',       // Endorsed and current
    REVOKED: 'REVOKED',     // Supervisor removed it
    SUPERSEDED: 'SUPERSEDED' // Replaced by newer anchor
};

// Key prefixes for organizing data
const KeyPrefix = {
    ANCHOR_ACTIVE: 'ANCHOR_ACTIVE',  // Currently active anchor per asset
    CLAIM: 'CLAIM',                   // Individual claim records
    ENDORSE: 'ENDORSE',               // Endorsement records
    CONFIG: 'CONFIG'                  // System configuration
};
```

### gateway/registry-gateway/src/config.js

Reads environment variables:

```javascript
module.exports = {
    port: process.env.GATEWAY_PORT || 3000,
    fabricMock: process.env.FABRIC_MOCK === 'true',  // MUST be false for real Fabric
    postgres: {
        host: process.env.POSTGRES_HOST,
        port: process.env.POSTGRES_PORT,
        // ...
    },
    fabric: {
        peerEndpoint: process.env.FABRIC_PEER_ENDPOINT,  // localhost:7051
        tlsEnabled: process.env.FABRIC_TLS_ENABLED,       // true
        // ...
    }
};
```

### gateway/registry-gateway/src/fabric/client.js

Connects to Fabric network:

```javascript
// 1. Load certificates
const credentials = fs.readFileSync(certPath);
const privateKey = crypto.createPrivateKey(keyPem);

// 2. Create gRPC connection with TLS
const tlsCert = fs.readFileSync(tlsCertPath);
const grpcCredentials = grpc.credentials.createSsl(tlsCert);
grpcClient = new grpc.Client(peerEndpoint, grpcCredentials, {
    'grpc.ssl_target_name_override': 'peer0.org1.example.com'
});

// 3. Create Fabric gateway
gateway = connect({ client: grpcClient, identity, signer });
contract = gateway.getNetwork(channelName).getContract(chaincodeName);
```

### gateway/registry-gateway/src/routes/claims.js

API endpoint handlers:

```javascript
// POST /claims/propose
router.post('/propose', requireRole('proposer'), async (req, res) => {
    // 1. Extract data from request
    const { asset_id, pose_site, quality_metrics } = req.body;
    
    // 2. Hash the payload
    const payloadHash = hashPayload(payload);
    
    // 3. Store in PostgreSQL
    await storePayload(payloadHash, ...);
    
    // 4. Submit to blockchain
    const claim = await fabric.proposeAnchor(...);
    
    // 5. Return result
    res.json({ success: true, claim_id: claim.claimId });
});
```

### storage/init.sql

PostgreSQL schema:

```sql
CREATE TABLE anchor_payloads (
    payload_hash VARCHAR(128) PRIMARY KEY,  -- SHA256 hash (stored on-chain)
    payload_ptr UUID UNIQUE NOT NULL,       -- Reference ID
    asset_id VARCHAR(255) NOT NULL,         -- Which asset this is for
    pose_site JSONB NOT NULL,               -- Full position/rotation data
    quality_metrics JSONB NOT NULL,         -- Confidence scores
    publisher_id VARCHAR(255) NOT NULL,     -- Who proposed it
    raw_payload JSONB NOT NULL,             -- Original complete payload
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

# 6. How Data Flows Through the System

## Propose Flow (Creating a New Anchor)

```
Step 1: Application sends HTTP request
────────────────────────────────────────
POST http://localhost:3000/claims/propose
Headers:
  Content-Type: application/json
  X-API-Key: proposer-key-001
Body:
{
  "asset_id": "desk-001",
  "pose_site": {
    "position": {"x": 1.5, "y": 2.0, "z": 3.5},
    "rotation": {"qx": 0, "qy": 0, "qz": 0, "qw": 1}
  },
  "quality_metrics": {
    "stability_rms": 0.02,
    "confidence_mean": 0.9
  }
}

Step 2: Gateway processes request
────────────────────────────────────────
a) Validate API key → proposer role ✓
b) Hash payload → sha256:abc123...
c) Store in PostgreSQL:
   INSERT INTO anchor_payloads (payload_hash, pose_site, ...)
d) Call chaincode:
   submitTransaction('ProposeAnchor', 'desk-001', 'sha256:abc123...', ...)

Step 3: Fabric processes transaction
────────────────────────────────────────
a) Peer Org1 executes chaincode:
   - Validate inputs
   - Check for conflicts with existing anchor
   - Create claim record with state=PROPOSED
   - Sign endorsement
   
b) Peer Org2 executes chaincode:
   - Same execution (must match!)
   - Sign endorsement
   
c) Gateway sends endorsed TX to orderer

d) Orderer adds TX to block

e) Block distributed to all peers

f) Peers commit to ledger

Step 4: Gateway returns response
────────────────────────────────────────
{
  "success": true,
  "claim_id": "claim-40dfa552d595d4ac",
  "state": "PROPOSED",
  "payload_hash": "sha256:abc123..."
}
```

## Endorse Flow (Approving a Proposal)

```
Step 1: Endorser sends request
────────────────────────────────────────
POST http://localhost:3000/claims/claim-40dfa552d595d4ac/endorse
Headers:
  X-API-Key: endorser-key-001

Step 2: Gateway calls chaincode
────────────────────────────────────────
submitTransaction('EndorseAnchor', 'claim-40dfa552d595d4ac', 'endorser-key-001')

Step 3: Chaincode logic
────────────────────────────────────────
a) Load claim from world state
b) Verify state is PROPOSED
c) Check for duplicate endorsement
d) Add endorser to list
e) Check if threshold reached (1 endorsement needed)
f) If threshold met:
   - Change state to ACTIVE
   - Update ANCHOR_ACTIVE key for this asset
g) Save updated claim

Step 4: Response
────────────────────────────────────────
{
  "success": true,
  "new_state": "ACTIVE",
  "endorsement_count": 1
}
```

## Resolve Flow (Getting Current Anchor)

```
Step 1: Application queries
────────────────────────────────────────
GET http://localhost:3000/assets/desk-001/resolve
Headers:
  X-API-Key: proposer-key-001

Step 2: Gateway queries chaincode (read-only)
────────────────────────────────────────
evaluateTransaction('ResolveAnchor', 'desk-001')

Step 3: Chaincode logic
────────────────────────────────────────
a) Look up ANCHOR_ACTIVE::desk-001
b) If found, load the claim record
c) Return claim data

Step 4: Gateway enriches response
────────────────────────────────────────
a) Get payload from PostgreSQL using payload_hash
b) Verify hash matches (integrity check)
c) Return full data

{
  "success": true,
  "claim_id": "claim-40dfa552d595d4ac",
  "state": "ACTIVE",
  "payload": {
    "pose_site": {...},
    "quality_metrics": {...}
  },
  "payload_verified": true
}
```

## Revoke Flow (Supervisor Removes Anchor)

```
Step 1: Supervisor sends request
────────────────────────────────────────
POST http://localhost:3000/assets/desk-001/revoke
Headers:
  X-API-Key: supervisor-key-001
Body:
  {"reason": "Location changed"}

Step 2: Gateway validates supervisor role
────────────────────────────────────────
API key supervisor-key-001 → role=supervisor ✓

Step 3: Chaincode logic
────────────────────────────────────────
a) Load current active anchor
b) Verify state is ACTIVE
c) Change state to REVOKED
d) Record reason and supervisor
e) Delete ANCHOR_ACTIVE entry

Step 4: Response
────────────────────────────────────────
{
  "success": true,
  "new_state": "REVOKED",
  "revoked_by": "supervisor-key-001"
}
```

---

# 7. Chaincode (Smart Contract) Explained

## State Machine

```
                    ┌──────────────┐
                    │   PROPOSED   │
                    │              │
                    │ New claim,   │
                    │ awaiting     │
                    │ endorsement  │
                    └──────┬───────┘
                           │
                           │ EndorseAnchor
                           │ (threshold met)
                           ▼
┌──────────────┐    ┌──────────────┐
│  SUPERSEDED  │◀──│    ACTIVE    │
│              │    │              │
│ Replaced by  │    │ Current      │
│ newer anchor │    │ anchor for   │
│              │    │ this asset   │
└──────────────┘    └──────┬───────┘
                           │
                           │ RevokeAnchor
                           │ (supervisor)
                           ▼
                    ┌──────────────┐
                    │   REVOKED    │
                    │              │
                    │ Removed by   │
                    │ supervisor   │
                    └──────────────┘
```

## Functions Reference

### InitLedger()

**Purpose**: Initialize the ledger with default configuration.

**Called**: Once after chaincode deployment.

**What it does**:
```javascript
const config = {
    endorsementThreshold: 1,      // Endorsements needed to activate
    thresholdRefinement: 0.05,    // Distance for "refinement" (meters)
    thresholdSuspicious: 0.25     // Distance for "suspicious" (meters)
};
await ctx.stub.putState('CONFIG', JSON.stringify(config));
```

### ProposeAnchor(ctx, assetId, payloadHash, payloadPtr, poseSummary, qualitySummary, publisherId)

**Purpose**: Create a new anchor proposal.

**Parameters**:
- `assetId`: Unique identifier for the physical object (e.g., "desk-001")
- `payloadHash`: SHA256 hash of the full payload
- `payloadPtr`: UUID pointing to off-chain data
- `poseSummary`: JSON with x, y, z coordinates and qw rotation
- `qualitySummary`: JSON with confidence_mean and stability_rms
- `publisherId`: API key of the proposer

**What it does**:
1. Validate required fields
2. Check for existing active anchor (conflict detection)
3. Generate unique claim ID from transaction ID
4. Create claim record with state=PROPOSED
5. Store in world state

**Conflict Detection**:
```javascript
// Calculate distance to existing anchor
const distance = sqrt((x1-x2)² + (y1-y2)² + (z1-z2)²);

if (distance < 0.05) {
    conflictClassification = 'REFINEMENT';  // Small adjustment
} else if (distance < 0.25) {
    conflictClassification = 'SUSPICIOUS';   // Needs extra endorsement
} else {
    conflictClassification = 'CONFLICT';     // Significant difference
}
```

### EndorseAnchor(ctx, claimId, endorserId)

**Purpose**: Add an endorsement to a proposal.

**What it does**:
1. Load claim record
2. Verify state is PROPOSED or CONFLICT
3. Check for duplicate endorsement
4. Add endorser to list
5. If threshold met, change state to ACTIVE
6. If activating, supersede any existing active anchor

**Duplicate Prevention**:
```javascript
// Check composite key
const endorseKey = `ENDORSE::${claimId}::${endorserId}`;
const existing = await ctx.stub.getState(endorseKey);
if (existing && existing.length > 0) {
    throw new Error('DUPLICATE: Already endorsed');
}
```

### ResolveAnchor(ctx, assetId)

**Purpose**: Get the current active anchor for an asset.

**What it does**:
1. Look up `ANCHOR_ACTIVE::${assetId}`
2. If found, load and return the claim record
3. If not found, return null

### RevokeAnchor(ctx, assetId, claimId, reason, supervisorId)

**Purpose**: Remove an active anchor.

**What it does**:
1. Find active anchor (from claimId or assetId)
2. Verify state is ACTIVE
3. Change state to REVOKED
4. Record reason and supervisor
5. Delete ANCHOR_ACTIVE entry

### GetClaim(ctx, claimId)

**Purpose**: Retrieve a specific claim record.

### ListClaims(ctx, assetId)

**Purpose**: Get all claims (any state) for an asset.

## Determinism Requirement

**CRITICAL**: Chaincode must be deterministic. The same inputs must produce the same outputs on every peer.

**BAD** (non-deterministic):
```javascript
const claimId = `claim-${Date.now()}`;  // Different on each peer!
```

**GOOD** (deterministic):
```javascript
const txId = ctx.stub.getTxID();  // Same on all peers
const claimId = `claim-${hash(assetId + txId)}`;

const timestamp = ctx.stub.getTxTimestamp();  // Same on all peers
```

---

# 8. Gateway API Explained

## Authentication

All endpoints (except /health) require an API key:

```
Header: X-API-Key: proposer-key-001
```

**Default API Keys**:
| Key | Role | Permissions |
|-----|------|-------------|
| proposer-key-001 | proposer | Propose anchors |
| endorser-key-001 | endorser | Endorse proposals |
| supervisor-key-001 | supervisor | All + Revoke |

## Endpoints Reference

### GET /health

**Purpose**: Check system status.

**Authentication**: None required.

**Response**:
```json
{
    "status": "healthy",
    "postgres": "connected",
    "fabric": "connected",
    "fabric_mock": false,
    "timestamp": "2026-01-26T03:00:00.000Z"
}
```

**Important**: `fabric_mock` must be `false` for real blockchain.

### POST /claims/propose

**Purpose**: Create a new anchor proposal.

**Authentication**: `proposer` or `supervisor` role.

**Request**:
```json
{
    "asset_id": "desk-001",
    "pose_site": {
        "position": {"x": 1.5, "y": 2.0, "z": 3.5},
        "rotation": {"qx": 0, "qy": 0, "qz": 0, "qw": 1}
    },
    "quality_metrics": {
        "stability_rms": 0.02,
        "confidence_mean": 0.9
    }
}
```

**Response**:
```json
{
    "success": true,
    "claim_id": "claim-40dfa552d595d4ac",
    "state": "PROPOSED",
    "conflict_classification": "NONE",
    "payload_hash": "sha256:abc123..."
}
```

### POST /claims/:claim_id/endorse

**Purpose**: Endorse a proposal.

**Authentication**: `endorser` or `supervisor` role.

**Response**:
```json
{
    "success": true,
    "claim_id": "claim-40dfa552d595d4ac",
    "endorsement_count": 1,
    "new_state": "ACTIVE"
}
```

### GET /assets/:asset_id/resolve

**Purpose**: Get current active anchor.

**Authentication**: Any valid API key.

**Response** (if active):
```json
{
    "success": true,
    "asset_id": "desk-001",
    "claim_id": "claim-40dfa552d595d4ac",
    "state": "ACTIVE",
    "payload": {
        "pose_site": {...},
        "quality_metrics": {...}
    },
    "payload_verified": true,
    "activated_at": "2026-01-26T03:00:00.000Z"
}
```

**Response** (if none):
```json
{
    "success": true,
    "asset_id": "desk-001",
    "claim_id": null,
    "message": "No active anchor"
}
```

### POST /assets/:asset_id/revoke

**Purpose**: Remove active anchor.

**Authentication**: `supervisor` role ONLY.

**Request**:
```json
{
    "reason": "Location changed"
}
```

**Response**:
```json
{
    "success": true,
    "claim_id": "claim-40dfa552d595d4ac",
    "new_state": "REVOKED",
    "revoked_by": "supervisor-key-001"
}
```

### GET /claims/:claim_id

**Purpose**: Get specific claim details.

**Authentication**: Any valid API key.

### GET /assets/:asset_id/claims

**Purpose**: List all claims for an asset.

**Authentication**: Any valid API key.

---

# 9. Commands Reference

## Startup Commands

### Start Everything
```bash
./up.sh
```
This script:
1. Checks if Fabric is running, starts if not
2. Deploys chaincode if not deployed
3. Starts PostgreSQL
4. Installs gateway dependencies
5. Starts gateway

### Start with Options
```bash
./up.sh --skip-fabric      # Assume Fabric already running
./up.sh --skip-chaincode   # Don't check chaincode
./up.sh --force-deploy     # Redeploy chaincode even if exists
```

## Shutdown Commands

### Shutdown Gateway + PostgreSQL
```bash
./down.sh
```
Keeps Fabric running for other uses.

### Shutdown Everything
```bash
./down.sh --fabric
```
Stops Fabric network too.

## Fabric Commands

### Set Environment (Required Before peer Commands)
```bash
cd ~/work/fabric-samples/test-network
export PATH=${PWD}/../bin:$PATH
export FABRIC_CFG_PATH=$PWD/../config/
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051
```

### Query Chaincode (Read-Only)
```bash
# Get configuration
peer chaincode query -C mychannel -n anchorregistry \
  -c '{"function":"GetConfig","Args":[]}'

# Get specific claim
peer chaincode query -C mychannel -n anchorregistry \
  -c '{"function":"GetClaim","Args":["claim-40dfa552d595d4ac"]}'

# Resolve asset
peer chaincode query -C mychannel -n anchorregistry \
  -c '{"function":"ResolveAnchor","Args":["desk-001"]}'
```

### Invoke Chaincode (Write)
```bash
peer chaincode invoke \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls \
  --cafile "${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" \
  -C mychannel \
  -n anchorregistry \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  -c '{"function":"InitLedger","Args":[]}'
```

### Check Chaincode Status
```bash
peer lifecycle chaincode querycommitted -C mychannel -n anchorregistry
```

## Docker Commands

### View Running Containers
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### View Container Logs
```bash
# Peer logs
docker logs peer0.org1.example.com --tail 50

# Chaincode logs (find container name first)
docker logs dev-peer0.org1.example.com-anchorregistry_1.0-xxx --tail 50

# PostgreSQL logs
docker logs mr-anchor-postgres --tail 50
```

### Access PostgreSQL
```bash
docker exec -it mr-anchor-postgres psql -U anchor_admin -d anchor_registry

# Query example
SELECT * FROM anchor_payloads;
```

## Gateway Commands

### View Logs
```bash
tail -f ~/work/MR-Anchor-Registry/gateway.log
```

### Health Check
```bash
curl http://localhost:3000/health | python3 -m json.tool
```

### Test Endpoints with curl
```bash
# Propose
curl -X POST http://localhost:3000/claims/propose \
  -H "Content-Type: application/json" \
  -H "X-API-Key: proposer-key-001" \
  -d '{"asset_id":"test","pose_site":{"position":{"x":1,"y":2,"z":3},"rotation":{"qw":1}},"quality_metrics":{"stability_rms":0.02,"confidence_mean":0.9}}'

# Endorse
curl -X POST http://localhost:3000/claims/CLAIM_ID/endorse \
  -H "X-API-Key: endorser-key-001"

# Resolve
curl http://localhost:3000/assets/test/resolve \
  -H "X-API-Key: proposer-key-001"

# Revoke
curl -X POST http://localhost:3000/assets/test/revoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: supervisor-key-001" \
  -d '{"reason":"test"}'
```

---

# 10. Troubleshooting Guide

## Common Issues and Solutions

### Issue: Gateway Won't Start

**Symptom**: `Error: Certificate not found` or `Keystore not found`

**Cause**: Fabric network not running or crypto materials missing.

**Solution**:
```bash
# Check if Fabric is running
docker ps | grep peer0.org1

# If not running, start it
cd ~/work/fabric-samples/test-network
./network.sh up createChannel -c mychannel
```

### Issue: "Failed to collect enough transaction endorsements"

**Symptom**: Chaincode invocation fails with endorsement error.

**Possible Causes**:
1. Chaincode not deployed on both peers
2. Non-deterministic chaincode (different results on each peer)

**Solution**:
```bash
# Check chaincode is committed
peer lifecycle chaincode querycommitted -C mychannel -n anchorregistry

# If not, redeploy
./network.sh deployCC -c mychannel -ccn anchorregistry -ccp ~/work/MR-Anchor-Registry/chaincode/anchor-registry -ccl javascript -ccs 2
```

### Issue: "fabric_mock: true" in Health Check

**Symptom**: Gateway shows mock mode even though you want real Fabric.

**Cause**: Environment variable FABRIC_MOCK is set to true or crypto not found.

**Solution**:
```bash
# Check environment
echo $FABRIC_MOCK  # Should be "false" or empty

# Check crypto exists
ls ~/work/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/
```

### Issue: TLS Handshake Failed

**Symptom**: `Error: 14 UNAVAILABLE: failed to connect`

**Cause**: TLS certificate mismatch or wrong endpoint.

**Solution**:
1. Verify TLS cert path in .env
2. Check hostname override in fabric/client.js:
```javascript
'grpc.ssl_target_name_override': 'peer0.org1.example.com'
```

### Issue: PostgreSQL Connection Refused

**Symptom**: `Error: ECONNREFUSED 127.0.0.1:5433`

**Cause**: PostgreSQL not running or wrong port.

**Solution**:
```bash
# Check if running
docker ps | grep mr-anchor-postgres

# If not, start it
docker run -d --name mr-anchor-postgres --network fabric_test -p 5433:5432 \
  -e POSTGRES_USER=anchor_admin -e POSTGRES_PASSWORD=anchor_secret_2025 \
  -e POSTGRES_DB=anchor_registry postgres:15-alpine
```

### Issue: "Supervisor required" Error

**Symptom**: Revoke fails with 403 error.

**Cause**: Using wrong API key (not supervisor).

**Solution**: Use `supervisor-key-001` for revoke operations.

### Issue: Chaincode Returns Empty or Garbled Response

**Symptom**: `SyntaxError: Unexpected token` when parsing response.

**Cause**: Fabric Gateway returns Uint8Array, not string.

**Solution**: Use TextDecoder in fabric/client.js:
```javascript
function uint8ArrayToString(uint8Array) {
    return new TextDecoder('utf-8').decode(uint8Array);
}
```

## Viewing Logs

### Gateway Logs
```bash
tail -f ~/work/MR-Anchor-Registry/gateway.log
```

### Chaincode Logs
```bash
# Find chaincode container
docker ps | grep dev-peer0

# View logs
docker logs <container_name> --tail 100
```

### Peer Logs
```bash
docker logs peer0.org1.example.com --tail 100
```

### Orderer Logs
```bash
docker logs orderer.example.com --tail 100
```

---

# 11. Glossary

| Term | Definition |
|------|------------|
| **Anchor** | A coordinate system that ties virtual content to a real-world position |
| **Asset** | A physical object that can have anchors (e.g., a desk, wall, landmark) |
| **Block** | A batch of transactions bundled together in the blockchain |
| **CA (Certificate Authority)** | Issues digital certificates for identity |
| **Chaincode** | Smart contract code that runs on Fabric peers |
| **Channel** | A private subnet within Fabric for confidential transactions |
| **Claim** | A proposal to register or update an anchor |
| **Endorsement** | A peer's signature approving a transaction |
| **Endorsement Policy** | Rules defining who must sign a transaction |
| **Gateway** | The REST API server that bridges applications to Fabric |
| **gRPC** | Google's Remote Procedure Call framework (used by Fabric) |
| **Ledger** | The blockchain plus world state database |
| **MSP** | Membership Service Provider - handles identity in Fabric |
| **Orderer** | Service that orders transactions and creates blocks |
| **Peer** | A node that maintains the ledger and executes chaincode |
| **Proposal** | A request to execute a transaction (before endorsement) |
| **Smart Contract** | Code that defines business logic on blockchain |
| **TLS** | Transport Layer Security - encryption for network communication |
| **Transaction** | A unit of change in the blockchain |
| **World State** | Current values of all keys (like a database) |

---

# Appendix A: Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `WORK_DIR` | ~/work | Base directory for all projects |
| `MR_ANCHOR_DIR` | ~/work/MR-Anchor-Registry | Gateway project directory |
| `FABRIC_SAMPLES_DIR` | ~/work/fabric-samples | Fabric samples directory |
| `GATEWAY_PORT` | 3000 | Gateway HTTP port |
| `POSTGRES_HOST` | localhost | PostgreSQL host |
| `POSTGRES_PORT` | 5433 | PostgreSQL port |
| `POSTGRES_DB` | anchor_registry | Database name |
| `POSTGRES_USER` | anchor_admin | Database user |
| `POSTGRES_PASSWORD` | anchor_secret_2025 | Database password |
| `FABRIC_PEER_ENDPOINT` | localhost:7051 | Peer gRPC endpoint |
| `FABRIC_CHANNEL` | mychannel | Fabric channel name |
| `FABRIC_CHAINCODE` | anchorregistry | Chaincode name |
| `FABRIC_MSP_ID` | Org1MSP | Organization MSP ID |
| `FABRIC_TLS_ENABLED` | true | Use TLS for Fabric |
| `FABRIC_MOCK` | false | Use mock mode (must be false) |
| `API_KEYS` | (see config) | API key:role:name mappings |
| `SUPERVISOR_IDS` | supervisor-key-001 | Keys with supervisor role |

---

# Appendix B: Quick Reference Card

## Start System
```bash
./up.sh
```

## Stop System
```bash
./down.sh          # Keep Fabric
./down.sh --fabric # Stop all
```

## Health Check
```bash
curl http://localhost:3000/health
```

## Create Anchor
```bash
curl -X POST http://localhost:3000/claims/propose \
  -H "Content-Type: application/json" \
  -H "X-API-Key: proposer-key-001" \
  -d '{"asset_id":"my-asset","pose_site":{"position":{"x":1,"y":2,"z":3},"rotation":{"qw":1}},"quality_metrics":{"stability_rms":0.02,"confidence_mean":0.9}}'
```

## Endorse
```bash
curl -X POST http://localhost:3000/claims/CLAIM_ID/endorse \
  -H "X-API-Key: endorser-key-001"
```

## Get Active Anchor
```bash
curl http://localhost:3000/assets/my-asset/resolve \
  -H "X-API-Key: proposer-key-001"
```

## Revoke (Supervisor Only)
```bash
curl -X POST http://localhost:3000/assets/my-asset/revoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: supervisor-key-001" \
  -d '{"reason":"test"}'
```

## View Logs
```bash
tail -f ~/work/MR-Anchor-Registry/gateway.log
```

---
