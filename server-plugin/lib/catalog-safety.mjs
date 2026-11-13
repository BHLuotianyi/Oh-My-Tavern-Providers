/**
 * Safety helpers for catalog layers that do not ship with the extension.
 *
 * A refreshed or imported catalog may update model metadata, prices and
 * labels, but it must never be able to change where requests or credentials
 * are sent. Every routing / authentication field is therefore taken from the
 * bundled catalog only. This is what keeps a poisoned `models.json` (or a
 * hand-written file in `data/omtp/`) from exfiltrating saved API keys.
 */
import { ADAPTER_IDS } from './adapter-ids.mjs';
import { isLoopbackHost } from './net-hosts.mjs';

const GATEWAY_ADAPTER_IDS = new Set(ADAPTER_IDS);

/** Model fields an external catalog is allowed to supply. */
const MODEL_FIELDS = [
    'id', 'name', 'contextWindow', 'maxTokens', 'input', 'supportsTools',
    'reasoning', 'efforts', 'cost', 'kind', 'tags',
];

/** Provider fields an external catalog may use for display only. */
const DISPLAY_FIELDS = ['label'];

/**
 * Validate a user-supplied base URL. Private/loopback hosts stay allowed on
 * purpose: local runtimes (Ollama, LM Studio, vLLM) are a supported use case.
 *
 * @param {unknown} value
 * @returns {string} normalized URL, or '' when empty
 * @throws {Error} when the URL is unsafe
 */
export function validateBaseUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Invalid base URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Base URL must use http or https');
    }
    if (url.username || url.password) {
        throw new Error('Base URL must not embed credentials');
    }
    if (!url.hostname) {
        throw new Error('Base URL must include a host');
    }
    if (url.search || url.hash) {
        throw new Error('Base URL must not include a query string or fragment');
    }
    return url.toString().replace(/\/+$/, '');
}


/**
 * Hosts already trusted by the bundled catalog. A brand-new provider in an
 * external layer may only point at one of these (or at loopback).
 *
 * @param {any} bundled
 * @returns {Set<string>}
 */
export function trustedHostsFromCatalog(bundled) {
    const hosts = new Set();
    for (const provider of Object.values(bundled?.providers || {})) {
        try {
            if (provider?.baseUrl) hosts.add(new URL(provider.baseUrl).hostname.toLowerCase());
        } catch {
            // Ignore a malformed bundled entry; it is never used below.
        }
    }
    return hosts;
}

/**
 * @param {string} url
 * @param {Set<string>} trustedHosts
 * @returns {boolean}
 */
export function isTrustedEndpoint(url, trustedHosts) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return trustedHosts.has(hostname) || isLoopbackHost(hostname);
    } catch {
        return false;
    }
}

/**
 * @param {Record<string, any>} source
 * @param {string[]} keys
 * @returns {Record<string, any>}
 */
function pick(source, keys) {
    const out = {};
    for (const key of keys) {
        const value = source?.[key];
        if (value === undefined || value === null || value === '') continue;
        out[key] = value;
    }
    return out;
}

/**
 * Strip all routing, header and OAuth material from a non-bundled catalog
 * layer. Unknown providers are kept as display-only entries so model search
 * still benefits from a refresh; they cannot become request targets unless
 * their endpoint is already trusted by the bundled catalog (or is loopback).
 *
 * @param {any} layer cached / imported / refreshed catalog
 * @param {any} bundled the trusted bundled catalog
 * @returns {any} a new, safe layer
 */
export function sanitizeExternalLayer(layer, bundled) {
    const trusted = bundled?.providers || {};
    const trustedHosts = trustedHostsFromCatalog(bundled);
    /** @type {Record<string, any>} */
    const providers = {};

    for (const [id, raw] of Object.entries(layer?.providers || {})) {
        if (!id || !raw || typeof raw !== 'object') continue;
        const models = Array.isArray(raw.models)
            ? raw.models
                .map((model) => pick(model, MODEL_FIELDS))
                .filter((model) => typeof model.id === 'string' && model.id)
            : [];
        const display = pick(raw, DISPLAY_FIELDS);

        if (Object.hasOwn(trusted, id)) {
            // Keep bundled routing/auth fields by not emitting them here:
            // mergeCatalog overlays only the keys present in this layer.
            providers[id] = { id, ...display, models };
            continue;
        }

        /** @type {Record<string, any>} */
        const fresh = {
            id,
            api: 'custom',
            authKind: 'api-key',
            envVars: [],
            bundled: false,
            ...display,
            models,
        };
        let baseUrl = '';
        try {
            baseUrl = validateBaseUrl(raw.baseUrl);
        } catch {
            baseUrl = '';
        }
        if (baseUrl && isTrustedEndpoint(baseUrl, trustedHosts)) {
            fresh.baseUrl = baseUrl;
            // An adapter without a trusted endpoint must never become a
            // request target (and validateCatalog would reject it anyway).
            if (GATEWAY_ADAPTER_IDS.has(raw.gatewayAdapter)) {
                fresh.gatewayAdapter = raw.gatewayAdapter;
            }
        }
        if (!fresh.gatewayAdapter && !fresh.unsupportedReason) {
            fresh.unsupportedReason = 'Configure this provider in OMTP before use';
        }
        providers[id] = fresh;
    }

    return {
        ...layer,
        schemaVersion: 1,
        providers,
    };
}
