#!/usr/bin/env node
/**
 * ==============================================================================
 * dataset_scaling.js — Experiment 2: Dataset Scaling (Read-Path)
 *
 * Pre-fills N anchors to ACTIVE state, then benchmarks read endpoints
 * (snapshot, all-anchors) at configurable tier checkpoints.
 *
 * Combines pre-filling and benchmarking in a single run so the read
 * measurements happen at exact anchor counts.
 *
 * REQUIRES: endorser_bot.js running in two-step mode
 *
 * USAGE:
 *   # Full experiment — pre-fill to each tier and benchmark reads:
 *   node dataset_scaling.js --gateway http://localhost:3000 \
 *       --run_id exp2-trial1 --tiers "10,100,500,1000" --reads 20
 *
 *   # Quick test:
 *   node dataset_scaling.js --gateway http://localhost:3000 \
 *       --run_id exp2-quick --tiers "5,10,20" --reads 5
 *
 *   # Benchmark reads only (ledger already has anchors):
 *   node dataset_scaling.js --gateway http://localhost:3000 \
 *       --run_id exp2-readonly --mode read-only --reads 20
 *
 * OUTPUTS (in experiments/runs/<run_id>/):
 *   dataset_scaling_summary.json  — per-tier aggregate statistics
 *   dataset_scaling_fill.jsonl    — per-proposal detail during fill
 *   dataset_scaling_reads.jsonl   — per-read detail log
 *   dataset_scaling_config.json   — config for reproducibility
 *
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const now = Date.now();
    const config = {
        gateway: 'http://localhost:3000',
        runId: `exp2-${now}`,
        tiers: [10, 100, 500, 1000],
        reads: 20,
        mode: 'fill-and-read',    // 'fill-and-read' or 'read-only'
        fillRate: 5,              // proposals/sec during fill phase
        prefix: `ds-${now}-`,
        timeout: 30000,
        activationTimeout: 180,   // seconds to wait for all activations per tier
        verbose: false
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--gateway':       config.gateway = args[++i]; break;
            case '--run_id':        config.runId = args[++i]; break;
            case '--tiers':         config.tiers = args[++i].split(',').map(Number); break;
            case '--reads':         config.reads = parseInt(args[++i], 10); break;
            case '--mode':          config.mode = args[++i]; break;
            case '--fill_rate':     config.fillRate = parseFloat(args[++i]); break;
            case '--prefix':        config.prefix = args[++i]; break;
            case '--timeout':       config.timeout = parseInt(args[++i], 10); break;
            case '--activation_timeout': config.activationTimeout = parseInt(args[++i], 10); break;
            case '--verbose':       config.verbose = true; break;
            case '--help':
                console.log(`
Usage: node dataset_scaling.js [options]

  --gateway <url>             Gateway URL (default: http://localhost:3000)
  --run_id <id>               Run identifier
  --tiers <list>              Comma-separated anchor counts (default: 10,100,500,1000)
  --reads <n>                 Read iterations per endpoint per tier (default: 20)
  --mode <mode>               'fill-and-read' or 'read-only' (default: fill-and-read)
  --fill_rate <ops/sec>       Proposal rate during filling (default: 5)
  --prefix <str>              Asset ID prefix for new anchors
  --timeout <ms>              HTTP timeout (default: 30000)
  --activation_timeout <sec>  Max wait for activations per tier (default: 180)
  --verbose                   Log every request
  --help                      Show this help
`);
                process.exit(0);
        }
    }
    // Sort tiers ascending
    config.tiers.sort((a, b) => a - b);
    return config;
}

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function logWarn(msg) { console.warn(`[${ts()}] WARN: ${msg}`); }
function logError(msg) { console.error(`[${ts()}] ERROR: ${msg}`); }

function percentile(sorted, p) {
    if (sorted.length === 0) return NaN;
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}

function mean(arr) {
    return arr.length === 0 ? NaN : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
    if (arr.length < 2) return NaN;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function stats(arr) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return {
        count: arr.length,
        min: sorted[0],
        p50: percentile(sorted, 50),
        mean: parseFloat(mean(arr).toFixed(3)),
        std: parseFloat(stddev(arr).toFixed(3)),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1]
    };
}

// =============================================================================
// HTTP CLIENT
// =============================================================================

function httpRequest(method, urlStr, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const transport = url.protocol === 'https:' ? https : http;
        const bodyStr = body ? JSON.stringify(body) : null;
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
            },
            timeout: timeoutMs || 30000
        };
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const responseBytes = Buffer.byteLength(data, 'utf8');
                try { resolve({ status: res.statusCode, body: JSON.parse(data), responseBytes }); }
                catch { resolve({ status: res.statusCode, body: data, responseBytes }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// =============================================================================
// SSE ACTIVATION TRACKER  (watches for CLAIM_ACTIVATED events)
// =============================================================================

class ActivationTracker {
    constructor(gatewayUrl) {
        this.gatewayUrl = gatewayUrl;
        this.url = `${gatewayUrl}/events/stream`;
        this.activated = new Set();
        this.connected = false;
        this.req = null;
    }

    connect() {
        return new Promise((resolve) => {
            const url = new URL(this.url);
            const transport = url.protocol === 'https:' ? https : http;
            this.req = transport.get(this.url, {
                headers: { 'Accept': 'text/event-stream' },
                timeout: 0
            }, (res) => {
                if (res.statusCode !== 200) { resolve(false); return; }
                this.connected = true;
                let buffer = '';
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const messages = buffer.split('\n\n');
                    buffer = messages.pop();
                    for (const msg of messages) {
                        if (msg.trim()) this._parse(msg);
                    }
                });
                res.on('end', () => {
                    this.connected = false;
                    logWarn('SSE connection closed by server');
                });
                res.on('error', (err) => {
                    this.connected = false;
                    logWarn(`SSE stream error: ${err.message}`);
                });
                resolve(true);
            });
            this.req.on('error', () => resolve(false));
        });
    }

    _parse(raw) {
        let eventType = null, data = null;
        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
                try { data = JSON.parse(line.slice(6)); } catch { }
            }
        }
        if (eventType === 'CLAIM_ACTIVATED' && data) {
            const assetId = data.asset_id || data.assetId;
            if (assetId) this.activated.add(assetId);
        }
    }

    isActivated(assetId) { return this.activated.has(assetId); }
    activatedCount() { return this.activated.size; }

    /**
     * FIX #4: Polling fallback — query GET /admin/anchors to count active anchors.
     * Used as a safety net if SSE misses events or disconnects.
     * Returns the count of active anchors on the ledger.
     */
    async pollActiveCount(timeout) {
        try {
            const result = await httpRequest(
                'GET',
                `${this.gatewayUrl}/admin/anchors`,
                null, {}, timeout || 10000
            );
            if (result.status === 200 && result.body) {
                const count = result.body.count || (result.body.anchors ? result.body.anchors.length : 0);
                return count;
            }
        } catch (err) {
            logWarn(`Polling fallback failed: ${err.message}`);
        }
        return null;
    }

    disconnect() {
        if (this.req) { this.req.destroy(); this.connected = false; }
    }
}

// =============================================================================
// FILL PHASE — propose anchors at target rate, wait for activations
// =============================================================================

async function fillAnchors(config, startIdx, count, tracker, fillLog) {
    const intervalMs = 1000 / config.fillRate;
    const assetIds = [];
    let okCount = 0;
    let failCount = 0;

    log(`  Filling ${count} anchors at ${config.fillRate} ops/sec...`);

    for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const assetId = `${config.prefix}${String(idx).padStart(5, '0')}`;
        const reqId = `fill-${config.runId}-${idx}`;
        const sendMs = Date.now();

        try {
            const result = await httpRequest(
                'POST',
                `${config.gateway}/claims/propose`,
                {
                    asset_id: assetId,
                    pose_site: {
                        position: { x: (idx % 50) * 0.2, y: 0, z: Math.floor(idx / 50) * 0.2 },
                        rotation: { qw: 1, qx: 0, qy: 0, qz: 0 }
                    },
                    quality_metrics: {
                        stability_rms: 0.02,
                        confidence_mean: 0.9,
                        observation_count: 10
                    },
                    run_id: config.runId,
                    req_id: reqId
                },
                { 'x-run-id': config.runId },
                config.timeout
            );

            const rttMs = Date.now() - sendMs;
            const ok = result.status >= 200 && result.status < 300 && result.body?.success;

            if (ok) { okCount++; assetIds.push(assetId); }
            else { failCount++; }

            fillLog.write(JSON.stringify({
                seq: idx, asset_id: assetId, rtt_ms: rttMs,
                status: ok ? 'ok' : 'fail',
                error: ok ? null : (result.body?.error || `HTTP ${result.status}`)
            }) + '\n');

            if (config.verbose) {
                log(`    #${idx} ${assetId} → ${ok ? 'ok' : 'FAIL'} ${rttMs}ms`);
            }
        } catch (err) {
            failCount++;
            fillLog.write(JSON.stringify({
                seq: idx, asset_id: assetId, rtt_ms: Date.now() - sendMs,
                status: 'error', error: err.message
            }) + '\n');
        }

        // Progress
        if ((i + 1) % Math.max(1, Math.round(count / 5)) === 0) {
            log(`    ${i + 1}/${count} proposed (${okCount} ok, ${failCount} fail)`);
        }

        // Rate control (sequential — simpler and sufficient for filling)
        if (i < count - 1) {
            const elapsed = Date.now() - sendMs;
            const waitMs = Math.max(0, intervalMs - elapsed);
            if (waitMs > 0) await sleep(waitMs);
        }
    }

    log(`  Proposed: ${okCount} ok, ${failCount} fail`);

    // Wait for endorser bot to activate all proposals
    if (assetIds.length > 0) {
        log(`  Waiting for ${assetIds.length} activations (timeout: ${config.activationTimeout}s)...`);
        const waitStart = Date.now();
        let lastReport = -1;

        while (Date.now() - waitStart < config.activationTimeout * 1000) {
            const activated = assetIds.filter(id => tracker.isActivated(id)).length;
            if (activated !== lastReport) {
                log(`    Activated: ${activated}/${assetIds.length}`);
                lastReport = activated;
            }
            if (activated >= assetIds.length) break;
            await sleep(2000);
        }

        let finalActivated = assetIds.filter(id => tracker.isActivated(id)).length;

        // FIX #4: Polling fallback if SSE missed events or disconnected
        if (finalActivated < assetIds.length) {
            log(`  SSE reports ${finalActivated}/${assetIds.length} — trying polling fallback...`);
            const polledCount = await tracker.pollActiveCount(config.timeout);
            if (polledCount !== null) {
                log(`  Polling reports ${polledCount} total active anchors on ledger`);
                // If ledger has at least as many active anchors as we expect,
                // trust the ledger over SSE (SSE may have missed events)
                if (polledCount >= (startIdx + assetIds.length)) {
                    log(`  Polling confirms all anchors ACTIVE (ledger count ${polledCount} >= expected ${startIdx + assetIds.length})`);
                    finalActivated = assetIds.length;
                } else {
                    logWarn(`  Polling shows ${polledCount} active, expected ${startIdx + assetIds.length} — some anchors may not have been endorsed`);
                }
            } else {
                logWarn(`  Polling fallback failed — relying on SSE count (${finalActivated})`);
            }
        }

        if (finalActivated < assetIds.length) {
            logWarn(`Only ${finalActivated}/${assetIds.length} activated within timeout`);
        } else {
            log(`  All ${finalActivated} anchors ACTIVE ✓`);
        }

        return { proposed: okCount, failed: failCount, activated: finalActivated };
    }

    return { proposed: okCount, failed: failCount, activated: 0 };
}

// =============================================================================
// READ BENCHMARK PHASE
// =============================================================================

async function benchmarkReads(config, tierN, readLog) {
    const results = {};

    // --- Benchmark: GET /events/snapshot ---
    const snapshotLatencies = [];
    const snapshotSizes = [];

    log(`  Benchmarking GET /events/snapshot (${config.reads} iterations)...`);
    for (let i = 0; i < config.reads; i++) {
        const startMs = Date.now();
        try {
            const result = await httpRequest(
                'GET',
                `${config.gateway}/events/snapshot`,
                null,
                { 'x-run-id': config.runId },
                config.timeout
            );
            const latencyMs = Date.now() - startMs;
            const ok = result.status >= 200 && result.status < 300;

            if (ok) {
                snapshotLatencies.push(latencyMs);
                snapshotSizes.push(result.responseBytes);
            }

            readLog.write(JSON.stringify({
                tier_n: tierN, endpoint: 'snapshot', iteration: i,
                latency_ms: latencyMs, response_bytes: result.responseBytes,
                status: ok ? 'ok' : 'fail',
                asset_count: result.body?.assets?.length || null
            }) + '\n');

            if (config.verbose) {
                log(`    snapshot #${i}: ${latencyMs}ms, ${result.responseBytes} bytes`);
            }
        } catch (err) {
            readLog.write(JSON.stringify({
                tier_n: tierN, endpoint: 'snapshot', iteration: i,
                latency_ms: Date.now() - startMs, status: 'error', error: err.message
            }) + '\n');
        }
    }

    results.snapshot = {
        latency: stats(snapshotLatencies),
        payload_bytes: stats(snapshotSizes)
    };

    // --- Benchmark: GET /admin/anchors ---
    const anchorsLatencies = [];
    const anchorsSizes = [];

    log(`  Benchmarking GET /admin/anchors (${config.reads} iterations)...`);
    for (let i = 0; i < config.reads; i++) {
        const startMs = Date.now();
        try {
            const result = await httpRequest(
                'GET',
                `${config.gateway}/admin/anchors`,
                null,
                { 'x-run-id': config.runId },
                config.timeout
            );
            const latencyMs = Date.now() - startMs;
            const ok = result.status >= 200 && result.status < 300;

            if (ok) {
                anchorsLatencies.push(latencyMs);
                anchorsSizes.push(result.responseBytes);
            }

            readLog.write(JSON.stringify({
                tier_n: tierN, endpoint: 'anchors', iteration: i,
                latency_ms: latencyMs, response_bytes: result.responseBytes,
                status: ok ? 'ok' : 'fail',
                anchor_count: result.body?.anchors?.length || null
            }) + '\n');

            if (config.verbose) {
                log(`    anchors #${i}: ${latencyMs}ms, ${result.responseBytes} bytes`);
            }
        } catch (err) {
            readLog.write(JSON.stringify({
                tier_n: tierN, endpoint: 'anchors', iteration: i,
                latency_ms: Date.now() - startMs, status: 'error', error: err.message
            }) + '\n');
        }
    }

    results.anchors = {
        latency: stats(anchorsLatencies),
        payload_bytes: stats(anchorsSizes)
    };

    // --- Benchmark: GET /claims/:assetId/history (sample one asset) ---
    // Pick a random existing asset from the snapshot to query history
    let historyResults = null;
    try {
        const snap = await httpRequest(
            'GET', `${config.gateway}/events/snapshot`, null,
            {}, config.timeout
        );
        const assets = snap.body?.assets || [];
        if (assets.length > 0) {
            const sampleAsset = assets[Math.floor(assets.length / 2)]?.asset_id;
            if (sampleAsset) {
                const histLatencies = [];
                const histSizes = [];

                log(`  Benchmarking GET /claims/${sampleAsset}/history (${config.reads} iterations)...`);
                for (let i = 0; i < config.reads; i++) {
                    const startMs = Date.now();
                    try {
                        const result = await httpRequest(
                            'GET',
                            `${config.gateway}/claims/${sampleAsset}/history`,
                            null,
                            {},
                            config.timeout
                        );
                        const latencyMs = Date.now() - startMs;
                        const ok = result.status >= 200 && result.status < 300;

                        if (ok) {
                            histLatencies.push(latencyMs);
                            histSizes.push(result.responseBytes);
                        }

                        readLog.write(JSON.stringify({
                            tier_n: tierN, endpoint: 'history', iteration: i,
                            latency_ms: latencyMs, response_bytes: result.responseBytes,
                            status: ok ? 'ok' : 'fail',
                            sample_asset: sampleAsset
                        }) + '\n');
                    } catch (err) {
                        readLog.write(JSON.stringify({
                            tier_n: tierN, endpoint: 'history', iteration: i,
                            latency_ms: Date.now() - startMs, status: 'error', error: err.message
                        }) + '\n');
                    }
                }

                historyResults = {
                    sample_asset: sampleAsset,
                    latency: stats(histLatencies),
                    payload_bytes: stats(histSizes)
                };
            }
        }
    } catch { /* skip history if snapshot fails */ }

    results.history = historyResults;

    return results;
}

// =============================================================================
// COUNT EXISTING ACTIVE ANCHORS
// =============================================================================

async function countActiveAnchors(gateway, timeout) {
    try {
        const result = await httpRequest(
            'GET', `${gateway}/admin/anchors`, null,
            {}, timeout
        );
        if (result.status >= 200 && result.status < 300 && result.body?.anchors) {
            return result.body.anchors.length;
        }
    } catch { }
    return 0;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    const config = parseArgs();

    const outDir = path.join(__dirname, 'runs', config.runId);
    fs.mkdirSync(outDir, { recursive: true });

    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  Dataset Scaling — Experiment 2: Read-Path Performance       ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`  Gateway:     ${config.gateway}`);
    console.log(`  Run ID:      ${config.runId}`);
    console.log(`  Mode:        ${config.mode}`);
    console.log(`  Tiers:       [${config.tiers.join(', ')}]`);
    console.log(`  Reads/tier:  ${config.reads}`);
    if (config.mode === 'fill-and-read') {
        console.log(`  Fill rate:   ${config.fillRate} ops/sec`);
        console.log(`  Prefix:      ${config.prefix}`);
        console.log(`  NOTE: Requires endorser_bot.js running in two-step mode`);
    }
    console.log('');

    // Health check
    try {
        const h = await httpRequest('GET', `${config.gateway}/health`, null, {}, 5000);
        log(`✓ Gateway healthy (org1=${h.body.org1Connected}, org2=${h.body.org2Connected})`);
    } catch (e) {
        logError(`Gateway unreachable: ${e.message}`);
        process.exit(1);
    }

    // Count existing anchors
    const existingCount = await countActiveAnchors(config.gateway, config.timeout);
    log(`Existing active anchors on ledger: ${existingCount}`);

    // Open log streams
    const fillLog = fs.createWriteStream(path.join(outDir, 'dataset_scaling_fill.jsonl'), { flags: 'w' });
    const readLog = fs.createWriteStream(path.join(outDir, 'dataset_scaling_reads.jsonl'), { flags: 'w' });

    // SSE tracker for fill phase
    let tracker = null;
    if (config.mode === 'fill-and-read') {
        tracker = new ActivationTracker(config.gateway);
        const sseOk = await tracker.connect();
        if (sseOk) log('✓ SSE activation tracker connected');
        else logWarn('SSE tracker failed — will poll for activations instead');
    }

    // =========================================================================
    // PER-TIER LOOP
    // =========================================================================
    const tierResults = [];
    let totalFilled = existingCount;

    for (const tierN of config.tiers) {
        console.log('');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  Tier: ${tierN} active anchors`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // Fill if needed
        let fillResult = null;
        if (config.mode === 'fill-and-read') {
            const needed = tierN - totalFilled;
            if (needed > 0) {
                fillResult = await fillAnchors(config, totalFilled, needed, tracker, fillLog);
                totalFilled += fillResult.activated;
            } else {
                log(`  Already have ${totalFilled} anchors, skipping fill`);
            }

            // Verify actual count
            const actualCount = await countActiveAnchors(config.gateway, config.timeout);
            log(`  Verified active anchor count: ${actualCount}`);
            totalFilled = actualCount;  // sync with reality
        }

        // Benchmark reads at this tier
        log(`  Starting read benchmark at N=${totalFilled}...`);
        const readResults = await benchmarkReads(config, tierN, readLog);

        // Print tier summary
        const snap = readResults.snapshot;
        const anch = readResults.anchors;
        const hist = readResults.history;

        console.log('');
        console.log(`  ── Tier ${tierN} Results ──`);
        if (snap?.latency) {
            console.log(`  Snapshot:  p50=${snap.latency.p50}ms  mean=${snap.latency.mean}ms  size=${snap.payload_bytes?.mean || '-'} bytes`);
        }
        if (anch?.latency) {
            console.log(`  Anchors:   p50=${anch.latency.p50}ms  mean=${anch.latency.mean}ms  size=${anch.payload_bytes?.mean || '-'} bytes`);
        }
        if (hist?.latency) {
            console.log(`  History:   p50=${hist.latency.p50}ms  mean=${hist.latency.mean}ms  size=${hist.payload_bytes?.mean || '-'} bytes`);
        }

        tierResults.push({
            target_n: tierN,
            actual_n: totalFilled,
            fill: fillResult,
            snapshot: snap,
            anchors: anch,
            history: hist
        });
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    if (tracker) tracker.disconnect();
    fillLog.end();
    readLog.end();

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  EXPERIMENT 2 — DATASET SCALING SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');

    // Summary table
    console.log('');
    console.log('  N(target) | N(actual) | Snap p50  | Snap size  | Anchors p50 | Anchors size');
    console.log('  ----------|-----------|-----------|------------|-------------|-------------');
    for (const t of tierResults) {
        const snapP50 = t.snapshot?.latency?.p50 ?? '-';
        const snapSize = t.snapshot?.payload_bytes?.mean ?? '-';
        const anchP50 = t.anchors?.latency?.p50 ?? '-';
        const anchSize = t.anchors?.payload_bytes?.mean ?? '-';
        const snapSizeStr = typeof snapSize === 'number' ? `${(snapSize / 1024).toFixed(1)} KB` : '-';
        const anchSizeStr = typeof anchSize === 'number' ? `${(anchSize / 1024).toFixed(1)} KB` : '-';
        console.log(`  ${String(t.target_n).padStart(9)} | ${String(t.actual_n).padStart(9)} | ${String(snapP50).padStart(7)}ms | ${snapSizeStr.padStart(10)} | ${String(anchP50).padStart(9)}ms | ${anchSizeStr.padStart(10)}`);
    }

    // Bytes per anchor
    if (tierResults.length >= 2) {
        const first = tierResults[0];
        const last = tierResults[tierResults.length - 1];
        if (first.snapshot?.payload_bytes?.mean && last.snapshot?.payload_bytes?.mean && last.actual_n > first.actual_n) {
            const bpa = (last.snapshot.payload_bytes.mean - first.snapshot.payload_bytes.mean) / (last.actual_n - first.actual_n);
            console.log(`\n  Estimated bytes/anchor (snapshot): ~${bpa.toFixed(0)} bytes`);
        }
    }

    console.log('═══════════════════════════════════════════════════════════════');

    // Save summary
    const summary = {
        metadata: {
            run_id: config.runId,
            gateway: config.gateway,
            mode: config.mode,
            tiers: config.tiers,
            reads_per_tier: config.reads,
            fill_rate: config.fillRate,
            prefix: config.prefix,
            existing_anchors_at_start: existingCount,
            timestamp: new Date().toISOString()
        },
        tier_results: tierResults
    };

    const summaryPath = path.join(outDir, 'dataset_scaling_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    log(`Summary saved: ${summaryPath}`);

    const configPath = path.join(outDir, 'dataset_scaling_config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`Config saved: ${configPath}`);

    log('Done.');
}

main().catch(err => {
    logError(`Fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});