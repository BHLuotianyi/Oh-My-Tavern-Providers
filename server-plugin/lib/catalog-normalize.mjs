import { KEYLESS_PROVIDERS } from './provider-config.mjs';
import { providerEnvPrefix } from './oauth-clients.mjs';

const BASE_URL_FALLBACKS = {
    azure: 'https://YOUR_RESOURCE.openai.azure.com',
    'cloudflare-workers-ai': 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1',
    local: 'http://127.0.0.1:11434/v1',
    ollama: 'http://127.0.0.1:11434/v1',
    'lm-studio': 'http://127.0.0.1:1234/v1',
    vllm: 'http://127.0.0.1:8000/v1',
    'llama.cpp': 'http://127.0.0.1:8080/v1',
    litellm: 'http://localhost:4000/v1',
};

const API_TO_GATEWAY = new Map([
    ['anthropic-messages', 'anthropic'],
    ['google-generative-ai', 'google'],
    ['google-vertex', 'google-vertex'],
    ['google-gemini-cli', 'antigravity'],
    ['openai-responses', 'responses'],
    ['azure-openai-responses', 'azure-responses'],
    ['bedrock-converse-stream', 'bedrock'],
    ['ollama-chat', 'ollama'],
]);

/**
 * Providers whose OAuth client pair stays local. `google-gemini-cli` is the
 * remaining one: its endpoints only accept the first-party app, so shipping the
 * pair is a policy decision for that provider alone.
 */
const LOCAL_ONLY_CLIENTS = new Set(['google-gemini-cli']);

/**
 * Reduce OAuth material in the catalog (returns a new map).
 *
 * Client ids and the matching installed-app secrets ship as-is for every
 * provider except `LOCAL_ONLY_CLIENTS`, whose values are replaced by env
 * references resolved on the user's machine (`oauth-clients.mjs`).
 * @param {Record<string, any>} providers
 * @returns {Record<string, any>}
 */
export function stripCatalogCredentials(providers) {
    const out = {};
    for (const [id, provider] of Object.entries(providers || {})) {
        const authLogin = provider?.authLogin;
        out[id] = authLogin ? { ...provider, authLogin: stripClientSecrets(id, authLogin) } : provider;
    }
    return out;
}

/**
 * @param {string} providerId
 * @param {Record<string, any>} login
 * @returns {Record<string, any>}
 */
function stripClientSecrets(providerId, login) {
    const prefix = providerEnvPrefix(providerId);
    const localOnly = LOCAL_ONLY_CLIENTS.has(providerId);
    const out = { ...login };
    for (const [field, suffix] of [['clientId', 'CLIENT_ID'], ['clientSecret', 'CLIENT_SECRET']]) {
        if (!(field in out)) continue;
        const previous = Array.isArray(out[field]?.env) ? out[field].env.filter(Boolean) : [];
        // Idempotent: scrubbing an already-scrubbed layer must not grow the list.
        const env = [...new Set([`OMTP_${prefix}_${suffix}`, ...previous])];
        const keepValue = localOnly ? '' : String(out[field]?.value ?? '');
        // Keep sibling keys (notably `encoding: 'base64'`) or the published id
        // would be sent verbatim instead of decoded.
        out[field] = { ...out[field], value: keepValue, env };
    }
    return out;
}

/**
 * @param {string} id
 * @returns {string}
 */
function titleCase(id) {
    return String(id)
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function mostCommon(values) {
    const counts = new Map();
    for (const value of values) {
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function normalizeAuth(rules) {
    const authProviders = rules?.auth?.providers;
    if (!Array.isArray(authProviders)) return new Map();
    return new Map(authProviders.map((entry) => [entry.id, entry]));
}

/**
 * Map the provider's chat models onto the picker's model shape.
 * @param {any[]} chatModels
 * @returns {any[]}
 */
function normalizeModels(chatModels) {
    return chatModels.map((model) => {
        const out = {
            id: String(model.id),
            name: model.name || String(model.id),
            contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
            maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
            input: Array.isArray(model.input) ? model.input : ['text'],
            supportsTools: Boolean(model.supportsTools),
            reasoning: Boolean(model.reasoning),
            efforts: Array.isArray(model.thinking?.efforts) ? model.thinking.efforts : [],
            // USD per million tokens, straight from OMP's catalog.
            ...(model.cost && typeof model.cost === 'object'
                ? { cost: {
                    input: Number(model.cost.input) || 0,
                    output: Number(model.cost.output) || 0,
                    cacheRead: Number(model.cost.cacheRead) || 0,
                    cacheWrite: Number(model.cost.cacheWrite) || 0,
                } }
                : {}),
            kind: 'chat',
        };
        return out;
    });
}

/**
 * Build one catalog provider entry from its rules and models.json section.
 * @param {string} providerId
 * @param {any} rule provider rules from OMP (may be empty)
 * @param {any} rawModels models.json entry for the provider, if any
 * @param {{authById: Map<string, any>, exceptions: Record<string, any>, remainingGatewayAdapter: string}} context
 * @returns {any}
 */
function normalizeProvider(providerId, rule, rawModels, context) {
    const { authById, exceptions, remainingGatewayAdapter } = context;
    const allModels = rawModels
        ? Object.values(rawModels || {}).filter(Boolean)
        : (Array.isArray(rule.seed?.models) ? rule.seed.models.filter(Boolean) : []);
    // `tab_*` / `chat_*` ids are editor-internal completion helpers, not
    // selectable chat models — they must never reach the picker.
    const chatModels = allModels.filter(
        (model) =>
            (model.kind === undefined || model.kind === null || model.kind === 'chat') &&
            !/^(?:tab_|chat_)/.test(String(model.id ?? '')),
    );

    const apis = allModels.map((model) => model.api).filter(Boolean);
    const api = mostCommon(apis);
    const mapping = exceptions[providerId];
    const baseUrl = mapping?.baseUrl
        || mostCommon(allModels.map((model) => model.baseUrl))
        || BASE_URL_FALLBACKS[providerId]
        || '';
    const auth = authById.get(providerId);
    const loginKind = auth?.login?.kind;
    // A provider can offer both: an env/API key *and* a subscription login
    // (Anthropic is the canonical case — Claude Pro/Max OAuth plus API keys).
    const authKinds = [];
    if (KEYLESS_PROVIDERS.includes(providerId)) {
        authKinds.push('none');
    } else {
        const hasEnv = Boolean(auth?.env) || (Array.isArray(rule.envVars) && rule.envVars.length > 0);
        if (hasEnv || loginKind === 'api-key') {
            authKinds.push('api-key');
        }
        if (loginKind && loginKind !== 'api-key') {
            authKinds.push('oauth');
        }
        if (authKinds.length === 0) {
            // No auth policy and no env var: a provider that ships chat models
            // still needs a key; one without models is inert (on-device, search).
            authKinds.push(chatModels.length > 0 ? 'api-key' : 'none');
        }
    }
    const authKind = authKinds.includes('oauth') ? 'oauth' : authKinds[0];

    let stAdapter = mapping?.stAdapter ?? null;
    let gatewayAdapter = mapping?.gatewayAdapter;
    let unsupportedReason = mapping?.unsupportedReason;

    if (mapping === undefined) {
        gatewayAdapter = remainingGatewayAdapter;
        stAdapter = null;
    }
    if (gatewayAdapter === undefined) {
        gatewayAdapter = API_TO_GATEWAY.get(api) ?? remainingGatewayAdapter;
    }
    if (!stAdapter && !gatewayAdapter && !unsupportedReason) unsupportedReason = 'unsupported';

    const models = normalizeModels(chatModels);
    return {
        id: providerId,
        // OMP's auth stratum carries the canonical display name (e.g.
        // "Anthropic (Claude Pro/Max)"); fall back to the rules label.
        label: auth?.name || rule.discovery?.label || titleCase(providerId),
        api,
        baseUrl,
        envVars: Array.isArray(rule.envVars) ? rule.envVars : [],
        authKind,
        authKinds,
        // Declarative login flow (OMP's auth stratum), consumed by the login
        // engine. `storeAs` maps aliases (e.g. `openai-codex-device`) onto the
        // provider that owns the models.
        ...(auth?.login
            ? {
                authLogin: {
                    ...stripClientSecrets(providerId, auth.login),
                    ...(auth?.storeAs ? { storeAs: auth.storeAs } : {}),
                },
            }
            : {}),
        ...(auth?.result ? { authResult: auth.result } : {}),
        defaultModel: rule.defaultModel || models[0]?.id || '',
        stAdapter,
        gatewayAdapter,
        ...(unsupportedReason ? { unsupportedReason } : {}),
        models,
    };
}

export function normalizeCatalog(models, rules, providerMap, { generatedAt = new Date().toISOString() } = {}) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
        throw new Error('models.json must be an object keyed by provider id');
    }
    if (!rules || typeof rules !== 'object') throw new Error('rules.json is required');

    const context = {
        authById: normalizeAuth(rules),
        exceptions: providerMap?.exceptions || {},
        remainingGatewayAdapter: providerMap?.remainingGatewayAdapter ?? 'openai',
    };
    const providers = {};
    let modelCount = 0;

    // OMP's provider universe is the union of the model catalog, the provider
    // rules and the auth stratum: local runtimes and OAuth-only providers have no
    // models.json entry but must still be listed and selectable after a live probe.
    const providerIds = new Set([
        ...Object.keys(models),
        ...Object.keys(rules.providers || {}),
        ...(Array.isArray(rules.auth?.providers) ? rules.auth.providers.map((entry) => entry.id) : []),
    ]);

    for (const providerId of [...providerIds].sort()) {
        const provider = normalizeProvider(providerId, rules.providers?.[providerId] || {}, models[providerId], context);
        providers[providerId] = provider;
        modelCount += provider.models.length;
    }

    return {
        schemaVersion: 1,
        source: 'oh-my-pi',
        sourceLicense: 'MIT',
        generatedAt,
        providers,
        stats: { providers: Object.keys(providers).length, models: modelCount },
    };
}

export const CATALOG_EXPECTATIONS = Object.freeze({ providers: 99, minModels: 5700 });

export function validateCatalog(catalog, { expectedProviders = CATALOG_EXPECTATIONS.providers, minModels = CATALOG_EXPECTATIONS.minModels, adapterKeys } = {}) {
    const errors = [];
    if (!catalog || catalog.schemaVersion !== 1) errors.push('schemaVersion must be 1');
    if (!catalog?.providers || typeof catalog.providers !== 'object') errors.push('providers missing');
    const providers = Object.values(catalog?.providers || {});
    if (expectedProviders && providers.length !== expectedProviders) {
        errors.push(`expected ${expectedProviders} providers, got ${providers.length}`);
    }
    let models = 0;
    const seen = new Set();
    const keys = adapterKeys ? new Set(adapterKeys) : null;
    for (const provider of providers) {
        if (!provider.id || provider.id !== provider.id.toLowerCase()) errors.push(`invalid provider id: ${provider.id}`);
        if (!provider.label) errors.push(`${provider.id}: missing label`);
        if (!provider.baseUrl && provider.gatewayAdapter) errors.push(`${provider.id}: gateway provider missing baseUrl`);
        if (provider.gatewayAdapter && !['openai', 'anthropic', 'google', 'google-vertex', 'antigravity', 'responses', 'azure-responses', 'bedrock', 'ollama'].includes(provider.gatewayAdapter)) {
            errors.push(`${provider.id}: unknown gateway adapter ${provider.gatewayAdapter}`);
        }
        if (provider.stAdapter && keys && !keys.has(provider.stAdapter)) {
            errors.push(`${provider.id}: unknown stAdapter ${provider.stAdapter}`);
        }
        if (!provider.stAdapter && !provider.gatewayAdapter && !provider.unsupportedReason) {
            errors.push(`${provider.id}: no adapter and no unsupportedReason`);
        }
        for (const model of provider.models || []) {
            const key = `${provider.id}/${model.id}`;
            if (seen.has(key)) errors.push(`duplicate model ${key}`);
            seen.add(key);
            models += 1;
            if (!model.id) errors.push(`${provider.id}: empty model id`);
            if (!Array.isArray(model.input)) errors.push(`${key}: input must be an array`);
        }
    }
    if (minModels && models < minModels) errors.push(`expected >= ${minModels} models, got ${models}`);
    return { ok: errors.length === 0, errors, providers: providers.length, models };
}
