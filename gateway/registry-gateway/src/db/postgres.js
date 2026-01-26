const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

let pool = null;

async function initializePostgres() {
    pool = new Pool(config.postgres);
    for (let i = 0; i < 30; i++) {
        try {
            const client = await pool.connect();
            await client.query('SELECT NOW()');
            client.release();
            logger.info('PostgreSQL connected');
            return;
        } catch (err) {
            logger.warn(`PostgreSQL attempt ${i + 1}/30`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error('PostgreSQL connection failed');
}

async function closePostgres() { if (pool) await pool.end(); }
function getPool() { return pool; }

async function storePayload(payloadHash, payloadPtr, assetId, poseSite, qualityMetrics, publisherId, rawPayload) {
    const query = `INSERT INTO anchor_payloads (payload_hash, payload_ptr, asset_id, pose_site, quality_metrics, publisher_id, raw_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (payload_hash) DO UPDATE SET last_accessed = NOW() RETURNING *`;
    const result = await getPool().query(query, [payloadHash, payloadPtr, assetId, JSON.stringify(poseSite), JSON.stringify(qualityMetrics), publisherId, JSON.stringify(rawPayload)]);
    return result.rows[0];
}

async function getPayloadByHash(payloadHash) {
    const result = await getPool().query('SELECT * FROM anchor_payloads WHERE payload_hash = $1', [payloadHash]);
    return result.rows[0];
}

module.exports = { initializePostgres, closePostgres, getPool, storePayload, getPayloadByHash };
