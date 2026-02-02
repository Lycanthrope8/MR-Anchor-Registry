/**
 * MR Anchor Registry — Supervisor UI v2.0
 * 
 * Features:
 * - Real-time updates via Server-Sent Events (SSE)
 * - On-chain reject with reason (auditable)
 * - Approve (endorse), Reject, Revoke actions
 * - No manual refresh required
 */

// =============================================================================
// DOM Elements
// =============================================================================

const els = {
    // Connection
    baseUrl: document.getElementById('baseUrl'),
    apiKey: document.getElementById('apiKey'),
    connectBtn: document.getElementById('connectBtn'),
    assetId: document.getElementById('assetId'),
    loadAssetBtn: document.getElementById('loadAssetBtn'),
    sseConnectBtn: document.getElementById('sseConnectBtn'),
    sseDisconnectBtn: document.getElementById('sseDisconnectBtn'),
    ssePill: document.getElementById('ssePill'),
    connPill: document.getElementById('connPill'),
    
    // Active anchor
    activeClaimId: document.getElementById('activeClaimId'),
    activeState: document.getElementById('activeState'),
    activeDetails: document.getElementById('activeDetails'),
    revokeBtn: document.getElementById('revokeBtn'),
    revokeReason: document.getElementById('revokeReason'),
    
    // Claims table
    claimsBody: document.getElementById('claimsBody'),
    
    // Claim details
    claimDetailsCard: document.getElementById('claimDetailsCard'),
    claimDetailsContent: document.getElementById('claimDetailsContent'),
    closeDetailsBtn: document.getElementById('closeDetailsBtn'),
    
    // Reject modal
    rejectModal: document.getElementById('rejectModal'),
    rejectClaimId: document.getElementById('rejectClaimId'),
    rejectReason: document.getElementById('rejectReason'),
    confirmRejectBtn: document.getElementById('confirmRejectBtn'),
    cancelRejectBtn: document.getElementById('cancelRejectBtn'),
    
    // Event log
    eventLog: document.getElementById('eventLog'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    eventCount: document.getElementById('eventCount')
};

// =============================================================================
// State
// =============================================================================

const state = {
    eventSource: null,
    connected: false,
    currentAssetId: null,
    pendingRejectClaimId: null,
    eventCounter: 0
};

const STORAGE_KEYS = {
    apiKey: 'mr_registry_api_key',
    assetId: 'mr_registry_asset_id'
};

// =============================================================================
// Utility Functions
// =============================================================================

function baseUrl() {
    return window.location.origin;
}

function getApiKey() {
    return (els.apiKey.value || '').trim();
}

function headers() {
    return {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey()
    };
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleTimeString();
}

function badgeClass(state) {
    if (!state) return 'warn';
    const s = state.toUpperCase();
    if (s === 'ACTIVE') return 'good';
    if (s === 'REJECTED' || s === 'REVOKED') return 'bad';
    if (s === 'PROPOSED' || s === 'CONFLICT' || s === 'SUPERSEDED') return 'warn';
    return 'info';
}

// =============================================================================
// API Functions
// =============================================================================

async function fetchJson(path, options = {}) {
    const url = `${baseUrl()}${path}`;
    const res = await fetch(url, options);
    const txt = await res.text();
    
    let data;
    try {
        data = txt ? JSON.parse(txt) : null;
    } catch (e) {
        throw new Error(`Non-JSON response: ${txt.slice(0, 100)}`);
    }
    
    if (!res.ok) {
        const err = data?.error || data?.message || `HTTP ${res.status}`;
        throw new Error(err);
    }
    
    return data;
}

async function checkHealth() {
    try {
        const data = await fetchJson('/health');
        els.connPill.textContent = `API: ${data.status}`;
        els.connPill.className = 'pill ' + (data.status === 'healthy' ? 'good' : 'warn');
        state.connected = true;
        return data;
    } catch (e) {
        els.connPill.textContent = 'API: error';
        els.connPill.className = 'pill bad';
        state.connected = false;
        logEvent('system', `Health check failed: ${e.message}`);
        return null;
    }
}

async function loadAssetData(assetId) {
    if (!assetId) {
        els.claimsBody.innerHTML = '<tr><td colspan="7" class="muted">Enter an asset_id</td></tr>';
        updateActiveDisplay(null);
        return;
    }
    
    try {
        const data = await fetchJson(`/admin/api/asset/${encodeURIComponent(assetId)}`, {
            headers: headers()
        });
        
        updateActiveDisplay(data.active);
        renderClaimsTable(data.claims || [], assetId);
        logEvent('system', `Loaded asset: ${assetId} (${(data.claims || []).length} claims)`);
    } catch (e) {
        logEvent('system', `Load failed: ${e.message}`, 'error');
    }
}

// =============================================================================
// UI Update Functions
// =============================================================================

function updateActiveDisplay(active) {
    if (!active) {
        els.activeClaimId.textContent = '—';
        els.activeState.innerHTML = '<span class="badge warn">none</span>';
        els.activeDetails.textContent = 'No active anchor';
        els.revokeBtn.disabled = true;
        return;
    }
    
    els.activeClaimId.textContent = active.claimId || '—';
    els.activeState.innerHTML = `<span class="badge ${badgeClass(active.state)}">${active.state}</span>`;
    
    const details = [
        `publisher: ${active.publisherId || '—'}`,
        `endorsements: ${active.endorsementCount || 0}`,
        `activated: ${formatTime(active.activatedAt)}`
    ];
    els.activeDetails.textContent = details.join(' | ');
    
    els.revokeBtn.disabled = active.state !== 'ACTIVE';
}

function renderClaimsTable(claims, assetId) {
    if (!claims || claims.length === 0) {
        els.claimsBody.innerHTML = `<tr><td colspan="7" class="muted">No claims for ${escapeHtml(assetId)}</td></tr>`;
        return;
    }
    
    // Sort by createdAt descending
    claims.sort((a, b) => {
        const ta = new Date(a.createdAt || 0).getTime();
        const tb = new Date(b.createdAt || 0).getTime();
        return tb - ta;
    });
    
    const rows = claims.map(c => {
        const claimId = c.claimId || '';
        const stateText = c.state || 'UNKNOWN';
        const conflict = c.conflictClassification || '—';
        const endorsements = c.endorsementCount || 0;
        const publisher = c.publisherId || '—';
        const created = formatTime(c.createdAt);
        
        const canApprove = ['PROPOSED', 'CONFLICT'].includes(stateText);
        const canReject = ['PROPOSED', 'CONFLICT'].includes(stateText);
        const canReopen = stateText === 'REJECTED';
        
        return `
            <tr data-claim-id="${escapeHtml(claimId)}">
                <td class="mono" style="font-size: 10px;">${escapeHtml(claimId)}</td>
                <td><span class="badge ${badgeClass(stateText)}">${stateText}</span></td>
                <td>${escapeHtml(conflict)}</td>
                <td>${endorsements}</td>
                <td class="mono" style="font-size: 10px;">${escapeHtml(publisher)}</td>
                <td>${created}</td>
                <td class="actions">
                    <button class="btn small good" data-action="approve" data-claim="${escapeHtml(claimId)}" ${canApprove ? '' : 'disabled'}>Approve</button>
                    <button class="btn small danger" data-action="reject" data-claim="${escapeHtml(claimId)}" ${canReject ? '' : 'disabled'}>Reject</button>
                    ${canReopen ? `<button class="btn small" data-action="reopen" data-claim="${escapeHtml(claimId)}">Reopen</button>` : ''}
                    <button class="btn small" data-action="details" data-claim="${escapeHtml(claimId)}">Details</button>
                </td>
            </tr>
        `;
    });
    
    els.claimsBody.innerHTML = rows.join('');
}

// =============================================================================
// SSE (Server-Sent Events)
// =============================================================================

function connectSSE() {
    const assetId = state.currentAssetId;
    const apiKey = getApiKey();
    
    if (!apiKey) {
        logEvent('system', 'API key required for SSE', 'error');
        return;
    }
    
    disconnectSSE();
    
    let url = `${baseUrl()}/admin/api/events/stream`;
    if (assetId) {
        url += `?asset_id=${encodeURIComponent(assetId)}`;
    }
    
    // Note: EventSource doesn't support custom headers, so we'll poll if needed
    // For this demo, we use a workaround with fetch + ReadableStream
    
    logEvent('system', `Connecting SSE...${assetId ? ` (filter: ${assetId})` : ''}`);
    
    // Use fetch for SSE with headers
    startSSEWithFetch(url);
}

async function startSSEWithFetch(url) {
    try {
        const response = await fetch(url, {
            headers: headers(),
            cache: 'no-store'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        els.ssePill.textContent = 'SSE: connected';
        els.ssePill.className = 'pill good';
        els.sseConnectBtn.disabled = true;
        els.sseDisconnectBtn.disabled = false;
        document.body.classList.add('sse-connected');
        
        state.eventSource = { reader, active: true };
        logEvent('system', 'SSE connected');
        
        while (state.eventSource?.active) {
            const { done, value } = await reader.read();
            
            if (done) {
                logEvent('system', 'SSE stream ended');
                break;
            }
            
            buffer += decoder.decode(value, { stream: true });
            
            // Process complete events (data: {...}\n\n)
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        handleSSEEvent(data);
                    } catch (e) {
                        console.error('SSE parse error:', e);
                    }
                }
            }
        }
    } catch (e) {
        logEvent('system', `SSE error: ${e.message}`, 'error');
    }
    
    disconnectSSE();
}

function disconnectSSE() {
    if (state.eventSource) {
        state.eventSource.active = false;
        if (state.eventSource.reader) {
            state.eventSource.reader.cancel().catch(() => {});
        }
        state.eventSource = null;
    }
    
    els.ssePill.textContent = 'SSE: disconnected';
    els.ssePill.className = 'pill';
    els.sseConnectBtn.disabled = false;
    els.sseDisconnectBtn.disabled = true;
    document.body.classList.remove('sse-connected');
}

function handleSSEEvent(event) {
    const type = event.type || 'UNKNOWN';
    
    // Log the event
    const typeClass = type.toLowerCase().replace('claim_', '');
    logEvent(typeClass, formatEventMessage(event));
    
    // Refresh data on relevant events
    if (['CLAIM_PROPOSED', 'CLAIM_ENDORSED', 'CLAIM_ACTIVATED', 
         'CLAIM_REJECTED', 'CLAIM_REVOKED', 'CLAIM_REOPENED', 
         'ACTIVE_CHANGED'].includes(type)) {
        
        // Only refresh if event is for our current asset
        if (!state.currentAssetId || event.assetId === state.currentAssetId) {
            loadAssetData(state.currentAssetId);
        }
    }
}

function formatEventMessage(event) {
    const type = event.type || 'UNKNOWN';
    const parts = [];
    
    if (event.assetId) parts.push(`asset=${event.assetId}`);
    if (event.claimId) parts.push(`claim=${event.claimId.slice(0, 12)}...`);
    if (event.state) parts.push(`state=${event.state}`);
    if (event.supervisorId) parts.push(`by=${event.supervisorId}`);
    if (event.reason) parts.push(`reason="${event.reason}"`);
    
    return `${type}: ${parts.join(', ')}`;
}

// =============================================================================
// Event Log
// =============================================================================

function logEvent(type, message, level = 'info') {
    state.eventCounter++;
    
    const ts = new Date().toLocaleTimeString();
    const typeClass = type.toLowerCase();
    
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML = `
        <span class="ts">${ts}</span>
        <span class="type ${typeClass}">[${type.toUpperCase()}]</span>
        <span class="${level === 'error' ? 'bad' : ''}">${escapeHtml(message)}</span>
    `;
    
    els.eventLog.appendChild(entry);
    els.eventLog.scrollTop = els.eventLog.scrollHeight;
    els.eventCount.textContent = `${state.eventCounter} events`;
    
    // Keep only last 100 entries
    while (els.eventLog.children.length > 100) {
        els.eventLog.removeChild(els.eventLog.firstChild);
    }
}

// =============================================================================
// Action Handlers
// =============================================================================

async function handleApprove(claimId) {
    const assetId = state.currentAssetId;
    if (!assetId || !claimId) return;
    
    try {
        logEvent('system', `Approving ${claimId}...`);
        
        const result = await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/approve`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ claim_id: claimId, reason: 'Approved by supervisor' })
        });
        
        const newState = result.claim?.state || 'UNKNOWN';
        logEvent('endorsed', `Claim ${claimId} → ${newState}`);
        
        await loadAssetData(assetId);
    } catch (e) {
        logEvent('system', `Approve failed: ${e.message}`, 'error');
    }
}

function showRejectModal(claimId) {
    state.pendingRejectClaimId = claimId;
    els.rejectClaimId.textContent = claimId;
    els.rejectReason.value = '';
    els.rejectModal.style.display = 'block';
    els.rejectReason.focus();
}

function hideRejectModal() {
    state.pendingRejectClaimId = null;
    els.rejectModal.style.display = 'none';
}

async function handleReject() {
    const claimId = state.pendingRejectClaimId;
    const reason = (els.rejectReason.value || '').trim();
    const assetId = state.currentAssetId;
    
    if (!claimId || !assetId) return;
    
    if (!reason) {
        alert('Rejection reason is required (will be recorded on-chain)');
        return;
    }
    
    try {
        logEvent('system', `Rejecting ${claimId} with reason: "${reason}"`);
        
        const result = await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/reject`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ claim_id: claimId, reason })
        });
        
        logEvent('rejected', `Claim ${claimId} REJECTED on-chain`);
        hideRejectModal();
        await loadAssetData(assetId);
    } catch (e) {
        logEvent('system', `Reject failed: ${e.message}`, 'error');
    }
}

async function handleReopen(claimId) {
    const assetId = state.currentAssetId;
    if (!assetId || !claimId) return;
    
    const reason = prompt('Reopen reason (optional):') || '';
    
    try {
        logEvent('system', `Reopening ${claimId}...`);
        
        const result = await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/reopen`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ claim_id: claimId, reason })
        });
        
        logEvent('system', `Claim ${claimId} reopened → PROPOSED`);
        await loadAssetData(assetId);
    } catch (e) {
        logEvent('system', `Reopen failed: ${e.message}`, 'error');
    }
}

async function handleRevoke() {
    const assetId = state.currentAssetId;
    const reason = (els.revokeReason.value || '').trim();
    
    if (!assetId) return;
    
    if (!reason) {
        alert('Revocation reason is required');
        els.revokeReason.focus();
        return;
    }
    
    if (!confirm(`Revoke the ACTIVE anchor for "${assetId}"?\n\nReason: ${reason}`)) {
        return;
    }
    
    try {
        logEvent('system', `Revoking active anchor for ${assetId}...`);
        
        const result = await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/revoke`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ reason })
        });
        
        logEvent('revoked', `Active anchor revoked: ${result.claim?.claimId}`);
        els.revokeReason.value = '';
        await loadAssetData(assetId);
    } catch (e) {
        logEvent('system', `Revoke failed: ${e.message}`, 'error');
    }
}

async function showClaimDetails(claimId) {
    try {
        const data = await fetchJson(`/admin/api/claim/${encodeURIComponent(claimId)}`, {
            headers: headers()
        });
        
        const claim = data.claim || {};
        const history = data.history || [];
        
        let html = `
            <div class="kv"><div class="k">Claim ID</div><div class="v mono">${escapeHtml(claim.claimId)}</div></div>
            <div class="kv"><div class="k">Asset ID</div><div class="v mono">${escapeHtml(claim.assetId)}</div></div>
            <div class="kv"><div class="k">State</div><div class="v"><span class="badge ${badgeClass(claim.state)}">${claim.state}</span></div></div>
            <div class="kv"><div class="k">Publisher</div><div class="v mono">${escapeHtml(claim.publisherId)}</div></div>
            <div class="kv"><div class="k">Created</div><div class="v">${claim.createdAt}</div></div>
            <div class="kv"><div class="k">Endorsements</div><div class="v">${claim.endorsementCount} (${(claim.endorsers || []).join(', ') || 'none'})</div></div>
            <div class="kv"><div class="k">Conflict</div><div class="v">${claim.conflictClassification} (distance: ${claim.conflictDistance?.toFixed(3) || 'N/A'})</div></div>
        `;
        
        if (claim.state === 'REJECTED') {
            html += `
                <div class="kv"><div class="k">Rejected By</div><div class="v mono">${escapeHtml(claim.rejectedBy)}</div></div>
                <div class="kv"><div class="k">Rejected At</div><div class="v">${claim.rejectedAt}</div></div>
                <div class="kv"><div class="k">Reason</div><div class="v">${escapeHtml(claim.rejectionReason)}</div></div>
            `;
        }
        
        if (claim.state === 'REVOKED') {
            html += `
                <div class="kv"><div class="k">Revoked By</div><div class="v mono">${escapeHtml(claim.revokedBy)}</div></div>
                <div class="kv"><div class="k">Revoked At</div><div class="v">${claim.revokedAt}</div></div>
                <div class="kv"><div class="k">Reason</div><div class="v">${escapeHtml(claim.revocationReason)}</div></div>
            `;
        }
        
        if (claim.poseSummary) {
            html += `
                <div class="kv"><div class="k">Pose</div><div class="v mono">x=${claim.poseSummary.x}, y=${claim.poseSummary.y}, z=${claim.poseSummary.z}</div></div>
            `;
        }
        
        if (history.length > 0) {
            html += `<h3 style="margin-top: 16px;">History (${history.length} changes)</h3>`;
            html += '<div style="max-height: 150px; overflow-y: auto; font-size: 11px;">';
            history.slice(0, 10).forEach(h => {
                html += `<div class="mono" style="margin-bottom: 4px;">${h.timestamp} - ${h.value?.state || 'unknown'} (tx: ${h.txId?.slice(0, 8)}...)</div>`;
            });
            html += '</div>';
        }
        
        els.claimDetailsContent.innerHTML = html;
        els.claimDetailsCard.style.display = 'block';
    } catch (e) {
        logEvent('system', `Details failed: ${e.message}`, 'error');
    }
}

// =============================================================================
// Event Listeners
// =============================================================================

function wireEvents() {
    // Connect button
    els.connectBtn.addEventListener('click', async () => {
        localStorage.setItem(STORAGE_KEYS.apiKey, getApiKey());
        await checkHealth();
        logEvent('system', 'API key saved');
    });
    
    // Load asset
    els.loadAssetBtn.addEventListener('click', () => {
        const assetId = (els.assetId.value || '').trim();
        localStorage.setItem(STORAGE_KEYS.assetId, assetId);
        state.currentAssetId = assetId;
        loadAssetData(assetId);
        
        // Reconnect SSE with new filter
        if (state.eventSource) {
            connectSSE();
        }
    });
    
    // Asset ID enter key
    els.assetId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            els.loadAssetBtn.click();
        }
    });
    
    // SSE connect/disconnect
    els.sseConnectBtn.addEventListener('click', connectSSE);
    els.sseDisconnectBtn.addEventListener('click', disconnectSSE);
    
    // Revoke button
    els.revokeBtn.addEventListener('click', handleRevoke);
    
    // Claims table actions
    els.claimsBody.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        
        const action = btn.dataset.action;
        const claimId = btn.dataset.claim;
        
        if (!claimId) return;
        
        switch (action) {
            case 'approve':
                handleApprove(claimId);
                break;
            case 'reject':
                showRejectModal(claimId);
                break;
            case 'reopen':
                handleReopen(claimId);
                break;
            case 'details':
                showClaimDetails(claimId);
                break;
        }
    });
    
    // Reject modal
    els.confirmRejectBtn.addEventListener('click', handleReject);
    els.cancelRejectBtn.addEventListener('click', hideRejectModal);
    
    // Close details
    els.closeDetailsBtn.addEventListener('click', () => {
        els.claimDetailsCard.style.display = 'none';
    });
    
    // Clear log
    els.clearLogBtn.addEventListener('click', () => {
        els.eventLog.innerHTML = '';
        state.eventCounter = 0;
        els.eventCount.textContent = '0 events';
    });
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
    // Set base URL
    els.baseUrl.value = baseUrl();
    
    // Restore from localStorage
    const savedKey = localStorage.getItem(STORAGE_KEYS.apiKey);
    const savedAssetId = localStorage.getItem(STORAGE_KEYS.assetId);
    
    if (savedKey) els.apiKey.value = savedKey;
    if (savedAssetId) {
        els.assetId.value = savedAssetId;
        state.currentAssetId = savedAssetId;
    }
    
    // Wire up event handlers
    wireEvents();
    
    // Check health
    await checkHealth();
    
    // Load initial data if we have an asset ID
    if (state.currentAssetId && getApiKey()) {
        await loadAssetData(state.currentAssetId);
    }
    
    logEvent('system', 'Supervisor UI v2.0 initialized');
    logEvent('system', 'Click "Connect SSE" for real-time updates');
}

// Start
init();
