CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS anchor_payloads (
    payload_hash VARCHAR(128) PRIMARY KEY,
    payload_ptr UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    asset_id VARCHAR(255) NOT NULL,
    pose_site JSONB NOT NULL,
    quality_metrics JSONB NOT NULL,
    publisher_id VARCHAR(255) NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_accessed TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payloads_asset ON anchor_payloads(asset_id);
