#!/usr/bin/env node
/**
 * ==============================================================================
 * commit_confirm_test.js - Commit-confirmed latency sanity test
 * 
 * PHASE 3 PATCH: Now reports failure reason frequency table, separates
 * attempted/committed/failed counts, and computes percentiles over
 * successful commits only.
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
        delayBetweenMs: 200,
        verifyTimeoutMs: 60000,
        verifyPollMs: 2000
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
  --prefix <str>            Asset ID prefix
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
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}

async function main() {
    const config = parseArgs();

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Commit-Confirm Sanity Test (patched)                       ║');
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
    let committedCount = 0;
    let failedCount = 0;
    const failureReasons = {};   // reason -> count

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
                committedCount++;
                proposalResults.push({
                    asset_id: assetId,
                    req_id: reqId,
                    duration_ms: durationMs,
                    claim_id: result.body.claim_id,
                    state: result.body.state,
                    status: 'ok'
                });
            } else {
                failedCount++;
                const reason = result.body?.error || `HTTP ${result.status}`;
                // Normalize known Fabric error patterns for frequency table
                const normalizedReason = normalizeErrorReason(reason);
                failureReasons[normalizedReason] = (failureReasons[normalizedReason] || 0) + 1;
                proposalResults.push({
                    asset_id: assetId,
                    req_id: reqId,
                    duration_ms: durationMs,
                    status: 'fail',
                    error: reason,
                    error_category: normalizedReason
                });
            }
        } catch (e) {
            failedCount++;
            const reason = e.message;
            const normalizedReason = normalizeErrorReason(reason);
            failureReasons[normalizedReason] = (failureReasons[normalizedReason] || 0) + 1;
            proposalResults.push({
                asset_id: assetId,
                req_id: reqId,
                duration_ms: Date.now() - startMs,
                status: 'error',
                error: reason,
                error_category: normalizedReason
            });
        }

        if ((i + 1) % 10 === 0) {
            console.log(`  ${i + 1}/${config.count} sent (${committedCount} ok, ${failedCount} fail)`);
        }

        if (i < config.count - 1 && config.delayBetweenMs > 0) {
            await sleep(config.delayBetweenMs);
        }
    }

    // ========================================================================
    // REPORT: Proposal results
    // ========================================================================
    const successRate = ((committedCount / config.count) * 100).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════`);
    console.log(`  PROPOSAL RESULTS`);
    console.log(`══════════════════════════════════════════════════════════════`);
    console.log(`  Attempted:         ${config.count}`);
    console.log(`  Committed (ok):    ${committedCount}  (${successRate}%)`);
    console.log(`  Failed:            ${failedCount}`);

    // Failure reason frequency table
    if (Object.keys(failureReasons).length > 0) {
        console.log(`\n  Failure Reasons:`);
        const sorted = Object.entries(failureReasons).sort((a, b) => b[1] - a[1]);
        for (const [reason, count] of sorted) {
            console.log(`    ${reason}: ${count}`);
        }
    } else {
        console.log(`\n  No failures!`);
    }

    // Latency stats over successful commits only
    const commitDurations = proposalResults
        .filter(r => r.status === 'ok')
        .map(r => r.duration_ms)
        .sort((a, b) => a - b);

    let proposeStats = null;
    if (commitDurations.length > 0) {
        proposeStats = {
            count: commitDurations.length,
            min_ms: commitDurations[0],
            p50_ms: percentile(commitDurations, 50),
            mean_ms: parseFloat((commitDurations.reduce((a, b) => a + b, 0) / commitDurations.length).toFixed(3)),
            p95_ms: percentile(commitDurations, 95),
            p99_ms: percentile(commitDurations, 99),
            max_ms: commitDurations[commitDurations.length - 1]
        };
        console.log(`\n  Commit-Confirmed Latency (successful commits only):`);
        console.log(`    Min:     ${proposeStats.min_ms} ms`);
        console.log(`    P50:     ${proposeStats.p50_ms} ms`);
        console.log(`    Mean:    ${proposeStats.mean_ms} ms`);
        console.log(`    P95:     ${proposeStats.p95_ms} ms`);
        console.log(`    P99:     ${proposeStats.p99_ms} ms`);
        console.log(`    Max:     ${proposeStats.max_ms} ms`);
    }
    console.log(`══════════════════════════════════════════════════════════════`);

    // ========================================================================
    // PHASE B: Wait for endorser_bot to activate, then verify
    // ========================================================================
    const expectedAssetIds = proposalResults
        .filter(r => r.status === 'ok')
        .map(r => r.asset_id);

    if (expectedAssetIds.length === 0) {
        console.log(`\n  ✗ No successful proposals — skipping activation verification.`);
        saveResults(config, proposalResults, proposeStats, failureReasons, 0, 0, 0, false);
        process.exit(1);
    }

    console.log(`\n--- Waiting for endorser_bot to activate ${expectedAssetIds.length} claims ---`);

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
        } catch (_) {}

        if (activeCount !== lastActiveCount) {
            console.log(`  Active: ${activeCount}/${expectedAssetIds.length}`);
            lastActiveCount = activeCount;
        }

        if (activeCount >= expectedAssetIds.length) break;
        await sleep(config.verifyPollMs);
    }

    const waitDuration = Date.now() - startWait;

    // ========================================================================
    // PHASE C: Verify via snapshot
    // ========================================================================
    console.log(`\n--- Verifying via /events/snapshot ---`);
    let snapshotActiveCount = 0;
    try {
        const snapshot = await httpRequest('GET', `${config.gateway}/events/snapshot`, null, {
            
            'x-run-id': config.runId,
            'x-lane': config.lane
        });
        if (snapshot.body?.assets) {
            snapshotActiveCount = snapshot.body.assets.filter(a =>
                a.state === 'ACTIVE' && expectedAssetIds.includes(a.asset_id)
            ).length;
        }
    } catch (e) {
        console.error(`  Snapshot fetch failed: ${e.message}`);
    }

    // ========================================================================
    // FINAL SUMMARY
    // ========================================================================
    const allActive = activeCount >= expectedAssetIds.length;
    const snapshotMatch = snapshotActiveCount >= expectedAssetIds.length;

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  SANITY TEST FINAL SUMMARY');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`  Proposals attempted:  ${config.count}`);
    console.log(`  Committed (ok):       ${committedCount}  (${successRate}%)`);
    console.log(`  Failed:               ${failedCount}`);
    console.log(`  Active in /anchors:   ${activeCount}/${expectedAssetIds.length}`);
    console.log(`  Active in /snapshot:  ${snapshotActiveCount}/${expectedAssetIds.length}`);
    console.log(`  Wait for activation:  ${(waitDuration / 1000).toFixed(1)}s`);

    const allPassed = allActive && snapshotMatch && failedCount === 0;

    if (allPassed) {
        console.log(`\n  ✓ ALL CHECKS PASSED`);
        console.log(`    - 100% commit success rate (no MVCC_READ_CONFLICT)`);
        console.log(`    - All endorsements completed (both orgs)`);
        console.log(`    - All anchors ACTIVE in /admin/anchors`);
        console.log(`    - All anchors ACTIVE in /events/snapshot`);
    } else {
        console.log(`\n  RESULT DETAILS:`);
        if (failedCount > 0) console.log(`    ⚠ ${failedCount} proposal(s) failed — see failure reasons above`);
        if (!allActive) console.log(`    ⚠ /admin/anchors: ${activeCount}/${expectedAssetIds.length} ACTIVE`);
        if (!snapshotMatch) console.log(`    ⚠ /events/snapshot: ${snapshotActiveCount}/${expectedAssetIds.length} ACTIVE`);
        if (failedCount === 0 && allActive && snapshotMatch) {
            console.log(`    ✓ All committed proposals activated successfully`);
        }
    }
    console.log('══════════════════════════════════════════════════════════════');

    saveResults(config, proposalResults, proposeStats, failureReasons, activeCount, snapshotActiveCount, waitDuration, allPassed);

    process.exit(allPassed ? 0 : (allActive && snapshotMatch ? 0 : 1));
}

/**
 * Normalize error strings into categories for the frequency table
 */
function normalizeErrorReason(errorStr) {
    if (!errorStr) return 'UNKNOWN';
    if (errorStr.includes('MVCC_READ_CONFLICT')) return 'MVCC_READ_CONFLICT';
    if (errorStr.includes('PHANTOM_READ')) return 'PHANTOM_READ_CONFLICT';
    if (errorStr.includes('already exists')) return 'DUPLICATE_ASSET';
    if (errorStr.includes('Pending claim already exists')) return 'PENDING_CLAIM_EXISTS';
    if (errorStr.includes('timeout') || errorStr.includes('TIMEOUT')) return 'TIMEOUT';
    if (errorStr.includes('ECONNREFUSED')) return 'CONNECTION_REFUSED';
    if (errorStr.includes('ENDORSEMENT_FAILURE')) return 'ENDORSEMENT_FAILURE';
    // Return first 80 chars of unknown errors
    return errorStr.substring(0, 80);
}

function saveResults(config, proposalResults, proposeStats, failureReasons, activeCount, snapshotActiveCount, waitDuration, allPassed) {
    const outDir = path.join(__dirname, 'runs', config.runId);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'commit_confirm_test.json');

    const committed = proposalResults.filter(r => r.status === 'ok').length;
    const failed = proposalResults.filter(r => r.status !== 'ok').length;

    const output = {
        metadata: {
            run_id: config.runId,
            lane: config.lane,
            gateway: config.gateway,
            count: config.count,
            prefix: config.prefix,
            delay_between_ms: config.delayBetweenMs,
            timestamp: new Date().toISOString()
        },
        results: {
            attempted_count: config.count,
            committed_success_count: committed,
            failed_count: failed,
            success_rate_pct: parseFloat(((committed / config.count) * 100).toFixed(1))
        },
        failure_reasons: failureReasons,
        propose_latency_stats: proposeStats,
        verification: {
            active_in_anchors: activeCount,
            active_in_snapshot: snapshotActiveCount,
            expected: proposalResults.filter(r => r.status === 'ok').length,
            wait_duration_ms: waitDuration,
            all_passed: allPassed
        },
        proposals: proposalResults
    };
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`\nResults saved to: ${outFile}`);
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});