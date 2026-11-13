import { fileURLToPath } from 'node:url';
import { normalizeCatalog, stripCatalogCredentials, validateCatalog } from './catalog-normalize.mjs';
import {
    CACHED_CATALOG_FILE,
    IMPORTED_CATALOG_FILE,
    getOmtpRoot,
    omtpPath,
    readJsonFile,
    writeJsonAtomic,
} from './config.mjs';
import { normalizeCustomModel } from './key-store.mjs';
import { buildProviderConfig } from './provider-config.mjs';
import { sanitizeExternalLayer, validateBaseUrl } from './catalog-safety.mjs';
import { log, logError } from './redact.mjs';

const DEFAULT_OMP_MODELS_URL = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/models.json';
const DEFAULT_OMP_RULES_URL = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/compat/rules.json';
const DEFAULT_REMAINING_GATEWAY_ADAPTER = 'openai';

const FETCH_TIMEOUT_MS = 60_000;
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const MAX_FETCH_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/**
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * @param {Record<string, any>} providers
 * @returns {{providers:number, models:number}}
 */
function computeStats(providers) {
    let models = 0;
    for (const provider of Object.values(providers || {})) {
        models += Array.isArray(provider?.models) ? provider.models.length : 0;
    }
    return { providers: Object.keys(providers || {}).length, models };
}

/**
 * Derive a provider-map compatible exception table from a catalog, so OMP
 * `models.json` imports use the same adapter decisions as the bundled catalog.
 * @param {any} catalog
 * @returns {{remainingGatewayAdapter:string, exceptions:Record<string, any>}}
 */
export function providerMapFromCatalog(catalog) {
    /** @type {Record<string, any>} */
    const exceptions = {};
    for (const provider of Object.values(catalog?.providers || {})) {
        exceptions[provider.id] = {
            stAdapter: provider.stAdapter ?? null,
            gatewayAdapter: provider.gatewayAdapter ?? null,
            // Providers without bundled models (local runtimes, OAuth plans)
            // keep their endpoint when the catalog is rebuilt from OMP sources.
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            ...(provider.unsupportedReason ? { unsupportedReason: provider.unsupportedReason } : {}),
        };
    }
    return { remainingGatewayAdapter: DEFAULT_REMAINING_GATEWAY_ADAPTER, exceptions };
}

/**
 * Merge two catalogs. The overlay wins field-by-field; models merge by id.
 * @param {any} base
 * @param {any} overlay
 * @returns {any}
 */
function mergeCatalog(base, overlay) {
    /** @type {Record<string, any>} */
    const providers = {};
    for (const [id, provider] of Object.entries(base?.providers || {})) {
        providers[id] = { ...provider, models: Array.isArray(provider.models) ? [...provider.models] : [] };
    }
    for (const [id, provider] of Object.entries(overlay?.providers || {})) {
        const existing = providers[id];
        /** @type {Map<string, any>} */
        const models = new Map();
        for (const model of existing?.models || []) models.set(model.id, model);
        for (const model of provider.models || []) {
            models.set(model.id, { ...(models.get(model.id) || {}), ...model });
        }
        providers[id] = {
            ...(existing || {}),
            ...provider,
            id,
            models: [...models.values()],
        };
    }
    const merged = {
        ...(base || {}),
        ...(overlay || {}),
        schemaVersion: Number(base?.schemaVersion || overlay?.schemaVersion || 1),
        source: overlay?.source || base?.source || 'oh-my-pi',
        generatedAt: overlay?.generatedAt || base?.generatedAt || new Date().toISOString(),
        providers,
    };
    merged.stats = computeStats(providers);
    return merged;
}

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
async function readStreamLimited(response, maxBytes) {
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`Catalog exceeds ${maxBytes} bytes`);
    }
    if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`Catalog exceeds ${maxBytes} bytes`);
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new Error(`Catalog exceeds ${maxBytes} bytes`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

async function fetchJsonLimited(url, signal) {
    const initialHost = new URL(url).host;
    let currentUrl = url;
    let response;
    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
        response = await fetch(currentUrl, {
            signal,
            redirect: 'manual',
            headers: { Accept: 'application/json', 'User-Agent': 'omtp-gateway/0.1.0' },
        });
        if (!REDIRECT_STATUSES.has(response.status)) break;
        await response.body?.cancel?.().catch(() => {});
        if (hop === MAX_FETCH_REDIRECTS) {
            throw new Error('Too many catalog redirects');
        }
        const location = response.headers.get('location');
        if (!location) {
            throw new Error(`HTTP ${response.status} without Location for ${currentUrl}`);
        }
        let nextUrl;
        try {
            nextUrl = new URL(location, currentUrl);
        } catch {
            throw new Error(`Invalid catalog redirect URL for ${currentUrl}`);
        }
        if ((nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') || nextUrl.host !== initialHost) {
            throw new Error('Catalog redirect to a different host is not allowed');
        }
        currentUrl = nextUrl.toString();
    }
    if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`HTTP ${response.status} for ${currentUrl}`);
    }
    const buffer = await readStreamLimited(response, MAX_FETCH_BYTES);
    return JSON.parse(buffer.toString('utf8'));
}

/**
 * Layered catalog service: bundled -> cached -> imported overlay -> custom providers.
 */
export class CatalogService {
    /**
     * @param {{root?:string, keyStore?:any, bundledPath?:string|URL}} [options]
     */
    constructor(options = {}) {
        this.root = options.root || getOmtpRoot();
        this.keyStore = options.keyStore || null;
        this.bundledPath = options.bundledPath || new URL('../catalog/omtp-catalog.json', import.meta.url);
        /** @type {any|null} */
        this._catalog = null;
        /** @type {any|null} */
        this._bundled = null;
        /** @type {Promise<any>|null} */
        this._catalogPromise = null;
        /** @type {Promise<any>|null} */
        this._bundledPromise = null;
        this._generation = 0;
        this._source = 'bundled';
    }

    /**
     * @param {boolean} [force]
     * @returns {Promise<any>}
     */
    async loadBundled(force = false) {
        if (this._bundled && !force) return this._bundled;
        if (!force && this._bundledPromise) return this._bundledPromise;
        const load = (async () => {
            const bundledFile = this.bundledPath instanceof URL ? fileURLToPath(this.bundledPath) : this.bundledPath;
            const raw = await readJsonFile(bundledFile);
            if (!raw || !raw.providers) throw new Error('Bundled OMTP catalog is missing or invalid');
            this._bundled = raw;
            return raw;
        })();
        this._bundledPromise = load;
        try {
            return await load;
        } finally {
            if (this._bundledPromise === load) this._bundledPromise = null;
        }
    }

    /**
     * @param {string} file
     * @returns {Promise<any|null>}
     */
    async readLayer(file) {
        try {
            const raw = await readJsonFile(omtpPath(this.root, file));
            if (!raw || raw.schemaVersion !== 1 || typeof raw.providers !== 'object' || !raw.providers) {
                return null;
            }
            return raw;
        } catch (error) {
            logError(`ignoring unreadable catalog layer ${file}`, error);
            return null;
        }
    }

    /**
     * @returns {Promise<{providers:Record<string, any>}>}
     */
    async buildCustomProviders() {
        if (!this.keyStore) return { providers: {} };
        /** @type {Record<string, any>} */
        const providers = {};
        let configs = [];
        try {
            configs = await this.keyStore.listProviderConfigs();
        } catch (error) {
            logError('failed to read custom providers', error);
            return { providers };
        }
        for (const { id, config, unreadable } of configs) {
            if (unreadable || !config?.custom || !config.adapter) continue;
            const models = (Array.isArray(config.models) ? config.models : []).map(normalizeCustomModel).filter(Boolean);
            if (models.length === 0) continue;
            let baseUrl = '';
            try {
                baseUrl = validateBaseUrl(config.baseUrl);
            } catch (error) {
                logError(`ignoring custom provider ${id} with an unsafe base URL`, error);
                continue;
            }
            providers[id] = {
                id,
                label: config.label || id,
                api: 'custom',
                baseUrl,
                envVars: [],
                authKind: 'api-key',
                defaultModel: models[0].id,
                stAdapter: null,
                gatewayAdapter: config.adapter,
                custom: true,
                models,
            };
        }
        return { providers };
    }

    /**
     * @param {boolean} [force]
     * @returns {Promise<any>}
     */
    async loadActive(force = false) {
        if (this._catalog && !force) return this._catalog;
        if (!force && this._catalogPromise) return this._catalogPromise;
        const generation = force ? (this._generation += 1) : this._generation;
        if (force) {
            this._catalog = null;
            this._catalogPromise = null;
        }
        const load = (async () => {
            const bundled = await this.loadBundled(false);
            // Copy so the layers below never mutate the trusted bundled object.
            let merged = { ...bundled };
            let source = 'bundled';

            // Cached / imported layers come from the network or from disk and can
            // only contribute model metadata. Routing, headers and OAuth endpoints
            // always come from the bundled catalog.
            const cached = await this.readLayer(CACHED_CATALOG_FILE);
            if (cached) {
                merged = mergeCatalog(merged, sanitizeExternalLayer(cached, bundled));
                source = 'cached';
            }
            const imported = await this.readLayer(IMPORTED_CATALOG_FILE);
            if (imported) {
                merged = mergeCatalog(merged, sanitizeExternalLayer(imported, bundled));
                source = 'cached';
            }
            const custom = await this.buildCustomProviders();
            if (Object.keys(custom.providers).length > 0) {
                merged = mergeCatalog(merged, { providers: custom.providers });
            }
            // Ensure local-only OAuth client material (e.g. google-gemini-cli)
            // is scrubbed to env references before leaving this method.
            merged.providers = stripCatalogCredentials(merged.providers);
            merged.stats = computeStats(merged.providers);
            if (generation === this._generation) {
                this._catalog = merged;
                this._source = source;
            }
            return merged;
        })();
        this._catalogPromise = load;
        try {
            return await load;
        } finally {
            if (this._catalogPromise === load) this._catalogPromise = null;
        }
    }

    invalidate() {
        this._generation += 1;
        this._catalog = null;
        this._catalogPromise = null;
    }

    /**
     * @returns {Promise<any>}
     */
    async getCatalog() {
        return this.loadActive();
    }

    /**
     * @returns {Promise<Record<string, any>>}
     */
    async getProviders() {
        return (await this.loadActive()).providers;
    }

    /**
     * @param {string} id
     * @returns {Promise<any|null>}
     */
    async getProvider(id) {
        const providers = await this.getProviders();
        return Object.hasOwn(providers, id) ? providers[id] : null;
    }

    /**
     * @param {string} providerId
     * @param {string} modelId
     * @returns {Promise<any|null>}
     */
    async findModel(providerId, modelId) {
        const provider = await this.getProvider(providerId);
        if (!provider) return null;
        return (provider.models || []).find((model) => model.id === modelId) || null;
    }

    /**
     * @returns {Promise<{version:string, generatedAt:string, providers:number, models:number, source:string}>}
     */
    async stats() {
        const catalog = await this.loadActive();
        return {
            version: catalog.generatedAt || 'unknown',
            generatedAt: catalog.generatedAt || '',
            providers: catalog.stats?.providers ?? Object.keys(catalog.providers || {}).length,
            models: catalog.stats?.models ?? 0,
            source: this._source,
        };
    }

    /**
     * Models exposed to ST's custom-model dropdown: only providers whose
     * gateway adapter exists and whose key is resolved (or keyless).
     * @returns {Promise<Array<{provider:any, model:any, adapter:string}>>}
     */
    async getModelsForGateway() {
        const providers = await this.getProviders();
        /** @type {Array<{provider:any, model:any, adapter:string}>} */
        const rows = [];
        for (const provider of Object.values(providers)) {
            if (!provider.gatewayAdapter || provider.unsupportedReason) continue;
            let resolved;
            try {
                resolved = this.keyStore
                    ? await this.keyStore.resolveProvider(provider)
                    : buildProviderConfig(provider, { keyless: provider.authKind === 'none' });
            } catch (error) {
                logError(`failed to resolve provider ${provider.id}`, error);
                continue;
            }
            if (!resolved.available || !resolved.baseUrl) continue;
            for (const model of provider.models || []) {
                rows.push({ provider, model, adapter: resolved.adapter });
            }
        }
        return rows;
    }

    /**
     * Fetch, normalize, validate and persist a catalog. Keeps the old catalog on failure.
     * @param {string} [url]
     * @returns {Promise<{ok:boolean, version?:string, providers?:number, models?:number, source?:string, error?:string}>}
     */
    async refresh(url = '') {
        const target = String(url || '').trim() || DEFAULT_OMP_MODELS_URL;
        if (!isHttpUrl(target)) return { ok: false, error: 'Catalog URL must be http(s)' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const payload = await fetchJsonLimited(target, controller.signal);
            const bundled = await this.loadBundled();
            let catalog;
            if (payload && payload.schemaVersion === 1 && payload.providers && typeof payload.providers === 'object') {
                catalog = payload;
            } else {
                const rules = await fetchJsonLimited(DEFAULT_OMP_RULES_URL, controller.signal);
                catalog = normalizeCatalog(payload, rules, providerMapFromCatalog(bundled));
            }
            // External data may only contribute model metadata. Validate the
            // merged result (so routing fields from the bundled catalog are
            // present), then persist just the sanitized overlay.
            const safe = sanitizeExternalLayer(catalog, bundled);
            const effective = mergeCatalog(bundled, safe);
            const validation = validateCatalog(effective, { expectedProviders: 0, minModels: 0 });
            if (!validation.ok || validation.providers === 0) {
                return { ok: false, error: `Catalog validation failed: ${validation.errors.slice(0, 5).join('; ')}` };
            }
            if (!safe.generatedAt) safe.generatedAt = new Date().toISOString();
            safe.stats = computeStats(safe.providers);
            await writeJsonAtomic(omtpPath(this.root, CACHED_CATALOG_FILE), {
                ...safe,
                providers: stripCatalogCredentials(safe.providers),
            });
            this.invalidate();
            const active = await this.loadActive(true);
            this._source = 'refreshed';
            log(`catalog refreshed: ${effective.stats.providers} providers, ${effective.stats.models} models`);
            return {
                ok: true,
                version: active.generatedAt,
                providers: active.stats.providers,
                models: active.stats.models,
                source: 'refreshed',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logError('catalog refresh failed', error);
            return { ok: false, error: message };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Persist an imported catalog overlay (never overwrites bundled/cached).
     * @param {any} catalog
     */
    async writeImportedOverlay(catalog) {
        await writeJsonAtomic(omtpPath(this.root, IMPORTED_CATALOG_FILE), {
            ...catalog,
            providers: stripCatalogCredentials(catalog.providers),
        });
        this.invalidate();
    }
}
