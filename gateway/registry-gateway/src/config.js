// =============================================================================
// Gateway Configuration
// =============================================================================

function parseApiKeys(str) {
    const keys = {};
    (str || '').split(',').forEach(entry => {
        const [key, role, name] = entry.split(':');
        if (key && role) {
            keys[key] = { role, name: name || 'Unknown' };
        }
    });
    return keys;
}

module.exports = {
    port: parseInt(process.env.PORT) || parseInt(process.env.GATEWAY_PORT) || 3000,
    
    // CRITICAL: Mock mode disabled - real Fabric only
    fabricMock: process.env.FABRIC_MOCK === 'true',
    
    postgres: {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT) || 5433,
        database: process.env.POSTGRES_DB || 'anchor_registry',
        user: process.env.POSTGRES_USER || 'anchor_admin',
        password: process.env.POSTGRES_PASSWORD || 'anchor_secret_2025'
    },
    
    fabric: {
        peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
        channelName: process.env.FABRIC_CHANNEL || 'mychannel',
        chaincodeName: process.env.FABRIC_CHAINCODE || 'anchorregistry',
        mspId: process.env.FABRIC_MSP_ID || 'Org1MSP',
        cryptoPath: process.env.FABRIC_CRYPTO_PATH || `${process.env.HOME}/work/fabric-samples/test-network/organizations`,
        tlsEnabled: process.env.FABRIC_TLS_ENABLED !== 'false', // Default true
        tlsCertPath: process.env.FABRIC_PEER_TLS_CERT
    },
    
    apiKeys: parseApiKeys(process.env.API_KEYS || 'proposer-key-001:proposer:Alice,endorser-key-001:endorser:Carlos,supervisor-key-001:supervisor:Eva'),
    supervisorIds: (process.env.SUPERVISOR_IDS || 'supervisor-key-001').split(','),
    
    // SSE configuration
    sse: {
        heartbeatInterval: 30000,  // 30 seconds
        reconnectTime: 3000        // 3 seconds
    }
};
