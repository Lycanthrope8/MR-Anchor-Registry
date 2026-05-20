/**
 * ============================================================================
 * server.js — PATCH INSTRUCTIONS for Phase 4
 *
 * Add the /skills route mount and the corresponding require.
 * Do NOT replace the file — insert the marked blocks at the locations shown.
 * ============================================================================
 */

// ─── INSERT 1: Add the require alongside the other route requires ───
// LOCATION: around line 30-32 in server.js, after:
//
//   const benchmarkRoutes = require('./routes/benchmark');
//
// ADD:

const skillsRoutes = require('./routes/skills');     // NEW (Phase 4)

// ─── INSERT 2: Mount the route under /skills, alongside the other app.use lines ───
// LOCATION: around line 106-110, after:
//
//   app.use('/admin', adminRoutes);
//   app.use('/admin', benchmarkRoutes);
//   app.use('/events', eventsRoutes);
//
// ADD:

app.use('/skills', skillsRoutes);                    // NEW (Phase 4)

// ─── INSERT 3 (optional but recommended): Add startup banner line ───
// LOCATION: in startServer(), inside the app.listen callback (around line 158),
// after:
//
//   logger.info(`Annotation routes: /annotations/*`);
//
// ADD:

        logger.info(`Skill routes: /skills/* (LLM-mediated governance)`);

// ─── End of patch ───
//
// After applying all three inserts, restart both gateway instances. They should
// log the new banner line and respond to:
//
//   GET  /skills/health
//   POST /skills/interpret
//   GET  /skills/decision/:id
//   POST /skills/execute
//   GET  /skills/audit/:decisionId
//   GET  /skills/audit/anchor/:assetId
