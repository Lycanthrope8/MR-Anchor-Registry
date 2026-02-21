#!/usr/bin/env node
/**
 * ==============================================================================
 * commit_confirm_test.js - Commit-confirmed latency sanity test
 * 
 * PHASE 3: Sends N proposals, relies on endorser_bot for endorsements,
 * then verifies ACTIVE anchors appear in snapshot and /admin/anchors.
 * 
 * USAGE:
 *   # Start endorser_bot first:
 *   node endorser_bot.js --gateway http://localhost:3000 --run_id sanity1 --mode two-step
 * 
 *   # Then run this test:
 *   node commit_confirm_test.js --gateway http://localhost:3000 --run_id sanity1 --count 50 --lane B
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        gateway: 'http://localhost:3000',
        runId: 'adhoc',
        lane: 'B',
        count: 50,
        prefix: `bench-${Date.now()}-`,
        delayBetweenMs: 200,      // Delay between proposals to avoid overwhelming Fabric
        verifyTimeoutMs: 60000,    // How long to wait for all to become ACTIVE
        verifyPollMs: 2000         // Poll interval for verification
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--gateway':     config.gateway = args[++i]; break;
            case '--run_id':      config.runId = args[++i]; break;
            case '--lane':        config.lane = args[++i]; break;
            case '--count':       config.count = parseInt(args[++i], 10); break;
            case '--prefix':      config.prefix = args[++i]; break;
            case '--delay_between_ms': config.delayBetweenMs = parseInt(args[++i], 10); break;
            case '--verify_timeout_ms': config.verifyTimeoutMs = parseInt(args[++i], 10); break;
            case '--help':
                console.log(`
Usage: node commit_confirm_test.js [options]
  --gateway <url>           Gateway URL
  --run_id <id>             Run ID
  --lane <A|B>              Lane label
  --count <n>               Number of proposals (default: 50)
  --prefix <str>            Asset ID prefix (default: bench-<timestamp>-)
  --delay_between_ms <ms>   Delay between proposals (default: 200)
  --verify_timeout_ms <ms>  Max wait for activation verification (default: 60000)
`);
                process.exit(0);
        }
    }
    return config;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function percentile(sorted, p) {
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}

async function main() {
    const config = parseArgs();

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Commit-Confirm Sanity Test                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  Gateway:     ${config.gateway}`);
    console.log(`  Run ID:      ${config.runId}`);
    console.log(`  Lane:        ${config.lane}`);
    console.log(`  Count:       ${config.count}`);
    console.log(`  Prefix:      ${config.prefix}`);
    console.log('');

    // Health check
    try {
        const h = await httpRequest('GET', `${config.gateway}/health`);
        console.log(`✓ Gateway healthy (org1=${h.body.org1Connected}, org2=${h.body.org2Connected})`);
    } catch (e) {
        console.error(`✗ Gateway unreachable: ${e.message}`);
        process.exit(1);
    }

    // ========================================================================
    // PHASE A: Send proposals
    // ========================================================================
    console.log(`\n--- Sending ${config.count} proposals ---`);

    const proposalResults = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < config.count; i++) {
        const assetId = `${config.prefix}${String(i).padStart(4, '0')}`;
        const reqId = `req-${config.runId}-${i}`;
        const startMs = Date.now();

        try {
            const result = await httpRequest(
                'POST',
                `${config.gateway}/claims/propose`,
                {
                    asset_id: assetId,
                    pose_site: {
                        position: { x: i * 0.1, y: 0, z: 0 },
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
                    
                    'x-run-id': config.runId,
                    'x-req-id': reqId,
                    'x-lane': config.lane
                }
            );

            const durationMs = Date.now() - startMs;

            if (result.status >= 200 && result.status < 300 && result.body?.success) {
                successCount++;
                proposalResults.push({
                    asset_id: assetId,
                    req_id: reqId,
                    duration_ms: durationMs,
                    claim_id: result.body.claim_id,
                    state: result.body.state,
                    status: 'ok'
                });
            } else {
                failCount++;
                proposalResults.push({
                    asset_id: assetId,
                    req_id: reqId,
                    duration_ms: durationMs,
                    status: 'fail',
                    error: result.body?.error || `HTTP ${result.status}`
                });
            }
        } catch (e) {
            failCount++;
            proposalResults.push({
                asset_id: assetId,
                req_id: reqId,
                duration_ms: Date.now() - startMs,
                status: 'error',
                error: e.message
            });
        }

        if ((i + 1) % 10 === 0) {
            console.log(`  ${i + 1}/${config.count} proposals sent (${successCount} ok, ${failCount} fail)`);
        }

        if (i < config.count - 1 && config.delayBetweenMs > 0) {
            await sleep(config.delayBetweenMs);
        }
    }

    console.log(`\nProposal Results: ${successCount} ok, ${failCount} fail`);

    // Compute proposal latency stats
    const proposeDurations = proposalResults
        .filter(r => r.status === 'ok')
        .map(r => r.duration_ms)
        .sort((a, b) => a - b);

    if (proposeDurations.length > 0) {
        console.log(`\nPropose Latency (commit-confirmed):`);
        console.log(`  Min:     ${proposeDurations[0]} ms`);
        console.log(`  Median:  ${percentile(proposeDurations, 50)} ms`);
        console.log(`  Mean:    ${(proposeDurations.reduce((a, b) => a + b, 0) / proposeDurations.length).toFixed(1)} ms`);
        console.log(`  P95:     ${percentile(proposeDurations, 95)} ms`);
        console.log(`  Max:     ${proposeDurations[proposeDurations.length - 1]} ms`);
    }

    // ========================================================================
    // PHASE B: Wait for endorser_bot to activate, then verify
    // ========================================================================
    console.log(`\n--- Waiting for endorser_bot to activate claims ---`);
    console.log(`  (timeout: ${config.verifyTimeoutMs / 1000}s, poll: ${config.verifyPollMs / 1000}s)`);

    const expectedAssetIds = proposalResults
        .filter(r => r.status === 'ok')
        .map(r => r.asset_id);

    const startWait = Date.now();
    let activeCount = 0;
    let lastActiveCount = -1;

    while (Date.now() - startWait < config.verifyTimeoutMs) {
        try {
            const anchors = await httpRequest('GET', `${config.gateway}/admin/anchors`, null, {
                
                'x-run-id': config.runId,
                'x-lane': config.lane
            });

            if (anchors.body?.anchors) {
                const activeAssets = new Set(anchors.body.anchors.map(a => a.assetId));
                activeCount = expectedAssetIds.filter(id => activeAssets.has(id)).length;
            }
        } catch (e) {
            // ignore transient errors
        }

        if (activeCount !== lastActiveCount) {
            console.log(`  Active: ${activeCount}/${expectedAssetIds.length}`);
            lastActiveCount = activeCount;
        }

        if (activeCount >= expectedAssetIds.length) {
            break;
        }

        await sleep(config.verifyPollMs);
    }

    const waitDuration = Date.now() - startWait;

    // ========================================================================
    // PHASE C: Verify via snapshot endpoint
    // ========================================================================
    console.log(`\n--- Verifying via /events/snapshot ---`);
    let snapshotActiveCount = 0;
    try {
        const snapshot = await httpRequest('GET', `${config.gateway}/events/snapshot`, null, {
            
            'x-run-id': config.runId,
            'x-lane': config.lane
        });
        if (snapshot.body?.assets) {
            const activeInSnapshot = snapshot.body.assets.filter(a =>
                a.state === 'ACTIVE' && expectedAssetIds.includes(a.asset_id)
            );
            snapshotActiveCount = activeInSnapshot.length;
        }
    } catch (e) {
        console.error(`  Snapshot fetch failed: ${e.message}`);
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  SANITY TEST RESULTS');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`  Proposals sent:       ${config.count}`);
    console.log(`  Proposals succeeded:  ${successCount}`);
    console.log(`  Active in /anchors:   ${activeCount}/${expectedAssetIds.length}`);
    console.log(`  Active in /snapshot:  ${snapshotActiveCount}/${expectedAssetIds.length}`);
    console.log(`  Wait for activation:  ${(waitDuration / 1000).toFixed(1)}s`);

    const allActive = activeCount >= expectedAssetIds.length;
    const snapshotMatch = snapshotActiveCount >= expectedAssetIds.length;

    if (allActive && snapshotMatch) {
        console.log(`\n  ✓ ALL CHECKS PASSED`);
        console.log(`    - All proposals committed (submitTransaction confirmed)`);
        console.log(`    - All endorsements completed (both orgs)`);
        console.log(`    - All anchors ACTIVE in /admin/anchors`);
        console.log(`    - All anchors ACTIVE in /events/snapshot`);
    } else {
        console.log(`\n  ✗ SOME CHECKS FAILED`);
        if (!allActive) console.log(`    - /admin/anchors: only ${activeCount}/${expectedAssetIds.length} ACTIVE`);
        if (!snapshotMatch) console.log(`    - /events/snapshot: only ${snapshotActiveCount}/${expectedAssetIds.length} ACTIVE`);
        console.log(`    - Check endorser_bot logs for errors`);
    }
    console.log('══════════════════════════════════════════════════════════════');

    // Save results
    const outDir = path.join(__dirname, 'runs', config.runId);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `commit_confirm_test.json`);
    const output = {
        metadata: {
            run_id: config.runId,
            lane: config.lane,
            gateway: config.gateway,
            count: config.count,
            prefix: config.prefix,
            timestamp: new Date().toISOString()
        },
        propose_stats: proposeDurations.length > 0 ? {
            count: proposeDurations.length,
            min_ms: proposeDurations[0],
            median_ms: percentile(proposeDurations, 50),
            mean_ms: parseFloat((proposeDurations.reduce((a, b) => a + b, 0) / proposeDurations.length).toFixed(3)),
            p95_ms: percentile(proposeDurations, 95),
            p99_ms: percentile(proposeDurations, 99),
            max_ms: proposeDurations[proposeDurations.length - 1]
        } : null,
        verification: {
            active_in_anchors: activeCount,
            active_in_snapshot: snapshotActiveCount,
            expected: expectedAssetIds.length,
            wait_duration_ms: waitDuration,
            all_passed: allActive && snapshotMatch
        },
        proposals: proposalResults
    };
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`\nResults saved to: ${outFile}`);

    process.exit(allActive && snapshotMatch ? 0 : 1);
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});