/**
 * Provider defaults for gateway adapters.
 *
 * A resolved provider config is the single object passed to gateway adapters:
 * `{ id, label, adapter, baseUrl, apiKey, headers, extraConfig, keySource,
 *    available, custom, models }`.
 */

export const ADAPTER_BY_API = new Map([
    ['openai-completions', 'openai'],
    ['openrouter', 'openai'],
    ['anthropic-messages', 'anthropic'],
    ['google-generative-ai', 'google'],
    ['google-vertex', 'google-vertex'],
    ['google-gemini-cli', 'antigravity'],
    ['openai-responses', 'responses'],
    ['azure-openai-responses', 'azure-responses'],
    ['bedrock-converse-stream', 'bedrock'],
    ['ollama-chat', 'ollama'],
]);

export const SUPPORTED_ADAPTERS = Object.freeze([
    'openai',
    'anthropic',
    'google',
    'google-vertex',
    'antigravity',
    'responses',
    'azure-responses',
    'bedrock',
    'ollama',
]);

export const KEYLESS_PROVIDERS = Object.freeze(['local', 'ollama', 'pollinations', 'yolo-auto']);

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';
const DEFAULT_VERTEX_REGION = 'us-central1';

/**
 * @param {string|null|undefined} api
 * @returns {string|null}
 */
export function adapterForApi(api) {
    return ADAPTER_BY_API.get(String(api || '')) ?? null;
}

/**
 * @param {string|null|undefined} adapter
 * @returns {boolean}
 */
export function isSupportedAdapter(adapter) {
    return SUPPORTED_ADAPTERS.includes(String(adapter || ''));
}

/**
 * @param {string} value
 * @param {string} suffix
 * @returns {string}
 */
function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

/**
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function compactHeaders(headers) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = String(value);
    }
    return out;
}

/**
 * @param {any} catalogProvider
 * @returns {boolean}
 */
export function isKeylessProvider(catalogProvider) {
    if (!catalogProvider) return false;
    if (catalogProvider.authKind) return catalogProvider.authKind === 'none';
    return KEYLESS_PROVIDERS.includes(catalogProvider.id);
}

/**
 * @param {string} adapter
 * @param {string} apiKey
 * @param {Record<string, any>} extraConfig
 * @returns {boolean}
 */
export function hasAdapterCredentials(adapter, apiKey, extraConfig = {}) {
    if (apiKey) return true;
    switch (adapter) {
        case 'google-vertex':
            return Boolean(extraConfig.serviceAccountJson || extraConfig.accessToken);
        case 'bedrock':
            return Boolean(extraConfig.accessKeyId && extraConfig.secretAccessKey);
        default:
            return false;
    }
}

/**
 * Build headers required by the adapter, without user overrides.
 * @param {string} adapter
 * @param {string} apiKey
 * @param {Record<string, any>} extraConfig
 * @returns {Record<string, string>}
 */
export function defaultHeadersFor(adapter, apiKey, extraConfig = {}) {
    switch (adapter) {
        case 'openai':
        case 'responses':
            return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        case 'google-vertex': {
            const token = apiKey || extraConfig.accessToken || '';
            return token ? { Authorization: `Bearer ${token}` } : {};
        }
        case 'anthropic':
            return compactHeaders({
                'x-api-key': apiKey,
                'anthropic-version': extraConfig.anthropicVersion || ANTHROPIC_VERSION,
            });
        case 'azure-responses':
            return compactHeaders({
                'api-key': apiKey,
                'api-version': extraConfig.apiVersion || DEFAULT_AZURE_API_VERSION,
            });
        case 'google':
        case 'ollama':
        default:
            return {};
    }
}

/**
 * @param {string} adapter
 * @param {any} catalogProvider
 * @param {Record<string, any>} extraConfig
 * @returns {string}
 */
function defaultBaseUrlFor(adapter, catalogProvider, extraConfig) {
    const catalogBaseUrl = trimTrailingSlash(catalogProvider?.baseUrl || '');
    if (adapter === 'google-vertex' && (!catalogBaseUrl || catalogBaseUrl.includes('{region}'))) {
        const region = extraConfig.region || DEFAULT_VERTEX_REGION;
        return `https://${region}-aiplatform.googleapis.com`;
    }
    return catalogBaseUrl;
}

/**
 * Merge catalog metadata, stored overrides and key information into the config
 * consumed by gateway adapters.
 *
 * @param {any} catalogProvider Catalog provider entry.
 * @param {{
 *   stored?: Record<string, any>|null,
 *   apiKey?: string,
 *   keySource?: 'omtp'|'st'|'env'|'none',
 *   keyless?: boolean,
 * }} [options]
 * @returns {any}
 */
export function buildProviderConfig(catalogProvider, options = {}) {
    const stored = options.stored || {};
    const adapter = stored.adapter || catalogProvider?.gatewayAdapter || adapterForApi(catalogProvider?.api) || null;
    const extraConfig = { ...(stored.extraConfig || {}) };
    if (adapter === 'google-vertex') {
        extraConfig.region = extraConfig.region || DEFAULT_VERTEX_REGION;
    } else if (adapter === 'azure-responses') {
        extraConfig.apiVersion = extraConfig.apiVersion || DEFAULT_AZURE_API_VERSION;
    } else if (adapter === 'bedrock') {
        extraConfig.region = extraConfig.region || 'us-east-1';
    }
    const baseUrl = trimTrailingSlash(stored.baseUrl || defaultBaseUrlFor(adapter, catalogProvider, extraConfig));
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    const keySource = options.keySource || (apiKey ? 'omtp' : 'none');
    const keyless = Boolean(options.keyless);
    const headers = compactHeaders({
        ...defaultHeadersFor(adapter, apiKey, extraConfig),
        // Headers required by a provider's login hook (e.g. Kimi's CLI
        // fingerprint); user overrides win over both.
        ...(options.hookHeaders || {}),
        ...(stored.headers || {}),
    });

    return {
        id: catalogProvider?.id || stored.id || '',
        label: stored.label || catalogProvider?.label || catalogProvider?.id || '',
        adapter,
        baseUrl,
        apiKey,
        headers,
        extraConfig,
        keySource,
        available: Boolean(adapter) && Boolean(keyless || hasAdapterCredentials(adapter, apiKey, extraConfig)),
        keyless,
        custom: Boolean(stored.custom || catalogProvider?.custom),
        models: Array.isArray(stored.models) && stored.models.length > 0 ? stored.models : catalogProvider?.models || [],
    };
}

/**
 * Build the `ctx` argument passed to adapter `chat`/`listModels`.
 *
 * @param {any} providerConfig Resolved provider config.
 * @param {string} model
 * @param {AbortSignal|null} [signal]
 * @param {any} [catalogProvider]
 * @param {any} [modelInfo]
 * @returns {any}
 */
export function buildProviderContext(providerConfig, model, signal = null, catalogProvider = null, modelInfo = null) {
    return {
        provider: providerConfig.id,
        model,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        headers: { ...(providerConfig.headers || {}) },
        extraConfig: { ...(providerConfig.extraConfig || {}) },
        signal,
        catalogProvider,
        modelInfo,
        fetchImpl: (...args) => globalThis.fetch(...args),
    };
}

/**
 * Build a best-effort model listing probe for provider testing.
 * Returns null when the adapter has no simple listing endpoint.
 *
 * @param {any} providerConfig
 * @returns {{url:string, headers:Record<string,string>}|null}
 */
export function buildModelsProbe(providerConfig) {
    const baseUrl = trimTrailingSlash(providerConfig.baseUrl);
    if (!baseUrl) return null;
    const modelsUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    switch (providerConfig.adapter) {
        case 'openai':
        case 'responses':
        case 'ollama':
            return { url: modelsUrl, headers: { ...providerConfig.headers } };
        case 'anthropic': {
            const base = /\/v1$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
            return { url: `${base}/models`, headers: { ...providerConfig.headers } };
        }
        case 'google': {
            const base = /\/v1beta$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`;
            const key = providerConfig.apiKey ? `?key=${encodeURIComponent(providerConfig.apiKey)}` : '';
            return { url: `${base}/models${key}`, headers: { ...providerConfig.headers } };
        }
        default:
            return null;
    }
}

/**
 * @param {string} value
 * @returns {string}
 */
export function stripTrailingSlash(value) {
    return trimTrailingSlash(value);
}

export const AZURE_DEFAULT_API_VERSION = DEFAULT_AZURE_API_VERSION;
export const VERTEX_DEFAULT_REGION = DEFAULT_VERTEX_REGION;
