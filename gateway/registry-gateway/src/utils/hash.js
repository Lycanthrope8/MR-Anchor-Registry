const crypto = require('crypto');
const canonicalize = require('canonicalize');

function hashPayload(payload) {
    const canonical = canonicalize(payload);
    return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function verifyPayloadHash(payload, expectedHash) {
    return hashPayload(payload) === expectedHash;
}

module.exports = { hashPayload, verifyPayloadHash };
