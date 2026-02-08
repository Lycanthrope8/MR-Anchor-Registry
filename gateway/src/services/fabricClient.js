/**
 * ==============================================================================
 * fabricClient.js - Hyperledger Fabric Gateway Client
 * Supports dynamic organization identity switching
 * Fixed: Proper Buffer to string conversion for all results
 * ==============================================================================
 */

const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Configuration paths - relative to gateway/src/services/
// Goes up to gateway/, then up to project root, then into network/
const PROJECT_DIR = path.resolve(__dirname, '../../..');
const NETWORK_DIR = path.join(PROJECT_DIR, 'network');
const CRYPTO_DIR = path.join(NETWORK_DIR, 'crypto-config');

// Channel and chaincode
const CHANNEL_NAME = 'anchorchannel';
const CHAINCODE_NAME = 'anchor-registry';

/**
 * Helper function to convert result to JSON
 * Handles Buffer, Uint8Array, string, and empty responses
 */
function resultToJson(result) {
    if (!result) {
        return null;
    }
    
    let str;
    
    // Convert to string based on type
    if (Buffer.isBuffer(result)) {
        str = result.toString('utf8');
    } else if (result instanceof Uint8Array) {
        str = Buffer.from(result).toString('utf8');
    } else if (typeof result === 'string') {
        str = result;
    } else {
        str = String(result);
    }
    
    // Handle empty string
    if (!str || str.trim() === '') {
        return null;
    }
    
    // Parse JSON
    try {
        return JSON.parse(str);
    } catch (e) {
        logger.error(`Failed to parse JSON: ${str.substring(0, 100)}...`, e);
        throw new Error(`Invalid JSON response: ${e.message}`);
    }
}

class FabricClient {
    constructor(org) {
        this.org = org.toLowerCase();
        this.mspId = this.org === 'org1' ? 'Org1MSP' : 'Org2MSP';
        this.gateway = null;
        this.contract = null;
        this.client = null;
        this.connected = false;
    }

    /**
     * Get organization-specific paths
     */
    getPaths() {
        const domain = this.org === 'org1' 
            ? 'org1.anchor-registry.com' 
            : 'org2.anchor-registry.com';
        
        const peerPort = this.org === 'org1' ? '7051' : '9051';
        const peerHost = `peer0.${domain}`;
        
        return {
            domain,
            peerHost,
            peerPort,
            peerEndpoint: `localhost:${peerPort}`,
            cryptoPath: path.join(CRYPTO_DIR, 'peerOrganizations', domain),
            tlsCertPath: path.join(CRYPTO_DIR, 'peerOrganizations', domain, 'peers', `peer0.${domain}`, 'tls', 'ca.crt'),
            certPath: path.join(CRYPTO_DIR, 'peerOrganizations', domain, 'users', `Admin@${domain}`, 'msp', 'signcerts'),
            keyPath: path.join(CRYPTO_DIR, 'peerOrganizations', domain, 'users', `Admin@${domain}`, 'msp', 'keystore')
        };
    }

    /**
     * Load TLS credentials
     */
    async loadTlsCredentials() {
        const paths = this.getPaths();
        
        if (!fs.existsSync(paths.tlsCertPath)) {
            throw new Error(`TLS cert not found: ${paths.tlsCertPath}`);
        }
        
        const tlsCert = fs.readFileSync(paths.tlsCertPath);
        return grpc.credentials.createSsl(tlsCert);
    }

    /**
     * Load user identity (certificate and private key)
     */
    async loadIdentity() {
        const paths = this.getPaths();
        
        // Find cert file
        const certDir = paths.certPath;
        if (!fs.existsSync(certDir)) {
            throw new Error(`Cert directory not found: ${certDir}`);
        }
        
        const certFiles = fs.readdirSync(certDir).filter(f => f.endsWith('.pem') || f.endsWith('-cert.pem'));
        if (certFiles.length === 0) {
            throw new Error(`No certificate found in ${certDir}`);
        }
        
        const certPath = path.join(certDir, certFiles[0]);
        const certificate = fs.readFileSync(certPath).toString();
        
        // Find private key
        const keyDir = paths.keyPath;
        if (!fs.existsSync(keyDir)) {
            throw new Error(`Key directory not found: ${keyDir}`);
        }
        
        const keyFiles = fs.readdirSync(keyDir).filter(f => f.endsWith('_sk') || f.endsWith('.pem'));
        if (keyFiles.length === 0) {
            throw new Error(`No private key found in ${keyDir}`);
        }
        
        const keyPath = path.join(keyDir, keyFiles[0]);
        const privateKeyPem = fs.readFileSync(keyPath).toString();
        
        return { certificate, privateKeyPem };
    }

    /**
     * Connect to the Fabric network
     */
    async connect() {
        try {
            const paths = this.getPaths();
            
            logger.info(`Connecting ${this.org} client to ${paths.peerEndpoint}...`);
            
            // Load credentials
            const tlsCredentials = await this.loadTlsCredentials();
            const { certificate, privateKeyPem } = await this.loadIdentity();
            
            // Create gRPC client
            this.client = new grpc.Client(
                paths.peerEndpoint,
                tlsCredentials,
                {
                    'grpc.ssl_target_name_override': paths.peerHost
                }
            );
            
            // Create signer from private key
            const privateKey = crypto.createPrivateKey(privateKeyPem);
            const signer = signers.newPrivateKeySigner(privateKey);
            
            // Connect to gateway
            this.gateway = connect({
                client: this.client,
                identity: {
                    mspId: this.mspId,
                    credentials: Buffer.from(certificate)
                },
                signer,
                evaluateOptions: () => ({ deadline: Date.now() + 60000 }),
                endorseOptions: () => ({ deadline: Date.now() + 60000 }),
                submitOptions: () => ({ deadline: Date.now() + 60000 }),
                commitStatusOptions: () => ({ deadline: Date.now() + 120000 })
            });
            
            // Get network and contract
            const network = this.gateway.getNetwork(CHANNEL_NAME);
            this.contract = network.getContract(CHAINCODE_NAME);
            
            this.connected = true;
            logger.info(`✓ ${this.org} (${this.mspId}) connected successfully`);
            
            return true;
        } catch (error) {
            logger.error(`Failed to connect ${this.org}:`, error);
            this.connected = false;
            throw error;
        }
    }

    /**
     * Disconnect from the network
     */
    async disconnect() {
        if (this.gateway) {
            this.gateway.close();
        }
        if (this.client) {
            this.client.close();
        }
        this.connected = false;
        logger.info(`${this.org} disconnected`);
    }

    /**
     * Check connection status
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Get MSP ID for this client
     */
    getMspId() {
        return this.mspId;
    }

    // ===========================================================================
    // CHAINCODE TRANSACTION METHODS
    // ===========================================================================

    /**
     * Propose a new anchor
     */
    async proposeAnchor(assetId, poseSite, qualityMetrics) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] ProposeAnchor: ${assetId}`);
        
        const result = await this.contract.submitTransaction(
            'ProposeAnchor',
            assetId,
            JSON.stringify(poseSite),
            JSON.stringify(qualityMetrics)
        );
        
        return resultToJson(result);
    }

    /**
     * Endorse a pending claim
     */
    async endorseClaim(assetId) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] EndorseClaim: ${assetId}`);
        
        const result = await this.contract.submitTransaction('EndorseClaim', assetId);
        return resultToJson(result);
    }

    /**
     * Reject a pending claim
     */
    async rejectClaim(assetId, reason) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] RejectClaim: ${assetId}`);
        
        const result = await this.contract.submitTransaction('RejectClaim', assetId, reason || '');
        return resultToJson(result);
    }

    /**
     * Initiate anchor revocation
     */
    async revokeAnchor(assetId, reason) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] RevokeAnchor: ${assetId}`);
        
        const result = await this.contract.submitTransaction('RevokeAnchor', assetId, reason || '');
        return resultToJson(result);
    }

    /**
     * Endorse a pending revocation
     */
    async endorseRevoke(assetId) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] EndorseRevoke: ${assetId}`);
        
        const result = await this.contract.submitTransaction('EndorseRevoke', assetId);
        return resultToJson(result);
    }

    /**
     * Reject a pending revocation
     */
    async rejectRevoke(assetId, reason) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        logger.info(`[${this.org}] RejectRevoke: ${assetId}`);
        
        const result = await this.contract.submitTransaction('RejectRevoke', assetId, reason || '');
        return resultToJson(result);
    }

    // ===========================================================================
    // QUERY METHODS
    // ===========================================================================

    /**
     * Get claim by asset ID
     */
    async getClaim(assetId) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetClaim', assetId);
        return resultToJson(result);
    }

    /**
     * Get active anchor by asset ID
     */
    async getActiveAnchor(assetId) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetActiveAnchor', assetId);
        return resultToJson(result);
    }

    /**
     * Get all active anchors
     */
    async getAllActiveAnchors() {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetAllActiveAnchors');
        const parsed = resultToJson(result);
        
        // Ensure we return a proper structure even if empty
        if (!parsed) {
            return { anchors: [], count: 0 };
        }
        
        return parsed;
    }

    /**
     * Get all pending revocations
     */
    async getPendingRevocations() {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetPendingRevocations');
        const parsed = resultToJson(result);
        
        // Ensure we return a proper structure even if empty
        if (!parsed) {
            return { pendingRevocations: [], count: 0 };
        }
        
        return parsed;
    }

    /**
     * Get pending revocations that require this org's action
     */
    async getPendingRevocationsForOrg() {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetPendingRevocationsForOrg');
        const parsed = resultToJson(result);
        
        if (!parsed) {
            return { pendingRevocations: [], count: 0, forOrg: this.mspId };
        }
        
        return parsed;
    }

    /**
     * Get snapshot for SSE clients
     */
    async getSnapshot() {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetSnapshot');
        const parsed = resultToJson(result);
        
        // Ensure we return a proper structure even if empty
        if (!parsed) {
            return { 
                success: true, 
                assets: [], 
                last_event_id: null,
                timestamp: new Date().toISOString()
            };
        }
        
        return parsed;
    }

    /**
     * Get claim history
     */
    async getClaimHistory(assetId) {
        if (!this.connected) {
            throw new Error('Not connected to Fabric network');
        }
        
        const result = await this.contract.evaluateTransaction('GetClaimHistory', assetId);
        const parsed = resultToJson(result);
        
        if (!parsed) {
            return { history: [], count: 0 };
        }
        
        return parsed;
    }
}

module.exports = FabricClient;