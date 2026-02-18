#!/usr/bin/env node
/**
 * ==============================================================================
 * load_generator.js — Experiment 1: Load Scaling (Write-Path)
 *
 * Multi-rate concurrent load generator for the anchor-registry system.
 * Fires ProposeAnchor requests at a configurable rate and optionally runs
 * the full Propose→Endorse×2 lifecycle (when endorser_bot is active).
 *
 * Unlike commit_confirm_test.js (which is sequential), this script uses
 * interval-based scheduling so requests are dispatched at a steady rate
 * regardless of response time, enabling true concurrent in-flight requests.
 *
 * USAGE:
 *   # W1 — Propose-only at 5 ops/sec for 60 seconds:
 *   node load_generator.js --gateway http://localhost:3000 \
 *       --run_id exp1-w1-r5 --rate 5 --duration 60 --workload propose
 *
 *   # W2 — Full lifecycle at 10 ops/sec (start endorser_bot first!):
 *   node load_generator.js --gateway http://localhost:3000 \
 *       --run_id exp1-w2-r10 --rate 10 --duration 60 --workload lifecycle
 *
 *   # Sweep multiple rates:
 *   for R in 1 5 10 20 50; do
 *     node load_generator.js --gateway http://localhost:3000 \
 *       --run_id "exp1-w1-r${R}" --rate $R --duration 60 --workload propose
 *     sleep 10   # cool-down between runs
 *   done
 *
 * OPTIONS:
 *   --gateway <url>       Gateway base URL (default: http://localhost:3000)
 *   --run_id <id>         Run identifier (default: exp1-<timestamp>)
 *   --rate <ops/sec>      Target request rate in ops/sec (default: 1)
 *   --duration <sec>      Test duration in seconds (default: 60)
 *   --workload <type>     'propose' (W1) or 'lifecycle' (W2) (default: propose)
 *   --warmup <sec>        Warmup period excluded from stats (default: 5)
 *   --lane <A|B>          Lane label (default: A)
 *   --prefix <str>        Asset ID prefix (default: load-<timestamp>-)
 *   --timeout <ms>        Per-request HTTP timeout (default: 30000)
 *   --sse_timeout <sec>   Max time to wait for SSE activations after sending (default: 120)
 *   --docker_stats        Capture docker stats during run (writes to run dir)
 *   --verbose             Verbose per-request logging
 *   --help                Show help
 *
 * OUTPUTS (in experiments/runs/<run_id>/):
 *   load_generator_requests.jsonl  — per-request detail log
 *   load_generator_summary.json    — aggregate statistics
 *   load_generator_sse.jsonl       — SSE events received during run
 *   docker_stats.jsonl             — docker stats (if --docker_stats)
 *
 * REQUIRES: endorser_bot.js running for workload=lifecycle
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const now = Date.now();
    const config = {
        gateway: 'http://localhost:3000',
        runId: `exp1-${now}`,
        rate: 1,
        duration: 60,
        workload: 'propose',   // 'propose' or 'lifecycle'
        warmup: 5,
        lane: 'A',
        prefix: `load-${now}-`,
        timeout: 30000,
        sseTimeout: 120,
        dockerStats: false,
        verbose: false
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--gateway':       config.gateway = args[++i]; break;
            case '--run_id':        config.runId = args[++i]; break;
            case '--rate':          config.rate = parseFloat(args[++i]); break;
            case '--duration':      config.duration = parseInt(args[++i], 10); break;
            case '--workload':      config.workload = args[++i]; break;
            case '--warmup':        config.warmup = parseInt(args[++i], 10); break;
            case '--lane':          config.lane = args[++i]; break;
            case '--prefix':        config.prefix = args[++i]; break;
            case '--timeout':       config.timeout = parseInt(args[++i], 10); break;
            case '--sse_timeout':   config.sseTimeout = parseInt(args[++i], 10); break;
            case '--docker_stats':  config.dockerStats = true; break;
            case '--verbose':       config.verbose = true; break;
            case '--help':
                console.log(`
Usage: node load_generator.js [options]

  --gateway <url>        Gateway URL (default: http://localhost:3000)
  --run_id <id>          Run identifier
  --rate <ops/sec>       Target request rate (default: 1)
  --duration <sec>       Test duration in seconds (default: 60)
  --workload <type>      'propose' (W1) or 'lifecycle' (W2) (default: propose)
  --warmup <sec>         Warmup seconds excluded from stats (default: 5)
  --lane <A|B>           Lane label (default: A)
  --prefix <str>         Asset ID prefix
  --timeout <ms>         HTTP timeout per request (default: 30000)
  --sse_timeout <sec>    Wait for SSE activations after load phase (default: 120)
  --docker_stats         Capture docker stats during the run
  --verbose              Log every request/response
  --help                 Show this help
`);
                process.exit(0);
        }
    }
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
    if (arr.length === 0) return NaN;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
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
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1]
    };
}

// =============================================================================
// HTTP CLIENT  (same pattern as commit_confirm_test.js)
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
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// =============================================================================
// ERROR NORMALIZATION  (same as commit_confirm_test.js)
// =============================================================================

function normalizeError(errStr) {
    if (!errStr) return 'UNKNOWN';
    if (errStr.includes('MVCC_READ_CONFLICT')) return 'MVCC_READ_CONFLICT';
    if (errStr.includes('PHANTOM_READ'))       return 'PHANTOM_READ_CONFLICT';
    if (errStr.includes('already exists'))      return 'DUPLICATE_ASSET';
    if (errStr.includes('Pending claim already exists')) return 'PENDING_CLAIM_EXISTS';
    if (errStr.includes('timeout') || errStr.includes('TIMEOUT')) return 'TIMEOUT';
    if (errStr.includes('ECONNREFUSED'))        return 'CONNECTION_REFUSED';
    if (errStr.includes('ENDORSEMENT_FAILURE')) return 'ENDORSEMENT_FAILURE';
    return errStr.substring(0, 80);
}

// =============================================================================
// SSE CLIENT  (for tracking commit-confirmed / activation latency)
// =============================================================================

class SseTracker {
    constructor(gatewayUrl, logStream) {
        this.url = `${gatewayUrl}/events/stream`;
        this.logStream = logStream;
        this.events = new Map();       // assetId → array of {event, timestamp_ms}
        this.activations = new Map();  // assetId → timestamp_ms of CLAIM_ACTIVATED
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
                if (res.statusCode !== 200) {
                    logError(`SSE connection failed: HTTP ${res.statusCode}`);
                    resolve(false);
                    return;
                }
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

                res.on('end', () => { this.connected = false; });
                res.on('error', () => { this.connected = false; });
                resolve(true);
            });

            this.req.on('error', () => { resolve(false); });
        });
    }

    _parse(raw) {
        let eventType = null, data = null;
        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
                try { data = JSON.parse(line.slice(6)); }
                catch { data = line.slice(6); }
            }
        }
        if (!eventType || !data) return;

        const nowMs = Date.now();
        const assetId = data.asset_id || data.assetId;

        if (assetId) {
            if (!this.events.has(assetId)) this.events.set(assetId, []);
            this.events.get(assetId).push({ event: eventType, timestamp_ms: nowMs });

            if (eventType === 'CLAIM_ACTIVATED') {
                this.activations.set(assetId, nowMs);
            }
        }

        // Log SSE event
        if (this.logStream) {
            this.logStream.write(JSON.stringify({
                timestamp_ms: nowMs,
                event: eventType,
                asset_id: assetId || null,
                data_keys: data ? Object.keys(data) : []
            }) + '\n');
        }
    }

    getActivationTime(assetId) {
        return this.activations.get(assetId) || null;
    }

    disconnect() {
        if (this.req) {
            this.req.destroy();
            this.connected = false;
        }
    }
}

// =============================================================================
// DOCKER STATS COLLECTOR  (optional)
// =============================================================================

class DockerStatsCollector {
    constructor(outPath) {
        this.outPath = outPath;
        this.proc = null;
    }

    start() {
        try {
            // Check if docker is available
            execSync('docker ps', { stdio: 'ignore' });
        } catch {
            logWarn('Docker not available — skipping docker stats collection');
            return false;
        }

        const stream = fs.createWriteStream(this.outPath, { flags: 'a' });
        this.proc = spawn('bash', ['-c',
            `while true; do
                docker stats --no-stream --format '{"timestamp_ms":{{json .}},"ts":'$(date +%s%3N)'}' 2>/dev/null | while IFS= read -r line; do
                    echo "$line"
                done
                sleep 2
            done`
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        // docker stats --format outputs one object per container but the JSON
        // template above isn't quite right. Let's use a simpler approach:
        this.proc.kill();  // kill the bad one

        // Better approach: poll docker stats every 2s
        this.interval = setInterval(() => {
            try {
                const raw = execSync(
                    `docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"`,
                    { timeout: 5000, encoding: 'utf8' }
                );
                const nowMs = Date.now();
                for (const line of raw.trim().split('\n')) {
                    if (!line.trim()) continue;
                    const [name, cpu, mem, net, block] = line.split('\t');
                    stream.write(JSON.stringify({
                        timestamp_ms: nowMs,
                        container: name,
                        cpu_pct: cpu,
                        mem_usage: mem,
                        net_io: net,
                        block_io: block
                    }) + '\n');
                }
            } catch { /* ignore individual poll failures */ }
        }, 2000);

        this.stream = stream;
        log('Docker stats collection started (every 2s)');
        return true;
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        if (this.stream) this.stream.end();
        log('Docker stats collection stopped');
    }
}

// =============================================================================
// CORE LOAD GENERATOR
// =============================================================================

async function runLoadTest(config) {
    const outDir = path.join(__dirname, 'runs', config.runId);
    fs.mkdirSync(outDir, { recursive: true });

    // Open log streams
    const reqLog = fs.createWriteStream(path.join(outDir, 'load_generator_requests.jsonl'), { flags: 'w' });
    const sseLog = fs.createWriteStream(path.join(outDir, 'load_generator_sse.jsonl'), { flags: 'w' });

    // Connect SSE tracker (for lifecycle latency tracking)
    const sse = new SseTracker(config.gateway, sseLog);
    const sseOk = await sse.connect();
    if (sseOk) {
        log('✓ SSE tracker connected');
    } else {
        logWarn('SSE tracker failed to connect — activation tracking unavailable');
    }

    // Docker stats (optional)
    let dockerCollector = null;
    if (config.dockerStats) {
        dockerCollector = new DockerStatsCollector(path.join(outDir, 'docker_stats.jsonl'));
        dockerCollector.start();
    }

    // =========================================================================
    // SEND PHASE: interval-based rate-controlled dispatch
    // =========================================================================
    const intervalMs = 1000 / config.rate;
    const totalRequests = Math.round(config.rate * config.duration);
    const warmupRequests = Math.round(config.rate * config.warmup);

    log(`Sending ${totalRequests} requests at ${config.rate} ops/sec (interval=${intervalMs.toFixed(1)}ms)`);
    log(`Warmup: first ${warmupRequests} requests (${config.warmup}s) excluded from stats`);
    log(`Workload: ${config.workload}`);

    const allResults = [];   // collect {assetId, sendMs, rttMs, status, error, ...}
    let inflight = 0;
    let maxInflight = 0;
    let seq = 0;

    const runStartMs = Date.now();

    // The dispatch function: fire one request, don't await
    function dispatch() {
        const i = seq++;
        const assetId = `${config.prefix}${String(i).padStart(5, '0')}`;
        const reqId = `req-${config.runId}-${i}`;
        const sendMs = Date.now();
        const isWarmup = i < warmupRequests;

        inflight++;
        if (inflight > maxInflight) maxInflight = inflight;

        const record = {
            seq: i,
            asset_id: assetId,
            req_id: reqId,
            send_ms: sendMs,
            is_warmup: isWarmup,
            rtt_ms: null,
            status: null,
            error: null,
            error_category: null,
            claim_id: null,
            http_status: null
        };

        // Fire-and-forget with completion tracking
        httpRequest(
            'POST',
            `${config.gateway}/claims/propose`,
            {
                asset_id: assetId,
                pose_site: {
                    position: { x: (i % 100) * 0.1, y: 0, z: Math.floor(i / 100) * 0.1 },
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
            {
                'x-org-id': 'org1',
                'x-run-id': config.runId,
                'x-req-id': reqId,
                'x-lane': config.lane
            },
            config.timeout
        ).then(result => {
            record.rtt_ms = Date.now() - sendMs;
            record.http_status = result.status;
            if (result.status >= 200 && result.status < 300 && result.body?.success) {
                record.status = 'ok';
                record.claim_id = result.body.claim_id;
            } else {
                record.status = 'fail';
                record.error = result.body?.error || `HTTP ${result.status}`;
                record.error_category = normalizeError(record.error);
            }
        }).catch(err => {
            record.rtt_ms = Date.now() - sendMs;
            record.status = 'error';
            record.error = err.message;
            record.error_category = normalizeError(err.message);
        }).finally(() => {
            inflight--;
            allResults.push(record);

            // Write JSONL log line
            reqLog.write(JSON.stringify(record) + '\n');

            if (config.verbose) {
                const tag = record.is_warmup ? ' [warmup]' : '';
                log(`  #${record.seq} ${record.asset_id} → ${record.status} ${record.rtt_ms}ms${tag}`);
            }
        });
    }

    // Schedule dispatches at precise intervals
    return new Promise((resolve) => {
        let dispatched = 0;

        // Use setInterval for steady rate, with drift correction
        const startTime = Date.now();

        const timer = setInterval(() => {
            if (dispatched >= totalRequests) {
                clearInterval(timer);
                finishSending();
                return;
            }

            // Drift correction: calculate how many should have been sent by now
            const elapsed = Date.now() - startTime;
            const shouldHaveSent = Math.min(Math.floor(elapsed / intervalMs) + 1, totalRequests);

            while (dispatched < shouldHaveSent && dispatched < totalRequests) {
                dispatch();
                dispatched++;
            }

            // Progress updates every 10% or every 5 seconds
            if (dispatched % Math.max(1, Math.round(totalRequests / 10)) === 0) {
                const ok = allResults.filter(r => r.status === 'ok').length;
                const fail = allResults.filter(r => r.status !== 'ok' && r.status !== null).length;
                const pending = dispatched - allResults.length;
                log(`  Progress: ${dispatched}/${totalRequests} dispatched, ` +
                    `${ok} ok, ${fail} fail, ${pending} in-flight, peak=${maxInflight}`);
            }
        }, Math.max(1, Math.floor(intervalMs / 2)));   // poll at 2× rate for accuracy

        async function finishSending() {
            const sendDuration = Date.now() - runStartMs;
            log(`All ${totalRequests} requests dispatched in ${(sendDuration / 1000).toFixed(1)}s`);

            // Wait for in-flight requests to complete (up to timeout)
            log(`Waiting for ${inflight} in-flight requests...`);
            const drainStart = Date.now();
            while (inflight > 0 && (Date.now() - drainStart) < config.timeout + 5000) {
                await sleep(100);
            }
            if (inflight > 0) {
                logWarn(`${inflight} requests still in-flight after drain timeout`);
            }

            // =====================================================================
            // SSE DRAIN: wait for activations (lifecycle workload)
            // =====================================================================
            if (config.workload === 'lifecycle' && sseOk) {
                const successAssets = allResults
                    .filter(r => r.status === 'ok')
                    .map(r => r.asset_id);

                if (successAssets.length > 0) {
                    log(`Waiting up to ${config.sseTimeout}s for ${successAssets.length} activations via SSE...`);
                    const sseStart = Date.now();
                    let lastCount = -1;

                    while (Date.now() - sseStart < config.sseTimeout * 1000) {
                        const activated = successAssets.filter(id => sse.getActivationTime(id)).length;
                        if (activated !== lastCount) {
                            log(`  Activations: ${activated}/${successAssets.length}`);
                            lastCount = activated;
                        }
                        if (activated >= successAssets.length) break;
                        await sleep(1000);
                    }

                    const finalActivated = successAssets.filter(id => sse.getActivationTime(id)).length;
                    log(`SSE drain complete: ${finalActivated}/${successAssets.length} activated`);
                }
            }

            // =====================================================================
            // COMPUTE STATISTICS
            // =====================================================================
            sse.disconnect();
            if (dockerCollector) dockerCollector.stop();
            reqLog.end();
            sseLog.end();

            const summary = computeSummary(config, allResults, sse, runStartMs, sendDuration);
            resolve(summary);
        }
    });
}

// =============================================================================
// STATISTICS COMPUTATION
// =============================================================================

function computeSummary(config, allResults, sse, runStartMs, sendDurationMs) {
    // Separate warmup from measurement
    const warmup = allResults.filter(r => r.is_warmup);
    const measured = allResults.filter(r => !r.is_warmup);

    // ---- Propose RTT stats (measurement window only) ----
    const okMeasured = measured.filter(r => r.status === 'ok');
    const failMeasured = measured.filter(r => r.status === 'fail' || r.status === 'error');
    const okRtts = okMeasured.map(r => r.rtt_ms).filter(v => v !== null);

    // ---- Error breakdown ----
    const errorCategories = {};
    for (const r of failMeasured) {
        const cat = r.error_category || 'UNKNOWN';
        errorCategories[cat] = (errorCategories[cat] || 0) + 1;
    }

    // ---- Throughput ----
    // Actual throughput = successful responses / measurement window duration
    const measureStart = measured.length > 0 ? Math.min(...measured.map(r => r.send_ms)) : runStartMs;
    const measureEnd = measured.length > 0 ? Math.max(...measured.map(r => r.send_ms + (r.rtt_ms || 0))) : runStartMs;
    const measureWindowSec = Math.max(0.001, (measureEnd - measureStart) / 1000);
    const actualThroughput = okMeasured.length / measureWindowSec;

    // ---- Offered load (actual send rate) ----
    const sendTimestamps = measured.map(r => r.send_ms).sort((a, b) => a - b);
    let actualRate = config.rate;
    if (sendTimestamps.length > 1) {
        const intervals = [];
        for (let i = 1; i < sendTimestamps.length; i++) {
            intervals.push(sendTimestamps[i] - sendTimestamps[i - 1]);
        }
        const meanInterval = mean(intervals);
        actualRate = meanInterval > 0 ? 1000 / meanInterval : 0;
    }

    // ---- Commit-confirmed latency (lifecycle workload) ----
    let commitConfirmStats = null;
    if (config.workload === 'lifecycle') {
        const ccLatencies = [];
        for (const r of okMeasured) {
            const activationMs = sse.getActivationTime(r.asset_id);
            if (activationMs && r.send_ms) {
                ccLatencies.push(activationMs - r.send_ms);
            }
        }
        if (ccLatencies.length > 0) {
            commitConfirmStats = stats(ccLatencies);
        }
    }

    // ---- Build summary ----
    const summary = {
        metadata: {
            run_id: config.runId,
            gateway: config.gateway,
            workload: config.workload,
            target_rate_ops: config.rate,
            duration_sec: config.duration,
            warmup_sec: config.warmup,
            lane: config.lane,
            prefix: config.prefix,
            timestamp: new Date().toISOString(),
            send_duration_ms: sendDurationMs
        },
        counts: {
            total_dispatched: allResults.length,
            warmup_excluded: warmup.length,
            measured: measured.length,
            measured_ok: okMeasured.length,
            measured_fail: failMeasured.length,
            success_rate_pct: measured.length > 0
                ? parseFloat(((okMeasured.length / measured.length) * 100).toFixed(1))
                : 0
        },
        throughput: {
            target_ops: config.rate,
            actual_send_rate_ops: parseFloat(actualRate.toFixed(3)),
            actual_throughput_ops: parseFloat(actualThroughput.toFixed(3)),
            measurement_window_sec: parseFloat(measureWindowSec.toFixed(3))
        },
        propose_rtt: stats(okRtts),
        commit_confirm: commitConfirmStats,
        error_breakdown: errorCategories,
        concurrency: {
            // Estimate: at target rate R and mean RTT T, concurrency ≈ R × T/1000
            estimated_mean: okRtts.length > 0
                ? parseFloat((config.rate * mean(okRtts) / 1000).toFixed(2))
                : null
        }
    };

    return summary;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    const config = parseArgs();

    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  Load Generator — Experiment 1: Load Scaling (Write-Path)    ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`  Gateway:     ${config.gateway}`);
    console.log(`  Run ID:      ${config.runId}`);
    console.log(`  Workload:    ${config.workload}`);
    console.log(`  Target rate: ${config.rate} ops/sec`);
    console.log(`  Duration:    ${config.duration}s (+ ${config.warmup}s warmup)`);
    console.log(`  Total reqs:  ~${Math.round(config.rate * config.duration)} (measured) + ~${Math.round(config.rate * config.warmup)} (warmup)`);
    console.log(`  Lane:        ${config.lane}`);
    console.log(`  Prefix:      ${config.prefix}`);
    if (config.workload === 'lifecycle') {
        console.log(`  NOTE: Requires endorser_bot.js running for full lifecycle tracking`);
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

    // Run the load test
    const summary = await runLoadTest(config);

    // =========================================================================
    // PRINT & SAVE SUMMARY
    // =========================================================================
    const outDir = path.join(__dirname, 'runs', config.runId);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  EXPERIMENT 1 — LOAD TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Workload:          ${summary.metadata.workload}`);
    console.log(`  Target rate:       ${summary.throughput.target_ops} ops/sec`);
    console.log(`  Actual send rate:  ${summary.throughput.actual_send_rate_ops} ops/sec`);
    console.log(`  Throughput:        ${summary.throughput.actual_throughput_ops} ops/sec`);
    console.log('');
    console.log(`  Dispatched:        ${summary.counts.total_dispatched}`);
    console.log(`    Warmup:          ${summary.counts.warmup_excluded}`);
    console.log(`    Measured:        ${summary.counts.measured}`);
    console.log(`    OK:              ${summary.counts.measured_ok}`);
    console.log(`    Failed:          ${summary.counts.measured_fail}`);
    console.log(`    Success rate:    ${summary.counts.success_rate_pct}%`);
    console.log('');

    if (summary.propose_rtt) {
        console.log('  Propose RTT (OK, measured window):');
        console.log(`    Min:   ${summary.propose_rtt.min} ms`);
        console.log(`    P50:   ${summary.propose_rtt.p50} ms`);
        console.log(`    Mean:  ${summary.propose_rtt.mean} ± ${summary.propose_rtt.std} ms`);
        console.log(`    P95:   ${summary.propose_rtt.p95} ms`);
        console.log(`    P99:   ${summary.propose_rtt.p99} ms`);
        console.log(`    Max:   ${summary.propose_rtt.max} ms`);
    }

    if (summary.commit_confirm) {
        console.log('');
        console.log('  Commit-Confirmed Latency (send → SSE ACTIVE):');
        console.log(`    Min:   ${summary.commit_confirm.min} ms`);
        console.log(`    P50:   ${summary.commit_confirm.p50} ms`);
        console.log(`    Mean:  ${summary.commit_confirm.mean} ± ${summary.commit_confirm.std} ms`);
        console.log(`    P95:   ${summary.commit_confirm.p95} ms`);
        console.log(`    P99:   ${summary.commit_confirm.p99} ms`);
        console.log(`    Max:   ${summary.commit_confirm.max} ms`);
    }

    if (Object.keys(summary.error_breakdown).length > 0) {
        console.log('');
        console.log('  Error Breakdown:');
        const sorted = Object.entries(summary.error_breakdown).sort((a, b) => b[1] - a[1]);
        for (const [category, count] of sorted) {
            console.log(`    ${category}: ${count}`);
        }
    }

    if (summary.concurrency.estimated_mean !== null) {
        console.log('');
        console.log(`  Est. mean concurrency: ${summary.concurrency.estimated_mean}`);
    }

    console.log('═══════════════════════════════════════════════════════════════');

    // Save summary JSON
    const summaryPath = path.join(outDir, 'load_generator_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    log(`Summary saved: ${summaryPath}`);

    // Save config for reproducibility
    const configPath = path.join(outDir, 'load_generator_config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`Config saved: ${configPath}`);

    log('Done.');
}

main().catch(err => {
    logError(`Fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});