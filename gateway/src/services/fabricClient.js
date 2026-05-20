/**
 * ==============================================================================
 * fabricClient.js - Hyperledger Fabric Gateway Client
 *
 * Each instance connects as ONE organization identity.
 * Added: subscribeToEvents() for ledger-driven SSE.
 * v2.0: Added annotation lifecycle methods.
 * v2.1: All annotation methods now require intentType parameter (multi-card).
 * ==============================================================================
 */

const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Configuration paths
const PROJECT_DIR = path.resolve(__dirname, '../../..');
const NETWORK_DIR = path.join(PROJECT_DIR, 'network');
const CRYPTO_DIR = path.join(NETWORK_DIR, 'crypto-config');

// Channel and chaincode
const CHANNEL_NAME = 'anchorchannel';
const CHAINCODE_NAME = 'anchor-registry';
const AUDIT_CHAINCODE_NAME = 'skill-audit-registry';

/**
 * Helper function to convert result to JSON
 */
function resultToJson(result) {
    if (!result) return null;

    let str;
    if (Buffer.isBuffer(result)) {
        str = result.toString('utf8');
    } else if (result instanceof Uint8Array) {
        str = Buffer.from(result).toString('utf8');
    } else if (typeof result === 'string') {
        str = result;
    } else {
        str = String(result);
    }

    if (!str || str.trim() === '') return null;

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
        this.network = null;
        this.contract = null;
        this.auditContract = null;
        this.client = null;
        this.connected = false;
        this.eventIterator = null;
    }

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

    async loadTlsCredentials() {
        const paths = this.getPaths();
        if (!fs.existsSync(paths.tlsCertPath)) {
            throw new Error(`TLS cert not found: ${paths.tlsCertPath}`);
        }
        const tlsCert = fs.readFileSync(paths.tlsCertPath);
        return grpc.credentials.createSsl(tlsCert);
    }

    async loadIdentity() {
        const paths = this.getPaths();

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

    async connect() {
        try {
            const paths = this.getPaths();
            logger.info(`Connecting ${this.org} client to ${paths.peerEndpoint}...`);

            const tlsCredentials = await this.loadTlsCredentials();
            const { certificate, privateKeyPem } = await this.loadIdentity();

            this.client = new grpc.Client(
                paths.peerEndpoint,
                tlsCredentials,
                { 'grpc.ssl_target_name_override': paths.peerHost }
            );

            const privateKey = crypto.createPrivateKey(privateKeyPem);
            const signer = signers.newPrivateKeySigner(privateKey);

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

            this.network = this.gateway.getNetwork(CHANNEL_NAME);
            this.contract = this.network.getContract(CHAINCODE_NAME);
            this.auditContract = this.network.getContract(AUDIT_CHAINCODE_NAME);
            logger.info(`[${this.org}] ✓ skill-audit-registry contract handle obtained`);

            this.connected = true;
            logger.info(`✓ ${this.org} (${this.mspId}) connected successfully`);
            return true;
        } catch (error) {
            logger.error(`Failed to connect ${this.org}:`, error);
            this.connected = false;
            throw error;
        }
    }

    async disconnect() {
        if (this.eventIterator) {
            try { this.eventIterator.close(); } catch (_) { /* ignore */ }
        }
        if (this.gateway) {
            this.gateway.close();
        }
        if (this.client) {
            this.client.close();
        }
        this.connected = false;
        logger.info(`${this.org} disconnected`);
    }

    isConnected() { return this.connected; }
    getMspId() { return this.mspId; }
    getOrg() { return this.org; }

    // =========================================================================
    // CHAINCODE EVENT SUBSCRIPTION
    // =========================================================================

    async subscribeToEvents(callback) {
        if (!this.connected || !this.network) {
            throw new Error('Must connect() before subscribing to events');
        }

        logger.info(`[${this.org}] Subscribing to chaincode events on '${CHAINCODE_NAME}'...`);

        this.eventIterator = await this.network.getChaincodeEvents(CHAINCODE_NAME, {
            startBlock: undefined
        });

        logger.info(`[${this.org}] ✓ Chaincode event subscription active`);

        (async () => {
            try {
                for await (const event of this.eventIterator) {
                    try {
                        const payload = JSON.parse(
                            Buffer.from(event.payload).toString('utf8')
                        );
                        callback(
                            event.eventName,
                            payload,
                            event.transactionId,
                            event.blockNumber
                        );
                    } catch (parseErr) {
                        logger.error(`[${this.org}] Failed to parse chaincode event payload:`, parseErr);
                    }
                }
            } catch (err) {
                if (this.connected) {
                    logger.error(`[${this.org}] Chaincode event stream error: ${err.message}`);
                }
            }
        })();
    }

    // =========================================================================
    // ANCHOR CHAINCODE TRANSACTION METHODS
    // =========================================================================

    async proposeAnchor(assetId, poseSite, qualityMetrics) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] ProposeAnchor: ${assetId}`);
        const result = await this.contract.submitTransaction(
            'ProposeAnchor', assetId,
            JSON.stringify(poseSite), JSON.stringify(qualityMetrics)
        );
        return resultToJson(result);
    }

    async endorseClaim(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] EndorseClaim: ${assetId}`);
        const result = await this.contract.submitTransaction('EndorseClaim', assetId);
        return resultToJson(result);
    }

    async rejectClaim(assetId, reason) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] RejectClaim: ${assetId}`);
        const result = await this.contract.submitTransaction('RejectClaim', assetId, reason || '');
        return resultToJson(result);
    }

    async revokeAnchor(assetId, reason) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] RevokeAnchor: ${assetId}`);
        const result = await this.contract.submitTransaction('RevokeAnchor', assetId, reason || '');
        return resultToJson(result);
    }

    async endorseRevoke(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] EndorseRevoke: ${assetId}`);
        const result = await this.contract.submitTransaction('EndorseRevoke', assetId);
        return resultToJson(result);
    }

    async rejectRevoke(assetId, reason) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] RejectRevoke: ${assetId}`);
        const result = await this.contract.submitTransaction('RejectRevoke', assetId, reason || '');
        return resultToJson(result);
    }

    // =========================================================================
    // ANCHOR QUERY METHODS
    // =========================================================================

    async getClaim(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetClaim', assetId);
        return resultToJson(result);
    }

    async getActiveAnchor(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetActiveAnchor', assetId);
        return resultToJson(result);
    }

    async getAllActiveAnchors() {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetAllActiveAnchors');
        const parsed = resultToJson(result);
        if (!parsed) return { anchors: [], count: 0 };
        return parsed;
    }

    async getPendingRevocations() {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetPendingRevocations');
        const parsed = resultToJson(result);
        if (!parsed) return { pendingRevocations: [], count: 0 };
        return parsed;
    }

    async getPendingRevocationsForOrg() {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetPendingRevocationsForOrg');
        const parsed = resultToJson(result);
        if (!parsed) return { pendingRevocations: [], count: 0, forOrg: this.mspId };
        return parsed;
    }

    async getSnapshot() {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetSnapshot');
        const parsed = resultToJson(result);
        if (!parsed) {
            return {
                success: true, assets: [], annotations: [],
                last_event_id: null,
                timestamp: new Date().toISOString()
            };
        }
        return parsed;
    }

    async getClaimHistory(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetClaimHistory', assetId);
        const parsed = resultToJson(result);
        if (!parsed) return { history: [], count: 0 };
        return parsed;
    }

    // =========================================================================
    // ANNOTATION CHAINCODE TRANSACTION METHODS (v2.1: intentType added)
    // =========================================================================

    async proposeAnnotation(assetId, contentText, tier, classContext, generatorId, promptHash, intentType) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] ProposeAnnotation: ${assetId} (tier=${tier}, intentType=${intentType})`);
        const result = await this.contract.submitTransaction(
            'ProposeAnnotation',
            assetId,
            contentText,
            tier,
            JSON.stringify(classContext),
            generatorId,
            promptHash,
            intentType
        );
        return resultToJson(result);
    }

    async endorseAnnotation(assetId, intentType) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] EndorseAnnotation: ${assetId}:${intentType}`);
        const result = await this.contract.submitTransaction('EndorseAnnotation', assetId, intentType);
        return resultToJson(result);
    }

    async rejectAnnotation(assetId, intentType, reason) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] RejectAnnotation: ${assetId}:${intentType}`);
        const result = await this.contract.submitTransaction('RejectAnnotation', assetId, intentType, reason || '');
        return resultToJson(result);
    }

    async revokeAnnotation(assetId, intentType, reason) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        logger.info(`[${this.org}] RevokeAnnotation: ${assetId}:${intentType}`);
        const result = await this.contract.submitTransaction('RevokeAnnotation', assetId, intentType, reason || '');
        return resultToJson(result);
    }

    // =========================================================================
    // ANNOTATION QUERY METHODS (v2.1: intentType added)
    // =========================================================================

    async getAnnotation(assetId, intentType) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetAnnotation', assetId, intentType);
        return resultToJson(result);
    }

    async getActiveAnnotation(assetId, intentType) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetActiveAnnotation', assetId, intentType);
        return resultToJson(result);
    }

    async getAllActiveAnnotations() {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetAllActiveAnnotations');
        const parsed = resultToJson(result);
        if (!parsed) return { annotations: [], count: 0 };
        return parsed;
    }

    async getActiveAnnotationsForAsset(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetActiveAnnotationsForAsset', assetId);
        const parsed = resultToJson(result);
        if (!parsed) return { assetId, annotations: [], count: 0 };
        return parsed;
    }

    async getAnnotationHistory(assetId, intentType) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        const result = await this.contract.evaluateTransaction('GetAnnotationHistory', assetId, intentType);
        const parsed = resultToJson(result);
        if (!parsed) return { history: [], count: 0 };
        return parsed;
    }
    // =========================================================================
    // SKILL-AUDIT-REGISTRY METHODS (Phase 4)
    // =========================================================================

    /**
     * Record a skill decision envelope on-chain. The chaincode validates
     * the envelope (required fields, hash formats, caller-msp == submittingOrg)
     * and refuses duplicates. Returns the persisted record's identifiers.
     *
     * @param {object} envelope - audit envelope built by the gateway
     * @returns {Promise<object>} { success, decision_id, tx_id, state, recorded_at, event_id }
     */
    async recordSkillDecision(envelope) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound (connect first)');
        logger.info(`[${this.org}] RecordSkillDecision: ${envelope.decisionId}`);
        const result = await this.auditContract.submitTransaction(
            'RecordSkillDecision',
            JSON.stringify(envelope)
        );
        return resultToJson(result);
    }

    /**
     * After a successful anchor-registry invocation, link the audit record
     * to the anchor tx id (and the final state the anchor reached).
     *
     * Idempotent: re-linking the same tx is OK; linking a different tx fails.
     *
     * @param {string} decisionId
     * @param {string} anchorTxId
     * @param {string} finalState   - e.g. 'PROPOSED', 'ENDORSED_ORG1', 'ACTIVE'
     * @param {string} assetId      - for the per-anchor decision index
     */
    async linkAnchorTx(decisionId, anchorTxId, finalState, assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        logger.info(`[${this.org}] LinkAnchorTx: ${decisionId} -> ${anchorTxId}`);
        const result = await this.auditContract.submitTransaction(
            'LinkAnchorTx',
            decisionId,
            anchorTxId,
            finalState,
            assetId || ''
        );
        return resultToJson(result);
    }

    /**
     * Read-only: fetch a single audit record by decisionId.
     */
    async querySkillDecision(decisionId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'QuerySkillDecision',
            decisionId
        );
        return resultToJson(result);
    }

    /**
     * Read-only: full causal chain (decision + all linked events) for replay.
     */
    async replayDecision(decisionId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'ReplayDecision',
            decisionId
        );
        return resultToJson(result);
    }

    /**
     * Read-only: all decisionIds linked to an asset.
     */
    async listDecisionsByAnchor(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'ListDecisionsByAnchor',
            assetId
        );
        return resultToJson(result);
    }

}

module.exports = FabricClient;