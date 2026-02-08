/**
 * ==============================================================================
 * org2.js - Org2 Admin Panel JavaScript
 * DUAL ENDORSEMENT - Both Org1 AND Org2 must explicitly endorse
 * ==============================================================================
 */

const API_BASE = window.location.origin;
const ORG_ID = 'org2';
const MY_MSP_ID = 'Org2MSP';
const OTHER_MSP_ID = 'Org1MSP';
const API_KEY = 'proposer-key-001';

let sseConnection = null;
let isConnected = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    connectSSE();
    refreshAll();
    
    // Set up form handlers
    document.getElementById('revokeForm')?.addEventListener('submit', initiateRevoke);
    document.getElementById('queryForm')?.addEventListener('submit', queryClaim);
});

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const contents = document.querySelectorAll('.tab-content');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(targetId).classList.add('active');
        });
    });
}

// SSE Connection
function connectSSE() {
    const url = `${API_BASE}/events/stream`;
    sseConnection = new EventSource(url);
    
    sseConnection.onopen = () => {
        updateConnectionStatus(true);
        showToast('Connected to event stream', 'success');
    };
    
    sseConnection.onerror = () => {
        updateConnectionStatus(false);
        setTimeout(connectSSE, 5000);
    };
    
    // Event handlers
    sseConnection.addEventListener('CONNECTED', () => updateConnectionStatus(true));
    sseConnection.addEventListener('CLAIM_PROPOSED', (e) => {
        showToast('New claim proposed - awaiting dual endorsement', 'warning');
        refreshPending();
    });
    sseConnection.addEventListener('CLAIM_ENDORSED_ORG1', (e) => {
        showToast('Org1 endorsed! Waiting for Org2...', 'success');
        refreshPending();
    });
    sseConnection.addEventListener('CLAIM_ENDORSED_ORG2', (e) => {
        showToast('Org2 endorsed! Waiting for Org1...', 'success');
        refreshPending();
    });
    sseConnection.addEventListener('CLAIM_ACTIVATED', (e) => {
        showToast('🎉 Claim ACTIVATED - Both orgs endorsed!', 'success');
        refreshAll();
    });
    sseConnection.addEventListener('CLAIM_REJECTED', () => {
        showToast('Claim rejected', 'error');
        refreshPending();
    });
    sseConnection.addEventListener('REVOKE_INITIATED', () => {
        showToast('Revocation initiated', 'warning');
        refreshRevocations();
    });
    sseConnection.addEventListener('CLAIM_REVOKED', () => {
        showToast('Anchor revoked', 'error');
        refreshAll();
    });
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const indicator = document.getElementById('connectionStatus');
    const statusText = document.getElementById('statusText');
    if (indicator) indicator.classList.toggle('connected', connected);
    if (statusText) statusText.textContent = connected ? 'Connected (Org2)' : 'Disconnected';
}

// API Helper
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

// Refresh functions
function refreshAll() {
    refreshAnchors();
    refreshPending();
    refreshRevocations();
}

async function refreshAnchors() {
    const tbody = document.getElementById('anchorsBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading...</td></tr>';
    
    try {
        const data = await apiRequest('/admin/anchors');
        if (!data.anchors || data.anchors.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="loading">No active anchors</td></tr>';
            return;
        }
        
        tbody.innerHTML = data.anchors.map(a => `
            <tr>
                <td><code>${a.assetId}</code></td>
                <td><code title="${a.claimId}">${(a.claimId || 'N/A').substring(0, 16)}...</code></td>
                <td>✅ Org1 | ✅ Org2</td>
                <td>${formatDate(a.activatedAt)}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-danger btn-small" onclick="initiateRevokeQuick('${a.assetId}')">Revoke</button>
                        <button class="btn btn-primary btn-small" onclick="viewClaimDetails('${a.assetId}')">Details</button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="loading">Error: ${error.message}</td></tr>`;
    }
}

async function refreshPending() {
    const tbody = document.getElementById('pendingBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';
    
    try {
        const data = await apiRequest('/events/snapshot');
        const allClaims = data.assets || [];
        
        // Filter to claims that need endorsement (not ACTIVE, not REJECTED, not REVOKED)
        const pendingClaims = allClaims.filter(c => 
            c.state === 'PROPOSED' || 
            c.state === 'ENDORSED_ORG1' || 
            c.state === 'ENDORSED_ORG2'
        );
        
        if (pendingClaims.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="loading">No pending claims</td></tr>';
            return;
        }
        
        let html = '';
        
        // 1. Claims that need MY (Org2) endorsement
        const needMyEndorsement = pendingClaims.filter(c => !c.endorsed_org2);
        if (needMyEndorsement.length > 0) {
            html += `<tr><td colspan="6" class="section-header">⚡ ACTION REQUIRED: Awaiting YOUR Endorsement (Org2)</td></tr>`;
            html += needMyEndorsement.map(c => renderPendingRow(c, true)).join('');
        }
        
        // 2. Claims waiting for Org1 (I already endorsed)
        const waitingForOther = pendingClaims.filter(c => c.endorsed_org2 && !c.endorsed_org1);
        if (waitingForOther.length > 0) {
            html += `<tr><td colspan="6" class="section-header">⏳ Waiting for Org1 Endorsement (You already endorsed)</td></tr>`;
            html += waitingForOther.map(c => renderPendingRow(c, false)).join('');
        }
        
        tbody.innerHTML = html || '<tr><td colspan="6" class="loading">No pending claims</td></tr>';
        
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="6" class="loading">Error: ${error.message}</td></tr>`;
    }
}

function renderPendingRow(claim, canAct) {
    const org1Status = claim.endorsed_org1 ? '✅' : '⏳';
    const org2Status = claim.endorsed_org2 ? '✅' : '⏳';
    const stateClass = canAct ? 'action-needed' : 'pending';
    
    const actions = canAct 
        ? `<div class="btn-group">
               <button class="btn btn-success btn-small" onclick="endorseClaim('${claim.asset_id}')">✓ Endorse</button>
               <button class="btn btn-danger btn-small" onclick="rejectClaim('${claim.asset_id}')">✗ Reject</button>
           </div>`
        : `<span class="text-muted">Waiting for Org1...</span>`;
    
    return `
        <tr>
            <td><code>${claim.asset_id}</code></td>
            <td>${claim.proposed_via_org || 'N/A'}</td>
            <td>${org1Status} Org1 | ${org2Status} Org2</td>
            <td><span class="status-badge ${stateClass}">${claim.state}</span></td>
            <td>${actions}</td>
        </tr>
    `;
}

async function refreshRevocations() {
    try {
        const data = await apiRequest('/admin/pending-revocations');
        const myRevocations = (data.pendingRevocations || []).filter(r => r.initiatedBy === MY_MSP_ID);
        const theirRevocations = (data.pendingRevocations || []).filter(r => r.initiatedBy === OTHER_MSP_ID);
        
        // My revocations (waiting for Org1)
        const myBody = document.getElementById('myRevocationsBody');
        if (myBody) {
            myBody.innerHTML = myRevocations.length === 0 
                ? '<tr><td colspan="4" class="loading">No pending revocations initiated by you</td></tr>'
                : myRevocations.map(r => `
                    <tr>
                        <td><code>${r.assetId}</code></td>
                        <td>${r.reason || 'N/A'}</td>
                        <td>${formatDate(r.initiatedAt)}</td>
                        <td><span class="status-badge revoke-pending">Waiting for Org1</span></td>
                    </tr>
                `).join('');
        }
        
        // Their revocations (I need to respond)
        const theirBody = document.getElementById('theirRevocationsBody');
        if (theirBody) {
            theirBody.innerHTML = theirRevocations.length === 0 
                ? '<tr><td colspan="4" class="loading">No revocations awaiting your response</td></tr>'
                : theirRevocations.map(r => `
                    <tr>
                        <td><code>${r.assetId}</code></td>
                        <td>${r.initiatedBy}</td>
                        <td>${r.reason || 'N/A'}</td>
                        <td>
                            <div class="btn-group">
                                <button class="btn btn-success btn-small" onclick="endorseRevoke('${r.assetId}')">Endorse Revoke</button>
                                <button class="btn btn-danger btn-small" onclick="rejectRevoke('${r.assetId}')">Reject Revoke</button>
                            </div>
                        </td>
                    </tr>
                `).join('');
        }
    } catch (error) {
        showToast(`Error loading revocations: ${error.message}`, 'error');
    }
}

// Claim Actions
async function endorseClaim(assetId) {
    if (!confirm(`Endorse claim for ${assetId}?\n\nThis adds Org2's endorsement. The claim becomes ACTIVE once BOTH Org1 AND Org2 endorse.`)) return;
    
    try {
        const result = await apiRequest('/admin/endorse-claim', 'POST', { asset_id: assetId });
        if (result.is_fully_endorsed) {
            showToast(`🎉 Claim ACTIVATED! Both orgs have endorsed.`, 'success');
        } else {
            showToast(`✅ Org2 endorsed. Now waiting for Org1...`, 'success');
        }
        refreshAll();
    } catch (error) {
        showToast(`Endorsement failed: ${error.message}`, 'error');
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
        showToast(`Rejection failed: ${error.message}`, 'error');
    }
}

// Revocation Actions
function initiateRevokeQuick(assetId) {
    document.querySelector('[data-tab="actions"]').click();
    document.getElementById('revokeAssetId').value = assetId;
}

async function initiateRevoke(event) {
    event.preventDefault();
    const assetId = document.getElementById('revokeAssetId').value;
    const reason = document.getElementById('revokeReason').value;
    
    if (!confirm(`Initiate revocation for ${assetId}?\n\nOrg1 will need to endorse this revocation to complete it.`)) return;
    
    try {
        await apiRequest('/admin/revoke', 'POST', { asset_id: assetId, reason });
        showToast('Revocation initiated - awaiting Org1 endorsement', 'warning');
        document.getElementById('revokeForm').reset();
        refreshRevocations();
    } catch (error) {
        showToast(`Revocation failed: ${error.message}`, 'error');
    }
}

async function endorseRevoke(assetId) {
    if (!confirm(`Endorse revocation of ${assetId}?\n\nThis will PERMANENTLY DELETE the anchor.`)) return;
    
    try {
        await apiRequest('/admin/endorse-revoke', 'POST', { asset_id: assetId });
        showToast('Revocation complete - anchor deleted', 'success');
        refreshAll();
    } catch (error) {
        showToast(`Failed to endorse revocation: ${error.message}`, 'error');
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
        showToast(`Failed to reject revocation: ${error.message}`, 'error');
    }
}

// Query Actions
async function queryClaim(event) {
    event.preventDefault();
    const assetId = document.getElementById('queryAssetId').value;
    const resultBox = document.getElementById('queryResult');
    
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
    document.querySelector('[data-tab="actions"]').click();
    document.getElementById('queryAssetId').value = assetId;
    await queryClaim({ preventDefault: () => {} });
}

// Helpers
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
    setTimeout(() => toast.classList.remove('visible'), 4000);
}