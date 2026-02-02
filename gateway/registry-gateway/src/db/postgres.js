// =============================================================================
// PostgreSQL Database Module
// =============================================================================

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

let pool = null;

async function initializePostgres() {
    pool = new Pool(config.postgres);
    
    // Retry connection up to 30 times
    for (let i = 0; i < 30; i++) {
        try {
            const client = await pool.connect();
            await client.query('SELECT NOW()');
            client.release();
            logger.info('PostgreSQL connected');
            
            // Ensure tables exist
            await ensureSchema();
            return;
        } catch (err) {
            logger.warn(`PostgreSQL attempt ${i + 1}/30: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error('PostgreSQL connection failed after 30 attempts');
}

async function ensureSchema() {
    const createPayloadsTable = `
        CREATE TABLE IF NOT EXISTS anchor_payloads (
            id SERIAL PRIMARY KEY,
            payload_hash VARCHAR(128) UNIQUE NOT NULL,
            payload_ptr UUID NOT NULL,
            asset_id VARCHAR(256) NOT NULL,
            pose_site JSONB NOT NULL,
            quality_metrics JSONB NOT NULL,
            publisher_id VARCHAR(256) NOT NULL,
            raw_payload JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            last_accessed TIMESTAMP DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_payloads_asset_id ON anchor_payloads(asset_id);
        CREATE INDEX IF NOT EXISTS idx_payloads_publisher ON anchor_payloads(publisher_id);
    `;

    // New: Asset index table for dashboard
    const createAssetIndexTable = `
        CREATE TABLE IF NOT EXISTS asset_index (
            asset_id VARCHAR(256) PRIMARY KEY,
            active_claim_id VARCHAR(256),
            latest_claim_id VARCHAR(256) NOT NULL,
            latest_state VARCHAR(64) NOT NULL,
            publisher_id VARCHAR(256),
            last_updated_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_asset_index_state ON asset_index(latest_state);
        CREATE INDEX IF NOT EXISTS idx_asset_index_updated ON asset_index(last_updated_at DESC);
    `;
    
    try {
        await pool.query(createPayloadsTable);
        await pool.query(createAssetIndexTable);
        logger.info('PostgreSQL schema ensured');
    } catch (err) {
        logger.warn('Schema creation warning:', err.message);
    }
}

async function closePostgres() {
    if (pool) {
        await pool.end();
        logger.info('PostgreSQL connection closed');
    }
}

function getPool() {
    return pool;
}

// =============================================================================
// Payload Functions
// =============================================================================

async function storePayload(payloadHash, payloadPtr, assetId, poseSite, qualityMetrics, publisherId, rawPayload) {
    const query = `
        INSERT INTO anchor_payloads 
        (payload_hash, payload_ptr, asset_id, pose_site, quality_metrics, publisher_id, raw_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (payload_hash) DO UPDATE SET last_accessed = NOW()
        RETURNING *
    `;
    
    const result = await getPool().query(query, [
        payloadHash,
        payloadPtr,
        assetId,
        JSON.stringify(poseSite),
        JSON.stringify(qualityMetrics),
        publisherId,
        JSON.stringify(rawPayload)
    ]);
    
    return result.rows[0];
}

async function getPayloadByHash(payloadHash) {
    const result = await getPool().query(
        'SELECT * FROM anchor_payloads WHERE payload_hash = $1',
        [payloadHash]
    );
    return result.rows[0];
}

async function getPayloadsByAsset(assetId) {
    const result = await getPool().query(
        'SELECT * FROM anchor_payloads WHERE asset_id = $1 ORDER BY created_at DESC',
        [assetId]
    );
    return result.rows;
}

// =============================================================================
// Asset Index Functions (for Dashboard)
// =============================================================================

/**
 * Update the asset index when a claim state changes
 */
async function updateAssetIndex(assetId, latestClaimId, latestState, activeClaimId = null, publisherId = null) {
    const query = `
        INSERT INTO asset_index (asset_id, active_claim_id, latest_claim_id, latest_state, publisher_id, last_updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (asset_id) DO UPDATE SET
            active_claim_id = COALESCE($2, asset_index.active_claim_id),
            latest_claim_id = $3,
            latest_state = $4,
            publisher_id = COALESCE($5, asset_index.publisher_id),
            last_updated_at = NOW()
        RETURNING *
    `;
    
    const result = await getPool().query(query, [
        assetId,
        activeClaimId,
        latestClaimId,
        latestState,
        publisherId
    ]);
    
    logger.info(`Asset index updated: ${assetId} -> ${latestState}`);
    return result.rows[0];
}

/**
 * Update asset index when a claim becomes ACTIVE
 */
async function setAssetActive(assetId, claimId) {
    const query = `
        UPDATE asset_index 
        SET active_claim_id = $2, 
            latest_claim_id = $2,
            latest_state = 'ACTIVE',
            last_updated_at = NOW()
        WHERE asset_id = $1
        RETURNING *
    `;
    
    const result = await getPool().query(query, [assetId, claimId]);
    return result.rows[0];
}

/**
 * Clear active claim when revoked
 */
async function clearAssetActive(assetId, claimId) {
    const query = `
        UPDATE asset_index 
        SET active_claim_id = NULL,
            latest_claim_id = $2,
            latest_state = 'REVOKED',
            last_updated_at = NOW()
        WHERE asset_id = $1
        RETURNING *
    `;
    
    const result = await getPool().query(query, [assetId, claimId]);
    return result.rows[0];
}

/**
 * Get all assets for dashboard (sorted by last_updated_at desc)
 */
async function getAllAssets(limit = 100) {
    const query = `
        SELECT 
            asset_id,
            active_claim_id,
            latest_claim_id,
            latest_state,
            publisher_id,
            last_updated_at
        FROM asset_index
        ORDER BY last_updated_at DESC
        LIMIT $1
    `;
    
    const result = await getPool().query(query, [limit]);
    return result.rows;
}

/**
 * Get single asset from index
 */
async function getAssetFromIndex(assetId) {
    const result = await getPool().query(
        'SELECT * FROM asset_index WHERE asset_id = $1',
        [assetId]
    );
    return result.rows[0];
}

module.exports = {
    initializePostgres,
    closePostgres,
    getPool,
    storePayload,
    getPayloadByHash,
    getPayloadsByAsset,
    // Asset index functions
    updateAssetIndex,
    setAssetActive,
    clearAssetActive,
    getAllAssets,
    getAssetFromIndex
};