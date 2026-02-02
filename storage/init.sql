-- =============================================================================
-- MR-Anchor-Registry PostgreSQL Schema
-- =============================================================================

-- Drop existing tables if recreating
DROP TABLE IF EXISTS anchor_payloads CASCADE;

-- Main payloads table for off-chain storage
CREATE TABLE anchor_payloads (
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

-- Indexes for common queries
CREATE INDEX idx_payloads_asset_id ON anchor_payloads(asset_id);
CREATE INDEX idx_payloads_publisher ON anchor_payloads(publisher_id);
CREATE INDEX idx_payloads_created ON anchor_payloads(created_at DESC);

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anchor_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anchor_admin;

-- Log
SELECT 'MR-Anchor-Registry schema initialized' as message;
