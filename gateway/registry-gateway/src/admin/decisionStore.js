'use strict';

// In-memory supervisor decisions.
// Purpose: Provide a minimal "approve/reject" control plane without changing chaincode.
// This is intentionally volatile (resets on gateway restart). For a tighter prototype,
// you can later persist this in Postgres.

const MAX_EVENTS = 200;

/** @type {Map<string, any>} */
const decisions = new Map();
/** @type {Array<any>} */
const events = [];

function nowIso() {
  return new Date().toISOString();
}

function addEvent(evt) {
  events.push({ ...evt, ts: evt.ts || nowIso() });
  while (events.length > MAX_EVENTS) events.shift();
}

function getDecision(assetId) {
  return decisions.get(assetId) || null;
}

function setDecision(assetId, decision) {
  decisions.set(assetId, decision);
  addEvent({ type: 'DECISION', asset_id: assetId, decision: decision.decision, claim_id: decision.claim_id, by: decision.decided_by, reason: decision.reason || '' });
  return decision;
}

function resetDecision(assetId, decidedBy) {
  const existed = decisions.has(assetId);
  decisions.delete(assetId);
  if (existed) addEvent({ type: 'DECISION_RESET', asset_id: assetId, by: decidedBy });
  return existed;
}

function listEvents(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return events.slice(-n);
}

module.exports = {
  getDecision,
  setDecision,
  resetDecision,
  listEvents,
  nowIso,
};
