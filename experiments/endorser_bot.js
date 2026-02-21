#!/usr/bin/env node
/**
 * ==============================================================================
 * endorser_bot.js - Auto-endorsement automation for experiment runs
 *
 * SECURITY FIX: Uses separate gateway URLs per org (no x-org-id header).
 * Each gateway holds exactly one org identity, so the bot must POST
 * endorsements to the correct gateway for each org.
 *
 * Mode 1 (two-step): Endorses as org1 (via gateway_org1) then org2
 *                     (via gateway_org2) for every new proposal
 * Mode 2 (single):   Endorses as one specified org only
 *
 * USAGE:
 *   # Two gateways (recommended):
 *   node endorser_bot.js \
 *     --gateway_org1 http://localhost:3000 \
 *     --gateway_org2 http://localhost:3001 \
 *     --run_id test1 --mode two-step
 *
 *   # Backward compat (auto-derives org2 port = org1 port + 1):
 *   node endorser_bot.js --gateway http://localhost:3000 \
 *     --run_id test1 --mode two-step
 *
 *   # Single org:
 *   node endorser_bot.js --gateway_org2 http://localhost:3001 \
 *     --run_id test1 --mode single --org org2
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        gatewayOrg1: null,
        gatewayOrg2: null,
        sseGateway: null,           // which gateway to connect SSE to
        runId: 'adhoc',
        mode: 'two-step',           // 'two-step' or 'single'
        org: 'org2',                // for single mode
        delayOrg1Ms: 0,
        delayOrg2Ms: 0,
        delayMs: 0,                 // for single mode
        maxRetries: 3,
        retryBackoffMs: 1000,
        maxInflight: 10,            // FIX #5: concurrency limit
        verbose: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--gateway':
                // Backward compat: auto-derive org2 = port+1
                config.gatewayOrg1 = args[++i];
                break;
            case '--gateway_org1':    config.gatewayOrg1 = args[++i]; break;
            case '--gateway_org2':    config.gatewayOrg2 = args[++i]; break;
            case '--sse_gateway':     config.sseGateway = args[++i]; break;
            case '--run_id':          config.runId = args[++i]; break;
            case '--mode':            config.mode = args[++i]; break;
            case '--org':             config.org = args[++i]; break;
            case '--delay_org1_ms':   config.delayOrg1Ms = parseInt(args[++i], 10); break;
            case '--delay_org2_ms':   config.delayOrg2Ms = parseInt(args[++i], 10); break;
            case '--delay_ms':        config.delayMs = parseInt(args[++i], 10); break;
            case '--max_retries':     config.maxRetries = parseInt(args[++i], 10); break;
            case '--max_inflight':    config.maxInflight = parseInt(args[++i], 10); break;
            case '--verbose':         config.verbose = true; break;
            case '--help':
                console.log(`
Usage: node endorser_bot.js [options]

Options:
  --gateway_org1 <url>    Org1 gateway URL (default: http://localhost:3000)
  --gateway_org2 <url>    Org2 gateway URL (default: http://localhost:3001)
  --gateway <url>         Shorthand: sets org1 URL, auto-derives org2 (port+1)
  --sse_gateway <url>     Which gateway to connect SSE to (default: gateway_org1)
  --run_id <id>           Experiment run ID (default: adhoc)
  --mode <mode>           'two-step' or 'single' (default: two-step)
  --org <org>             For single mode: org1 or org2 (default: org2)
  --delay_org1_ms <ms>    Delay before org1 endorsement (default: 0)
  --delay_org2_ms <ms>    Delay before org2 endorsement (default: 0)
  --delay_ms <ms>         For single mode: delay before endorsement (default: 0)
  --max_retries <n>       Max retry attempts (default: 3)
  --max_inflight <n>     Max concurrent endorsement batches (default: 10)
  --verbose               Enable verbose logging
  --help                  Show this help
`);
                process.exit(0);
        }
    }

    // Defaults and auto-derivation
    if (!config.gatewayOrg1) config.gatewayOrg1 = 'http://localhost:3000';

    if (!config.gatewayOrg2) {
        // Auto-derive: increment port by 1
        try {
            const url = new URL(config.gatewayOrg1);
            const port = parseInt(url.port || '3000', 10);
            url.port = String(port + 1);
            config.gatewayOrg2 = url.toString().replace(/\/$/, '');
        } catch (_) {
            config.gatewayOrg2 = 'http://localhost:3001';
        }
    }

    if (!config.sseGateway) config.sseGateway = config.gatewayOrg1;

    return config;
}

// ============================================================================
// LOGGING
// ============================================================================

const config = parseArgs();

const logDir = path.join(__dirname, 'runs', config.runId);
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'endorser_actions.jsonl');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function logAction(entry) {
    const line = JSON.stringify({
        run_id: config.runId,
        timestamp: new Date().toISOString(),
        timestamp_ms: Date.now(),
        ...entry
    });
    logStream.write(line + '\n');
    if (config.verbose) {
        console.log(`  [LOG] ${line}`);
    }
}

function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] ERROR: ${msg}`);
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

const endorsedAssets = {
    org1: new Set(),
    org2: new Set()
};

function alreadyEndorsed(assetId, org) {
    return endorsedAssets[org]?.has(assetId) || false;
}

function markEndorsed(assetId, org) {
    if (!endorsedAssets[org]) endorsedAssets[org] = new Set();
    endorsedAssets[org].add(assetId);
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function httpRequest(method, urlStr, body, headers) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const transport = url.protocol === 'https:' ? https : http;

        const bodyStr = body ? JSON.stringify(body) : null;

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
            },
            timeout: 30000
        };

        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ============================================================================
// GATEWAY ROUTING
// ============================================================================

/**
 * Return the correct gateway URL for a given org.
 */
function gatewayForOrg(org) {
    return org === 'org1' ? config.gatewayOrg1 : config.gatewayOrg2;
}

// ============================================================================
// ENDORSEMENT LOGIC
// ============================================================================

async function endorseAsOrg(assetId, org, delayMs, reqId) {
    if (alreadyEndorsed(assetId, org)) {
        log(`  [${org}] Already endorsed ${assetId}, skipping`);
        return { success: true, skipped: true };
    }

    if (delayMs > 0) {
        if (config.verbose) log(`  [${org}] Waiting ${delayMs}ms before endorsing ${assetId}`);
        await sleep(delayMs);
    }

    const gateway = gatewayForOrg(org);
    const startMs = Date.now();

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            const result = await httpRequest(
                'POST',
                `${gateway}/claims/endorse`,
                {
                    asset_id: assetId,
                    req_id: reqId || null,
                    run_id: config.runId
                },
                {}  // No x-org-id header — gateway identity is fixed
            );

            const durationMs = Date.now() - startMs;

            if (result.status >= 200 && result.status < 300 && result.body?.success) {
                markEndorsed(assetId, org);

                logAction({
                    action: 'endorse',
                    asset_id: assetId,
                    req_id: reqId,
                    org: org,
                    gateway: gateway,
                    delay_ms: delayMs,
                    duration_ms: durationMs,
                    attempt: attempt,
                    status: 'ok',
                    is_fully_endorsed: result.body.is_fully_endorsed || false,
                    new_state: result.body.state || null,
                    error: null
                });

                log(`  ✓ [${org}] Endorsed ${assetId} in ${durationMs}ms via ${gateway}` +
                    (result.body.is_fully_endorsed ? ' → ACTIVATED' : ''));

                return { success: true, result: result.body };
            } else {
                const errMsg = result.body?.error || `HTTP ${result.status}`;

                logAction({
                    action: 'endorse',
                    asset_id: assetId,
                    req_id: reqId,
                    org: org,
                    gateway: gateway,
                    delay_ms: delayMs,
                    duration_ms: durationMs,
                    attempt: attempt,
                    status: 'fail',
                    error: errMsg
                });

                if (attempt < config.maxRetries) {
                    const backoff = config.retryBackoffMs * attempt;
                    logError(`[${org}] Endorse failed for ${assetId}: ${errMsg}. Retry in ${backoff}ms`);
                    await sleep(backoff);
                } else {
                    logError(`[${org}] Endorse failed for ${assetId} after ${attempt} attempts: ${errMsg}`);
                    return { success: false, error: errMsg };
                }
            }
        } catch (err) {
            const durationMs = Date.now() - startMs;
            logAction({
                action: 'endorse',
                asset_id: assetId,
                req_id: reqId,
                org: org,
                gateway: gateway,
                delay_ms: delayMs,
                duration_ms: durationMs,
                attempt: attempt,
                status: 'error',
                error: err.message
            });

            if (attempt < config.maxRetries) {
                const backoff = config.retryBackoffMs * attempt;
                logError(`[${org}] Network error endorsing ${assetId}: ${err.message}. Retry in ${backoff}ms`);
                await sleep(backoff);
            } else {
                logError(`[${org}] Network error endorsing ${assetId} after ${attempt} attempts: ${err.message}`);
                return { success: false, error: err.message };
            }
        }
    }
}

async function handleProposal(assetId, reqId) {
    log(`→ New proposal detected: ${assetId}`);

    if (config.mode === 'two-step') {
        const r1 = await endorseAsOrg(assetId, 'org1', config.delayOrg1Ms, reqId);
        if (!r1?.success) {
            logError(`Org1 endorsement failed for ${assetId}, skipping org2`);
            return;
        }
        await endorseAsOrg(assetId, 'org2', config.delayOrg2Ms, reqId);
    } else if (config.mode === 'single') {
        await endorseAsOrg(assetId, config.org, config.delayMs, reqId);
    }
}

// ============================================================================
// FIX #5: CONCURRENCY-LIMITED QUEUE
// ============================================================================
// Without this, every SSE CLAIM_PROPOSED event fires handleProposal immediately
// and unbounded. At rate=50, that's 50 concurrent handleProposal coroutines,
// each doing 2 sequential endorsements = 100 concurrent HTTP requests, which
// causes MVCC conflict storms and chaotic saturation behavior.

const endorsementQueue = [];
let activeInflight = 0;
let totalQueued = 0;
let totalProcessed = 0;

function enqueueProposal(assetId, reqId) {
    endorsementQueue.push({ assetId, reqId, enqueuedAt: Date.now() });
    totalQueued++;
    drainQueue();
}

function drainQueue() {
    while (endorsementQueue.length > 0 && activeInflight < config.maxInflight) {
        const item = endorsementQueue.shift();
        activeInflight++;
        handleProposal(item.assetId, item.reqId)
            .catch(err => logError(`handleProposal error for ${item.assetId}: ${err.message}`))
            .finally(() => {
                activeInflight--;
                totalProcessed++;
                drainQueue();  // process next in queue
            });
    }
}

// Periodic queue depth logging (every 5s if queue is non-empty)
setInterval(() => {
    if (endorsementQueue.length > 0 || activeInflight > 0) {
        log(`[queue] depth=${endorsementQueue.length} inflight=${activeInflight} processed=${totalProcessed} total_queued=${totalQueued}`);
        logAction({
            action: 'queue_status',
            queue_depth: endorsementQueue.length,
            active_inflight: activeInflight,
            total_processed: totalProcessed,
            total_queued: totalQueued
        });
    }
}, 5000);

// ============================================================================
// SSE CLIENT
// ============================================================================

function connectSSE() {
    const url = new URL(`${config.sseGateway}/events/stream`);
    const transport = url.protocol === 'https:' ? https : http;

    log(`Connecting to SSE: ${url.href}`);

    const req = transport.get(url.href, {
        headers: { 'Accept': 'text/event-stream' },
        timeout: 0
    }, (res) => {
        if (res.statusCode !== 200) {
            logError(`SSE connection failed: HTTP ${res.statusCode}`);
            scheduleReconnect();
            return;
        }

        log('✓ SSE connected');
        logAction({ action: 'sse_connected', status: 'ok', sse_gateway: config.sseGateway });

        let buffer = '';

        res.on('data', (chunk) => {
            buffer += chunk.toString();

            const messages = buffer.split('\n\n');
            buffer = messages.pop();

            for (const msg of messages) {
                if (!msg.trim()) continue;
                parseSseMessage(msg);
            }
        });

        res.on('end', () => {
            log('SSE connection closed by server');
            logAction({ action: 'sse_disconnected', status: 'server_close' });
            scheduleReconnect();
        });

        res.on('error', (err) => {
            logError(`SSE stream error: ${err.message}`);
            logAction({ action: 'sse_error', error: err.message });
            scheduleReconnect();
        });
    });

    req.on('error', (err) => {
        logError(`SSE connection error: ${err.message}`);
        scheduleReconnect();
    });
}

let reconnectTimer = null;
let reconnectAttempt = 0;

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
    log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
    }, delay);
}

function parseSseMessage(raw) {
    let eventType = null;
    let data = null;

    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
            try {
                data = JSON.parse(line.slice(6));
            } catch (e) {
                data = line.slice(6);
            }
        }
    }

    if (!eventType || !data) return;

    reconnectAttempt = 0;

    if (config.verbose) {
        log(`SSE event: ${eventType} ${data.asset_id || data.assetId || ''}`);
    }

    if (eventType === 'CLAIM_PROPOSED') {
        const assetId = data.asset_id || data.assetId;
        const reqId = data.req_id || null;
        if (assetId) {
            enqueueProposal(assetId, reqId);
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Endorser Bot - Auto-endorsement for experiment runs        ║');
    console.log('║  (Two-gateway mode: no org impersonation)                   ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Gateway Org1:  ${config.gatewayOrg1}`);
    console.log(`  Gateway Org2:  ${config.gatewayOrg2}`);
    console.log(`  SSE Gateway:   ${config.sseGateway}`);
    console.log(`  Run ID:        ${config.runId}`);
    console.log(`  Mode:          ${config.mode}`);
    if (config.mode === 'two-step') {
        console.log(`  Delay Org1:    ${config.delayOrg1Ms}ms`);
        console.log(`  Delay Org2:    ${config.delayOrg2Ms}ms`);
    } else {
        console.log(`  Org:           ${config.org}`);
        console.log(`  Delay:         ${config.delayMs}ms`);
    }
    console.log(`  Max inflight:  ${config.maxInflight}`);
    console.log(`  Log file:      ${logPath}`);
    console.log('');

    // Health check both gateways
    for (const [label, url] of [['Org1', config.gatewayOrg1], ['Org2', config.gatewayOrg2]]) {
        try {
            const health = await httpRequest('GET', `${url}/health`);
            if (health.status === 200) {
                log(`✓ ${label} gateway healthy (org=${health.body.org}, msp=${health.body.mspId}, connected=${health.body.connected})`);
            } else {
                logError(`${label} gateway health check failed: HTTP ${health.status}`);
            }
        } catch (err) {
            logError(`Cannot reach ${label} gateway at ${url}: ${err.message}`);
            if (config.mode === 'two-step' || config.org === label.toLowerCase()) {
                logError('  → This gateway is required. Make sure it is running.');
            }
        }
    }

    logAction({
        action: 'bot_started',
        mode: config.mode,
        org: config.mode === 'single' ? config.org : 'both',
        gateway_org1: config.gatewayOrg1,
        gateway_org2: config.gatewayOrg2,
        sse_gateway: config.sseGateway,
        delay_org1_ms: config.delayOrg1Ms,
        delay_org2_ms: config.delayOrg2Ms
    });

    connectSSE();

    process.on('SIGINT', () => {
        log(`Shutting down... (processed=${totalProcessed}, queued_remaining=${endorsementQueue.length})`);
        logAction({ action: 'bot_stopped', assets_endorsed_org1: endorsedAssets.org1.size, assets_endorsed_org2: endorsedAssets.org2.size, total_processed: totalProcessed, queue_remaining: endorsementQueue.length });
        logStream.end(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
        log(`Shutting down... (processed=${totalProcessed}, queued_remaining=${endorsementQueue.length})`);
        logAction({ action: 'bot_stopped', assets_endorsed_org1: endorsedAssets.org1.size, assets_endorsed_org2: endorsedAssets.org2.size, total_processed: totalProcessed, queue_remaining: endorsementQueue.length });
        logStream.end(() => process.exit(0));
    });
}

main().catch(err => {
    logError(`Fatal: ${err.message}`);
    process.exit(1);
});