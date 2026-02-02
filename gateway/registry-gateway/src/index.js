// =============================================================================
// MR-Anchor-Registry Gateway - Main Entry Point
// EP5 UPDATE: Added /events routes for headset SSE and snapshot
// =============================================================================

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./utils/logger');
const config = require('./config');
const { initializePostgres, closePostgres } = require('./db/postgres');
const { initializeFabric, closeFabric } = require('./fabric/client');
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const claimsRoutes = require('./routes/claims');
const assetsRoutes = require('./routes/assets');
const healthRoutes = require('./routes/health');
const eventsRoutes = require('./routes/events');  // EP5: New headset-accessible events
const adminRoutes = require('./admin/routes');

const app = express();

// Security middleware (relaxed for SSE)
app.use(helmet({
    contentSecurityPolicy: false  // Allow inline scripts for admin UI
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// =============================================================================
// ROUTES
// =============================================================================

// Health check (no auth required)
app.use('/health', healthRoutes);

// Supervisor UI - static files (no auth for static assets)
app.use('/admin', express.static(path.join(__dirname, 'admin', 'public')));

// Admin API (auth required)
app.use('/admin/api', authMiddleware, adminRoutes);

// EP5: Headset-accessible events (SSE stream + snapshot)
// Accessible to proposer role - NOT supervisor-only
app.use('/events', authMiddleware, eventsRoutes);

// Main API routes (auth required)
app.use('/claims', authMiddleware, claimsRoutes);
app.use('/assets', authMiddleware, assetsRoutes);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'MR-Anchor-Registry',
        version: '2.1.0',  // EP5 version bump
        endpoints: {
            health: '/health',
            claims: '/claims',
            assets: '/assets',
            events_stream: '/events/stream',     // EP5: Headset SSE
            events_snapshot: '/events/snapshot', // EP5: Headset catch-up
            admin_ui: '/admin/',
            admin_api: '/admin/api',
            admin_sse_stream: '/admin/api/events/stream'  // Legacy admin stream
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler
app.use(errorHandler);

// =============================================================================
// STARTUP
// =============================================================================

async function start() {
    logger.info('========================================');
    logger.info('  MR-Anchor-Registry Gateway v2.1.0');
    logger.info('  EP5: Unity <-> Gateway Integration');
    logger.info('========================================');
    logger.info('');
    logger.info('Configuration:');
    logger.info(`  Port: ${config.port}`);
    logger.info(`  FABRIC_MOCK: ${config.fabricMock}`);
    logger.info(`  Postgres: ${config.postgres.host}:${config.postgres.port}`);
    logger.info(`  Fabric peer: ${config.fabric.peerEndpoint}`);
    logger.info(`  Channel: ${config.fabric.channelName}`);
    logger.info(`  Chaincode: ${config.fabric.chaincodeName}`);
    logger.info('');

    // Initialize PostgreSQL
    logger.info('Connecting to PostgreSQL...');
    await initializePostgres();

    // Initialize Fabric
    logger.info('Connecting to Fabric network...');
    await initializeFabric();

    // Start HTTP server
    app.listen(config.port, '0.0.0.0', () => {
        logger.info('');
        logger.info('========================================');
        logger.info(`  Gateway listening on port ${config.port}`);
        logger.info('========================================');
        logger.info('');
        logger.info('Endpoints:');
        logger.info(`  Health:          http://localhost:${config.port}/health`);
        logger.info(`  Claims API:      http://localhost:${config.port}/claims`);
        logger.info(`  Assets API:      http://localhost:${config.port}/assets`);
        logger.info(`  Events SSE:      http://localhost:${config.port}/events/stream`);
        logger.info(`  Events Snapshot: http://localhost:${config.port}/events/snapshot`);
        logger.info(`  Admin UI:        http://localhost:${config.port}/admin/`);
        logger.info(`  Admin SSE:       http://localhost:${config.port}/admin/api/events/stream`);
        logger.info('');
        logger.info('EP5 Notes:');
        logger.info('  - /events/stream accessible with proposer API key');
        logger.info('  - Supports Last-Event-ID header for replay');
        logger.info('  - /events/snapshot for catch-up after reconnect');
        logger.info('');
    });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down...');
    await closeFabric();
    await closePostgres();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down...');
    await closeFabric();
    await closePostgres();
    process.exit(0);
});

// Start the server
start().catch(err => {
    logger.error('Startup failed:', err);
    process.exit(1);
});
