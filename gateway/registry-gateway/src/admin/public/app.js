/**
 * MR Anchor Registry — Supervisor UI v2.1
 * 
 * Features:
 * - Dashboard view showing ALL assets by default
 * - "Needs Action" badge for PROPOSED claims
 * - Real-time updates via Server-Sent Events (SSE)
 * - Click row to view asset details
 * - On-chain approve/reject/revoke
 */

// =============================================================================
// DOM Elements
// =============================================================================

const els = {
    // Connection
    baseUrl: document.getElementById('baseUrl'),
    apiKey: document.getElementById('apiKey'),
    connectBtn: document.getElementById('connectBtn'),
    ssePill: document.getElementById('ssePill'),
    connPill: document.getElementById('connPill'),
    
    // Dashboard
    dashboardCard: document.getElementById('dashboardCard'),
    dashboardBody: document.getElementById('dashboardBody'),
    dashboardCount: document.getElementById('dashboardCount'),
    refreshDashboardBtn: document.getElementById('refreshDashboardBtn'),
    
    // Asset detail
    assetDetailCard: document.getElementById('assetDetailCard'),
    selectedAssetId: document.getElementById('selectedAssetId'),
    backToDashboardBtn: document.getElementById('backToDashboardBtn'),
    activeClaimId: document.getElementById('activeClaimId'),
    activeState: document.getElementById('activeState'),
    activeDetails: document.getElementById('activeDetails'),
    revokeBtn: document.getElementById('revokeBtn'),
    revokeReason: document.getElementById('revokeReason'),
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
    currentView: 'dashboard', // 'dashboard' or 'detail'
    selectedAssetId: null,
    pendingRejectClaimId: null,
    eventCounter: 0,
    assetsCache: new Map() // asset_id -> row data
};

const STORAGE_KEYS = {
    apiKey: 'mr_registry_api_key'
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
    return d.toLocaleString();
}

function formatTimeShort(isoString) {
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

function toggleCard(contentId) {
    const content = document.getElementById(contentId);
    if (content) {
        content.classList.toggle('collapsed');
    }
}

// Make toggleCard available globally for onclick
window.toggleCard = toggleCard;

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

// =============================================================================
// Dashboard Functions
// =============================================================================

async function loadDashboard() {
    if (!getApiKey()) {
        els.dashboardBody.innerHTML = '<tr><td colspan="6" class="muted">Enter API key and click Connect</td></tr>';
        return;
    }
    
    try {
        const data = await fetchJson('/admin/api/assets', { headers: headers() });
        const assets = data.assets || [];
        
        // Update cache
        state.assetsCache.clear();
        assets.forEach(a => state.assetsCache.set(a.asset_id, a));
        
        renderDashboard(assets);
        els.dashboardCount.textContent = `${assets.length} asset${assets.length !== 1 ? 's' : ''}`;
        logEvent('system', `Dashboard loaded: ${assets.length} assets`);
    } catch (e) {
        logEvent('system', `Dashboard load failed: ${e.message}`, 'error');
        els.dashboardBody.innerHTML = `<tr><td colspan="6" class="muted">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function renderDashboard(assets) {
    if (!assets || assets.length === 0) {
        els.dashboardBody.innerHTML = '<tr><td colspan="6" class="muted">No assets found. Use CLI to propose claims.</td></tr>';
        return;
    }
    
    const rows = assets.map(a => {
        const needsAction = a.latest_state === 'PROPOSED';
        const actionBadge = needsAction 
            ? '<span class="badge action-badge">Needs Action</span>' 
            : '';
        
        return `
            <tr class="dashboard-row ${needsAction ? 'needs-action' : ''}" data-asset-id="${escapeHtml(a.asset_id)}">
                <td class="mono">${escapeHtml(a.asset_id)}</td>
                <td><span class="badge ${badgeClass(a.latest_state)}">${a.latest_state || 'UNKNOWN'}</span></td>
                <td>${actionBadge}</td>
                <td class="mono small">${a.active_claim_id ? escapeHtml(a.active_claim_id.substring(0, 16)) + '...' : '—'}</td>
                <td class="mono small">${a.latest_claim_id ? escapeHtml(a.latest_claim_id.substring(0, 16)) + '...' : '—'}</td>
                <td class="small">${formatTime(a.last_updated_at)}</td>
            </tr>
        `;
    });
    
    els.dashboardBody.innerHTML = rows.join('');
}

function updateDashboardRow(assetId, newState, activeClaimId, latestClaimId) {
    // Update cache
    const cached = state.assetsCache.get(assetId);
    if (cached) {
        cached.latest_state = newState;
        cached.active_claim_id = activeClaimId;
        cached.latest_claim_id = latestClaimId || cached.latest_claim_id;
        cached.last_updated_at = new Date().toISOString();
    } else {
        // New asset - add to cache
        state.assetsCache.set(assetId, {
            asset_id: assetId,
            latest_state: newState,
            active_claim_id: activeClaimId,
            latest_claim_id: latestClaimId,
            last_updated_at: new Date().toISOString()
        });
    }
    
    // Re-render dashboard if we're on that view
    if (state.currentView === 'dashboard') {
        const assets = Array.from(state.assetsCache.values());
        // Sort by last_updated_at desc
        assets.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
        renderDashboard(assets);
        els.dashboardCount.textContent = `${assets.length} asset${assets.length !== 1 ? 's' : ''}`;
    }
}

// =============================================================================
// Asset Detail Functions
// =============================================================================

function showAssetDetail(assetId) {
    state.currentView = 'detail';
    state.selectedAssetId = assetId;
    
    els.dashboardCard.style.display = 'none';
    els.assetDetailCard.style.display = 'block';
    els.selectedAssetId.textContent = assetId;
    
    loadAssetDetail(assetId);
}

function showDashboard() {
    state.currentView = 'dashboard';
    state.selectedAssetId = null;
    
    els.assetDetailCard.style.display = 'none';
    els.dashboardCard.style.display = 'block';
    
    // Refresh dashboard
    loadDashboard();
}

async function loadAssetDetail(assetId) {
    if (!assetId) return;
    
    try {
        const data = await fetchJson(`/admin/api/asset/${encodeURIComponent(assetId)}`, {
            headers: headers()
        });
        
        updateActiveDisplay(data.active);
        renderClaimsTable(data.claims || [], assetId);
    } catch (e) {
        logEvent('system', `Load asset detail failed: ${e.message}`, 'error');
    }
}

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
        `activated: ${formatTimeShort(active.activatedAt)}`
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
        const created = formatTimeShort(c.createdAt);
        
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
    const apiKey = getApiKey();
    
    if (!apiKey) {
        logEvent('system', 'API key required for SSE', 'error');
        return;
    }
    
    disconnectSSE();
    
    // Connect without asset filter to get ALL events for dashboard
    const url = `${baseUrl()}/admin/api/events/stream`;
    
    logEvent('system', 'Connecting SSE (all assets)...');
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
    document.body.classList.remove('sse-connected');
}

function handleSSEEvent(event) {
    const type = event.type || 'UNKNOWN';
    
    // Log the event
    const typeClass = type.toLowerCase().replace('claim_', '');
    logEvent(typeClass, formatEventMessage(event));
    
    // Update dashboard based on event type
    if (['CLAIM_PROPOSED', 'CLAIM_ENDORSED', 'CLAIM_ACTIVATED', 
         'CLAIM_REJECTED', 'CLAIM_REVOKED', 'CLAIM_REOPENED', 
         'ACTIVE_CHANGED'].includes(type)) {
        
        const assetId = event.assetId;
        const claimId = event.claimId;
        let newState = event.state;
        let activeClaimId = null;
        
        // Determine new state and active claim
        switch (type) {
            case 'CLAIM_PROPOSED':
                newState = 'PROPOSED';
                break;
            case 'CLAIM_ACTIVATED':
            case 'CLAIM_ENDORSED':
                if (event.state === 'ACTIVE') {
                    newState = 'ACTIVE';
                    activeClaimId = claimId;
                }
                break;
            case 'CLAIM_REJECTED':
                newState = 'REJECTED';
                break;
            case 'CLAIM_REVOKED':
                newState = 'REVOKED';
                activeClaimId = null;
                break;
            case 'CLAIM_REOPENED':
                newState = 'PROPOSED';
                break;
            case 'ACTIVE_CHANGED':
                activeClaimId = event.activeClaimId;
                break;
        }
        
        // Update dashboard row
        if (assetId && newState) {
            updateDashboardRow(assetId, newState, activeClaimId, claimId);
        }
        
        // Refresh detail view if we're viewing this asset
        if (state.currentView === 'detail' && state.selectedAssetId === assetId) {
            loadAssetDetail(assetId);
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
    const assetId = state.selectedAssetId;
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
        
        await loadAssetDetail(assetId);
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
    const assetId = state.selectedAssetId;
    
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
        await loadAssetDetail(assetId);
    } catch (e) {
        logEvent('system', `Reject failed: ${e.message}`, 'error');
    }
}

async function handleReopen(claimId) {
    const assetId = state.selectedAssetId;
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
        await loadAssetDetail(assetId);
    } catch (e) {
        logEvent('system', `Reopen failed: ${e.message}`, 'error');
    }
}

async function handleRevoke() {
    const assetId = state.selectedAssetId;
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
        await loadAssetDetail(assetId);
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
        await loadDashboard();
        connectSSE();
        logEvent('system', 'Connected');
    });
    
    // Refresh dashboard
    els.refreshDashboardBtn.addEventListener('click', () => {
        loadDashboard();
    });
    
    // Dashboard row click
    els.dashboardBody.addEventListener('click', (e) => {
        const row = e.target.closest('.dashboard-row');
        if (row) {
            const assetId = row.dataset.assetId;
            if (assetId) {
                showAssetDetail(assetId);
            }
        }
    });
    
    // Back to dashboard
    els.backToDashboardBtn.addEventListener('click', () => {
        showDashboard();
    });
    
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
    
    if (savedKey) {
        els.apiKey.value = savedKey;
    }
    
    // Wire up event handlers
    wireEvents();
    
    // Check health
    await checkHealth();
    
    // If we have an API key, auto-connect
    if (getApiKey()) {
        await loadDashboard();
        connectSSE();
    }
    
    logEvent('system', 'Supervisor UI v2.1 initialized');
    logEvent('system', 'Dashboard shows all assets. Click a row for details.');
}

// Start
init();