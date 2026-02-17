/**
 * ==============================================================================
 * experimentLogger.js - Experiment-grade JSONL request logging
 * 
 * PHASE 1: Logs every request to benchmarked endpoints as one JSON line.
 * Output: experiments/runs/<run_id>/gateway_requests.jsonl
 * 
 * Timing uses process.hrtime.bigint() for monotonic nanosecond precision.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Directory for experiment logs (relative to gateway/)
const EXPERIMENTS_BASE = path.resolve(__dirname, '../../experiments/runs');

// Endpoints to instrument
const INSTRUMENTED_ENDPOINTS = new Set([
    'POST /claims/propose',
    'POST /claims/endorse',
    'POST /admin/endorse-claim',
    'GET /events/snapshot',
    'GET /admin/anchors',
    'GET /health'
]);

// Cache open file descriptors per run_id to avoid repeated open/close
const openStreams = new Map();

/**
 * Get or create a write stream for a given run_id
 */
function getStream(runId) {
    if (openStreams.has(runId)) {
        return openStreams.get(runId);
    }

    const dir = path.join(EXPERIMENTS_BASE, runId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, 'gateway_requests.jsonl');
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    stream.on('error', (err) => {
        logger.error(`[ExperimentLogger] Write error for run ${runId}: ${err.message}`);
    });

    openStreams.set(runId, stream);
    logger.info(`[ExperimentLogger] Opened log file: ${filePath}`);
    return stream;
}

/**
 * Close all open streams (call on shutdown)
 */
function closeAllStreams() {
    for (const [runId, stream] of openStreams) {
        stream.end();
    }
    openStreams.clear();
}

/**
 * Express middleware that logs requests to instrumented endpoints.
 * 
 * Extracts run_id and req_id from:
 *   - POST body: { run_id, req_id, ... }
 *   - GET query: ?run_id=...&req_id=...
 *   - Headers: x-run-id, x-req-id, x-lane
 */
function experimentLogMiddleware(req, res, next) {
    const routeKey = `${req.method} ${req.path}`;

    // Only instrument specific endpoints
    if (!INSTRUMENTED_ENDPOINTS.has(routeKey)) {
        return next();
    }

    // Extract experiment metadata
    const runId = req.body?.run_id || req.query?.run_id || req.headers['x-run-id'] || 'adhoc';
    const reqId = req.body?.req_id || req.query?.req_id || req.headers['x-req-id'] || null;
    const lane = req.body?.lane || req.query?.lane || req.headers['x-lane'] || 'unknown';
    const org = req.headers['x-org-id'] || req.orgId || 'org1';

    // Determine asset_id
    let assetId = null;
    if (req.body?.asset_id) {
        assetId = req.body.asset_id;
    }

    // Monotonic timing
    const t0 = process.hrtime.bigint();
    const tRecvMs = Date.now();

    // Capture request payload size
    const payloadBytes = req.headers['content-length']
        ? parseInt(req.headers['content-length'], 10)
        : (req.body ? Buffer.byteLength(JSON.stringify(req.body), 'utf8') : 0);

    // Intercept response to capture timing and status
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        const t1 = process.hrtime.bigint();
        const tRespMs = Date.now();
        const durationMs = Number(t1 - t0) / 1e6; // nanoseconds → milliseconds

        // Determine success/fail
        const httpStatus = res.statusCode;
        const isOk = httpStatus >= 200 && httpStatus < 300;
        const status = isOk ? 'ok' : 'fail';
        const errorMsg = (!isOk && body?.error) ? body.error : null;

        // Extract tx_id from response if present
        const txId = body?.tx_id || body?.claim_id || null;

        // Calculate response size
        const responseStr = JSON.stringify(body);
        const responseBytes = Buffer.byteLength(responseStr, 'utf8');

        // Build log entry
        const entry = {
            run_id: runId,
            lane: lane,
            op: routeKey,
            org: org,
            req_id: reqId,
            asset_id: assetId,
            t_recv_ms: tRecvMs,
            t_resp_ms: tRespMs,
            duration_ms: parseFloat(durationMs.toFixed(3)),
            status: status,
            error: errorMsg,
            http_status: httpStatus,
            payload_bytes: payloadBytes,
            response_bytes: responseBytes,
            tx_id: txId
        };

        // Write JSONL line
        try {
            const stream = getStream(runId);
            stream.write(JSON.stringify(entry) + '\n');
        } catch (err) {
            logger.error(`[ExperimentLogger] Failed to write log: ${err.message}`);
        }

        // Call original res.json
        return originalJson(body);
    };

    next();
}

// Cleanup on process exit
process.on('SIGTERM', closeAllStreams);
process.on('SIGINT', closeAllStreams);
process.on('exit', closeAllStreams);

module.exports = {
    experimentLogMiddleware,
    closeAllStreams
};