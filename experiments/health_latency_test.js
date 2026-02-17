#!/usr/bin/env node
/**
 * ==============================================================================
 * health_latency_test.js - Health endpoint latency measurement
 * PHASE 3: Measures /health round-trip N times, reports median/p95/p99.
 * 
 * USAGE:
 *   node health_latency_test.js --gateway http://localhost:3000 --run_id test1 --lane B --count 100
 *   node health_latency_test.js --gateway https://xxx.ngrok-free.app --run_id test1 --lane A --count 100
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = { gateway: 'http://localhost:3000', runId: 'adhoc', lane: 'B', count: 100, warmup: 5 };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--gateway': cfg.gateway = args[++i]; break;
            case '--run_id':  cfg.runId = args[++i]; break;
            case '--lane':    cfg.lane = args[++i]; break;
            case '--count':   cfg.count = parseInt(args[++i], 10); break;
            case '--warmup':  cfg.warmup = parseInt(args[++i], 10); break;
            case '--help':
                console.log('Usage: node health_latency_test.js --gateway <url> --run_id <id> --lane <A|B> --count <n>');
                process.exit(0);
        }
    }
    return cfg;
}

function httpGet(urlStr) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const transport = url.protocol === 'https:' ? https : http;
        const start = process.hrtime.bigint();
        const req = transport.get(url.href, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const end = process.hrtime.bigint();
                resolve({ status: res.statusCode, durationMs: Number(end - start) / 1e6, body: data });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function pct(sorted, p) { return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)]; }

async function main() {
    const cfg = parseArgs();
    const url = `${cfg.gateway}/health`;
    console.log(`Health Latency Test\n  URL: ${url}\n  Lane: ${cfg.lane}\n  Count: ${cfg.count} (+${cfg.warmup} warmup)\n`);

    for (let i = 0; i < cfg.warmup; i++) { try { await httpGet(url); } catch (_) {} }

    const samples = [];
    let fails = 0;
    for (let i = 0; i < cfg.count; i++) {
        try {
            const r = await httpGet(url);
            samples.push({ seq: i + 1, duration_ms: parseFloat(r.durationMs.toFixed(3)), status: r.status, ts: Date.now() });
        } catch (e) {
            fails++;
            samples.push({ seq: i + 1, duration_ms: -1, status: 0, error: e.message, ts: Date.now() });
        }
        if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${cfg.count}\r`);
    }
    console.log('');

    const dur = samples.filter(s => s.duration_ms > 0).map(s => s.duration_ms).sort((a, b) => a - b);
    if (!dur.length) { console.error('All failed!'); process.exit(1); }

    const stats = {
        count: dur.length, failures: fails,
        min_ms: dur[0], max_ms: dur[dur.length - 1],
        median_ms: pct(dur, 50), p95_ms: pct(dur, 95), p99_ms: pct(dur, 99),
        mean_ms: parseFloat((dur.reduce((a, b) => a + b, 0) / dur.length).toFixed(3))
    };

    console.log(`Results:\n  Count: ${stats.count} (${fails} failures)`);
    console.log(`  Min:    ${stats.min_ms.toFixed(1)} ms\n  Median: ${stats.median_ms.toFixed(1)} ms`);
    console.log(`  Mean:   ${stats.mean_ms.toFixed(1)} ms\n  P95:    ${stats.p95_ms.toFixed(1)} ms`);
    console.log(`  P99:    ${stats.p99_ms.toFixed(1)} ms\n  Max:    ${stats.max_ms.toFixed(1)} ms`);

    const outDir = path.join(__dirname, 'runs', cfg.runId);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `health_latency_lane${cfg.lane}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
        metadata: { run_id: cfg.runId, lane: cfg.lane, gateway: cfg.gateway, count: cfg.count, warmup: cfg.warmup, timestamp: new Date().toISOString() },
        stats, samples
    }, null, 2));
    console.log(`\nSaved: ${outFile}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });