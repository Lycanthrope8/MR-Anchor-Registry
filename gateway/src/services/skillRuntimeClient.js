/**
 * ==============================================================================
 * skillRuntimeClient.js
 *
 * HTTP client for MR-Skill-Runtime, which runs on a SEPARATE edge box.
 * The gateway never speaks to an LLM directly — the runtime does, on the edge.
 * This client only does HTTP calls; no Fabric credentials cross over.
 *
 * Env vars:
 *   SKILL_RUNTIME_URL       e.g. http://edge.local:5100 (REQUIRED for /skills/*)
 *   SKILL_RUNTIME_TIMEOUT_MS default 30000
 *   SKILL_RUNTIME_API_KEY    optional shared secret if you put a proxy in front
 * ==============================================================================
 */

const logger = require('./logger');

class SkillRuntimeClient {
    constructor({ baseUrl, timeoutMs, apiKey } = {}) {
        this.baseUrl = (baseUrl || process.env.SKILL_RUNTIME_URL || '').replace(/\/$/, '');
        this.timeoutMs = Number(timeoutMs || process.env.SKILL_RUNTIME_TIMEOUT_MS || 30000);
        this.apiKey = apiKey || process.env.SKILL_RUNTIME_API_KEY || null;
        this._healthy = null;
        this._healthCheckedAt = 0;
    }

    isConfigured() {
        return !!this.baseUrl;
    }

    _headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
        return h;
    }

    async _fetch(path, init = {}) {
        if (!this.baseUrl) {
            throw new Error('SKILL_RUNTIME_URL is not configured');
        }
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), this.timeoutMs);
        const url = `${this.baseUrl}${path}`;
        try {
            const res = await fetch(url, {
                ...init,
                headers: { ...this._headers(), ...(init.headers || {}) },
                signal: controller.signal,
            });
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`runtime HTTP ${res.status}: ${text.slice(0, 400)}`);
            }
            try { return JSON.parse(text); }
            catch (e) { throw new Error(`runtime returned non-JSON: ${text.slice(0, 400)}`); }
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`runtime call to ${path} timed out after ${this.timeoutMs}ms`);
            }
            throw e;
        } finally {
            clearTimeout(t);
        }
    }

    /**
     * GET /health on the runtime.
     * Cached for 30s — the gateway calls this on each /skills/interpret
     * to surface configuration drift but we don't want to overload the edge.
     */
    async health() {
        const now = Date.now();
        if (this._healthy !== null && (now - this._healthCheckedAt) < 30000) {
            return this._healthy;
        }
        try {
            const res = await this._fetch('/health', { method: 'GET' });
            this._healthy = res;
            this._healthCheckedAt = now;
            return res;
        } catch (e) {
            this._healthy = { ok: false, error: e.message };
            this._healthCheckedAt = now;
            throw e;
        }
    }

    /**
     * Send a request to /skills/interpret on the runtime.
     * Returns the runtime's envelope (decision + audit metadata).
     */
    async interpret({ userText, orgMsp, context }) {
        const body = { userText, orgMsp, context: context || {} };
        return this._fetch('/skills/interpret', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
}

module.exports = SkillRuntimeClient;
