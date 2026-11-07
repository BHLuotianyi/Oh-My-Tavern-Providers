/**
 * Disk-backed cache for live model lists discovered through provider APIs.
 *
 * The gateway keeps successful probe results in memory as well; this store
 * makes them survive a SillyTavern restart inside the freshness window, so a
 * restart does not repeat a probe it already has an answer for. Entries are
 * never served as a fallback: once a list is older than `LIVE_MODELS_TTL` the
 * next request probes upstream, and a failed probe is reported as an error.
 * The file lives with the rest of the server state in
 * `<DATA_ROOT>/omtp/live-models.json` and contains no credentials, only model
 * metadata.
 */

import { omtpPath, readJsonFile, writeJsonAtomic } from './config.mjs';

export const LIVE_MODELS_FILE = 'live-models.json';
export const LIVE_MODELS_STORE_VERSION = 1;

/** Upper bound on providers kept on disk; least recently probed are dropped. */
export const LIVE_MODELS_MAX_PROVIDERS = 128;

/** Freshness window: younger results answer without a network call. */
export const LIVE_MODELS_TTL = 300_000;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cacheEntry(cache, providerId) {
    const entry = cache instanceof Map ? cache.get(String(providerId)) : null;
    if (!isPlainObject(entry) || !Array.isArray(entry.models) || entry.models.length === 0) {
        return null;
    }
    const at = Number(entry.at);
    return Number.isFinite(at) ? { models: entry.models, at } : null;
}

/** One boundary for serving and pruning: a list is usable only below `ttl`. */
function isFresh(at, now, ttl = LIVE_MODELS_TTL) {
    return now - at < ttl;
}

/**
 * Entry fresh enough to answer a non-forced request without probing.
 * @param {Map<string, any>} cache
 * @param {string} providerId
 * @param {{ttl?:number, now?:number}} [options]
 */
export function freshLiveModels(cache, providerId, { ttl = LIVE_MODELS_TTL, now = Date.now() } = {}) {
    const entry = cacheEntry(cache, providerId);
    return entry && isFresh(entry.at, now, ttl) ? entry : null;
}

/** Normalize a stored model list; null when nothing usable remains. */
function normalizeModels(value) {
    if (!Array.isArray(value)) return null;
    const models = value.filter((model) => (
        isPlainObject(model) && typeof model.id === 'string' && model.id.length > 0
    ));
    return models.length > 0 ? models : null;
}

/**
 * Load persisted probe results.
 *
 * Unreadable or corrupt files degrade to an empty cache: a cache must never
 * keep the gateway from starting.
 *
 * @param {string} root OMTP data directory
 * @param {number} [now] clock override for tests
 * @returns {Promise<Map<string, {models: object[], at: number}>>}
 */
export async function loadLiveModels(root, now = Date.now()) {
    const cache = new Map();
    let raw;
    try {
        raw = await readJsonFile(omtpPath(root, LIVE_MODELS_FILE));
    } catch {
        return cache;
    }
    if (!isPlainObject(raw)
        || raw.version !== LIVE_MODELS_STORE_VERSION
        || !isPlainObject(raw.providers)) {
        return cache;
    }
    for (const [providerId, entry] of Object.entries(raw.providers)) {
        if (!providerId || !isPlainObject(entry)) {
            continue;
        }
        const models = normalizeModels(entry.models);
        const at = Number(entry.at);
        if (!models || !Number.isFinite(at) || !isFresh(at, now)) {
            continue;
        }
        cache.set(providerId, { models, at });
    }
    return cache;
}

/**
 * Persist `cache`, dropping entries outside the freshness window and
 * keeping the newest providers.
 *
 * @param {string} root OMTP data directory
 * @param {Map<string, {models: object[], at: number}>} cache
 * @param {number} [now] clock override for tests
 * @returns {Promise<{providers: number, dropped: number}>}
 */
export async function saveLiveModels(root, cache, now = Date.now()) {
    const providers = {};
    let dropped = 0;
    const entries = [];
    for (const [providerId, entry] of cache instanceof Map ? cache.entries() : []) {
        const models = normalizeModels(entry?.models);
        const at = Number(entry?.at);
        if (typeof providerId !== 'string' || !providerId || !models
            || !Number.isFinite(at) || !isFresh(at, now)) {
            dropped += 1;
            continue;
        }
        entries.push([providerId, { models, at }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at);
    if (entries.length > LIVE_MODELS_MAX_PROVIDERS) {
        dropped += entries.length - LIVE_MODELS_MAX_PROVIDERS;
    }
    for (const [providerId, entry] of entries.slice(0, LIVE_MODELS_MAX_PROVIDERS)) {
        providers[providerId] = { at: entry.at, models: entry.models };
    }
    await writeJsonAtomic(omtpPath(root, LIVE_MODELS_FILE), {
        version: LIVE_MODELS_STORE_VERSION,
        providers,
    });
    return { providers: Object.keys(providers).length, dropped };
}
