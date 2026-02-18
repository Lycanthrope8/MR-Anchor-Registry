/**
 * ==============================================================================
 * benchmark.js - Benchmark log upload routes
 * Phase 4: Receives benchmark results from Unity devices and stores them
 * under experiments/runs/<run_id>/
 * ==============================================================================
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');

const EXPERIMENTS_BASE = path.resolve(__dirname, '../../experiments/runs');

/**
 * Upload benchmark summary from device
 * POST /admin/benchmark-upload
 */
router.post('/benchmark-upload', (req, res) => {
    try {
        const { run_id } = req.body;
        if (!run_id) {
            return res.status(400).json({ success: false, error: 'Missing run_id' });
        }

        const dir = path.join(EXPERIMENTS_BASE, run_id);
        fs.mkdirSync(dir, { recursive: true });

        const filePath = path.join(dir, 'device_summary.json');
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));

        logger.info(`[Benchmark] Summary saved: ${filePath}`);
        res.json({ success: true, path: filePath });

    } catch (error) {
        logger.error(`[Benchmark] Upload summary error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Upload raw JSONL log file from device
 * POST /admin/benchmark-upload-log
 * Body: { run_id, log_type, content, line_count }
 */
router.post('/benchmark-upload-log', (req, res) => {
    try {
        const { run_id, log_type, content, line_count } = req.body;

        if (!run_id || !log_type || !content) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: run_id, log_type, content'
            });
        }

        // Sanitize log_type to prevent path traversal
        const safeLogType = log_type.replace(/[^a-zA-Z0-9_-]/g, '_');

        const dir = path.join(EXPERIMENTS_BASE, run_id);
        fs.mkdirSync(dir, { recursive: true });

        const filePath = path.join(dir, `device_${safeLogType}.jsonl`);

        // Append mode so multiple devices/lanes can write to the same run
        fs.appendFileSync(filePath, content + '\n');

        logger.info(`[Benchmark] Log uploaded: ${filePath} (${line_count} lines)`);
        res.json({ success: true, path: filePath, lines: line_count });

    } catch (error) {
        logger.error(`[Benchmark] Upload log error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * List available benchmark runs
 * GET /admin/benchmark-runs
 */
router.get('/benchmark-runs', (req, res) => {
    try {
        if (!fs.existsSync(EXPERIMENTS_BASE)) {
            return res.json({ success: true, runs: [] });
        }

        const runs = fs.readdirSync(EXPERIMENTS_BASE, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const runDir = path.join(EXPERIMENTS_BASE, d.name);
                const files = fs.readdirSync(runDir);
                const hasSummary = files.includes('device_summary.json');

                let summary = null;
                if (hasSummary) {
                    try {
                        summary = JSON.parse(
                            fs.readFileSync(path.join(runDir, 'device_summary.json'), 'utf8')
                        );
                    } catch (e) { /* ignore parse errors */ }
                }

                return {
                    run_id: d.name,
                    files: files,
                    has_device_summary: hasSummary,
                    summary_preview: summary ? {
                        lane: summary.lane,
                        proposals_sent: summary.proposals_sent,
                        proposals_completed: summary.proposals_completed,
                        commit_confirm_p50_ms: summary.commit_confirm_p50_ms,
                        reason: summary.reason
                    } : null
                };
            })
            .sort((a, b) => b.run_id.localeCompare(a.run_id));

        res.json({ success: true, runs });

    } catch (error) {
        logger.error(`[Benchmark] List runs error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get files for a specific run
 * GET /admin/benchmark-runs/:runId
 */
router.get('/benchmark-runs/:runId', (req, res) => {
    try {
        const runDir = path.join(EXPERIMENTS_BASE, req.params.runId);
        if (!fs.existsSync(runDir)) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const files = fs.readdirSync(runDir).map(f => {
            const stats = fs.statSync(path.join(runDir, f));
            return { name: f, size_bytes: stats.size, modified: stats.mtime.toISOString() };
        });

        res.json({ success: true, run_id: req.params.runId, files });

    } catch (error) {
        logger.error(`[Benchmark] Get run error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Download a specific log file from a run
 * GET /admin/benchmark-runs/:runId/:fileName
 */
router.get('/benchmark-runs/:runId/:fileName', (req, res) => {
    try {
        const safeFileName = path.basename(req.params.fileName);
        const filePath = path.join(EXPERIMENTS_BASE, req.params.runId, safeFileName);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        const content = fs.readFileSync(filePath, 'utf8');

        if (safeFileName.endsWith('.json')) {
            res.setHeader('Content-Type', 'application/json');
        } else if (safeFileName.endsWith('.jsonl')) {
            res.setHeader('Content-Type', 'application/x-ndjson');
        }

        res.send(content);

    } catch (error) {
        logger.error(`[Benchmark] Download file error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;