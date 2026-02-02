/*
  MR Anchor Registry — Supervisor UI

  Design goals:
  - zero build tooling (plain HTML/CSS/JS)
  - works over SSH port-forwarding
  - "real-time" without page reload: periodic refresh + event log polling

  Security model (simple):
  - user enters an x-api-key (stored in localStorage)
  - all API calls include x-api-key header
*/

const els = {
  connPill: document.getElementById('connPill'),
  baseUrl: document.getElementById('baseUrl'),
  apiKey: document.getElementById('apiKey'),
  saveKeyBtn: document.getElementById('saveKeyBtn'),
  assetId: document.getElementById('assetId'),
  autoRefresh: document.getElementById('autoRefresh'),
  refreshEvery: document.getElementById('refreshEvery'),
  refreshBtn: document.getElementById('refreshBtn'),

  activeClaimId: document.getElementById('activeClaimId'),
  activeState: document.getElementById('activeState'),
  activeMeta: document.getElementById('activeMeta'),
  revokeReason: document.getElementById('revokeReason'),
  revokeBtn: document.getElementById('revokeBtn'),

  decisionState: document.getElementById('decisionState'),
  decisionMeta: document.getElementById('decisionMeta'),
  decisionResetBtn: document.getElementById('decisionResetBtn'),

  claimsBody: document.getElementById('claimsBody'),
  log: document.getElementById('log'),
};

const STORAGE = {
  apiKey: 'mr_registry_api_key',
  assetId: 'mr_registry_asset_id',
  autoRefresh: 'mr_registry_auto_refresh',
  refreshEvery: 'mr_registry_refresh_every',
};

const state = {
  healthTimer: null,
  refreshTimer: null,
  eventsTimer: null,
  lastEventsSeen: 0,
  lastRenderKey: '',
};

function baseUrl() {
  return window.location.origin;
}

function getApiKey() {
  return (els.apiKey.value || '').trim();
}

function headers() {
  const key = getApiKey();
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
  };
}

function logLine(msg, level = 'ok') {
  const ts = new Date().toISOString();
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `<span class="ts">${ts}</span> <span class="${level}">${escapeHtml(msg)}</span>`;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setConn(ok, detail) {
  els.connPill.textContent = ok ? 'connected' : 'disconnected';
  els.connPill.classList.toggle('good', ok);
  els.connPill.classList.toggle('bad', !ok);
  els.connPill.title = detail || '';
}

async function fetchJson(path, options = {}) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, options);
  const txt = await res.text();
  let data;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch (e) {
    throw new Error(`Non-JSON response from ${path}: ${txt.slice(0, 120)}`);
  }
  if (!res.ok) {
    const err = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data;
}

async function refreshHealth() {
  try {
    const data = await fetchJson('/health');
    setConn(true, `${data.status} | postgres=${data.postgres} | fabric=${data.fabric} | mock=${data.fabric_mock}`);
  } catch (e) {
    setConn(false, e.message);
  }
}

function uiSetActive({ claim_id, stateText, metaText }) {
  els.activeClaimId.textContent = claim_id || '—';
  els.activeState.innerHTML = `<span class="badge ${badgeClass(stateText)}">${stateText || '—'}</span>`;
  els.activeMeta.textContent = metaText || '';

  const canRevoke = !!claim_id && (stateText === 'ACTIVE');
  els.revokeBtn.disabled = !canRevoke;
}

function badgeClass(stateText) {
  if (!stateText) return 'warn';
  const s = String(stateText).toUpperCase();
  if (s === 'ACTIVE' || s === 'APPROVED') return 'good';
  if (s === 'REJECTED' || s === 'REVOKED') return 'bad';
  if (s === 'PROPOSED' || s === 'CONFLICT') return 'warn';
  return 'warn';
}

function uiSetDecision(decision) {
  if (!decision) {
    els.decisionState.innerHTML = `<span class="badge warn">none</span>`;
    els.decisionMeta.textContent = '';
    els.decisionResetBtn.disabled = true;
    return;
  }
  els.decisionState.innerHTML = `<span class="badge ${badgeClass(decision.decision)}">${decision.decision}</span>`;
  const parts = [];
  if (decision.claim_id) parts.push(`claim=${decision.claim_id}`);
  if (decision.decided_by) parts.push(`by=${decision.decided_by}`);
  if (decision.decided_at) parts.push(`at=${decision.decided_at}`);
  if (decision.reason) parts.push(`reason=${decision.reason}`);
  els.decisionMeta.textContent = parts.join(' | ');
  els.decisionResetBtn.disabled = false;
}

function renderClaimsTable(claims, assetId) {
  if (!Array.isArray(claims) || claims.length === 0) {
    els.claimsBody.innerHTML = `<tr><td colspan="7" class="muted">No claims found for ${escapeHtml(assetId)}.</td></tr>`;
    return;
  }

  // newest first if timestamps exist
  claims.sort((a, b) => {
    const ta = Date.parse(a.createdAt || a.activatedAt || 0) || 0;
    const tb = Date.parse(b.createdAt || b.activatedAt || 0) || 0;
    return tb - ta;
  });

  const rows = claims.map(c => {
    const claimId = c.claimId || c.claim_id || '';
    const stateText = c.state || '';
    const cc = c.conflictClassification || c.conflict_classification || '—';
    const ecount = Number(c.endorsementCount || c.endorsement_count || 0);
    const created = c.createdAt || '—';
    const publisher = c.publisherId || c.publisher_id || '—';

    const canEndorse = (stateText === 'PROPOSED' || stateText === 'CONFLICT') && !!claimId;

    return `
      <tr>
        <td class="mono">${escapeHtml(claimId)}</td>
        <td><span class="badge ${badgeClass(stateText)}">${escapeHtml(stateText)}</span></td>
        <td>${escapeHtml(cc)}</td>
        <td>${ecount}</td>
        <td class="mono">${escapeHtml(publisher)}</td>
        <td class="mono">${escapeHtml(created)}</td>
        <td class="actions">
          <button class="btn sm" data-act="endorse" data-claim="${escapeHtml(claimId)}" ${canEndorse ? '' : 'disabled'}>Approve (endorse)</button>
          <button class="btn sm" data-act="reject" data-claim="${escapeHtml(claimId)}" ${claimId ? '' : 'disabled'}>Reject</button>
          <button class="btn sm" data-act="copy" data-claim="${escapeHtml(claimId)}" ${claimId ? '' : 'disabled'}>Copy ID</button>
        </td>
      </tr>
    `;
  });

  els.claimsBody.innerHTML = rows.join('');
}

async function refreshForAsset(assetId) {
  const key = getApiKey();
  if (!key) {
    uiSetActive({ claim_id: '', stateText: '', metaText: 'Enter x-api-key first.' });
    uiSetDecision(null);
    els.claimsBody.innerHTML = `<tr><td colspan="7" class="muted">Enter x-api-key first.</td></tr>`;
    return;
  }

  if (!assetId) {
    uiSetActive({ claim_id: '', stateText: '', metaText: '' });
    uiSetDecision(null);
    els.claimsBody.innerHTML = `<tr><td colspan="7" class="muted">Enter an asset_id to view claims.</td></tr>`;
    return;
  }

  try {
    // Claims list
    const claimsResp = await fetchJson(`/assets/${encodeURIComponent(assetId)}/claims`, {
      method: 'GET',
      headers: headers(),
    });

    // Active resolve (may be null)
    const resolveResp = await fetchJson(`/assets/${encodeURIComponent(assetId)}/resolve`, {
      method: 'GET',
      headers: headers(),
    });

    // Local supervisor decision (optional)
    const decisionResp = await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}`, {
      method: 'GET',
      headers: headers(),
    });

    // Render
    const activeClaimId = resolveResp.claim_id || '';
    const activeState = resolveResp.state || (activeClaimId ? 'UNKNOWN' : 'NONE');
    const meta = activeClaimId
      ? `payload_verified=${resolveResp.payload_verified} | activated_at=${resolveResp.activated_at || '—'}`
      : (resolveResp.message || '');

    uiSetActive({ claim_id: activeClaimId, stateText: activeState, metaText: meta });
    uiSetDecision(decisionResp.decision);
    renderClaimsTable(claimsResp.claims || [], assetId);

    // Avoid spamming logs: only log when something meaningfully changed.
    const renderKey = JSON.stringify({
      assetId,
      activeClaimId,
      activeState,
      decision: decisionResp.decision ? decisionResp.decision.decision : null,
      claimsCount: (claimsResp.claims || []).length,
      lastClaim: (claimsResp.claims || [])[0]?.claimId || null,
    });

    if (state.lastRenderKey !== renderKey) {
      state.lastRenderKey = renderKey;
      logLine(`Synced asset=${assetId} | active=${activeClaimId || 'none'} | claims=${(claimsResp.claims || []).length}`, 'ok');
    }
  } catch (e) {
    logLine(`Refresh failed: ${e.message}`, 'err');
  }
}

async function doEndorse(assetId, claimId) {
  try {
    const resp = await fetchJson(`/claims/${encodeURIComponent(claimId)}/endorse`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });

    const newState = resp.new_state || resp.state || 'UNKNOWN';
    logLine(`Endorsed ${claimId} → state=${newState} endorsements=${resp.endorsement_count}`, newState === 'ACTIVE' ? 'ok' : 'warn');

    // If it becomes active, mark local decision as approved too (helps Unity later).
    if (newState === 'ACTIVE') {
      await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/approve`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ claim_id: claimId, reason: 'endorsed via supervisor UI' }),
      });
    }

    await refreshForAsset(assetId);
  } catch (e) {
    logLine(`Approve failed (${claimId}): ${e.message}`, 'err');
  }
}

async function doReject(assetId, claimId) {
  try {
    const reason = prompt('Reject reason (optional):', 'rejected by supervisor') || '';
    await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/reject`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ claim_id: claimId, reason }),
    });

    logLine(`Rejected ${claimId} (local decision)`, 'warn');
    await refreshForAsset(assetId);
  } catch (e) {
    logLine(`Reject failed (${claimId}): ${e.message}`, 'err');
  }
}

async function doRevokeActive(assetId) {
  const activeClaimId = els.activeClaimId.textContent.trim();
  if (!activeClaimId || activeClaimId === '—') return;

  const reason = (els.revokeReason.value || '').trim() || 'revoked by supervisor UI';
  try {
    await fetchJson(`/assets/${encodeURIComponent(assetId)}/revoke`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ reason, claim_id: activeClaimId }),
    });
    logLine(`Revoked ACTIVE claim ${activeClaimId} for asset=${assetId}`, 'warn');

    // Clear local decision for cleanliness
    await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/reset`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });

    await refreshForAsset(assetId);
  } catch (e) {
    logLine(`Revoke failed: ${e.message}`, 'err');
  }
}

async function doDecisionReset(assetId) {
  try {
    await fetchJson(`/admin/api/decision/${encodeURIComponent(assetId)}/reset`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });
    logLine(`Decision reset for asset=${assetId}`, 'ok');
    await refreshForAsset(assetId);
  } catch (e) {
    logLine(`Decision reset failed: ${e.message}`, 'err');
  }
}

async function pollEvents() {
  const key = getApiKey();
  if (!key) return;

  try {
    const resp = await fetchJson('/admin/api/events?limit=30', {
      method: 'GET',
      headers: headers(),
    });

    const events = resp.events || [];
    // naive de-dupe: log only new events since last poll
    if (events.length > state.lastEventsSeen) {
      const newOnes = events.slice(Math.max(0, events.length - (events.length - state.lastEventsSeen)));
      newOnes.forEach(evt => {
        const msg = evt.type === 'DECISION'
          ? `Decision: ${evt.asset_id} → ${evt.decision} (claim=${evt.claim_id || '—'})`
          : (evt.type === 'DECISION_RESET'
            ? `Decision reset: ${evt.asset_id}`
            : `${evt.type}`);
        logLine(msg, evt.type === 'DECISION' ? 'warn' : 'ok');
      });
    }
    state.lastEventsSeen = events.length;
  } catch (e) {
    // don't spam: ignore event poll failures
  }
}

function startAutoRefresh() {
  stopAutoRefresh();

  const every = Math.max(500, Math.min(60000, Number(els.refreshEvery.value) || 1500));
  const enabled = !!els.autoRefresh.checked;

  localStorage.setItem(STORAGE.autoRefresh, enabled ? '1' : '0');
  localStorage.setItem(STORAGE.refreshEvery, String(every));

  if (!enabled) return;

  state.refreshTimer = setInterval(() => {
    const assetId = (els.assetId.value || '').trim();
    refreshForAsset(assetId);
  }, every);
}

function stopAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function initFromStorage() {
  els.baseUrl.value = baseUrl();

  const key = localStorage.getItem(STORAGE.apiKey) || '';
  const assetId = localStorage.getItem(STORAGE.assetId) || '';
  const auto = localStorage.getItem(STORAGE.autoRefresh);
  const every = localStorage.getItem(STORAGE.refreshEvery);

  if (key) els.apiKey.value = key;
  if (assetId) els.assetId.value = assetId;
  if (auto !== null) els.autoRefresh.checked = auto === '1';
  if (every) els.refreshEvery.value = every;
}

function wireEvents() {
  els.saveKeyBtn.addEventListener('click', () => {
    localStorage.setItem(STORAGE.apiKey, getApiKey());
    logLine('Saved x-api-key', 'ok');
    refreshForAsset((els.assetId.value || '').trim());
  });

  els.assetId.addEventListener('change', () => {
    const assetId = (els.assetId.value || '').trim();
    localStorage.setItem(STORAGE.assetId, assetId);
    refreshForAsset(assetId);
  });

  els.refreshBtn.addEventListener('click', () => {
    refreshForAsset((els.assetId.value || '').trim());
  });

  els.autoRefresh.addEventListener('change', () => startAutoRefresh());
  els.refreshEvery.addEventListener('change', () => startAutoRefresh());

  els.revokeBtn.addEventListener('click', () => {
    const assetId = (els.assetId.value || '').trim();
    if (!assetId) return;
    if (!confirm(`Revoke ACTIVE anchor for ${assetId}?`)) return;
    doRevokeActive(assetId);
  });

  els.decisionResetBtn.addEventListener('click', () => {
    const assetId = (els.assetId.value || '').trim();
    if (!assetId) return;
    doDecisionReset(assetId);
  });

  els.claimsBody.addEventListener('click', async (evt) => {
    const btn = evt.target.closest('button');
    if (!btn) return;

    const act = btn.getAttribute('data-act');
    const claimId = btn.getAttribute('data-claim');
    const assetId = (els.assetId.value || '').trim();

    if (!assetId || !claimId) return;

    if (act === 'endorse') {
      await doEndorse(assetId, claimId);
    } else if (act === 'reject') {
      await doReject(assetId, claimId);
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(claimId);
        logLine(`Copied claim id: ${claimId}`, 'ok');
      } catch (e) {
        logLine('Copy failed (clipboard permissions).', 'warn');
      }
    }
  });
}

async function boot() {
  initFromStorage();
  wireEvents();

  logLine('Supervisor UI loaded', 'ok');
  await refreshHealth();

  // Health polling (connectivity indicator)
  state.healthTimer = setInterval(refreshHealth, 5000);

  // Events polling (small "push-like" log)
  state.eventsTimer = setInterval(pollEvents, 1500);

  // Initial asset refresh
  await refreshForAsset((els.assetId.value || '').trim());

  // Start auto refresh if enabled
  startAutoRefresh();
}

boot();
