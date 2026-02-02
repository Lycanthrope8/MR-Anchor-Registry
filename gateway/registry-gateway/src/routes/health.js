// =============================================================================
// Health Routes
// =============================================================================

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/postgres');
const fabric = require('../fabric/client');
const sseEventBus = require('../utils/sseEventBus');

router.get('/', async (req, res) => {
    let postgresOk = false;
    try {
        await getPool().query('SELECT 1');
        postgresOk = true;
    } catch (e) {
        // Postgres not available
    }

    res.json({
        status: postgresOk ? 'healthy' : 'degraded',
        postgres: postgresOk ? 'connected' : 'disconnected',
        fabric: 'connected',
        fabric_mock: fabric.isInMockMode(),
        sse_clients: sseEventBus.getClientCount(),
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

module.exports = router;
