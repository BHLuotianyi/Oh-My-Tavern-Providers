/**
 * Catalog loading, merging and entry construction.
 *
 * The bundled catalog is always available; the optional server plugin serves
 * the active (possibly refreshed) catalog. Fetch failures degrade silently to
 * the bundled snapshot so native selection keeps working without the plugin.
 */

import { extension_settings } from '../../../../extensions.js';
import {
    CATALOG_SCHEMA_VERSION,
    NATIVE_PROVIDER_IDS,
    PROFILE_PROVIDER_ID,
} from './constants.js';
import { getNativeAdapter } from './adapters/native.js';
import { apiBase, hasServerBackend, requestHeaders } from './backend.js';
import { gatewayUnavailableText, tr } from './ui/dom.js';

const EMPTY_CATALOG = Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'none',
    generatedAt: null,
    providers: Object.freeze({}),
    stats: Object.freeze({ providers: 0, models: 0 }),
});

const NATIVE_PROVIDER_SET = new Set(NATIVE_PROVIDER_IDS);
const MANAGEMENT_TIMEOUT_MS = 8000;
const PROVIDER_AVAILABILITY_TTL_MS = 5000;

let activeCatalog = EMPTY_CATALOG;
let catalogSource = 'none';
let catalogError = null;
let entriesCache = null;
let catalogIndex = null;
let cachedProfilesSource = null;
let cachedProfilesLength = -1;
let cachedProfilesSignature = '';
let cachedProfileEntries = null;
let cachedProfileIndex = null;
let cachedCombinedEntries = null;
const nativeSupportCache = new Map();

// ST 1.19 stores saved native keys in secrets.js's module-level `secret_state`
// (reassigned on read/write). Keep the module namespace object so reads see
// the live binding; TauriTavern may not ship secrets.js, so load dynamically.
let secretsModule = null;
let secretsUnavailable = false;
const secretsReady = import('../../../../secrets.js')
    .then((mod) => {
        secretsModule = mod;
        invalidateNativeCache();
    })
    .catch(() => {
        secretsUnavailable = true;
    });
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCatalog(value) {
    return isPlainObject(value) && isPlainObject(value.providers);
}

function hasActiveCatalog() {
    return Object.keys(activeCatalog.providers).length > 0;
}

function refKey(ref) {
    if (typeof ref === 'string') {
        return ref;
    }
    if (!isPlainObject(ref)) {
        return '';
    }
    if (typeof ref.key === 'string' && ref.key.length > 0) {
        return ref.key;
    }
    if (typeof ref.kind !== 'string' || typeof ref.provider !== 'string' || typeof ref.model !== 'string') {
        return '';
    }
    if (!ref.provider || !ref.model) {
        return '';
    }
    return `${ref.kind}/${ref.provider}/${ref.model}`;
}

function computeStats(providers) {
    let models = 0;
    for (const provider of Object.values(providers)) {
        if (Array.isArray(provider?.models)) {
            models += provider.models.length;
        }
    }
    return { providers: Object.keys(providers).length, models };
}

function setCatalog(catalog, source) {
    activeCatalog = catalog;
    catalogSource = source;
    catalogError = null;
    invalidateNativeCache();
}

/**
 * Fetch the bundled catalog shipped with the extension.
 * Throws when the bundled file cannot be read.
 */
async function loadBundledCatalog() {
    const url = new URL('../catalog/omtp-catalog.json', import.meta.url);
    const response = await fetch(url, { signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`Failed to load bundled catalog: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!isCatalog(data)) {
        throw new Error('Bundled catalog has an invalid shape');
    }
    return data;
}

async function fetchServerCatalog() {
    try {
        const response = await fetch(`${apiBase()}/catalog`, {
            headers: requestHeaders(),
            signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Catalog request failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        if (!isCatalog(data)) {
            throw new Error('Server catalog has an invalid shape');
        }
        return data;
    } catch (error) {
        catalogError = error;
        console.debug('[omtp] Server catalog unavailable, using bundled snapshot:', error?.message ?? error);
        return null;
    }
}

async function fetchBundledCatalogSafe() {
    try {
        return await loadBundledCatalog();
    } catch (error) {
        catalogError = error;
        console.warn('[omtp] Failed to load bundled catalog', error);
        return null;
    }
}

/**
 * Load the active catalog: server catalog when available, otherwise the
 * bundled snapshot. Never throws on fetch failures.
 *
 * @param {{force?: boolean}} [options] force re-fetch even when a catalog is loaded
 * @returns {Promise<object>}
 */
export async function loadCatalog(options = {}) {
    await secretsReady;
    const force = options.force === true;
    if (!force && hasActiveCatalog()) {
        return activeCatalog;
    }
    const serverCatalog = await fetchServerCatalog();
    if (serverCatalog) {
        setCatalog(serverCatalog, 'server');
        return activeCatalog;
    }

    if (hasActiveCatalog()) {
        // A refresh failed; keep the previously active catalog.
        return activeCatalog;
    }

    const bundledCatalog = await fetchBundledCatalogSafe();
    if (bundledCatalog) {
        setCatalog(bundledCatalog, 'bundled');
        return activeCatalog;
    }

    const previousError = catalogError;
    setCatalog(EMPTY_CATALOG, 'none');
    catalogError = previousError;
    return activeCatalog;
}

/** Alias used by the hub during initialization. */
export async function initCatalog(options = {}) {
    return loadCatalog(options);
}

/** Current in-memory catalog (never null). */
export function getActiveCatalog() {
    return activeCatalog;
}

/** Metadata for the settings UI. */
export function getCatalogInfo() {
    return {
        source: catalogSource,
        schemaVersion: activeCatalog.schemaVersion ?? CATALOG_SCHEMA_VERSION,
        generatedAt: activeCatalog.generatedAt ?? null,
        stats: computeStats(activeCatalog.providers),
        error: catalogError ? String(catalogError.message ?? catalogError) : null,
    };
}

/**
 * Replace the in-memory catalog (runtime registration). Synchronous and
 * cache-invalidating.
 */
export function setActiveCatalog(catalog) {
    if (!isCatalog(catalog)) {
        throw new TypeError('[omtp] setActiveCatalog requires a catalog with a providers object');
    }
    setCatalog(catalog, 'runtime');
    return activeCatalog;
}

function isProviderLike(value) {
    return isPlainObject(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && (Array.isArray(value.models)
            || value.stAdapter !== undefined
            || value.gatewayAdapter !== undefined);
}

function overlayProviders(overlay) {
    if (!isPlainObject(overlay)) {
        return {};
    }
    if (isProviderLike(overlay)) {
        return { [overlay.id]: overlay };
    }
    if (isPlainObject(overlay.providers)) {
        return overlay.providers;
    }

    const providers = {};
    for (const [id, value] of Object.entries(overlay)) {
        if (isPlainObject(value) && (Array.isArray(value.models) || value.label !== undefined)) {
            providers[id] = value;
        }
    }
    return providers;
}

function mergeModels(baseModels, nextModels) {
    const base = Array.isArray(baseModels) ? baseModels : [];
    const next = Array.isArray(nextModels) ? nextModels : [];
    if (next.length === 0) {
        return base.slice();
    }

    const result = base.slice();
    const indexById = new Map();
    result.forEach((model, index) => {
        if (model && typeof model.id === 'string') {
            indexById.set(model.id, index);
        }
    });

    for (const model of next) {
        if (!isPlainObject(model) || typeof model.id !== 'string' || model.id.length === 0) {
            continue;
        }
        const existing = indexById.get(model.id);
        if (existing === undefined) {
            indexById.set(model.id, result.length);
            result.push(model);
        } else {
            result[existing] = { ...result[existing], ...model };
        }
    }
    return result;
}

function mergeProvider(base, overlay, id) {
    return {
        ...base,
        ...overlay,
        id: typeof overlay.id === 'string' && overlay.id.length > 0 ? overlay.id : id,
        models: mergeModels(base.models, overlay.models),
    };
}

/**
 * Merge an overlay (catalog, single provider, or provider map) over a base
 * catalog without mutating either input. Higher layers win field-by-field;
 * models merge by id.
 */
export function mergeCatalog(base, overlay) {
    const baseCatalog = isCatalog(base) ? base : EMPTY_CATALOG;
    const incoming = overlayProviders(overlay);
    const providers = { ...baseCatalog.providers };

    for (const [id, provider] of Object.entries(incoming)) {
        if (!isPlainObject(provider)) {
            continue;
        }
        const normalized = {
            ...provider,
            id: typeof provider.id === 'string' && provider.id.length > 0 ? provider.id : id,
            models: Array.isArray(provider.models) ? provider.models : [],
        };
        if (normalized.gatewayAdapter === undefined && typeof provider.adapter === 'string' && provider.adapter.length > 0) {
            normalized.gatewayAdapter = provider.adapter;
        }
        const previous = baseCatalog.providers[id];
        providers[id] = previous ? mergeProvider(previous, normalized, id) : normalized;
    }

    const hasBaseProviders = Object.keys(baseCatalog.providers).length > 0;
    return {
        ...baseCatalog,
        schemaVersion: hasBaseProviders
            ? baseCatalog.schemaVersion
            : overlay?.schemaVersion ?? CATALOG_SCHEMA_VERSION,
        source: hasBaseProviders
            ? baseCatalog.source
            : overlay?.source ?? 'runtime',
        generatedAt: hasBaseProviders
            ? baseCatalog.generatedAt
            : overlay?.generatedAt ?? null,
        providers,
        stats: computeStats(providers),
    };
}

const KEYLESS_PROVIDERS = Object.freeze(new Set(['local', 'ollama', 'pollinations', 'yolo-auto']));
const providerAvailabilityCache = new Map();
let providerAvailabilityAt = 0;
let providerAvailabilityGeneration = 0;
let providerAvailabilityInFlight = null;
const liveModelsCache = new Map();

export function setProviderAvailability(mapOrList) {
    // Replace instead of merge: a provider that disappears (disabled server
    // plugin, removed key) must not keep its stale availability forever.
    providerAvailabilityGeneration += 1;
    if (mapOrList instanceof Map) {
        providerAvailabilityCache.clear();
        for (const [k, v] of mapOrList.entries()) providerAvailabilityCache.set(String(k), v);
    } else if (Array.isArray(mapOrList)) {
        providerAvailabilityCache.clear();
        for (const p of mapOrList) if (p?.id) providerAvailabilityCache.set(String(p.id), p);
    }
    providerAvailabilityAt = Date.now();
    invalidateNativeCache();
}

/** Current cached gateway provider availability map. */
export function getProviderAvailability() {
    return new Map(providerAvailabilityCache);
}

/** Mark the cached gateway provider availability as stale so the next refresh probes the server. */
export function invalidateProviderAvailability() {
    providerAvailabilityGeneration += 1;
    providerAvailabilityAt = 0;
    providerAvailabilityInFlight = null;
}

/**
 * Fetch `/providers` availability from the server plugin (5s TTL, 8s timeout).
 * Never throws; returns null on failure and clears the shared cache so UI and
 * switch engine never diverge.
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Map<string, object>|null>}
 */
export async function refreshProviderAvailability({ force = false } = {}) {
    if (!force && providerAvailabilityAt > 0 && Date.now() - providerAvailabilityAt < PROVIDER_AVAILABILITY_TTL_MS) {
        return new Map(providerAvailabilityCache);
    }
    if (!force && providerAvailabilityInFlight) {
        return providerAvailabilityInFlight;
    }
    const generation = ++providerAvailabilityGeneration;
    const promise = (async () => {
        try {
            const response = await fetch(`${apiBase()}/providers`, {
                headers: requestHeaders({ omitContentType: true }),
                signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const list = Array.isArray(data?.providers) ? data.providers : [];
            if (generation !== providerAvailabilityGeneration) {
                return providerAvailabilityInFlight && providerAvailabilityInFlight !== promise
                    ? await providerAvailabilityInFlight
                    : new Map(providerAvailabilityCache);
            }
            providerAvailabilityCache.clear();
            for (const provider of list) {
                if (provider?.id) {
                    providerAvailabilityCache.set(String(provider.id), provider);
                }
            }
            providerAvailabilityAt = Date.now();
            invalidateNativeCache();
            return new Map(providerAvailabilityCache);
        } catch {
            if (generation === providerAvailabilityGeneration) {
                providerAvailabilityCache.clear();
                providerAvailabilityAt = 0;
                invalidateNativeCache();
            }
            return null;
        } finally {
            if (providerAvailabilityInFlight === promise) {
                providerAvailabilityInFlight = null;
            }
        }
    })();
    providerAvailabilityInFlight = promise;
    return promise;
}
/**
 * Overlay live gateway availability onto a catalog entry.
 *
 * The server plugin is the only authority on whether a gateway provider can be
 * driven right now (key present, OAuth session stored, keyless). Catalog
 * entries carry an optimistic guess; this rewrites it. Returns the same object
 * when nothing changes so callers can map cheaply.
 *
 * @param {object} entry
 * @returns {object}
 */
export function withProviderAvailability(entry) {
    if (!entry || entry.kind !== 'omp') {
        return entry;
    }
    const status = providerAvailabilityCache.get(String(entry.provider));
    if (!status) {
        return entry;
    }
    const available = status.available === true && entry.gatewayAdapter !== null;
    const unsupportedReason = available
        ? null
        : status.unsupportedReason
            || (status.available === false ? tr('omtp_needs_api_key', 'Needs API key') : null);
    if (available === entry.available && unsupportedReason === (entry.unsupportedReason ?? null)) {
        return entry;
    }
    return { ...entry, available, unsupportedReason };
}

/**
 * Whether SillyTavern currently holds a non-empty value for one of its own
 * secret fields. Returns `null` when no secret store is reachable (e.g.
 * TauriTavern without `secrets.js`) so native entries stay selectable.
 * @param {string} keyName
 * @returns {boolean|null}
 */
function readSecret(keyName) {
    try {
        if (document.getElementById(keyName)?.value?.trim()) return true;
    } catch {}
    try {
        const state = secretsModule?.secret_state;
        if (state && typeof state === 'object') {
            const value = state[keyName];
            return Array.isArray(value) ? value.length > 0 : Boolean(value);
        }
    } catch {}
    if (secretsUnavailable || !secretsModule) {
        return null;
    }
    return false;
}

function hasProviderCredentials(providerId, stAdapter = null, provider = null, { includeGateway = true } = {}) {
    if (KEYLESS_PROVIDERS.has(providerId) || provider?.authKind === 'none') {
        return true;
    }
    if (stAdapter?.requiresKey) {
        const secretFound = readSecret(stAdapter.requiresKey);
        if (secretFound !== false) {
            return true;
        }
    }
    if (includeGateway && providerAvailabilityCache.has(providerId)) {
        const status = providerAvailabilityCache.get(providerId);
        if (status?.hasKey || status?.available) return true;
    }
    return false;
}

/** Same freshness window as the server's `LIVE_MODELS_TTL`. */
const LIVE_MODELS_TTL = 300_000;

/**
 * Drop a provider's live model list, e.g. after its credentials changed.
 * @param {string} providerId
 */
export function forgetLiveModels(providerId) {
    if (liveModelsCache.delete(String(providerId))) invalidateNativeCache();
}

/**
 * Ask the server for a provider's live model list.
 *
 * Never throws. Mirrors the server's policy: a failed probe drops the
 * previously fetched list, so the hub falls back to the catalog models instead
 * of offering ones the provider may no longer serve.
 *
 * @param {string} providerId
 * @param {boolean} [force] bypass the local cache
 * @returns {Promise<{models: object[]|null, error: string|null, needsCredentials: boolean, source: 'server'|null}>}
 */
export async function fetchLiveModelsForProvider(providerId, force = false) {
    const cached = liveModelsCache.get(providerId);
    if (!force && cached && Date.now() - cached.at < LIVE_MODELS_TTL) {
        return { models: cached.models, error: null, needsCredentials: false, source: 'server' };
    }

    let error = null;
    let needsCredentials = false;
    try {
        const headers = requestHeaders({ omitContentType: true });
        const res = await fetch(`${apiBase()}/providers/${encodeURIComponent(providerId)}/models?refresh=${force ? 'true' : 'false'}`, {
            headers,
            signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
                // The server may answer from its own cache: age the list from
                // the probe time, not from now, so it expires on schedule.
                const at = Number.isFinite(data.at) ? Math.min(data.at, Date.now()) : Date.now();
                liveModelsCache.set(providerId, { models: data.models, at });
                invalidateNativeCache();
                return { models: data.models, error: null, needsCredentials: false, source: 'server' };
            }
            error = typeof data?.error === 'string' ? data.error : null;
            needsCredentials = data?.available === false;
        } else {
            error = `HTTP ${res.status}`;
        }
    } catch (err) {
        error = err?.message ? String(err.message) : String(err);
    }

    forgetLiveModels(providerId);
    return { models: null, error, needsCredentials, source: null };
}

/**
 * Whether a native adapter can accept a model id right now.
 * Accepts `(adapter, model)` or an entry object.
 */
function canUseNative(adapter, model) {
    let target = adapter;
    let modelId = model;

    if (isPlainObject(target) && typeof target.supportsModel !== 'function' && 'nativeAdapter' in target) {
        modelId = target.model;
        target = target.nativeAdapter;
    }
    if (typeof target === 'string') {
        target = getNativeAdapter(target);
    }
    if (!target || typeof target.supportsModel !== 'function' || typeof modelId !== 'string' || !modelId) {
        return false;
    }
    if (target.readOnlyReason) {
        return false;
    }

    const cacheKey = `${target.key}\u0000${modelId}`;
    if (nativeSupportCache.has(cacheKey)) {
        return nativeSupportCache.get(cacheKey);
    }

    let supported = false;
    try {
        supported = target.supportsModel(modelId) === true;
    } catch {
        supported = false;
    }
    nativeSupportCache.set(cacheKey, supported);
    return supported;
}

function entryBase(provider, providerLabel, model, id) {
    return {
        providerLabel,
        // Providers can offer both an API key and a subscription login.
        authKinds: Array.isArray(provider.authKinds)
            ? provider.authKinds
            : (provider.authKind ? [provider.authKind] : []),
        modelLabel: model.name || id,
        contextWindow: model.contextWindow ?? null,
        maxTokens: model.maxTokens ?? null,
        input: Array.isArray(model.input) ? model.input : ['text'],
        supportsTools: model.supportsTools === true,
        reasoning: model.reasoning === true,
        efforts: Array.isArray(model.efforts) ? model.efforts : [],
    };
}

/**
 * Filter legacy completions and retired/superseded dated snapshots from the
 * static catalog. Kept client-side because the bundled catalog is imported
 * verbatim from OMP (whose upstream source is not in this repo).
 *
 * Dated 2023/2024 snapshots (`-YYYYMMDD` or `-YYYY-MM-DD`, optionally before
 * `-vN:0`) are only hidden when the same provider also offers the undated base
 * id, so providers that only serve dated ids (e.g. `amazon-bedrock`, `nanogpt`)
 * keep their canonical models.
 */
function isObsoleteModel(model, providerIds) {
    if (model?.retired === true) return true;
    const id = typeof model?.id === 'string' ? model.id : '';
    if (!id) return false;
    const lower = id.toLowerCase();
    if (/^(?:text-davinci|text-curie|text-babbage|text-ada|code-davinci)/i.test(lower)) return true;
    if (/^gpt-3\.5-turbo-(?:0301|0613|16k-0613|1106|0125)/i.test(lower)) return true;
    if (/^gpt-4-(?:0314|0613|32k-0314|32k-0613|1106-preview|0125-preview)/i.test(lower)) return true;
    if (/^gemini-1\.0-/i.test(lower)) return true;
    if (/^claude-(?:1|2|instant)/i.test(lower)) return true;
    const undated = id.replace(/(?:-(?:2023\d{4}|2024\d{4}|2023-\d{2}-\d{2}|2024-\d{2}-\d{2}))(?=-v\d+:\d+$|$)/, '');
    if (undated !== id && providerIds?.has(undated)) return true;
    return false;
}

/** Live-discovered model list for a provider, or null when none was fetched. */
function liveModelsFor(providerId) {
    const liveData = liveModelsCache.get(providerId);
    return Array.isArray(liveData?.models) ? liveData.models : null;
}

/**
 * Models to build entries for. A live probe is authoritative: only the models
 * it returned are shown. Otherwise the catalog list is used, without models
 * that predate the current generation.
 */
function modelsForProvider(provider, liveList) {
    if (liveList && liveList.length > 0) {
        const existingById = new Map();
        for (const model of provider.models || []) {
            if (model && typeof model.id === 'string') {
                existingById.set(model.id, model);
            }
        }
        const liveMap = new Map(liveList.map((model) => (
            typeof model === 'string' ? [model, { id: model, name: model }] : [model.id, model]
        )));
        return Array.from(liveMap.values()).map((liveModel) => {
            const existing = existingById.get(liveModel.id);
            if (existing) {
                return { ...existing, isLive: true };
            }
            return {
                id: liveModel.id,
                name: liveModel.name || liveModel.id,
                kind: 'chat',
                contextWindow: liveModel.contextWindow ?? null,
                maxTokens: liveModel.maxTokens ?? null,
                reasoning: Boolean(liveModel.reasoning || liveModel.supportsThinking),
                efforts: Array.isArray(liveModel.efforts) ? liveModel.efforts : [],
                supportsTools: liveModel.supportsTools ?? true,
                input: liveModel.input || ['text'],
                isLive: true,
            };
        });
    }

    const models = Array.isArray(provider.models) ? provider.models : [];
    const providerIds = new Set();
    for (const model of models) {
        if (typeof model?.id === 'string' && model.id) {
            providerIds.add(model.id);
        }
    }
    return models.filter((model) => !isObsoleteModel(model, providerIds));
}

/** Adapters and credential state shared by every model of one provider. */
function providerRoute(provider, providerId) {
    const stKey = typeof provider.stAdapter === 'string' && provider.stAdapter.length > 0
        ? provider.stAdapter
        : null;
    const stAdapter = stKey ? getNativeAdapter(stKey) : null;
    // SillyTavern's own key and the gateway's key are different stores: an
    // OAuth session imported from OMP only exists in the gateway, so those
    // models must route through it instead of the native adapter.
    const gatewayStatus = providerAvailabilityCache.get(providerId);
    return {
        providerLabel: provider.label || providerId,
        stKey,
        stAdapter,
        gatewayAdapter: typeof provider.gatewayAdapter === 'string' && provider.gatewayAdapter.length > 0
            ? provider.gatewayAdapter
            : null,
        source: NATIVE_PROVIDER_SET.has(providerId) ? 'Native' : 'Translated',
        gatewayCreds: Boolean(gatewayStatus?.hasKey || gatewayStatus?.available),
        nativeCreds: hasProviderCredentials(providerId, stAdapter, provider, { includeGateway: false }),
    };
}

/** One entry for `model`, routed native or through the gateway. */
function entryForModel(provider, providerId, route, model, isLive) {
    if (!isPlainObject(model)) {
        return null;
    }
    const id = typeof model.id === 'string' ? model.id : '';
    if (!id) {
        return null;
    }
    if (model.kind && model.kind !== 'chat') {
        return null;
    }

    const { stKey, stAdapter, gatewayAdapter, source, gatewayCreds, nativeCreds } = route;
    const base = {
        ...entryBase(provider, route.providerLabel, model, id),
        providerId,
        isLive,
    };

    const nativeUsable = Boolean(stAdapter && canUseNative(stAdapter, id));
    const routeNative = nativeUsable && (nativeCreds || !gatewayCreds);

    if (routeNative) {
        return {
            ...base,
            key: `st/${providerId}/${id}`,
            kind: 'st',
            provider: providerId,
            providerKey: stAdapter.key,
            model: id,
            source,
            nativeAdapter: stAdapter,
            gatewayAdapter,
            unsupportedReason: nativeCreds ? null : tr('omtp_no_credentials', 'No credentials / not signed in'),
            available: nativeCreds,
        };
    }

    if (gatewayAdapter) {
        return {
            ...base,
            key: `omp/${providerId}/${id}`,
            kind: 'omp',
            provider: providerId,
            providerKey: providerId,
            model: id,
            source: 'OMTP',
            nativeAdapter: null,
            gatewayAdapter,
            unsupportedReason: gatewayCreds
                ? null
                : (hasServerBackend() ? tr('omtp_no_credentials', 'No credentials / not signed in') : gatewayUnavailableText()),
            available: gatewayCreds,
        };
    }

    const reason = provider.unsupportedReason
        || stAdapter?.readOnlyReason
        || (stKey
            ? `Model is not available in the native ${stAdapter?.label ?? stKey} control and no gateway adapter is configured`
            : 'No gateway adapter is configured');

    return {
        ...base,
        key: `omp/${providerId}/${id}`,
        kind: 'omp',
        provider: providerId,
        model: id,
        source: 'OMTP',
        nativeAdapter: null,
        gatewayAdapter: null,
        unsupportedReason: reason,
        available: false,
    };
}

function buildEntries() {
    const entries = [];

    for (const provider of Object.values(activeCatalog.providers)) {
        const providerId = typeof provider.id === 'string' && provider.id.length > 0
            ? provider.id
            : String(provider.id ?? '');
        if (!providerId) continue;

        const liveList = liveModelsFor(providerId);
        const models = modelsForProvider(provider, liveList);
        if (models.length === 0) continue;

        const route = providerRoute(provider, providerId);
        // Models synthesized from a live probe are live by construction; static
        // catalog models carry no liveness signal.
        const isLive = liveList ? true : null;
        for (const model of models) {
            const entry = entryForModel(provider, providerId, route, model, isLive);
            if (entry) {
                entries.push(entry);
            }
        }
    }

    return entries;
}

function discoverProfiles() {
    try {
        const disabled = Array.isArray(extension_settings?.disabledExtensions)
            ? extension_settings.disabledExtensions
            : [];
        if (disabled.includes('third-party/connection-manager')) {
            return [];
        }
        const profiles = extension_settings?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch {
        return [];
    }
}

function buildProfileEntries(profiles) {
    const entries = [];
    for (const profile of profiles) {
        if (!isPlainObject(profile)) {
            continue;
        }
        const id = typeof profile.id === 'string' && profile.id.length > 0
            ? profile.id
            : typeof profile.name === 'string'
                ? profile.name
                : '';
        if (!id) {
            continue;
        }
        entries.push({
            key: `profile/${PROFILE_PROVIDER_ID}/${id}`,
            kind: 'profile',
            provider: PROFILE_PROVIDER_ID,
            model: id,
            providerLabel: 'Connection Profiles',
            modelLabel: profile.name || id,
            source: 'Profile',
            nativeAdapter: null,
            gatewayAdapter: null,
            contextWindow: null,
            maxTokens: null,
            input: [],
            supportsTools: false,
            reasoning: false,
            efforts: [],
            unsupportedReason: null,
            available: true,
            profile,
        });
    }
    return entries;
}

function buildEntryIndex(entries, { includeLegacySt = false } = {}) {
    const byKey = new Map();
    const byLowerKey = new Map();
    const byLegacyStKey = includeLegacySt ? new Map() : null;
    for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string') continue;
        if (!byKey.has(entry.key)) {
            byKey.set(entry.key, entry);
        }
        const lower = entry.key.toLowerCase();
        if (!byLowerKey.has(lower)) {
            byLowerKey.set(lower, entry);
        }
        if (byLegacyStKey && entry.kind === 'st') {
            const legacyKey = `st/${String(entry.providerKey || '').toLowerCase()}/${String(entry.model || '').toLowerCase()}`;
            if (!byLegacyStKey.has(legacyKey)) {
                byLegacyStKey.set(legacyKey, entry);
            }
        }
    }
    return { byKey, byLowerKey, byLegacyStKey };
}

function ensureCatalogCache() {
    if (!entriesCache) {
        entriesCache = buildEntries();
        catalogIndex = buildEntryIndex(entriesCache, { includeLegacySt: true });
        cachedCombinedEntries = null;
    }
}

function profileSignature(profiles) {
    return profiles
        .map((profile) => (isPlainObject(profile) ? `${profile.id ?? ''}\u0000${profile.name ?? ''}` : ''))
        .join('\u0001');
}

function ensureProfileCache(profiles) {
    const sig = profileSignature(profiles);
    if (
        cachedProfilesSource === profiles
        && cachedProfilesLength === profiles.length
        && cachedProfilesSignature === sig
        && cachedProfileEntries
        && cachedProfileIndex
    ) {
        return;
    }
    cachedProfilesSource = profiles;
    cachedProfilesLength = profiles.length;
    cachedProfilesSignature = sig;
    cachedProfileEntries = buildProfileEntries(profiles);
    cachedProfileIndex = buildEntryIndex(cachedProfileEntries);
    cachedCombinedEntries = null;
}

/**
 * All catalog entries (native, gateway and unsupported). Built once per
 * catalog/availability change. Connection Profile entries are appended when
 * `options.profiles` is supplied, or discovered from Connection Manager
 * settings when it is enabled.
 */
export function getEntries(options = {}) {
    ensureCatalogCache();
    const profiles = Array.isArray(options.profiles) ? options.profiles : discoverProfiles();
    if (profiles.length === 0) {
        return entriesCache;
    }
    ensureProfileCache(profiles);
    if (cachedProfileEntries.length === 0) {
        return entriesCache;
    }
    if (!cachedCombinedEntries) {
        cachedCombinedEntries = entriesCache.concat(cachedProfileEntries);
    }
    return cachedCombinedEntries;
}

/** Resolve an EntryRef (or entry key) against the active entry list. */
export function resolveEntry(ref, options = {}) {
    const key = refKey(ref);
    if (!key) {
        return null;
    }
    ensureCatalogCache();
    const profiles = Array.isArray(options.profiles) ? options.profiles : discoverProfiles();
    if (profiles.length > 0) {
        ensureProfileCache(profiles);
    }
    const direct = catalogIndex.byKey.get(key)
        ?? (profiles.length > 0 ? cachedProfileIndex.byKey.get(key) : undefined);
    if (direct) {
        return direct;
    }
    const needle = key.toLowerCase();
    const byKey = catalogIndex.byLowerKey.get(needle)
        ?? (profiles.length > 0 ? cachedProfileIndex.byLowerKey.get(needle) : undefined);
    if (byKey) {
        return byKey;
    }
    // Legacy fallback for `st/<stAdapter.key>/<model>` refs.
    if (needle.startsWith('st/')) {
        return catalogIndex.byLegacyStKey.get(needle) ?? null;
    }
    return null;
}

/**
 * Clear cached Connection Profile entries so profile updates rebuild on next read.
 */
export function invalidateProfileCache() {
    cachedProfilesSource = null;
    cachedProfilesLength = -1;
    cachedProfilesSignature = '';
    cachedProfileEntries = null;
    cachedProfileIndex = null;
    cachedCombinedEntries = null;
}

/**
 * Clear cached native support checks and rebuilt entries. Call after
 * MAIN_API/CHATCOMPLETION/ONLINE_STATUS/SECRET events.
 */
export function invalidateNativeCache() {
    nativeSupportCache.clear();
    entriesCache = null;
    catalogIndex = null;
    cachedCombinedEntries = null;
}
