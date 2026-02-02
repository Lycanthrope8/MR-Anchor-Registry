'use strict';

const express = require('express');
const router = express.Router();
const { requireSupervisor } = require('../middleware/auth');
const store = require('./decisionStore');

// GET /admin/api/decision/:asset_id
router.get('/decision/:asset_id', (req, res) => {
  const assetId = req.params.asset_id;
  const decision = store.getDecision(assetId);
  return res.json({ success: true, asset_id: assetId, decision });
});

// POST /admin/api/decision/:asset_id/approve
router.post('/decision/:asset_id/approve', requireSupervisor, (req, res) => {
  const assetId = req.params.asset_id;
  const { claim_id, reason } = req.body || {};
  if (!claim_id) {
    return res.status(400).json({ success: false, error: 'claim_id required' });
  }
  const decision = {
    asset_id: assetId,
    claim_id,
    decision: 'APPROVED',
    reason: reason || '',
    decided_by: req.auth.apiKey,
    decided_at: store.nowIso(),
  };
  store.setDecision(assetId, decision);
  return res.json({ success: true, decision });
});

// POST /admin/api/decision/:asset_id/reject
router.post('/decision/:asset_id/reject', requireSupervisor, (req, res) => {
  const assetId = req.params.asset_id;
  const { claim_id, reason } = req.body || {};
  if (!claim_id) {
    return res.status(400).json({ success: false, error: 'claim_id required' });
  }
  const decision = {
    asset_id: assetId,
    claim_id,
    decision: 'REJECTED',
    reason: reason || '',
    decided_by: req.auth.apiKey,
    decided_at: store.nowIso(),
  };
  store.setDecision(assetId, decision);
  return res.json({ success: true, decision });
});

// POST /admin/api/decision/:asset_id/reset
router.post('/decision/:asset_id/reset', requireSupervisor, (req, res) => {
  const assetId = req.params.asset_id;
  const ok = store.resetDecision(assetId, req.auth.apiKey);
  return res.json({ success: true, asset_id: assetId, reset: ok });
});

// GET /admin/api/events?limit=50
router.get('/events', (req, res) => {
  const limit = req.query.limit;
  const events = store.listEvents(limit);
  return res.json({ success: true, count: events.length, events });
});

module.exports = router;
