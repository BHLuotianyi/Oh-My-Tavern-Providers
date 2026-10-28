/**
 * Shared constants for the OMTP Model Hub client extension.
 *
 * This module is intentionally dependency-free so it can be imported from
 * every other client module (including the pure selector module and unit
 * tests) without pulling in SillyTavern code.
 */

/** Third-party extension folder name (manifest id). */
export const EXTENSION_ID = 'omtp-model-hub';

/** Human readable extension name. */
export const EXTENSION_DISPLAY_NAME = 'OMTP Model Hub';

/** Key under `extension_settings` that stores all plugin settings. */
export const SETTINGS_NAMESPACE = 'omtp';

/** Base path of the optional server plugin routes. */
export const API_BASE = '/api/plugins/omtp';

/** Catalog schema version written by tools/build-catalog.mjs. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Provider id used for Connection Profile entries. */
export const PROFILE_PROVIDER_ID = 'connection-manager';

/** Gateway protocol adapters supported by the OMTP server plugin. */
export const GATEWAY_ADAPTERS = Object.freeze([
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

/** Providers that authenticate via OAuth / OMP session rather than plain API keys. */
export const OAUTH_PROVIDER_IDS = Object.freeze(new Set([
    'google-antigravity',
    'google-gemini-cli',
    'openai-codex',
    'openai-codex-device',
    'github-copilot',
    'cursor',
    'devin',
    'gitlab-duo',
    'gitlab-duo-agent',
    'stencil',
    'xai-oauth',
    'zai-coding-plan',
]));

/**
 * Request body keys that OMTP manages itself. Manual extra-body JSON may not
 * override them.
 */
export const PROTECTED_EXTRA_BODY_KEYS = Object.freeze([
    'model',
    'messages',
    'prompt',
    'stream',
    'api_type',
    'api_server',
    'chat_completion_source',
    'custom_url',
]);

/** Reasoning effort levels accepted by the selector and details panel. */
export const REASONING_LEVELS = Object.freeze([
    'auto',
    'min',
    'low',
    'medium',
    'high',
    'max',
]);

/**
 * First-party AI labs (and their own subscription portals). The sidebar keeps
 * these in their own section above the aggregators, clouds and local runtimes.
 */
export const LAB_PROVIDERS = Object.freeze(new Set([
    'anthropic',
    'openai', 'openai-codex', 'openai-codex-device',
    'google', 'google-vertex', 'google-gemini-cli', 'google-antigravity',
    'xai', 'xai-oauth',
    'deepseek',
    'mistral',
    'meta',
    'moonshot', 'kimi-code',
    'zai', 'zai-coding-plan', 'zhipu-coding-plan',
    'minimax', 'minimax-cn', 'minimax-code', 'minimax-code-cn',
    'qwen-portal', 'qianfan', 'alibaba-coding-plan', 'alibaba-token-plan',
    'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
    'nvidia',
    'perplexity',
    'stepfun',
]));

/**
 * Mainstream providers: first-party labs and their subscription portals, major
 * inference platforms, and local runtimes. Everything else (resellers, niche
 * gateways) is hidden by the "hide non-mainstream" filter.
 */
export const MAINSTREAM_PROVIDERS = Object.freeze(new Set([
    // First-party labs with a usable consumer/API offering.
    'anthropic',
    'openai', 'openai-codex', 'openai-codex-device',
    'google', 'google-vertex', 'google-gemini-cli', 'google-antigravity',
    'xai', 'xai-oauth',
    'deepseek',
    'mistral',
    'meta',
    'moonshot', 'kimi-code',
    'zai', 'zai-coding-plan', 'zhipu-coding-plan',
    'minimax', 'minimax-cn', 'minimax-code', 'minimax-code-cn',
    'qwen-portal', 'qianfan', 'alibaba-coding-plan', 'alibaba-token-plan',
    'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
    'nvidia',
    'perplexity',
    'stepfun',
    // Aggregators people actually use for chat/RP.
    'openrouter',
    'siliconflow', 'siliconflow-cn',
    'commandcode', 'opencode-go', 'opencode-zen',
    // Coding subscriptions.
    'github-copilot', 'cursor', 'gitlab-duo', 'gitlab-duo-agent',
    // Major clouds.
    'amazon-bedrock', 'azure',
    // Local runtimes.
    'ollama', 'ollama-cloud', 'lm-studio', 'vllm', 'llama.cpp', 'litellm', 'local',
]));

/** Entry ref kinds. */
export const ENTRY_KINDS = Object.freeze(['st', 'omp', 'profile']);

/** Entry source badges rendered by the hub. */
export const ENTRY_SOURCES = Object.freeze(['Native', 'Translated', 'OMTP', 'Profile']);

/** Number of quick slots (`Alt+1..9`). */
export const QUICK_SLOT_COUNT = 9;

/** Maximum number of recent selections retained. */
export const MAX_RECENTS = 20;

/** Maximum number of favorites retained. */
export const MAX_FAVORITES = 100;

/** Maximum number of rows returned by a global search. */
export const MAX_SEARCH_RESULTS = 100;

/** Debounce delay for hub search input. */
export const SEARCH_DEBOUNCE_MS = 120;

/** Public event names emitted on SillyTavern's eventSource. */
export const EVENTS = Object.freeze({
    SELECTION_CHANGED: 'omtp:selection-changed',
    CATALOG_CHANGED: 'omtp:catalog-changed',
});

/**
 * Subset of SillyTavern event types used by the client. Kept as plain string
 * values so modules can subscribe without importing the ST event module.
 */
export const ST_EVENTS = Object.freeze({
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    MAIN_API_CHANGED: 'main_api_changed',
    CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
    CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
    ONLINE_STATUS_CHANGED: 'online_status_changed',
    SECRET_WRITTEN: 'secret_written',
    SECRET_DELETED: 'secret_deleted',
    SECRET_ROTATED: 'secret_rotated',
    SECRET_EDITED: 'secret_edited',
    CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
    GENERATE_AFTER_DATA: 'generate_after_data',
});

/** Server-side gateway defaults (mirrored by the settings UI). */
export const DEFAULT_GATEWAY_SETTINGS = Object.freeze({
    autoStart: true,
    port: 4100,
    requireAuth: true,
});

/** Default gateway URL used when the server plugin status is unavailable. */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4100/v1';

/** Default global hotkey for opening the hub. */
export const DEFAULT_HOTKEY = 'alt+m';

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

/**
 * Default `extension_settings.omtp` object. Always clone before use
 * (`structuredClone`/JSON) — the exported value is deeply frozen.
 */
export const DEFAULT_SETTINGS = deepFreeze({
    version: 1,
    hideNativeSelector: true,
    gatewayUrl: DEFAULT_GATEWAY_URL,
    gatewayToken: '',
    catalogUrl: '',
    favorites: [],
    recents: [],
    quickSlots: Array.from({ length: QUICK_SLOT_COUNT }, () => null),
    lastSelection: null,
    lastNativeSelection: null,
    extraBodies: {},
    reasoningByEntry: {},
    characterBindings: {},
    autoApplyBindings: true,
    ui: {
        hotkey: DEFAULT_HOTKEY,
        mainstreamOnly: false,
        translateProviderNames: true,
        scoredOnly: false,
    },
    gateway: { savedCustom: null },
});

/**
 * Catalog provider ids that SillyTavern itself supports as first-class
 * providers. Used to label entries `Native` instead of `Translated`.
 */
export const NATIVE_PROVIDER_IDS = Object.freeze([
    'openai',
    'anthropic',
    'google',
    'google-vertex',
    'openrouter',
    'mistral',
    'deepseek',
    'xai',
    'groq',
    'zai',
    'moonshot',
    'minimax',
    'fireworks',
    'together',
    'nanogpt',
    'aimlapi',
    'chutes',
    'electronhub',
    'siliconflow',
    'cloudflare-workers-ai',
    'pollinations',
    'perplexity',
    'cohere',
    'ai21',
    'azure',
]);
