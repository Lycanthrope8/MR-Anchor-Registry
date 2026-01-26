const express = require('express');
const router = express.Router();
const { getPool } = require('../db/postgres');
const fabric = require('../fabric/client');

router.get('/', async (req, res) => {
    let postgresOk = false;
    try { await getPool().query('SELECT 1'); postgresOk = true; } catch (e) {}
    res.json({
        status: postgresOk ? 'healthy' : 'degraded',
        postgres: postgresOk ? 'connected' : 'disconnected',
        fabric: 'connected',
        fabric_mock: fabric.isInMockMode(),
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
