/**
 * ==============================================================================
 * Org2 Admin Panel - JavaScript
 * MR Anchor Registry - Dual Endorsement Workflow
 * v2.1: Multi-card annotation model — intent_type required for all annotation ops
 * ==============================================================================
 */

const API_BASE = window.location.origin;
const ORG_ID = 'org2';
const MY_MSP_ID = 'Org2MSP';
const OTHER_MSP_ID = 'Org1MSP';
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
    logEvent('system', 'Org2 Admin Panel initialized (v2.1 — multi-card annotations)');
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
    
    // Anchor event handlers (existing)
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
    
    // Annotation event handlers (v2.1: include intentType in logs)
    sseConnection.addEventListener('ANNOTATION_PROPOSED', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        logEvent('proposed', `📝 Annotation proposed: ${data.assetId || data.asset_id || 'unknown'} [${intent}] [${data.tier || ''}]`);
        showToast('New annotation proposed - awaiting endorsements', 'warning');
        refreshAnnotations();
    });
    
    sseConnection.addEventListener('ANNOTATION_ENDORSED_ORG1', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        logEvent('endorsed', `📝 Annotation Org1 endorsed: ${data.assetId || data.asset_id || 'unknown'} [${intent}]`);
        showToast('Annotation: Org1 endorsed', 'success');
        refreshAnnotations();
    });
    
    sseConnection.addEventListener('ANNOTATION_ENDORSED_ORG2', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        logEvent('endorsed', `📝 Annotation Org2 endorsed: ${data.assetId || data.asset_id || 'unknown'} [${intent}]`);
        showToast('Annotation: Org2 endorsed', 'success');
        refreshAnnotations();
    });
    
    sseConnection.addEventListener('ANNOTATION_ACTIVE', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        const method = data.activationMethod || data.activation_method || '';
        logEvent('activated', `📝 Annotation ACTIVE: ${data.assetId || data.asset_id || 'unknown'} [${intent}] (${method})`);
        showToast('🤖 Annotation ACTIVATED!', 'success');
        refreshAnnotations();
    });
    
    sseConnection.addEventListener('ANNOTATION_REJECTED', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        logEvent('rejected', `📝 Annotation rejected: ${data.assetId || data.asset_id || 'unknown'} [${intent}]`);
        showToast('Annotation rejected', 'error');
        refreshAnnotations();
    });
    
    sseConnection.addEventListener('ANNOTATION_REVOKED', (e) => {
        const data = parseEventData(e);
        const intent = data.intentType || data.intent_type || '';
        logEvent('revoked', `📝 Annotation revoked: ${data.assetId || data.asset_id || 'unknown'} [${intent}]`);
        showToast('Annotation revoked', 'error');
        refreshAnnotations();
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
    refreshAnnotations();
}

async function refreshAnchors() {
    const tbody = document.getElementById('anchorsBody');
    if (!tbody) return;
    
    try {
        const data = await apiRequest('/admin/anchors');
        const anchors = data.anchors || [];
        
        updateStat('activeCount', anchors.length);
        
        if (anchors.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">No active anchors yet</td></tr>';
            return;
        }
        
        tbody.innerHTML = anchors.map(anchor => `
            <tr>
                <td><code>${anchor.asset_id || anchor.assetId}</code></td>
                <td><code class="muted">${(anchor.claim_id || anchor.claimId || '').substring(0, 12)}...</code></td>
                <td>
                    <span class="org"><span class="check">✓</span> Org1</span>
                    <span class="org"><span class="check">✓</span> Org2</span>
                </td>
                <td class="muted">${formatDate(anchor.activated_at || anchor.activatedAt)}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn small" onclick="viewClaimDetails('${anchor.asset_id || anchor.assetId}')">Details</button>
                        <button class="btn danger small" onclick="initiateRevokeQuick('${anchor.asset_id || anchor.assetId}')">Revoke</button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading anchors:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="muted">Error loading anchors</td></tr>';
    }
}

async function refreshPending() {
    const tbody = document.getElementById('pendingBody');
    if (!tbody) return;
    
    try {
        const data = await apiRequest('/events/snapshot');
        const pendingClaims = (data.assets || []).filter(c =>
            c.state === 'PROPOSED' || c.state === 'ENDORSED_ORG1' || c.state === 'ENDORSED_ORG2'
        );
        
        updateStat('pendingCount', pendingClaims.length);
        
        // For Org2: needs action if Org2 hasn't endorsed yet
        const needMyAction = pendingClaims.filter(c => !c.endorsed_org2);
        updateStat('actionCount', needMyAction.length);
        
        if (pendingClaims.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">No pending claims</td></tr>';
            return;
        }
        
        // Waiting for Org1 (Org2 already endorsed)
        const waitingForOther = pendingClaims.filter(c => c.endorsed_org2 && !c.endorsed_org1);
        
        tbody.innerHTML = pendingClaims.map(claim => {
            const org1Done = claim.endorsed_org1;
            const org2Done = claim.endorsed_org2;
            const myAction = !org2Done;
            
            const endorseHtml = `
                <div class="endorsement-status">
                    <span class="org"><span class="${org1Done ? 'check' : 'wait'}">${org1Done ? '✓' : '○'}</span> Org1</span>
                    <span class="org"><span class="${org2Done ? 'check' : 'wait'}">${org2Done ? '✓' : '○'}</span> Org2</span>
                </div>`;
            
            const statusBadge = myAction
                ? '<span class="badge action">Needs Your Action</span>'
                : '<span class="badge info">Waiting for Org1</span>';
            
            const actions = myAction
                ? `<div class="btn-group">
                       <button class="btn good small" onclick="endorseClaim('${claim.asset_id}')">✓ Endorse</button>
                       <button class="btn danger small" onclick="rejectClaim('${claim.asset_id}')">✗ Reject</button>
                   </div>`
                : '<span class="muted">Waiting...</span>';
            
            return `
                <tr class="${myAction ? 'action-row' : ''}">
                    <td><code>${claim.asset_id}</code></td>
                    <td class="muted">${claim.proposed_by || ''}</td>
                    <td>${endorseHtml}</td>
                    <td>${statusBadge}</td>
                    <td>${actions}</td>
                </tr>`;
        }).join('');
    } catch (error) {
        console.error('Error loading pending claims:', error);
    }
}

async function refreshRevocations() {
    try {
        const data = await apiRequest('/admin/pending-revocations');
        const revocations = data.revocations || [];
        
        updateStat('revokeCount', revocations.length);
        
        // My revocations (waiting for Org1)
        const myRevocations = revocations.filter(r => r.initiated_by === MY_MSP_ID);
        const theirRevocations = revocations.filter(r => r.initiated_by === OTHER_MSP_ID);
        
        const myBody = document.getElementById('myRevocationsBody');
        if (myBody) {
            if (myRevocations.length === 0) {
                myBody.innerHTML = '<tr><td colspan="4" class="muted">No pending revocations</td></tr>';
            } else {
                myBody.innerHTML = myRevocations.map(r => `
                    <tr>
                        <td><code>${r.asset_id}</code></td>
                        <td class="muted">${r.reason || 'No reason'}</td>
                        <td class="muted">${formatDate(r.initiated_at)}</td>
                        <td><span class="badge info">Waiting for Org1</span></td>
                    </tr>
                `).join('');
            }
        }
        
        const theirBody = document.getElementById('theirRevocationsBody');
        if (theirBody) {
            if (theirRevocations.length === 0) {
                theirBody.innerHTML = '<tr><td colspan="4" class="muted">No revocations awaiting your response</td></tr>';
            } else {
                theirBody.innerHTML = theirRevocations.map(r => `
                    <tr class="action-row">
                        <td><code>${r.asset_id}</code></td>
                        <td class="muted">${r.initiated_by}</td>
                        <td class="muted">${r.reason || 'No reason'}</td>
                        <td>
                            <div class="btn-group">
                                <button class="btn danger small" onclick="endorseRevoke('${r.asset_id}')">Approve</button>
                                <button class="btn small" onclick="rejectRevoke('${r.asset_id}')">Reject</button>
                            </div>
                        </td>
                    </tr>
                `).join('');
            }
        }
    } catch (error) {
        console.error('Error loading revocations:', error);
    }
}

// =============================================================================
// Annotation Refresh (v2.1: intent_type shown and passed)
// =============================================================================

async function refreshAnnotations() {
    try {
        const data = await apiRequest('/events/snapshot');
        const allAnnotations = data.annotations || [];
        const pendingAnnotations = allAnnotations.filter(a =>
            a.state === 'ANN_PROPOSED' || a.state === 'ANN_ENDORSED_ORG1' || a.state === 'ANN_ENDORSED_ORG2'
        );
        const activeAnnotations = allAnnotations.filter(a => a.state === 'ANN_ACTIVE');
        updateStat('annPendingCount', pendingAnnotations.length);
        updateStat('annActiveCount', activeAnnotations.length);

        // Pending annotations table (v2.1: Intent column)
        const pendBody = document.getElementById('annPendingBody');
        if (pendBody) {
            if (pendingAnnotations.length === 0) {
                pendBody.innerHTML = '<tr><td colspan="7" class="muted">No pending annotations</td></tr>';
            } else {
                pendBody.innerHTML = pendingAnnotations.map(a => {
                    const org1Done = a.endorsed_org1;
                    const org2Done = a.endorsed_org2;
                    const needMyAction = !org2Done;
                    const intentType = a.intent_type || 'N/A';
                    const endorseHtml = `
                        <div class="endorsement-status">
                            <span class="org"><span class="${org1Done ? 'check' : 'wait'}">${org1Done ? '✓' : '○'}</span> Org1</span>
                            <span class="org"><span class="${org2Done ? 'check' : 'wait'}">${org2Done ? '✓' : '○'}</span> Org2</span>
                        </div>`;
                    const statusBadge = needMyAction
                        ? '<span class="badge action">Needs Your Action</span>'
                        : '<span class="badge info">Waiting for Org1</span>';
                    const actions = needMyAction
                        ? `<div class="btn-group">
                               <button class="btn good small" onclick="endorseAnnotation('${a.asset_id}','${intentType}')">✓ Endorse</button>
                               <button class="btn danger small" onclick="rejectAnnotation('${a.asset_id}','${intentType}')">✗ Reject</button>
                           </div>`
                        : '<span class="muted">Waiting...</span>';
                    const contentPreview = (a.content_text || '').substring(0, 50) + ((a.content_text || '').length > 50 ? '...' : '');
                    return `
                        <tr class="${needMyAction ? 'action-row' : ''}">
                            <td><code>${a.asset_id}</code></td>
                            <td><span class="badge">${intentType}</span></td>
                            <td><span class="badge ${a.tier === 'GOVERNED' ? 'warn' : 'info'}">${a.tier || 'N/A'}</span></td>
                            <td class="muted" title="${(a.content_text || '').replace(/"/g, '&quot;')}">${contentPreview}</td>
                            <td>${endorseHtml}</td>
                            <td>${statusBadge}</td>
                            <td>${actions}</td>
                        </tr>`;
                }).join('');
            }
        }

        // Active annotations table (v2.1: Intent column)
        const actBody = document.getElementById('annActiveBody');
        if (actBody) {
            if (activeAnnotations.length === 0) {
                actBody.innerHTML = '<tr><td colspan="6" class="muted">No active annotations</td></tr>';
            } else {
                actBody.innerHTML = activeAnnotations.map(a => {
                    const intentType = a.intent_type || 'N/A';
                    const contentPreview = (a.content_text || '').substring(0, 70) + ((a.content_text || '').length > 70 ? '...' : '');
                    return `
                        <tr>
                            <td><code>${a.asset_id}</code></td>
                            <td><span class="badge">${intentType}</span></td>
                            <td><span class="badge ${a.tier === 'GOVERNED' ? 'warn' : 'info'}">${a.tier || 'N/A'}</span></td>
                            <td class="muted" title="${(a.content_text || '').replace(/"/g, '&quot;')}">${contentPreview}</td>
                            <td class="muted">${a.endorsed_org1 && a.endorsed_org2 ? 'Dual endorsed' : 'Auto-approved'}</td>
                            <td>
                                <div class="btn-group">
                                    <button class="btn danger small" onclick="revokeAnnotation('${a.asset_id}','${intentType}')">Revoke</button>
                                    <button class="btn small" onclick="queryAnnotationByIntent('${a.asset_id}','${intentType}')">Details</button>
                                </div>
                            </td>
                        </tr>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Error loading annotations:', error);
    }
}

function updateStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// =============================================================================
// Claim Actions (existing)
// =============================================================================

async function endorseClaim(assetId) {
    if (!confirm(`Endorse claim for ${assetId}?\n\nThis adds Org2's approval. The claim becomes ACTIVE once both organizations endorse.`)) return;
    try {
        const result = await apiRequest('/admin/endorse-claim', 'POST', { asset_id: assetId });
        if (result.is_fully_endorsed) showToast('🎉 Claim ACTIVATED!', 'success');
        else showToast('✓ Endorsed. Waiting for Org1...', 'success');
        refreshAll();
    } catch (error) { showToast(`Error: ${error.message}`, 'error'); }
}

async function rejectClaim(assetId) {
    const reason = prompt('Reason for rejection:');
    if (reason === null) return;
    try {
        await apiRequest('/admin/reject-claim', 'POST', { asset_id: assetId, reason });
        showToast('Claim rejected', 'success');
        refreshPending();
    } catch (error) { showToast(`Error: ${error.message}`, 'error'); }
}

// =============================================================================
// Annotation Actions (v2.1: intent_type passed)
// =============================================================================

async function endorseAnnotation(assetId, intentType) {
    if (!confirm(`Endorse annotation for ${assetId} (${intentType})?\n\nThis adds Org2's approval.`)) return;
    try {
        const result = await apiRequest('/admin/endorse-annotation', 'POST', { asset_id: assetId, intent_type: intentType });
        if (result.is_fully_endorsed) showToast('🤖 Annotation ACTIVATED!', 'success');
        else showToast('✓ Annotation endorsed. Waiting for Org1...', 'success');
        refreshAnnotations();
    } catch (error) { showToast(`Error: ${error.message}`, 'error'); }
}

async function rejectAnnotation(assetId, intentType) {
    const reason = prompt('Reason for rejecting annotation:');
    if (reason === null) return;
    try {
        await apiRequest('/admin/reject-annotation', 'POST', { asset_id: assetId, intent_type: intentType, reason });
        showToast('Annotation rejected', 'success');
        refreshAnnotations();
    } catch (error) { showToast(`Error: ${error.message}`, 'error'); }
}

async function revokeAnnotation(assetId, intentType) {
    const reason = prompt('Reason for revoking annotation:');
    if (reason === null) return;
    if (!confirm(`Revoke annotation for ${assetId} (${intentType})?\n\nThis will remove the active annotation.`)) return;
    try {
        await apiRequest('/admin/revoke-annotation', 'POST', { asset_id: assetId, intent_type: intentType, reason });
        showToast('Annotation revoked', 'success');
        refreshAnnotations();
    } catch (error) { showToast(`Error: ${error.message}`, 'error'); }
}

async function queryAnnotation() {
    const id = document.getElementById('queryAssetId')?.value?.trim();
    const intentType = document.getElementById('queryIntentType')?.value || 'ASK_ANCHOR';
    const resultBox = document.getElementById('queryResult');
    if (!id) { showToast('Enter an asset ID', 'error'); return; }
    try {
        const result = await apiRequest(`/admin/annotations/${id}/${intentType}`);
        resultBox.textContent = JSON.stringify(result, null, 2);
        resultBox.classList.add('visible');
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        resultBox.textContent = `Error: ${error.message}`;
        resultBox.classList.add('visible');
    }
}

async function queryAnnotationByIntent(assetId, intentType) {
    const resultBox = document.getElementById('queryResult');
    try {
        const result = await apiRequest(`/admin/annotations/${assetId}/${intentType}`);
        resultBox.textContent = JSON.stringify(result, null, 2);
        resultBox.classList.add('visible');
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        resultBox.textContent = `Error: ${error.message}`;
        resultBox.classList.add('visible');
    }
}

// =============================================================================
// Revocation Actions (existing)
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
    
    if (!confirm(`Initiate revocation for ${assetId}?\n\nOrg1 will need to approve this.`)) return;
    
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
// Query Actions (existing)
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
window.refreshAnnotations = refreshAnnotations;
window.endorseClaim = endorseClaim;
window.rejectClaim = rejectClaim;
window.endorseAnnotation = endorseAnnotation;
window.rejectAnnotation = rejectAnnotation;
window.revokeAnnotation = revokeAnnotation;
window.queryAnnotation = queryAnnotation;
window.queryAnnotationByIntent = queryAnnotationByIntent;
window.initiateRevokeQuick = initiateRevokeQuick;
window.endorseRevoke = endorseRevoke;
window.rejectRevoke = rejectRevoke;
window.viewClaimDetails = viewClaimDetails;
window.clearLog = clearLog;