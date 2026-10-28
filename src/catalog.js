/**
 * Catalog loading, merging and entry construction.
 *
 * The bundled catalog is always available; the optional server plugin serves
 * the active (possibly refreshed) catalog. Fetch failures degrade silently to
 * the bundled snapshot so native selection keeps working without the plugin.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import {
    API_BASE,
    CATALOG_SCHEMA_VERSION,
    NATIVE_PROVIDER_IDS,
    PROFILE_PROVIDER_ID,
} from './constants.js';
import { getNativeAdapter } from './adapters/native.js';
import { tr } from './ui/dom.js';

const EMPTY_CATALOG = Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'none',
    generatedAt: null,
    providers: Object.freeze({}),
    stats: Object.freeze({ providers: 0, models: 0 }),
});

const NATIVE_PROVIDER_SET = new Set(NATIVE_PROVIDER_IDS);

let activeCatalog = EMPTY_CATALOG;
let catalogSource = 'none';
let catalogError = null;
let entriesCache = null;
const nativeSupportCache = new Map();

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
export async function loadBundledCatalog() {
    const url = new URL('../catalog/omtp-catalog.json', import.meta.url);
    const response = await fetch(url);
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
        const response = await fetch(`${API_BASE}/catalog`, {
            headers: getRequestHeaders(),
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

/** Alias used by index.js during initialization. */
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

/** All provider metadata objects from the active catalog. */
export function getProviders() {
    return Object.values(activeCatalog.providers);
}

/** Provider metadata map (id -> provider). */
export function getProviderMap() {
    return activeCatalog.providers;
}

/** Single provider metadata object, or null. */
export function getProvider(id) {
    return activeCatalog.providers[id] ?? null;
}

/** True when the catalog provider maps to a first-class SillyTavern provider. */
export function isNativeProvider(providerId) {
    return NATIVE_PROVIDER_SET.has(providerId);
}
export const KEYLESS_PROVIDERS = Object.freeze(new Set(['local', 'ollama', 'pollinations', 'yolo-auto']));
export const providerAvailabilityCache = new Map();
export const liveModelsCache = new Map();

export function setProviderAvailability(mapOrList) {
    if (mapOrList instanceof Map) {
        for (const [k, v] of mapOrList.entries()) providerAvailabilityCache.set(k, v);
    } else if (Array.isArray(mapOrList)) {
        for (const p of mapOrList) if (p?.id) providerAvailabilityCache.set(p.id, p);
    }
    invalidateNativeCache();
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

export function hasProviderCredentials(providerId, stAdapter = null, provider = null, { includeGateway = true } = {}) {
    if (KEYLESS_PROVIDERS.has(providerId) || provider?.authKind === 'none') {
        return true;
    }
    if (stAdapter?.requiresKey) {
        const keyName = stAdapter.requiresKey;
        try {
            if (document.getElementById(keyName)?.value?.trim()) return true;
        } catch {}
        try {
            if (globalThis.secret_state && globalThis.secret_state[keyName]) return true;
        } catch {}
        try {
            const context = globalThis.SillyTavern?.getContext?.();
            if (context?.secret_state?.[keyName]) return true;
        } catch {}
        try {
            if (globalThis.oai_settings?.[keyName]) return true;
            if (globalThis.textgenerationwebui_settings?.[keyName]) return true;
        } catch {}
    }
    try {
        const omtpSettings = extension_settings?.omtp;
        if (omtpSettings?.customProviders?.[providerId]?.apiKey) return true;
    } catch {}
    if (includeGateway && providerAvailabilityCache.has(providerId)) {
        const status = providerAvailabilityCache.get(providerId);
        if (status?.hasKey || status?.available) return true;
    }
    return false;
}

/**
 * Ask the server for a provider's live model list.
 *
 * Never throws and never clears previously cached models: a failed probe keeps
 * the catalog list on screen and reports why it failed.
 *
 * @param {string} providerId
 * @param {boolean} [force] bypass the local cache
 * @returns {Promise<{models: object[]|null, error: string|null, needsCredentials: boolean, source: 'server'|null}>}
 */
export async function fetchLiveModelsForProvider(providerId, force = false) {
    const cached = liveModelsCache.get(providerId);
    if (!force && cached && Date.now() - cached.at < 300_000) {
        return { models: cached.models, error: null, needsCredentials: false, source: 'server' };
    }

    let error = null;
    let needsCredentials = false;
    try {
        const headers = getRequestHeaders ? getRequestHeaders({ omitContentType: true }) : {};
        const res = await fetch(`${API_BASE}/providers/${encodeURIComponent(providerId)}/models?refresh=${force ? 'true' : 'false'}`, { headers });
        if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
                liveModelsCache.set(providerId, { models: data.models, at: Date.now() });
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

    return { models: null, error, needsCredentials, source: null };
}

/**
 * Whether a native adapter can accept a model id right now.
 * Accepts `(adapter, model)` or an entry object.
 */
export function canUseNative(adapter, model) {
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
export function isObsoleteModel(id) {
    if (!id) return false;
    const lower = id.toLowerCase();
    if (/^(?:text-davinci|text-curie|text-babbage|text-ada|code-davinci)/i.test(lower)) return true;
    if (/^gpt-3\.5-turbo-(?:0301|0613|16k-0613|1106|0125)/i.test(lower)) return true;
    if (/^gpt-4-(?:0314|0613|32k-0314|32k-0613|1106-preview|0125-preview)/i.test(lower)) return true;
    if (/^gemini-1\.0-/i.test(lower)) return true;
    if (/^claude-(?:1|2|instant)/i.test(lower)) return true;
    if (/-(?:2023\d{4}|20240[1-9]\d{2}|20241[01]\d{2})/i.test(lower)) return true;
    return false;
}

function buildEntries() {
    const entries = [];

    for (const provider of Object.values(activeCatalog.providers)) {
        const providerId = typeof provider.id === 'string' && provider.id.length > 0
            ? provider.id
            : String(provider.id ?? '');
        if (!providerId) continue;

        const providerLabel = provider.label || providerId;
        const stKey = typeof provider.stAdapter === 'string' && provider.stAdapter.length > 0
            ? provider.stAdapter
            : null;
        const stAdapter = stKey ? getNativeAdapter(stKey) : null;
        const gatewayAdapter = typeof provider.gatewayAdapter === 'string' && provider.gatewayAdapter.length > 0
            ? provider.gatewayAdapter
            : null;
        const source = NATIVE_PROVIDER_SET.has(providerId) ? 'Native' : 'Translated';
        // SillyTavern's own key and the gateway's key are different stores: an
        // OAuth session imported from OMP only exists in the gateway, so those
        // models must route through it instead of the native adapter.
        const gatewayStatus = providerAvailabilityCache.get(providerId);
        const gatewayCreds = Boolean(gatewayStatus?.hasKey || gatewayStatus?.available);
        const nativeCreds = hasProviderCredentials(providerId, stAdapter, provider, { includeGateway: false });
        const hasCreds = nativeCreds || gatewayCreds;

        // Merge live-discovered models if available
        const liveData = liveModelsCache.get(providerId);
        const liveList = Array.isArray(liveData?.models) ? liveData.models : null;
        let rawModels = Array.isArray(provider.models) ? [...provider.models] : [];

        if (liveList && liveList.length > 0) {
            // Live API is AUTHORITATIVE: only models returned by live API are shown
            const liveMap = new Map(liveList.map((m) => typeof m === 'string' ? [m, { id: m, name: m }] : [m.id, m]));
            rawModels = Array.from(liveMap.values()).map((lm) => {
                const existing = (provider.models || []).find((m) => m.id === lm.id);
                if (existing) return { ...existing, isLive: true };
                return {
                    id: lm.id,
                    name: lm.name || lm.id,
                    kind: 'chat',
                    contextWindow: lm.contextWindow ?? null,
                    maxTokens: lm.maxTokens ?? null,
                    reasoning: Boolean(lm.reasoning || lm.supportsThinking),
                    supportsTools: lm.supportsTools ?? true,
                    input: lm.input || ['text'],
                    isLive: true,
                };
            });
        } else {
            rawModels = rawModels.filter((m) => !isObsoleteModel(m.id));
        }

        if (rawModels.length === 0) continue;

        for (const model of rawModels) {
            if (!isPlainObject(model)) continue;
            const id = typeof model.id === 'string' ? model.id : '';
            if (!id) continue;
            if (model.kind && model.kind !== 'chat') continue;

            // Models synthesized from a live probe are live by construction; static
            // catalog models carry no liveness signal.
            const isLive = liveList ? true : null;
            const base = {
                ...entryBase(provider, providerLabel, model, id),
                providerId,
                isLive,
            };

            const nativeUsable = Boolean(stAdapter && canUseNative(stAdapter, id));
            const routeNative = nativeUsable && (nativeCreds || !gatewayCreds);

            if (routeNative) {
                entries.push({
                    ...base,
                    key: `st/${stAdapter.key}/${id}`,
                    kind: 'st',
                    provider: providerId,
                    providerKey: stAdapter.key,
                    model: id,
                    source,
                    nativeAdapter: stAdapter,
                    gatewayAdapter,
                    unsupportedReason: nativeCreds ? null : tr('omtp_no_credentials', 'No credentials / not signed in'),
                    available: nativeCreds,
                });
                continue;
            }

            if (gatewayAdapter) {
                entries.push({
                    ...base,
                    key: `omp/${providerId}/${id}`,
                    kind: 'omp',
                    provider: providerId,
                    providerKey: providerId,
                    model: id,
                    source: 'OMTP',
                    nativeAdapter: null,
                    gatewayAdapter,
                    unsupportedReason: gatewayCreds ? null : tr('omtp_no_credentials', 'No credentials / not signed in'),
                    available: gatewayCreds,
                });
                continue;
            }

            const reason = provider.unsupportedReason
                || stAdapter?.readOnlyReason
                || (stKey
                    ? `Model is not available in the native ${stAdapter?.label ?? stKey} control and no gateway adapter is configured`
                    : 'No gateway adapter is configured');

            entries.push({
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
            });
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

/**
 * All catalog entries (native, gateway and unsupported). Built once per
 * catalog/availability change. Connection Profile entries are appended when
 * `options.profiles` is supplied, or discovered from Connection Manager
 * settings when it is enabled.
 */
export function getEntries(options = {}) {
    if (!entriesCache) {
        entriesCache = buildEntries();
    }
    const profiles = Array.isArray(options.profiles) ? options.profiles : discoverProfiles();
    if (profiles.length === 0) {
        return entriesCache;
    }
    const profileEntries = buildProfileEntries(profiles);
    if (profileEntries.length === 0) {
        return entriesCache;
    }
    return entriesCache.concat(profileEntries);
}

/** Entries that can be switched through the OMTP gateway. */
export function getGatewayEntries() {
    return getEntries().filter((entry) => entry.kind === 'omp' && entry.gatewayAdapter && entry.available);
}

/** Resolve an EntryRef (or entry key) against the active entry list. */
export function resolveEntry(ref, options = {}) {
    const key = refKey(ref);
    if (!key) {
        return null;
    }
    const entries = getEntries(options);
    const direct = entries.find((entry) => entry.key === key);
    if (direct) {
        return direct;
    }
    const needle = key.toLowerCase();
    return entries.find((entry) => entry.key.toLowerCase() === needle) ?? null;
}

/**
 * Clear cached native support checks and rebuilt entries. Call after
 * MAIN_API/CHATCOMPLETION/ONLINE_STATUS/SECRET events.
 */
export function invalidateNativeCache() {
    nativeSupportCache.clear();
    entriesCache = null;
}
