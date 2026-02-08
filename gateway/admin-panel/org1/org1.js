/**
 * ==============================================================================
 * Org1 Admin Panel - JavaScript
 * MR Anchor Registry - Dual Endorsement Workflow
 * ==============================================================================
 */

const API_BASE = window.location.origin;
const ORG_ID = 'org1';
const MY_MSP_ID = 'Org1MSP';
const OTHER_MSP_ID = 'Org2MSP';
const API_KEY = 'proposer-key-001';

let sseConnection = null;
let isConnected = false;
let eventCounter = 0;

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    connectSSE();
    refreshAll();
    wireEvents();
    logEvent('system', 'Org1 Admin Panel initialized');
});

function wireEvents() {
    document.getElementById('revokeForm')?.addEventListener('submit', initiateRevoke);
    document.getElementById('queryForm')?.addEventListener('submit', queryClaim);
}

// =============================================================================
// SSE Connection
// =============================================================================

function connectSSE() {
    const url = `${API_BASE}/events/stream`;
    logEvent('system', 'Connecting to SSE...');
    
    sseConnection = new EventSource(url);
    
    sseConnection.onopen = () => {
        updateConnectionStatus(true);
        logEvent('connected', 'Real-time connection established');
    };
    
    sseConnection.onerror = () => {
        updateConnectionStatus(false);
        logEvent('system', 'Connection lost. Reconnecting...');
        setTimeout(connectSSE, 5000);
    };
    
    // Event handlers
    sseConnection.addEventListener('CONNECTED', () => {
        updateConnectionStatus(true);
    });
    
    sseConnection.addEventListener('CLAIM_PROPOSED', (e) => {
        const data = parseEventData(e);
        logEvent('proposed', `New claim: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('New claim proposed - awaiting endorsements', 'warning');
        refreshPending();
    });
    
    sseConnection.addEventListener('CLAIM_ENDORSED_ORG1', (e) => {
        const data = parseEventData(e);
        logEvent('endorsed', `Org1 endorsed: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Org1 endorsed! Waiting for Org2...', 'success');
        refreshPending();
    });
    
    sseConnection.addEventListener('CLAIM_ENDORSED_ORG2', (e) => {
        const data = parseEventData(e);
        logEvent('endorsed', `Org2 endorsed: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Org2 endorsed! Waiting for Org1...', 'success');
        refreshPending();
    });
    
    sseConnection.addEventListener('CLAIM_ACTIVATED', (e) => {
        const data = parseEventData(e);
        logEvent('activated', `ACTIVE: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('🎉 Claim ACTIVATED - Both orgs endorsed!', 'success');
        refreshAll();
    });
    
    sseConnection.addEventListener('CLAIM_REJECTED', (e) => {
        const data = parseEventData(e);
        logEvent('rejected', `Rejected: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Claim rejected', 'error');
        refreshPending();
    });
    
    sseConnection.addEventListener('REVOKE_INITIATED', (e) => {
        const data = parseEventData(e);
        logEvent('revoked', `Revoke initiated: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Revocation initiated', 'warning');
        refreshRevocations();
    });
    
    sseConnection.addEventListener('CLAIM_REVOKED', (e) => {
        const data = parseEventData(e);
        logEvent('revoked', `Revoked: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Anchor revoked', 'error');
        refreshAll();
    });
    
    sseConnection.addEventListener('REVOKE_REJECTED', (e) => {
        const data = parseEventData(e);
        logEvent('system', `Revoke rejected: ${data.assetId || data.asset_id || 'unknown'}`);
        showToast('Revocation rejected - anchor preserved', 'success');
        refreshRevocations();
    });
    
    sseConnection.addEventListener('HEARTBEAT', () => {
        // Keep connection alive indicator
    });
}

function parseEventData(e) {
    try {
        return JSON.parse(e.data);
    } catch {
        return {};
    }
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const pill = document.getElementById('ssePill');
    const statusText = document.getElementById('statusText');
    
    if (pill) {
        pill.classList.toggle('connected', connected);
    }
    if (statusText) {
        statusText.textContent = connected ? 'Connected' : 'Disconnected';
    }
}

// =============================================================================
// API Helper
// =============================================================================

async function apiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'x-org-id': ORG_ID
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// =============================================================================
// Refresh Functions
// =============================================================================

function refreshAll() {
    refreshAnchors();
    refreshPending();
    refreshRevocations();
}

async function refreshAnchors() {
    const tbody = document.getElementById('anchorsBody');
    if (!tbody) return;
    
    try {
        const data = await apiRequest('/admin/anchors');
        const anchors = data.anchors || [];
        
        updateStat('activeCount', anchors.length);
        
        if (anchors.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">No active anchors</td></tr>';
            return;
        }
        
        tbody.innerHTML = anchors.map(a => `
            <tr>
                <td><code>${a.assetId}</code></td>
                <td><code title="${a.claimId}">${(a.claimId || 'N/A').substring(0, 20)}...</code></td>
                <td>
                    <div class="endorsement-status">
                        <span class="org"><span class="check">✓</span> Org1</span>
                        <span class="org"><span class="check">✓</span> Org2</span>
                    </div>
                </td>
                <td class="muted">${formatDate(a.activatedAt)}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn danger small" onclick="initiateRevokeQuick('${a.assetId}')">Revoke</button>
                        <button class="btn small" onclick="viewClaimDetails('${a.assetId}')">Details</button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">Error: ${error.message}</td></tr>`;
    }
}

async function refreshPending() {
    const tbody = document.getElementById('pendingBody');
    if (!tbody) return;
    
    try {
        const data = await apiRequest('/events/snapshot');
        const allClaims = data.assets || [];
        
        const pendingClaims = allClaims.filter(c => 
            c.state === 'PROPOSED' || 
            c.state === 'ENDORSED_ORG1' || 
            c.state === 'ENDORSED_ORG2'
        );
        
        const needMyAction = pendingClaims.filter(c => !c.endorsed_org1);
        
        updateStat('pendingCount', pendingClaims.length);
        updateStat('actionCount', needMyAction.length);
        
        if (pendingClaims.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">No pending claims</td></tr>';
            return;
        }
        
        let html = '';
        
        // Action required section
        if (needMyAction.length > 0) {
            html += needMyAction.map(c => renderPendingRow(c, true)).join('');
        }
        
        // Waiting for other org
        const waitingForOther = pendingClaims.filter(c => c.endorsed_org1 && !c.endorsed_org2);
        if (waitingForOther.length > 0) {
            html += waitingForOther.map(c => renderPendingRow(c, false)).join('');
        }
        
        tbody.innerHTML = html || '<tr><td colspan="5" class="muted">No pending claims</td></tr>';
        
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">Error: ${error.message}</td></tr>`;
    }
}

function renderPendingRow(claim, canAct) {
    const org1Done = claim.endorsed_org1;
    const org2Done = claim.endorsed_org2;
    
    const endorsementHtml = `
        <div class="endorsement-status">
            <span class="org"><span class="${org1Done ? 'check' : 'wait'}">${org1Done ? '✓' : '○'}</span> Org1</span>
            <span class="org"><span class="${org2Done ? 'check' : 'wait'}">${org2Done ? '✓' : '○'}</span> Org2</span>
        </div>
    `;
    
    const statusBadge = canAct 
        ? '<span class="badge action">Needs Your Action</span>'
        : '<span class="badge info">Waiting for Org2</span>';
    
    const actions = canAct 
        ? `<div class="btn-group">
               <button class="btn good small" onclick="endorseClaim('${claim.asset_id}')">✓ Endorse</button>
               <button class="btn danger small" onclick="rejectClaim('${claim.asset_id}')">✗ Reject</button>
           </div>`
        : `<span class="muted">Waiting...</span>`;
    
    return `
        <tr class="${canAct ? 'action-row' : ''}">
            <td><code>${claim.asset_id}</code></td>
            <td class="muted">${claim.proposed_via_org || 'Device'}</td>
            <td>${endorsementHtml}</td>
            <td>${statusBadge}</td>
            <td>${actions}</td>
        </tr>
    `;
}

async function refreshRevocations() {
    try {
        const data = await apiRequest('/admin/pending-revocations');
        const all = data.pendingRevocations || [];
        const myRevocations = all.filter(r => r.initiatedBy === MY_MSP_ID);
        const theirRevocations = all.filter(r => r.initiatedBy === OTHER_MSP_ID);
        
        updateStat('revokeCount', all.length);
        
        // My revocations
        const myBody = document.getElementById('myRevocationsBody');
        if (myBody) {
            myBody.innerHTML = myRevocations.length === 0 
                ? '<tr><td colspan="4" class="muted">No pending revocations initiated by you</td></tr>'
                : myRevocations.map(r => `
                    <tr>
                        <td><code>${r.assetId}</code></td>
                        <td class="muted">${r.reason || 'N/A'}</td>
                        <td class="muted">${formatDate(r.initiatedAt)}</td>
                        <td><span class="badge warn">Waiting for Org2</span></td>
                    </tr>
                `).join('');
        }
        
        // Their revocations
        const theirBody = document.getElementById('theirRevocationsBody');
        if (theirBody) {
            theirBody.innerHTML = theirRevocations.length === 0 
                ? '<tr><td colspan="4" class="muted">No revocations awaiting your response</td></tr>'
                : theirRevocations.map(r => `
                    <tr class="action-row">
                        <td><code>${r.assetId}</code></td>
                        <td class="muted">${r.initiatedBy}</td>
                        <td class="muted">${r.reason || 'N/A'}</td>
                        <td>
                            <div class="btn-group">
                                <button class="btn good small" onclick="endorseRevoke('${r.assetId}')">Approve</button>
                                <button class="btn danger small" onclick="rejectRevoke('${r.assetId}')">Reject</button>
                            </div>
                        </td>
                    </tr>
                `).join('');
        }
    } catch (error) {
        console.error('Error loading revocations:', error);
    }
}

function updateStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// =============================================================================
// Claim Actions
// =============================================================================

async function endorseClaim(assetId) {
    if (!confirm(`Endorse claim for ${assetId}?\n\nThis adds Org1's approval. The claim becomes ACTIVE once both organizations endorse.`)) return;
    
    try {
        const result = await apiRequest('/admin/endorse-claim', 'POST', { asset_id: assetId });
        if (result.is_fully_endorsed) {
            showToast('🎉 Claim ACTIVATED!', 'success');
        } else {
            showToast('✓ Endorsed. Waiting for Org2...', 'success');
        }
        refreshAll();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function rejectClaim(assetId) {
    const reason = prompt('Reason for rejection:');
    if (reason === null) return;
    
    try {
        await apiRequest('/admin/reject-claim', 'POST', { asset_id: assetId, reason });
        showToast('Claim rejected', 'success');
        refreshPending();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// =============================================================================
// Revocation Actions
// =============================================================================

function initiateRevokeQuick(assetId) {
    document.getElementById('revokeAssetId').value = assetId;
    document.getElementById('revokeAssetId').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function initiateRevoke(event) {
    event.preventDefault();
    const assetId = document.getElementById('revokeAssetId').value.trim();
    const reason = document.getElementById('revokeReason').value.trim();
    
    if (!assetId || !reason) {
        showToast('Asset ID and reason are required', 'error');
        return;
    }
    
    if (!confirm(`Initiate revocation for ${assetId}?\n\nOrg2 will need to approve this.`)) return;
    
    try {
        await apiRequest('/admin/revoke', 'POST', { asset_id: assetId, reason });
        showToast('Revocation initiated', 'warning');
        document.getElementById('revokeForm').reset();
        refreshRevocations();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function endorseRevoke(assetId) {
    if (!confirm(`Approve revocation of ${assetId}?\n\nThis will PERMANENTLY DELETE the anchor.`)) return;
    
    try {
        await apiRequest('/admin/endorse-revoke', 'POST', { asset_id: assetId });
        showToast('Revocation complete', 'success');
        refreshAll();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function rejectRevoke(assetId) {
    const reason = prompt('Reason for rejecting revocation:');
    if (reason === null) return;
    
    try {
        await apiRequest('/admin/reject-revoke', 'POST', { asset_id: assetId, reason });
        showToast('Revocation rejected - anchor preserved', 'success');
        refreshRevocations();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// =============================================================================
// Query Actions
// =============================================================================

async function queryClaim(event) {
    event.preventDefault();
    const assetId = document.getElementById('queryAssetId').value.trim();
    const resultBox = document.getElementById('queryResult');
    
    if (!assetId) {
        showToast('Enter an asset ID', 'error');
        return;
    }
    
    try {
        const result = await apiRequest(`/claims/${assetId}`);
        resultBox.textContent = JSON.stringify(result, null, 2);
        resultBox.classList.add('visible');
    } catch (error) {
        resultBox.textContent = `Error: ${error.message}`;
        resultBox.classList.add('visible');
    }
}

async function viewClaimDetails(assetId) {
    document.getElementById('queryAssetId').value = assetId;
    await queryClaim({ preventDefault: () => {} });
    document.getElementById('queryResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// =============================================================================
// Event Log
// =============================================================================

function logEvent(type, message) {
    const log = document.getElementById('eventLog');
    if (!log) return;
    
    eventCounter++;
    const time = new Date().toLocaleTimeString();
    
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
        <span class="time">${time}</span>
        <span class="type ${type}">${type}</span>
        <span class="message">${message}</span>
    `;
    
    log.insertBefore(entry, log.firstChild);
    
    // Keep only last 50 entries
    while (log.children.length > 50) {
        log.removeChild(log.lastChild);
    }
}

function clearLog() {
    const log = document.getElementById('eventLog');
    if (log) log.innerHTML = '';
    eventCounter = 0;
    logEvent('system', 'Log cleared');
}

// =============================================================================
// Helpers
// =============================================================================

function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    try {
        return new Date(dateStr).toLocaleString();
    } catch {
        return dateStr;
    }
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    
    toast.textContent = message;
    toast.className = `toast ${type} visible`;
    
    setTimeout(() => {
        toast.classList.remove('visible');
    }, 4000);
}

// Make functions globally available
window.refreshAll = refreshAll;
window.refreshAnchors = refreshAnchors;
window.refreshPending = refreshPending;
window.refreshRevocations = refreshRevocations;
window.endorseClaim = endorseClaim;
window.rejectClaim = rejectClaim;
window.initiateRevokeQuick = initiateRevokeQuick;
window.endorseRevoke = endorseRevoke;
window.rejectRevoke = rejectRevoke;
window.viewClaimDetails = viewClaimDetails;
window.clearLog = clearLog;