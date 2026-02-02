#!/usr/bin/env node

/**
 * MR-Anchor-Registry CLI Tool
 * 
 * Usage:
 *   ./cli.js propose <asset_id> [--x=1] [--y=2] [--z=3]
 *   ./cli.js list <asset_id>
 *   ./cli.js resolve <asset_id>
 *   ./cli.js get <claim_id>
 *   ./cli.js history <claim_id>
 *   ./cli.js health
 * 
 * Environment:
 *   GATEWAY_URL=http://localhost:3000
 *   API_KEY=proposer-key-001
 */

const http = require('http');
const https = require('https');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'proposer-key-001';

// Parse URL
const gatewayUrl = new URL(GATEWAY_URL);
const httpModule = gatewayUrl.protocol === 'https:' ? https : http;

// =============================================================================
// HTTP Request Helper
// =============================================================================

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: gatewayUrl.hostname,
            port: gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? 443 : 80),
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            }
        };

        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject(new Error(json.error || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// =============================================================================
// Commands
// =============================================================================

async function cmdHealth() {
    console.log('Checking gateway health...\n');
    const result = await request('GET', '/health');
    console.log('Health Status:');
    console.log(`  Status:      ${result.status}`);
    console.log(`  PostgreSQL:  ${result.postgres}`);
    console.log(`  Fabric:      ${result.fabric}`);
    console.log(`  Mock Mode:   ${result.fabric_mock}`);
    console.log(`  SSE Clients: ${result.sse_clients || 0}`);
    console.log(`  Version:     ${result.version || 'unknown'}`);
    console.log(`  Timestamp:   ${result.timestamp}`);
}

async function cmdPropose(assetId, options = {}) {
    const x = parseFloat(options.x) || Math.random() * 10;
    const y = parseFloat(options.y) || Math.random() * 10;
    const z = parseFloat(options.z) || Math.random() * 10;
    
    console.log(`Proposing anchor for asset: ${assetId}`);
    console.log(`  Position: (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})\n`);
    
    const result = await request('POST', '/claims/propose', {
        asset_id: assetId,
        pose_site: {
            position: { x, y, z },
            rotation: { qx: 0, qy: 0, qz: 0, qw: 1 }
        },
        quality_metrics: {
            stability_rms: 0.02 + Math.random() * 0.01,
            confidence_mean: 0.85 + Math.random() * 0.1
        }
    });
    
    console.log('Proposal Created:');
    console.log(`  Claim ID:    ${result.claim_id}`);
    console.log(`  State:       ${result.state}`);
    console.log(`  Conflict:    ${result.conflict_classification}`);
    console.log(`  Payload:     ${result.payload_hash}`);
    console.log('\nNext: Use supervisor UI to approve or reject this claim.');
}

async function cmdList(assetId) {
    console.log(`Listing claims for asset: ${assetId}\n`);
    
    const result = await request('GET', `/assets/${encodeURIComponent(assetId)}/claims`);
    
    if (!result.claims || result.claims.length === 0) {
        console.log('No claims found for this asset.');
        return;
    }
    
    console.log(`Found ${result.count} claim(s):\n`);
    
    result.claims.forEach((c, i) => {
        console.log(`[${i + 1}] ${c.claimId}`);
        console.log(`    State:        ${c.state}`);
        console.log(`    Conflict:     ${c.conflictClassification}`);
        console.log(`    Endorsements: ${c.endorsementCount}`);
        console.log(`    Publisher:    ${c.publisherId}`);
        console.log(`    Created:      ${c.createdAt}`);
        if (c.state === 'REJECTED') {
            console.log(`    Rejected by:  ${c.rejectedBy}`);
            console.log(`    Reason:       ${c.rejectionReason}`);
        }
        if (c.state === 'REVOKED') {
            console.log(`    Revoked by:   ${c.revokedBy}`);
            console.log(`    Reason:       ${c.revocationReason}`);
        }
        console.log('');
    });
}

async function cmdResolve(assetId) {
    console.log(`Resolving active anchor for asset: ${assetId}\n`);
    
    const result = await request('GET', `/assets/${encodeURIComponent(assetId)}/resolve`);
    
    if (!result.claim_id) {
        console.log('No active anchor for this asset.');
        return;
    }
    
    console.log('Active Anchor:');
    console.log(`  Claim ID:      ${result.claim_id}`);
    console.log(`  State:         ${result.state}`);
    console.log(`  Activated:     ${result.activated_at}`);
    console.log(`  Publisher:     ${result.publisher_id}`);
    console.log(`  Endorsements:  ${result.endorsement_count}`);
    console.log(`  Verified:      ${result.payload_verified}`);
    
    if (result.payload) {
        console.log('\nPayload:');
        const pos = result.payload.pose_site?.position || {};
        console.log(`  Position:      (${pos.x}, ${pos.y}, ${pos.z})`);
        const qm = result.payload.quality_metrics || {};
        console.log(`  Stability:     ${qm.stability_rms}`);
        console.log(`  Confidence:    ${qm.confidence_mean}`);
    }
}

async function cmdGet(claimId) {
    console.log(`Getting claim: ${claimId}\n`);
    
    const result = await request('GET', `/claims/${encodeURIComponent(claimId)}`);
    
    if (!result.claim) {
        console.log('Claim not found.');
        return;
    }
    
    const c = result.claim;
    console.log('Claim Details:');
    console.log(`  Claim ID:      ${c.claimId}`);
    console.log(`  Asset ID:      ${c.assetId}`);
    console.log(`  State:         ${c.state}`);
    console.log(`  Publisher:     ${c.publisherId}`);
    console.log(`  Endorsements:  ${c.endorsementCount} (${(c.endorsers || []).join(', ') || 'none'})`);
    console.log(`  Conflict:      ${c.conflictClassification}`);
    console.log(`  Created:       ${c.createdAt}`);
    
    if (c.state === 'ACTIVE') {
        console.log(`  Activated:     ${c.activatedAt}`);
    }
    if (c.state === 'REJECTED') {
        console.log(`  Rejected by:   ${c.rejectedBy}`);
        console.log(`  Rejected at:   ${c.rejectedAt}`);
        console.log(`  Reason:        ${c.rejectionReason}`);
    }
    if (c.state === 'REVOKED') {
        console.log(`  Revoked by:    ${c.revokedBy}`);
        console.log(`  Revoked at:    ${c.revokedAt}`);
        console.log(`  Reason:        ${c.revocationReason}`);
    }
}

async function cmdHistory(claimId) {
    console.log(`Getting history for claim: ${claimId}\n`);
    
    const result = await request('GET', `/claims/${encodeURIComponent(claimId)}/history`);
    
    if (!result.history || result.history.length === 0) {
        console.log('No history found.');
        return;
    }
    
    console.log(`History (${result.history.length} entries):\n`);
    
    result.history.forEach((h, i) => {
        console.log(`[${i + 1}] ${h.timestamp}`);
        console.log(`    TX ID:  ${h.txId}`);
        console.log(`    State:  ${h.value?.state || 'N/A'}`);
        if (h.isDelete) console.log('    (deleted)');
        console.log('');
    });
}

// =============================================================================
// CLI Entry Point
// =============================================================================

function printUsage() {
    console.log(`
MR-Anchor-Registry CLI Tool v2.0

Usage:
  ./cli.js <command> [arguments] [options]

Commands:
  health                    Check gateway health status
  propose <asset_id>        Create a new anchor proposal
  list <asset_id>           List all claims for an asset
  resolve <asset_id>        Get the active anchor for an asset
  get <claim_id>            Get details of a specific claim
  history <claim_id>        Get ledger history for a claim

Options for propose:
  --x=<number>              X coordinate (default: random)
  --y=<number>              Y coordinate (default: random)
  --z=<number>              Z coordinate (default: random)

Environment Variables:
  GATEWAY_URL               Gateway URL (default: http://localhost:3000)
  API_KEY                   API key for authentication (default: proposer-key-001)

Examples:
  ./cli.js health
  ./cli.js propose my-desk --x=1.5 --y=2.0 --z=0.5
  ./cli.js list my-desk
  ./cli.js resolve my-desk
  ./cli.js get claim-abc123

API Keys:
  proposer-key-001          Proposer role (can create claims)
  endorser-key-001          Endorser role (can endorse claims)
  supervisor-key-001        Supervisor role (can approve/reject/revoke)
`);
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(0);
    }
    
    const command = args[0];
    const positionalArgs = args.slice(1).filter(a => !a.startsWith('--'));
    const options = {};
    
    args.slice(1).filter(a => a.startsWith('--')).forEach(a => {
        const [key, value] = a.slice(2).split('=');
        options[key] = value;
    });
    
    try {
        switch (command) {
            case 'health':
                await cmdHealth();
                break;
            case 'propose':
                if (!positionalArgs[0]) {
                    console.error('Error: asset_id required');
                    process.exit(1);
                }
                await cmdPropose(positionalArgs[0], options);
                break;
            case 'list':
                if (!positionalArgs[0]) {
                    console.error('Error: asset_id required');
                    process.exit(1);
                }
                await cmdList(positionalArgs[0]);
                break;
            case 'resolve':
                if (!positionalArgs[0]) {
                    console.error('Error: asset_id required');
                    process.exit(1);
                }
                await cmdResolve(positionalArgs[0]);
                break;
            case 'get':
                if (!positionalArgs[0]) {
                    console.error('Error: claim_id required');
                    process.exit(1);
                }
                await cmdGet(positionalArgs[0]);
                break;
            case 'history':
                if (!positionalArgs[0]) {
                    console.error('Error: claim_id required');
                    process.exit(1);
                }
                await cmdHistory(positionalArgs[0]);
                break;
            default:
                console.error(`Unknown command: ${command}`);
                printUsage();
                process.exit(1);
        }
    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    }
}

main();
