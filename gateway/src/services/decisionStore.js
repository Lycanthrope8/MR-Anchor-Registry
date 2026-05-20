/**
 * ==============================================================================
 * decisionStore.js
 *
 * Holds pending Decision envelopes between /skills/interpret and /skills/execute.
 * The human-in-the-loop flow needs a place to park the envelope while the user
 * reviews it in the admin panel.
 *
 *   /skills/interpret  →  store.put(decisionId, envelope)   ttl 5min
 *                         returns decisionId to the client
 *
 *   admin reviews
 *
 *   /skills/execute    →  store.consume(decisionId)         atomic, single-use
 *                         policy re-checks the envelope
 *                         invoke anchor-registry
 *                         RecordSkillDecision + LinkAnchorTx
 *
 * Persistence: in-memory map + append-only WAL file (one line of JSON per put).
 * WAL is for crash recovery only; on startup we replay it to repopulate memory,
 * dropping entries past their TTL.
 *
 * The WAL is NOT a substitute for on-chain audit. It only persists envelopes
 * that haven't yet been executed (= not yet on chain). Once consumed, the
 * envelope is removed from memory; the on-chain record is the durable trace.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_TTL_MS = 5 * 60 * 1000;     // 5 minutes per spec
const SWEEP_INTERVAL_MS = 30 * 1000;       // janitor runs twice a minute

class DecisionStore {
    /**
     * @param {object} opts
     * @param {string} opts.walPath  - absolute path to a writable WAL file
     * @param {number} [opts.ttlMs]  - default 5 minutes
     */
    constructor({ walPath, ttlMs } = {}) {
        if (!walPath) throw new Error('decisionStore: walPath required');
        this.walPath = walPath;
        this.ttlMs = Number(ttlMs || DEFAULT_TTL_MS);
        this._map = new Map();        // decisionId -> { envelope, putAt, expiresAt }
        this._sweepTimer = null;

        this._ensureWalFile();
        this._replay();
        this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
        if (this._sweepTimer.unref) this._sweepTimer.unref();
        logger.info(`decisionStore initialized, walPath=${this.walPath}, ttlMs=${this.ttlMs}`);
    }

    _ensureWalFile() {
        const dir = path.dirname(this.walPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.walPath)) fs.writeFileSync(this.walPath, '');
    }

    _replay() {
        const raw = fs.readFileSync(this.walPath, 'utf8');
        const now = Date.now();
        let kept = 0, dropped = 0;
        for (const line of raw.split('\n')) {
            const s = line.trim();
            if (!s) continue;
            try {
                const rec = JSON.parse(s);
                if (rec.op === 'put' && rec.decisionId && rec.envelope) {
                    if (rec.expiresAt && rec.expiresAt > now) {
                        this._map.set(rec.decisionId, {
                            envelope: rec.envelope,
                            putAt: rec.putAt,
                            expiresAt: rec.expiresAt,
                        });
                        kept++;
                    } else {
                        dropped++;
                    }
                } else if (rec.op === 'consume' && rec.decisionId) {
                    this._map.delete(rec.decisionId);
                }
            } catch (_) { /* skip malformed lines */ }
        }
        logger.info(`decisionStore replay: kept=${kept}, dropped=${dropped}`);
    }

    _appendWal(rec) {
        try {
            // Synchronous append — guarantees the line is on disk before put() returns.
            // Without this, crash recovery and TTL-replay would lose recent puts.
            fs.appendFileSync(this.walPath, JSON.stringify(rec) + '\n');
        } catch (e) {
            logger.error(`decisionStore: WAL append failed: ${e.message}`);
        }
    }

    _sweep() {
        const now = Date.now();
        let n = 0;
        for (const [id, entry] of this._map) {
            if (entry.expiresAt <= now) {
                this._map.delete(id);
                this._appendWal({ op: 'consume', decisionId: id, reason: 'ttl-expired', at: now });
                n++;
            }
        }
        if (n > 0) logger.debug(`decisionStore: swept ${n} expired entries`);
    }

    /**
     * Generate a fresh decisionId. We use the runtime's intentHash + a server-side
     * nonce so the same intentHash can be replayed (different requests, different
     * decisionIds) but still has the decision-side traceability.
     */
    static newDecisionId() {
        return 'sd-' + crypto.randomBytes(12).toString('hex');
    }

    /**
     * Store a pending decision envelope.
     */
    put(decisionId, envelope) {
        if (!decisionId) throw new Error('decisionStore.put: decisionId required');
        if (!envelope) throw new Error('decisionStore.put: envelope required');
        const putAt = Date.now();
        const expiresAt = putAt + this.ttlMs;
        this._map.set(decisionId, { envelope, putAt, expiresAt });
        this._appendWal({ op: 'put', decisionId, envelope, putAt, expiresAt });
        return { decisionId, expiresAt };
    }

    /**
     * Peek without consuming (used by GET /skills/decision/:id for the admin panel).
     */
    peek(decisionId) {
        const entry = this._map.get(decisionId);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this._map.delete(decisionId);
            return null;
        }
        return entry.envelope;
    }

    /**
     * Atomic consume: removes the entry and returns it. Returns null if missing.
     * After consume, the same decisionId cannot be consumed twice — that's the
     * replay protection at the gateway layer (the chaincode also enforces
     * duplicate-decisionId protection independently).
     */
    consume(decisionId) {
        const entry = this._map.get(decisionId);
        if (!entry) return null;
        this._map.delete(decisionId);
        this._appendWal({ op: 'consume', decisionId, at: Date.now() });
        if (entry.expiresAt <= Date.now()) return null;
        return entry.envelope;
    }

    size() { return this._map.size; }

    close() {
        if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    }
}

module.exports = DecisionStore;
