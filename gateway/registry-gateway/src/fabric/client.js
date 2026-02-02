// =============================================================================
// Fabric Client - Real Fabric Network Connection
// =============================================================================

const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

let gateway = null;
let contract = null;
let grpcClient = null;

// Helper to convert Uint8Array to string
function uint8ArrayToString(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) {
        return '';
    }
    return new TextDecoder('utf-8').decode(uint8Array);
}

async function initializeFabric() {
    if (config.fabricMock) {
        throw new Error('FABRIC_MOCK=true is disabled. Set FABRIC_MOCK=false for real Fabric.');
    }

    const cryptoPath = config.fabric.cryptoPath;
    const orgPath = path.join(cryptoPath, 'peerOrganizations/org1.example.com');
    const userPath = path.join(orgPath, 'users/Admin@org1.example.com');

    const certPath = path.join(userPath, 'msp/signcerts/Admin@org1.example.com-cert.pem');
    const altCertPath = path.join(userPath, 'msp/signcerts/cert.pem');
    const keyDir = path.join(userPath, 'msp/keystore');
    const tlsCertPath = config.fabric.tlsCertPath || path.join(orgPath, 'peers/peer0.org1.example.com/tls/ca.crt');

    let actualCertPath = certPath;
    if (!fs.existsSync(certPath) && fs.existsSync(altCertPath)) {
        actualCertPath = altCertPath;
    }

    logger.info('Fabric crypto paths:');
    logger.info(`  Cert: ${actualCertPath}`);
    logger.info(`  Key dir: ${keyDir}`);
    logger.info(`  TLS cert: ${tlsCertPath}`);

    if (!fs.existsSync(actualCertPath)) throw new Error(`Certificate not found: ${actualCertPath}`);
    if (!fs.existsSync(keyDir)) throw new Error(`Keystore not found: ${keyDir}`);
    if (config.fabric.tlsEnabled && !fs.existsSync(tlsCertPath)) throw new Error(`TLS cert not found: ${tlsCertPath}`);

    const credentials = fs.readFileSync(actualCertPath);
    const keyFiles = fs.readdirSync(keyDir);
    const keyFile = keyFiles.find(f => f.endsWith('_sk')) || keyFiles[0];
    if (!keyFile) throw new Error(`No private key found in ${keyDir}`);
    const privateKeyPem = fs.readFileSync(path.join(keyDir, keyFile));
    const privateKey = crypto.createPrivateKey(privateKeyPem);

    const peerEndpoint = config.fabric.peerEndpoint;
    logger.info(`Connecting to Fabric peer: ${peerEndpoint} (TLS: ${config.fabric.tlsEnabled})`);

    let grpcCredentials;
    if (config.fabric.tlsEnabled) {
        const tlsCert = fs.readFileSync(tlsCertPath);
        grpcCredentials = grpc.credentials.createSsl(tlsCert);
    } else {
        grpcCredentials = grpc.credentials.createInsecure();
    }

    const grpcOptions = config.fabric.tlsEnabled ? {
        'grpc.ssl_target_name_override': 'peer0.org1.example.com',
        'grpc.default_authority': 'peer0.org1.example.com'
    } : {};

    grpcClient = new grpc.Client(peerEndpoint, grpcCredentials, grpcOptions);

    const identity = { mspId: config.fabric.mspId, credentials };
    const signer = signers.newPrivateKeySigner(privateKey);

    gateway = connect({ client: grpcClient, identity, signer });
    const network = gateway.getNetwork(config.fabric.channelName);
    contract = network.getContract(config.fabric.chaincodeName);

    logger.info('Testing chaincode connection...');
    try {
        const result = await contract.evaluateTransaction('GetConfig');
        const resultStr = uint8ArrayToString(result);
        logger.info('Chaincode connected successfully!');
        logger.info(`Config: ${resultStr}`);
    } catch (err) {
        throw new Error(`Chaincode connection failed: ${err.message}`);
    }

    logger.info('Fabric gateway connected (REAL MODE - TLS)');
}

async function closeFabric() {
    if (gateway) gateway.close();
    if (grpcClient) grpcClient.close();
}

function getContract() {
    if (!contract) throw new Error('Fabric not initialized');
    return contract;
}

function isInMockMode() {
    return false;
}

// =============================================================================
// CHAINCODE OPERATIONS
// =============================================================================

async function proposeAnchor(assetId, payloadHash, payloadPtr, poseSummary, qualitySummary, publisherId) {
    logger.info('proposeAnchor called with:', { assetId, payloadHash, payloadPtr, poseSummary, qualitySummary, publisherId });

    const poseSummaryStr = typeof poseSummary === 'string' ? poseSummary : JSON.stringify(poseSummary);
    const qualitySummaryStr = typeof qualitySummary === 'string' ? qualitySummary : JSON.stringify(qualitySummary);

    const result = await getContract().submitTransaction(
        'ProposeAnchor',
        assetId,
        payloadHash,
        payloadPtr,
        poseSummaryStr,
        qualitySummaryStr,
        publisherId
    );

    const resultStr = uint8ArrayToString(result);
    logger.info('ProposeAnchor result:', resultStr);

    if (!resultStr) {
        throw new Error('Empty response from chaincode');
    }

    return JSON.parse(resultStr);
}

async function endorseAnchor(claimId, endorserId) {
    logger.info('endorseAnchor called with:', { claimId, endorserId });
    const result = await getContract().submitTransaction('EndorseAnchor', claimId, endorserId);
    const resultStr = uint8ArrayToString(result);
    logger.info('EndorseAnchor result:', resultStr);
    return JSON.parse(resultStr);
}

async function rejectClaim(claimId, reason, supervisorId) {
    logger.info('rejectClaim called with:', { claimId, reason, supervisorId });
    const result = await getContract().submitTransaction('RejectClaim', claimId, reason, supervisorId);
    const resultStr = uint8ArrayToString(result);
    logger.info('RejectClaim result:', resultStr);
    return JSON.parse(resultStr);
}

async function reopenClaim(claimId, reason, supervisorId) {
    logger.info('reopenClaim called with:', { claimId, reason, supervisorId });
    const result = await getContract().submitTransaction('ReopenClaim', claimId, reason || '', supervisorId);
    const resultStr = uint8ArrayToString(result);
    logger.info('ReopenClaim result:', resultStr);
    return JSON.parse(resultStr);
}

async function resolveAnchor(assetId) {
    const result = await getContract().evaluateTransaction('ResolveAnchor', assetId);
    const str = uint8ArrayToString(result);
    if (!str || str === 'null' || str === '') {
        return null;
    }
    return JSON.parse(str);
}

async function revokeAnchor(assetId, claimId, reason, supervisorId) {
    logger.info('revokeAnchor called with:', { assetId, claimId, reason, supervisorId });
    const result = await getContract().submitTransaction('RevokeAnchor', assetId, claimId || '', reason, supervisorId);
    const resultStr = uint8ArrayToString(result);
    return JSON.parse(resultStr);
}

async function getClaim(claimId) {
    const result = await getContract().evaluateTransaction('GetClaim', claimId);
    const str = uint8ArrayToString(result);
    if (!str || str === 'null' || str === '') {
        return null;
    }
    return JSON.parse(str);
}

async function listClaims(assetId) {
    const result = await getContract().evaluateTransaction('ListClaims', assetId);
    const str = uint8ArrayToString(result);
    return JSON.parse(str || '[]');
}

async function getClaimHistory(claimId) {
    const result = await getContract().evaluateTransaction('GetClaimHistory', claimId);
    const str = uint8ArrayToString(result);
    return JSON.parse(str || '[]');
}

async function getAuditLog(assetId, limit) {
    const result = await getContract().evaluateTransaction('GetAuditLog', assetId || '', String(limit || 100));
    const str = uint8ArrayToString(result);
    return JSON.parse(str || '[]');
}

module.exports = {
    initializeFabric,
    closeFabric,
    getContract,
    isInMockMode,
    proposeAnchor,
    endorseAnchor,
    rejectClaim,
    reopenClaim,
    resolveAnchor,
    revokeAnchor,
    getClaim,
    listClaims,
    getClaimHistory,
    getAuditLog
};
