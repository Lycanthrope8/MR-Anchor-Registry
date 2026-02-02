# MR Anchor Registry — Supervisor Web UI (Tiny, Real‑Time)

This drop‑in adds a minimal supervisor control panel to the existing **registry-gateway**.

## What it does
- Serves a static web page at: `/admin/`
- Page auto-refreshes (no manual reload) to show:
  - Active claim for an `asset_id`
  - All claims for that `asset_id`
  - An in-memory supervisor decision (APPROVED/REJECTED) for that `asset_id`
- Lets supervisor:
  - **Approve** a claim by calling the existing `/claims/{claim_id}/endorse` endpoint
  - **Reject** a claim (stored in gateway memory only, for now)
  - **Revoke** the ACTIVE claim via `/assets/{asset_id}/revoke`

## Files included
- `gateway/registry-gateway/src/index.js` (updated)
- `gateway/registry-gateway/src/admin/decisionStore.js` (new)
- `gateway/registry-gateway/src/admin/routes.js` (new)
- `gateway/registry-gateway/src/admin/public/index.html` (new)
- `gateway/registry-gateway/src/admin/public/styles.css` (new)
- `gateway/registry-gateway/src/admin/public/app.js` (new)

## Install (copy into your repo)
1) From the repo root (`MR-Anchor-Registry`), copy the `gateway/registry-gateway/src/...` paths from this zip into your project, overwriting when asked.

2) Rebuild and restart the gateway container:
- `docker-compose up -d --no-deps gateway`
- `docker-compose up -d gateway`

3) Open the UI:
- If you can reach the server directly: `http://<server-ip>:3000/admin/`
- If you're working over SSH, use port-forwarding:
  - `ssh -L 3000:localhost:3000 <user>@<server>`
  - then open: `http://localhost:3000/admin/`

4) In the UI:
- Enter the supervisor key (default from docker-compose: `supervisor-key-001`)
- Enter `asset_id` (from the headset InfoPanel, e.g., `chair_TAG_12`)
- Leave Auto refresh on (1–2s)

## Notes
- Reject/decision is **in-memory** (resets if gateway restarts). This is intentional to keep the prototype simple.
- The on-chain lifecycle still comes from Fabric; the page is just a thin supervisor panel.
