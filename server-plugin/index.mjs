import fs from 'node:fs';
import express from 'express';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { getUserDirectories } from '../../src/users.js';
import { DEFAULT_USER } from '../../src/constants.js';
import {
    ensureGatewayToken,
    ensureOmtpRoot,
    getOmtpRoot,
    loadConfig,
    saveConfig,
} from './lib/config.mjs';
import { KeyStore, KeyStoreUnreadableError } from './lib/key-store.mjs';
import { CatalogService } from './lib/catalog-service.mjs';
import { GatewayServer, buildGatewayContext } from './lib/gateway-server.mjs';
import { buildModelsProbe, buildProviderContext, isSupportedAdapter, SUPPORTED_ADAPTERS } from './lib/provider-config.mjs';
import { parseStructuredCredential } from './lib/oauth.mjs';
import { importFromOmp } from './lib/import-omp.mjs';
import { getAdapter } from './lib/adapters/index.mjs';
import { log, logError } from './lib/redact.mjs';
import { headerHookSupported } from './lib/custom-logins/kimi-fingerprint.mjs';
import { USAGE_PROVIDERS, fetchProviderUsage } from './lib/usage.mjs';
import { loginEnv } from './lib/oauth-clients.mjs';
import { UsageStats } from './lib/stats.mjs';
import { ensureStatsServer, statsServerStatus, stopStatsServer } from './lib/stats-server.mjs';
import {
    cancelLogin,
    customHookSupported,
    describeSession,
    getSession,
    startLogin,
    submitCode,
} from './lib/login-engine.mjs';

/** Server plugin version, read once from its own package.json. */
const SERVER_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.1.0';
    } catch {
        return '0.1.0';
    }
})();

export const info = {
    id: 'omtp',
    name: 'OMTP Gateway',
    description: 'Auto-started OpenAI-compatible gateway for OMTP providers.',
};

/**
 * Provider id -> SillyTavern secret key. The gateway has no request user
 * context, so secrets are read from the default user's directories.
 */
const ST_SECRET_BY_PROVIDER = Object.freeze({
    openai: SECRET_KEYS.OPENAI,
    anthropic: SECRET_KEYS.CLAUDE,
    google: SECRET_KEYS.MAKERSUITE,
    'google-vertex': SECRET_KEYS.VERTEXAI,
    openrouter: SECRET_KEYS.OPENROUTER,
    mistral: SECRET_KEYS.MISTRALAI,
    deepseek: SECRET_KEYS.DEEPSEEK,
    xai: SECRET_KEYS.XAI,
    groq: SECRET_KEYS.GROQ,
    zai: SECRET_KEYS.ZAI,
    moonshot: SECRET_KEYS.MOONSHOT,
    minimax: SECRET_KEYS.MINIMAX,
    'minimax-cn': SECRET_KEYS.MINIMAX,
    fireworks: SECRET_KEYS.FIREWORKS,
    nanogpt: SECRET_KEYS.NANOGPT,
    aimlapi: SECRET_KEYS.AIMLAPI,
    chutes: SECRET_KEYS.CHUTES,
    electronhub: SECRET_KEYS.ELECTRONHUB,
    siliconflow: SECRET_KEYS.SILICONFLOW,
    'cloudflare-workers-ai': SECRET_KEYS.WORKERS_AI,
    pollinations: SECRET_KEYS.POLLINATIONS,
    perplexity: SECRET_KEYS.PERPLEXITY,
    cohere: SECRET_KEYS.COHERE,
    ai21: SECRET_KEYS.AI21,
    together: SECRET_KEYS.TOGETHERAI,
    azure: SECRET_KEYS.AZURE_OPENAI,
});

/**
 * @param {string} providerId
 * @returns {string}
 */
function resolveStSecret(providerId) {
    const secretKey = ST_SECRET_BY_PROVIDER[providerId];
    if (!secretKey) return '';
    try {
        const directories = getUserDirectories(DEFAULT_USER.handle);
        return readSecret(directories, secretKey) || '';
    } catch (error) {
        logError(`failed to read ST secret for ${providerId}`, error);
        return '';
    }
}

class HttpError extends Error {
    /**
     * @param {number} status
     * @param {string} message
     * @param {string} [code]
     * @param {string} [type]
     */
    constructor(status, message, code = null, type = 'invalid_request_error') {
        super(message);
        this.status = status;
        this.code = code;
        this.type = type;
    }
}

/** @type {{root:string, keyStore:KeyStore, catalogService:CatalogService, gateway:GatewayServer}|null} */
let state = null;

/**
 * @returns {{root:string, keyStore:KeyStore, catalogService:CatalogService, gateway:GatewayServer}}
 */
function requireState() {
    if (!state) throw new HttpError(503, 'OMTP server plugin failed to initialize', 'not_initialized', 'server_error');
    return state;
}

/**
 * Providers whose last live probe was rejected by the upstream with an auth
 * error. A stored key is not proof of a working key, so this is what separates
 * "signed in" from "has a key that the provider refuses".
 * @type {Map<string, {at:number, status:number, message:string}>}
 */
const authFailures = new Map();

const AUTH_FAILURE_HINT = /\b(401|403)\b|unauthor|invalid.*(?:api[ _-]?key|token)|authentication/i;

/**
 * @param {unknown} status
 * @param {unknown} message
 * @returns {boolean}
 */
function looksLikeAuthFailure(status, message) {
    if (status === 401 || status === 403) return true;
    return AUTH_FAILURE_HINT.test(String(message ?? ''));
}

/**
 * @param {string} providerId
 * @param {number} status
 * @param {string} message
 */
function recordAuthFailure(providerId, status, message) {
    authFailures.set(String(providerId), {
        at: Date.now(),
        status: Number(status) || 0,
        message: String(message || `HTTP ${status || 'error'}`),
    });
}

/**
 * @param {string} providerId
 */
function clearAuthFailure(providerId) {
    authFailures.delete(String(providerId));
}

/**
 * @param {string} providerId
 * @param {KeyStore} keyStore
 * @param {CatalogService} catalogService
 * @returns {Promise<any|null>}
 */
async function buildProviderStatus(providerId, keyStore, catalogService) {
    const provider = await catalogService.getProvider(providerId);
    const { config, unreadable } = await keyStore.getConfigSafe(providerId);
    if (!provider && !unreadable && Object.keys(config).length === 0) return null;
    const synthetic = provider || {
        id: providerId,
        label: config.label || providerId,
        baseUrl: config.baseUrl || '',
        api: 'custom',
        envVars: [],
        authKind: 'api-key',
        stAdapter: null,
        gatewayAdapter: config.adapter || null,
        custom: Boolean(config.custom),
        models: config.models || [],
    };
    let resolved;
    try {
        resolved = await keyStore.resolveProvider(synthetic);
    } catch (error) {
        logError(`failed to resolve provider ${providerId}`, error);
        resolved = {
            id: providerId,
            label: synthetic.label,
            adapter: synthetic.gatewayAdapter || null,
            baseUrl: synthetic.baseUrl,
            apiKey: '',
            keySource: 'none',
            available: false,
            custom: Boolean(synthetic.custom),
            models: synthetic.models || [],
        };
    }
    return {
        id: providerId,
        label: resolved.label || synthetic.label || providerId,
        adapter: resolved.adapter,
        baseUrl: resolved.baseUrl,
        authKind: synthetic.authKind || 'api-key',
        custom: Boolean(resolved.custom || synthetic.custom),
        hasKey: resolved.keySource !== 'none',
        keySource: resolved.keySource,
        last4: (() => {
            if (!resolved.apiKey) return '';
            const structured = parseStructuredCredential(resolved.apiKey);
            if (structured?.email) return structured.email;
            if (structured?.access) return structured.access.slice(-4);
            return resolved.apiKey.slice(-4);
        })(),
        available: Boolean(resolved.available) && !authFailures.has(providerId),
        modelCount: Array.isArray(resolved.models) ? resolved.models.length : 0,
        unreadable,
        keyInvalid: authFailures.has(providerId),
        loginKind: provider?.authLogin?.kind || null,
        // `custom` logins run only when we ship the provider's hook (see
        // `custom-logins/`); the rest fall back to the OMP import. Header
        // hooks (fingerprints) and `afterExchange` only enrich the credential,
        // so they never block the flow.
        loginNeedsHook: Boolean(
            (provider?.authLogin?.headersHook && !headerHookSupported(provider.authLogin.headersHook))
            || (provider?.authLogin?.kind === 'custom' && !customHookSupported(provider.authLogin.hook)),
        ),
        keyInvalidReason: authFailures.get(providerId)?.message ?? null,
        unsupportedReason: synthetic.unsupportedReason || authFailures.get(providerId)?.message || null,
    };
}

/**
 * @param {(req:any, res:any) => Promise<any>} fn
 * @returns {any}
 */
function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function extractModelIds(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (typeof entry === 'string' ? entry : entry?.id || entry?.name || ''))
            .filter(Boolean);
    }
    if (Array.isArray(value?.data)) return extractModelIds(value.data);
    if (Array.isArray(value?.models)) return extractModelIds(value.models);
    return [];
}

/** Successful live model lists, keyed by provider id. */
const liveModelsCache = new Map();
const LIVE_MODELS_TTL = 300_000;

/**
 * Fetch a provider's live model list. Successful results are cached; auth
 * rejections are remembered so the UI can tell a working key from a dead one.
 *
 * @param {any} current
 * @param {string} providerId
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<any>} response payload
 */
async function probeProviderModels(current, providerId, { refresh = false } = {}) {
    const cached = liveModelsCache.get(providerId);
    if (!refresh && cached && Date.now() - cached.at < LIVE_MODELS_TTL) {
        return { ok: true, cached: true, models: cached.models, at: cached.at };
    }

    const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
    if (!status) {
        throw new HttpError(404, `Unknown provider: ${providerId}`, 'unknown_provider');
    }
    // A rejected key still counts as configured: the user has to be able to
    // re-probe after fixing it.
    if (!status.hasKey && status.authKind !== 'none') {
        return { ok: false, available: false, error: 'No credentials configured', models: [] };
    }

    const provider = (await current.catalogService.getProvider(providerId)) || {
        id: providerId,
        label: status.label,
        baseUrl: status.baseUrl,
        api: 'custom',
        envVars: [],
        authKind: status.authKind,
        gatewayAdapter: status.adapter,
        models: [],
    };

    const resolved = await current.keyStore.resolveProvider(provider);
    const adapter = await getAdapter(resolved.adapter);

    try {
        let rawModels = [];
        if (adapter && typeof adapter.listModels === 'function') {
            const ctx = await buildGatewayContext(resolved, current.keyStore, '', AbortSignal.timeout(20_000), provider);
            rawModels = await adapter.listModels(ctx);
        } else {
            const probe = buildModelsProbe(resolved);
            if (probe) {
                const response = await fetch(probe.url, {
                    headers: probe.headers,
                    signal: AbortSignal.timeout(20_000),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const text = await response.text();
                try {
                    rawModels = JSON.parse(text);
                } catch {
                    rawModels = [];
                }
            }
        }

        const modelIds = extractModelIds(rawModels);
        const detailedModels = Array.isArray(rawModels)
            ? rawModels.map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name || m.id, ...m }))
            : modelIds.map((id) => ({ id, name: id }));

        liveModelsCache.set(providerId, { models: detailedModels, at: Date.now() });
        clearAuthFailure(providerId);
        return { ok: true, models: detailedModels, at: Date.now() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = Number(/\(HTTP (\d{3})\)/.exec(message)?.[1] || /^HTTP (\d{3})$/.exec(message)?.[1] || 0);
        if (looksLikeAuthFailure(code, message)) {
            recordAuthFailure(providerId, code, message);
        }
        return { ok: false, error: message, models: [] };
    }
}

/**
 * Probe every provider that has credentials, once, in the background, so the
 * sidebar can distinguish a working key from a rejected one without waiting
 * for the user to click refresh.
 * @param {any} current
 */
async function validateKeyedProviders(current) {
    let providers = {};
    try {
        providers = await current.catalogService.getProviders();
    } catch (error) {
        logError('key validation skipped: provider list unavailable', error);
        return;
    }
    const ids = Object.keys(providers);
    const queue = [];
    for (const id of ids) {
        const status = await buildProviderStatus(id, current.keyStore, current.catalogService).catch(() => null);
        if (status?.hasKey && status.authKind !== 'none') {
            queue.push(id);
        }
    }
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
            await probeProviderModels(current, id, { refresh: true }).catch(() => {});
        }
    });
    await Promise.all(workers);
}

/**
 * @param {any} router
 */
function registerRoutes(router) {
    router.get('/status', asyncRoute(async (req, res) => {
        const current = requireState();
        const catalog = await current.catalogService.stats().catch(() => ({
            version: 'unknown',
            generatedAt: '',
            providers: 0,
            models: 0,
            source: 'bundled',
        }));
        res.json({
            gateway: current.gateway.getStatus(),
            catalog,
            serverPlugin: true,
            serverVersion: SERVER_VERSION,
        });
    }));

    router.get('/catalog', asyncRoute(async (req, res) => {
        const current = requireState();
        res.json(await current.catalogService.getCatalog());
    }));

    router.post('/catalog/refresh', asyncRoute(async (req, res) => {
        const current = requireState();
        const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        const result = await current.catalogService.refresh(url);
        res.status(result.ok ? 200 : 400).json(result);
    }));

    router.get('/providers', asyncRoute(async (req, res) => {
        const current = requireState();
        const providers = await current.catalogService.getProviders();
        /** @type {string[]} */
        const ids = Object.keys(providers);
        const stored = await current.keyStore.listProviderConfigs();
        for (const entry of stored) {
            if (!ids.includes(entry.id)) ids.push(entry.id);
        }
        /** @type {any[]} */
        const list = [];
        for (const id of ids.sort()) {
            const status = await buildProviderStatus(id, current.keyStore, current.catalogService);
            if (status) list.push(status);
        }
        res.json({ providers: list });
    }));

    router.post('/providers/:id/key', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
        if (!key) throw new HttpError(400, 'key is required', 'invalid_key');
        await current.keyStore.setProviderConfig(providerId, { apiKey: key });
        clearAuthFailure(providerId);
        current.catalogService.invalidate();
        const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
        res.json({ ok: true, provider: status });
    }));

    router.delete('/providers/:id/key', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        await current.keyStore.clearProviderKey(providerId);
        clearAuthFailure(providerId);
        current.catalogService.invalidate();
        const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
        res.json({ ok: true, provider: status });
    }));

    router.post('/providers/:id/config', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        /** @type {Record<string, any>} */
        const patch = {};
        for (const key of ['label', 'adapter', 'baseUrl', 'headers', 'extraConfig', 'custom', 'models']) {
            if (key in body) patch[key] = body[key];
        }
        if (patch.adapter !== undefined && patch.adapter !== null && patch.adapter !== '' && !isSupportedAdapter(patch.adapter)) {
            throw new HttpError(400, `Unsupported adapter; expected one of ${SUPPORTED_ADAPTERS.join(', ')}`, 'invalid_adapter');
        }
        if (patch.headers !== undefined && patch.headers !== null && (typeof patch.headers !== 'object' || Array.isArray(patch.headers))) {
            throw new HttpError(400, 'headers must be an object', 'invalid_headers');
        }
        if (patch.extraConfig !== undefined && patch.extraConfig !== null && (typeof patch.extraConfig !== 'object' || Array.isArray(patch.extraConfig))) {
            throw new HttpError(400, 'extraConfig must be an object', 'invalid_extra_config');
        }
        if (patch.models !== undefined && !Array.isArray(patch.models)) {
            throw new HttpError(400, 'models must be an array', 'invalid_models');
        }
        if (Object.keys(patch).length === 0) throw new HttpError(400, 'No config fields supplied', 'invalid_config');
        await current.keyStore.setProviderConfig(providerId, patch);
        current.catalogService.invalidate();
        const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
        res.json({ ok: true, provider: status });
    }));

    router.delete('/providers/:id/config', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const removed = await current.keyStore.deleteProviderConfig(providerId);
        current.catalogService.invalidate();
        res.json({ ok: true, removed, id: providerId });
    }));

    router.post('/providers/:id/test', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
        if (!status) throw new HttpError(404, `Unknown provider: ${providerId}`, 'unknown_provider');
        if (!status.adapter) {
            res.json({ ok: false, error: 'Provider has no gateway adapter' });
            return;
        }
        if (!status.hasKey && status.authKind !== 'none') {
            res.json({ ok: false, error: 'Provider has no API key' });
            return;
        }
        const provider = await current.catalogService.getProvider(providerId) || {
            id: providerId,
            label: status.label,
            baseUrl: status.baseUrl,
            api: 'custom',
            envVars: [],
            authKind: status.authKind,
            gatewayAdapter: status.adapter,
            models: [],
        };
        const resolved = await current.keyStore.resolveProvider(provider);
        const model = resolved.models?.[0]?.id || provider.defaultModel || '';
        const adapter = await getAdapter(resolved.adapter);
        try {
            if (adapter && typeof adapter.listModels === 'function') {
                const models = await adapter.listModels(buildProviderContext(resolved, model, AbortSignal.timeout(20_000), provider));
                clearAuthFailure(providerId);
                res.json({ ok: true, models: extractModelIds(models).slice(0, 20) });
                return;
            }
            const probe = buildModelsProbe(resolved);
            if (!probe) {
                res.json({ ok: true, skipped: true, message: 'Adapter does not expose a model listing endpoint' });
                return;
            }
            const response = await fetch(probe.url, {
                headers: probe.headers,
                signal: AbortSignal.timeout(20_000),
            });
            const text = await response.text();
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
            if (!response.ok) {
                if (looksLikeAuthFailure(response.status, '')) {
                    recordAuthFailure(providerId, response.status, `HTTP ${response.status}`);
                }
                res.json({ ok: false, status: response.status, error: `HTTP ${response.status}` });
                return;
            }
            clearAuthFailure(providerId);
            res.json({ ok: true, status: response.status, models: extractModelIds(parsed).slice(0, 20) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = Number(/\(HTTP (\d{3})\)/.exec(message)?.[1] || 0);
            if (looksLikeAuthFailure(status, message)) {
                recordAuthFailure(providerId, status, message);
            }
            res.json({ ok: false, error: message });
        }
    }));

    router.get('/providers/:id/models', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const refresh = req.query?.refresh === 'true';
        res.json(await probeProviderModels(current, providerId, { refresh }));
    }));

    /* ---------------- OAuth login (mirrors omp's /login) ---------------- */

    const loginPolicyFor = async (current, providerId) => {
        const provider = await current.catalogService.getProvider(providerId);
        if (!provider?.authLogin) return null;
        // `result` decides whether the flow yields a durable key or a session.
        return { ...provider.authLogin, result: provider.authResult || '' };
    };

    /* ---------------- Token accounting (mirrors `omp` run summaries) ---------------- */

    router.get('/stats', asyncRoute(async (req, res) => {
        const current = requireState();
        const since = typeof req.query?.since === 'string' ? req.query.since : null;
        const chat = typeof req.query?.chat === 'string' ? req.query.chat : '';
        res.json({ ok: true, ...current.stats.snapshot({ since, chat }) });
    }));

    /* ---------------- Stats dashboard (mirrors `omp stats`) ---------------- */

    // `omp stats` serves a local page; so does this. The dashboard binds to
    // loopback only and shuts itself down after a half hour of silence.
    router.get('/stats/server', asyncRoute(async (req, res) => {
        const current = requireState();
        const chat = typeof req.query?.chat === 'string' ? req.query.chat : '';
        const lang = typeof req.query?.lang === 'string' ? req.query.lang : '';
        const { url, port, reused } = await ensureStatsServer({ stats: current.stats, chat, lang });
        res.json({ ok: true, url, port, reused });
    }));

    router.get('/stats/server/status', asyncRoute(async (_req, res) => {
        res.json({ ok: true, server: statsServerStatus() });
    }));

    /* ---------------- Usage / quota (mirrors `omp usage`) ---------------- */

    router.get('/usage', asyncRoute(async (req, res) => {
        const current = requireState();
        const refresh = req.query?.refresh === 'true';
        const catalog = await current.catalogService.getCatalog();
        const providers = Object.values(catalog?.providers || {})
            .filter((provider) => USAGE_PROVIDERS.has(String(provider.id)))
            .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));

        const rows = [];
        const queue = [...providers];
        const worker = async () => {
            while (queue.length) {
                const provider = queue.shift();
                if (!provider) break;
                const resolved = await current.keyStore.resolveProvider(provider).catch(() => null);
                // omp's usage page only lists providers it can actually read, and so
                // do we: a provider without credentials would just be noise.
                if (!resolved?.apiKey) {
                    continue;
                }
                rows.push(await fetchProviderUsage(provider.id, resolved, { refresh, label: resolved.label }));
            }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
        rows.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
        res.json({ ok: true, fetchedAt: new Date().toISOString(), providers: rows });
    }));

    router.post('/providers/:id/login', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        const policy = await loginPolicyFor(current, providerId);
        if (!policy) throw new HttpError(400, 'This provider has no login flow', 'no_login');
        const locale = typeof req.body?.locale === 'string' ? req.body.locale : '';
        // Client ids/secrets live in the local config, not the catalog.
        const env = { ...process.env, ...loginEnv(current.keyStore.root, providerId) };
        const started = await startLogin(providerId, policy, { keyStore: current.keyStore, locale, env });
        clearAuthFailure(providerId);
        res.json({ ok: true, ...started });
    }));

    router.get('/providers/:id/login/:session', asyncRoute(async (req, res) => {
        const session = getSession(req.params.session);
        if (!session || session.providerId !== String(req.params.id || '')) {
            throw new HttpError(404, 'Unknown or expired login session', 'unknown_session');
        }
        if (session.status === 'done') {
            clearAuthFailure(session.providerId);
        }
        res.json({ ok: true, ...describeSession(session) });
    }));

    router.post('/providers/:id/login/:session/code', asyncRoute(async (req, res) => {
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const session = await submitCode(req.params.session, code);
        if (session.status === 'done') clearAuthFailure(session.providerId);
        res.json({ ok: session.status === 'done', ...describeSession(session) });
    }));

    router.delete('/providers/:id/login/:session', asyncRoute(async (req, res) => {
        const removed = cancelLogin(req.params.session);
        res.json({ ok: true, canceled: removed });
    }));

    router.post('/providers/:id/logout', asyncRoute(async (req, res) => {
        const current = requireState();
        const providerId = String(req.params.id || '');
        await current.keyStore.clearProviderKey(providerId);
        clearAuthFailure(providerId);
        current.catalogService.invalidate();
        const status = await buildProviderStatus(providerId, current.keyStore, current.catalogService);
        res.json({ ok: true, provider: status });
    }));

    router.get('/gateway/token', asyncRoute(async (req, res) => {
        const current = requireState();
        const token = await ensureGatewayToken(current.root);
        res.json({ token });
    }));

    router.post('/gateway/restart', asyncRoute(async (req, res) => {
        const current = requireState();
        const status = await current.gateway.restart();
        res.json(status);
    }));

    router.get('/config', asyncRoute(async (req, res) => {
        const current = requireState();
        res.json(await loadConfig(current.root));
    }));

    router.post('/config', asyncRoute(async (req, res) => {
        const current = requireState();
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        /** @type {Record<string, any>} */
        const patch = {};
        if (typeof body.autoStart === 'boolean') patch.autoStart = body.autoStart;
        if (body.port !== undefined) patch.port = body.port;
        if (typeof body.requireAuth === 'boolean') patch.requireAuth = body.requireAuth;
        const config = await saveConfig(current.root, patch);
        let status;
        if (config.autoStart) {
            status = await current.gateway.restart();
        } else {
            await current.gateway.stop();
            status = current.gateway.getStatus();
        }
        res.json({ config, gateway: status });
    }));

    router.post('/import/omp', asyncRoute(async (req, res) => {
        const current = requireState();
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const credentials = Boolean(body.credentials);
        if (credentials && body.confirm !== true) {
            throw new HttpError(400, 'Credential import requires confirm:true', 'confirmation_required');
        }
        const bundled = await current.catalogService.loadBundled().catch(() => null);
        const result = await importFromOmp({
            catalogPath: typeof body.catalogPath === 'string' ? body.catalogPath : '',
            credentials,
            keyStore: current.keyStore,
            bundledCatalog: bundled,
            root: current.root,
        });
        current.catalogService.invalidate();
        // Imported credentials replace whatever we had; a failure recorded for
        // the previous key must not survive and label the new one "rejected".
        for (const id of result.credentialProviders || []) {
            clearAuthFailure(id);
        }
        res.json(result);
    }));

    router.use((req, res) => {
        res.status(404).json({
            error: {
                message: 'Not found',
                type: 'invalid_request_error',
                code: 'not_found',
            },
        });
    });

    // eslint-disable-next-line no-unused-vars
    router.use((error, req, res, next) => {
        if (res.headersSent) {
            res.end();
            return;
        }
        if (error instanceof KeyStoreUnreadableError) {
            res.status(409).json({
                error: {
                    message: error.message,
                    type: 'key_store_error',
                    code: error.code,
                },
            });
            return;
        }
        const status = Number(error?.status) || 500;
        if (status >= 500) logError('route failed', error);
        res.status(status).json({
            error: {
                message: error instanceof Error ? error.message : 'OMTP server error',
                type: error?.type || 'server_error',
                code: error?.code || null,
            },
        });
    });
}

/**
 * @returns {Promise<{root:string, keyStore:KeyStore, catalogService:CatalogService, gateway:GatewayServer}>}
 */
async function createState() {
    const root = getOmtpRoot();
    await ensureOmtpRoot(root);
    const keyStore = new KeyStore({ root, resolveStSecret });
    try {
        const { importOmpCredentials } = await import('./lib/import-omp.mjs');
        await importOmpCredentials({ keyStore });
    } catch {
        // Non-fatal if OMP is absent.
    }
    const catalogService = new CatalogService({ root, keyStore });
    try {
        await catalogService.loadActive();
    } catch (error) {
        logError('failed to load bundled catalog', error);
    }
    const stats = new UsageStats({ root });
    const gateway = new GatewayServer({ root, catalogService, keyStore, stats });
    try {
        const config = await loadConfig(root);
        if (config.autoStart) {
            await gateway.start();
        }
    } catch (error) {
        logError('gateway startup failed; native mode is unaffected', error);
    }
    return { root, keyStore, catalogService, gateway, stats };
}

/**
 * @param {any} router
 */
export async function init(router) {
    try {
        state = await createState();
        const status = state.gateway.getStatus();
        log(status.running
            ? `server plugin ready; gateway ${status.external ? 'reused' : 'running'} at ${status.url}`
            : `server plugin ready; gateway stopped${status.lastError ? ` (${status.lastError})` : ''}`);
        // Learn which stored keys actually work, without blocking startup.
        const current = state;
        setTimeout(() => {
            validateKeyedProviders(current).catch((error) => logError('key validation failed', error));
        }, 2500);
    } catch (error) {
        state = null;
        logError('server plugin initialization failed', error);
    }
    registerRoutes(router);
}

export async function exit() {
    stopStatsServer();
    if (!state) return;
    try {
        await state.gateway.stop();
    } catch (error) {
        logError('failed to stop gateway', error);
    }
    state = null;
}

export default { info, init, exit };
