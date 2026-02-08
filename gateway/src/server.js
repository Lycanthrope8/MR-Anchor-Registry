/**
 * ==============================================================================
 * server.js - MR Anchor Registry Gateway Server
 * Supports both Org1 and Org2 identities with role-based access
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
const logger = require('./services/logger');

const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const ORG = process.env.ORG || 'org1'; // Default to org1

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-org-id']
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, {
        org: req.headers['x-org-id'] || ORG,
        ip: req.ip
    });
    next();
});

// Initialize Fabric clients for both orgs
let fabricClients = {};

async function initializeFabricClients() {
    try {
        logger.info('Initializing Fabric clients...');
        
        // Initialize Org1 client
        fabricClients.org1 = new FabricClient('org1');
        await fabricClients.org1.connect();
        logger.info('✓ Org1 Fabric client connected');
        
        // Initialize Org2 client
        fabricClients.org2 = new FabricClient('org2');
        await fabricClients.org2.connect();
        logger.info('✓ Org2 Fabric client connected');
        
        return true;
    } catch (error) {
        logger.error('Failed to initialize Fabric clients:', error);
        return false;
    }
}

// Make Fabric clients available to routes
app.use((req, res, next) => {
    req.fabricClients = fabricClients;
    
    // Determine which org's identity to use based on header or default
    const requestedOrg = req.headers['x-org-id'] || ORG;
    req.currentOrg = requestedOrg;
    req.fabricClient = fabricClients[requestedOrg] || fabricClients.org1;
    
    next();
});

// Health check
app.get('/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        org1Connected: fabricClients.org1?.isConnected() || false,
        org2Connected: fabricClients.org2?.isConnected() || false,
        defaultOrg: ORG
    };
    res.json(health);
});

// API Routes
app.use('/claims', claimsRoutes);
app.use('/admin', adminRoutes);
app.use('/events', eventsRoutes);

// Static files for admin panels
app.use('/admin-panel/org1', express.static(path.join(__dirname, '../admin-panel/org1')));
app.use('/admin-panel/org2', express.static(path.join(__dirname, '../admin-panel/org2')));

// Error handling
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    
    for (const [org, client] of Object.entries(fabricClients)) {
        if (client) {
            await client.disconnect();
            logger.info(`${org} client disconnected`);
        }
    }
    
    process.exit(0);
});

// Start server
async function startServer() {
    const clientsInitialized = await initializeFabricClients();
    
    if (!clientsInitialized) {
        logger.error('Failed to initialize Fabric clients. Server starting in degraded mode.');
    }
    
    app.listen(PORT, () => {
        logger.info(`============================================`);
        logger.info(`MR Anchor Registry Gateway`);
        logger.info(`============================================`);
        logger.info(`Server running on port ${PORT}`);
        logger.info(`Default organization: ${ORG}`);
        logger.info(`Org1 Admin Panel: http://localhost:${PORT}/admin-panel/org1`);
        logger.info(`Org2 Admin Panel: http://localhost:${PORT}/admin-panel/org2`);
        logger.info(`============================================`);
    });
}

startServer();
