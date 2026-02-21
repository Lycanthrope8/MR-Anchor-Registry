/**
 * ==============================================================================
 * server.js - MR Anchor Registry Gateway Server
 *
 * SECURITY FIX: Each gateway instance holds EXACTLY ONE org identity.
 * Org selection is fixed at startup via the ORG env var (default: org1).
 * The x-org-id header is IGNORED for identity selection.
 *
 * Run two instances for the two-org governance model:
 *   ORG=org1 PORT=3000 node src/server.js   # Gateway for Org1
 *   ORG=org2 PORT=3001 node src/server.js   # Gateway for Org2
 *
 * SSE is ledger-driven: this gateway subscribes to Fabric chaincode events
 * and broadcasts them to all connected SSE clients.  Events committed via
 * the OTHER gateway are visible here too (both peers receive the same blocks).
 * ==============================================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const FabricClient = require('./services/fabricClient');
const claimsRoutes = require('./routes/claims');
const adminRoutes = require('./routes/admin');
const eventsRoutes = require('./routes/events');
const benchmarkRoutes = require('./routes/benchmark');
const logger = require('./services/logger');
const { experimentLogMiddleware } = require('./services/experimentLogger');
const { startChaincodeEventListener } = require('./routes/events');

const app = express();

// Configuration — identity is FIXED at startup, never switchable at runtime
const PORT = process.env.PORT || 3000;
const ORG = (process.env.ORG || 'org1').toLowerCase();

if (ORG !== 'org1' && ORG !== 'org2') {
    console.error(`FATAL: ORG must be 'org1' or 'org2', got '${ORG}'`);
    process.exit(1);
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key',
                     'x-run-id', 'x-req-id', 'x-lane']
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, { org: ORG, ip: req.ip });
    next();
});

// ─── Single Fabric client for this org ─────────────────────────────────────
let fabricClient = null;

async function initializeFabricClient() {
    try {
        logger.info(`Initializing Fabric client for ${ORG}...`);
        fabricClient = new FabricClient(ORG);
        await fabricClient.connect();
        logger.info(`✓ ${ORG} Fabric client connected`);
        return true;
    } catch (error) {
        logger.error('Failed to initialize Fabric client:', error);
        return false;
    }
}

// Make Fabric client available to routes — identity is ALWAYS this org
app.use((req, res, next) => {
    req.fabricClient = fabricClient;
    req.currentOrg = ORG;
    req.orgId = ORG;
    next();
});

// Experiment logging middleware
app.use(experimentLogMiddleware);

// ─── Health check (shows fixed org identity) ───────────────────────────────
app.get('/health', (req, res) => {
    const mspId = fabricClient?.getMspId() || 'unknown';
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        org: ORG,
        mspId: mspId,
        connected: fabricClient?.isConnected() || false,
        // Backward-compat fields
        org1Connected: ORG === 'org1' ? (fabricClient?.isConnected() || false) : false,
        org2Connected: ORG === 'org2' ? (fabricClient?.isConnected() || false) : false,
        defaultOrg: ORG
    });
});

// API Routes
app.use('/claims', claimsRoutes);
app.use('/admin', adminRoutes);
app.use('/admin', benchmarkRoutes);
app.use('/events', eventsRoutes);

// Static files for admin panels
app.use('/admin-panel/org1', express.static(path.join(__dirname, '../admin-panel/org1')));
app.use('/admin-panel/org2', express.static(path.join(__dirname, '../admin-panel/org2')));

// Error handling
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    if (fabricClient) {
        await fabricClient.disconnect();
        logger.info(`${ORG} client disconnected`);
    }
    process.exit(0);
});

// ─── Start server ──────────────────────────────────────────────────────────
async function startServer() {
    const connected = await initializeFabricClient();

    if (!connected) {
        logger.error('Failed to initialize Fabric client. Server starting in degraded mode.');
    } else {
        // Start ledger-driven SSE: subscribe to chaincode events
        startChaincodeEventListener(fabricClient);
        logger.info('✓ Chaincode event listener started (ledger-driven SSE)');
    }

    app.listen(PORT, () => {
        logger.info(`============================================`);
        logger.info(`MR Anchor Registry Gateway`);
        logger.info(`============================================`);
        logger.info(`Server running on port ${PORT}`);
        logger.info(`Organization: ${ORG} (FIXED — not switchable)`);
        logger.info(`MSP ID: ${fabricClient?.getMspId() || 'N/A'}`);
        logger.info(`Experiment logging: ENABLED`);
        logger.info(`SSE source: Fabric chaincode events (ledger-driven)`);
        logger.info(`============================================`);
    });
}

startServer();
