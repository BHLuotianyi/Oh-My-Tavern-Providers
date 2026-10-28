/**
 * Native SillyTavern adapter registry.
 *
 * Every adapter describes how to read/write one native model control. The hub
 * never adds options to native selects — `supportsModel` only reports whether
 * an id is already selectable.
 */

import { oai_settings } from '../../../../../openai.js';
import { textgenerationwebui_settings } from '../../../../../textgen-settings.js';
import { nai_settings } from '../../../../../nai-settings.js';

const CHAT_CONNECT_BUTTON = '#api_button_openai';
const TEXTGEN_CONNECT_BUTTON = '#api_button_textgenerationwebui';

function documentObject() {
    return typeof globalThis.document === 'object' ? globalThis.document : null;
}

function selectSupports(selector, id) {
    const doc = documentObject();
    if (!doc || !selector) {
        return false;
    }
    const control = doc.querySelector(selector);
    if (!control) {
        return false;
    }
    const tag = typeof control.tagName === 'string' ? control.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return true;
    }
    if (!control.options) {
        return false;
    }
    return Array.from(control.options).some((option) => option.value === id);
}

function readSettings(source, field) {
    if (!field) {
        return () => null;
    }
    if (source === 'openai') {
        return () => oai_settings?.[field] ?? null;
    }
    if (source === 'textgenerationwebui') {
        return () => textgenerationwebui_settings?.[field] ?? null;
    }
    if (source === 'novel') {
        return () => nai_settings?.[field] ?? null;
    }
    return () => null;
}

function createAdapter(config) {
    const {
        key,
        label,
        mainApi,
        source = null,
        type = null,
        modelControl = null,
        modelField = null,
        connectButton = null,
        requiresKey = null,
        settingsBlock = null,
        readOnlyReason = null,
        supportsModel = null,
    } = config;

    return Object.freeze({
        key,
        label,
        mainApi,
        source,
        type,
        modelControl,
        modelField,
        connectButton,
        requiresKey,
        settingsBlock,
        readOnlyReason,
        getModel: readSettings(mainApi === 'novel' ? 'novel' : mainApi, modelField),
        supportsModel: supportsModel ?? ((id) => selectSupports(modelControl, id)),
    });
}

function chatAdapter(source, label, control, field, options = {}) {
    return createAdapter({
        key: `openai:${source}`,
        label,
        mainApi: 'openai',
        source,
        modelControl: control,
        modelField: field,
        connectButton: CHAT_CONNECT_BUTTON,
        settingsBlock: options.settingsBlock ?? `#${source}_form`,
        ...options,
    });
}

function textgenAdapter(type, label, control, field, options = {}) {
    return createAdapter({
        key: `textgenerationwebui:${type}`,
        label,
        mainApi: 'textgenerationwebui',
        type,
        modelControl: control,
        modelField: field,
        connectButton: TEXTGEN_CONNECT_BUTTON,
        settingsBlock: `[data-tg-type="${type}"]`,
        ...options,
    });
}

const ADAPTER_LIST = [
    // Chat completion sources.
    chatAdapter('openai', 'OpenAI', '#model_openai_select', 'openai_model', {
        requiresKey: 'api_key_openai',
    }),
    chatAdapter('claude', 'Anthropic Claude', '#model_claude_select', 'claude_model', {
        requiresKey: 'api_key_claude',
    }),
    chatAdapter('openrouter', 'OpenRouter', '#model_openrouter_select', 'openrouter_model', {
        requiresKey: 'api_key_openrouter',
    }),
    chatAdapter('ai21', 'AI21', '#model_ai21_select', 'ai21_model', {
        requiresKey: 'api_key_ai21',
    }),
    chatAdapter('makersuite', 'Google AI Studio', '#model_google_select', 'google_model', {
        requiresKey: 'api_key_makersuite',
    }),
    chatAdapter('vertexai', 'Google Vertex AI', '#model_vertexai_select', 'vertexai_model', {
        requiresKey: 'api_key_vertexai',
    }),
    chatAdapter('mistralai', 'Mistral', '#model_mistralai_select', 'mistralai_model', {
        requiresKey: 'api_key_mistralai',
    }),
    chatAdapter('custom', 'Custom (OpenAI-compatible)', '#custom_model_id', 'custom_model', {
        requiresKey: null,
        settingsBlock: '#custom_form',
    }),
    chatAdapter('cohere', 'Cohere', '#model_cohere_select', 'cohere_model', {
        requiresKey: 'api_key_cohere',
    }),
    chatAdapter('perplexity', 'Perplexity', '#model_perplexity_select', 'perplexity_model', {
        requiresKey: 'api_key_perplexity',
    }),
    chatAdapter('groq', 'Groq', '#model_groq_select', 'groq_model', {
        requiresKey: 'api_key_groq',
    }),
    chatAdapter('chutes', 'Chutes', '#model_chutes_select', 'chutes_model', {
        requiresKey: 'api_key_chutes',
    }),
    chatAdapter('electronhub', 'Electron Hub', '#model_electronhub_select', 'electronhub_model', {
        requiresKey: 'api_key_electronhub',
    }),
    chatAdapter('nanogpt', 'NanoGPT', '#model_nanogpt_select', 'nanogpt_model', {
        requiresKey: 'api_key_nanogpt',
    }),
    chatAdapter('deepseek', 'DeepSeek', '#model_deepseek_select', 'deepseek_model', {
        requiresKey: 'api_key_deepseek',
    }),
    chatAdapter('aimlapi', 'AI/ML API', '#model_aimlapi_select', 'aimlapi_model', {
        requiresKey: 'api_key_aimlapi',
    }),
    chatAdapter('xai', 'xAI', '#model_xai_select', 'xai_model', {
        requiresKey: 'api_key_xai',
    }),
    chatAdapter('pollinations', 'Pollinations', '#model_pollinations_select', 'pollinations_model', {
        requiresKey: 'api_key_pollinations',
    }),
    chatAdapter('moonshot', 'Moonshot', '#model_moonshot_select', 'moonshot_model', {
        requiresKey: 'api_key_moonshot',
    }),
    chatAdapter('fireworks', 'Fireworks', '#model_fireworks_select', 'fireworks_model', {
        requiresKey: 'api_key_fireworks',
    }),
    chatAdapter('cometapi', 'CometAPI', '#model_cometapi_select', 'cometapi_model', {
        requiresKey: 'api_key_cometapi',
        readOnlyReason: 'CometAPI is disabled on this server',
    }),
    chatAdapter('azure_openai', 'Azure OpenAI', '#azure_openai_model', 'azure_openai_model', {
        requiresKey: 'api_key_azure_openai',
        settingsBlock: '#azure_openai_settings',
    }),
    chatAdapter('zai', 'Z.AI', '#model_zai_select', 'zai_model', {
        requiresKey: 'api_key_zai',
    }),
    chatAdapter('siliconflow', 'SiliconFlow', '#model_siliconflow_select', 'siliconflow_model', {
        requiresKey: 'api_key_siliconflow',
    }),
    chatAdapter('minimax', 'MiniMax', '#model_minimax_select', 'minimax_model', {
        requiresKey: 'api_key_minimax',
    }),
    chatAdapter('workers_ai', 'Cloudflare Workers AI', '#model_workers_ai_select', 'workers_ai_model', {
        requiresKey: 'api_key_workers_ai',
    }),

    // Text completion types.
    textgenAdapter('ooba', 'Text Generation WebUI', '#custom_model_textgenerationwebui', 'custom_model', {
        requiresKey: 'api_key_ooba',
    }),
    textgenAdapter('mancer', 'Mancer', '#mancer_model', 'mancer_model', {
        requiresKey: 'api_key_mancer',
    }),
    textgenAdapter('vllm', 'vLLM', '#vllm_model', 'vllm_model', {
        requiresKey: 'api_key_vllm',
    }),
    textgenAdapter('aphrodite', 'Aphrodite', '#aphrodite_model', 'aphrodite_model', {
        requiresKey: 'api_key_aphrodite',
    }),
    textgenAdapter('tabby', 'TabbyAPI', '#tabby_model', 'tabby_model', {
        requiresKey: 'api_key_tabby',
    }),
    textgenAdapter('koboldcpp', 'KoboldCpp', null, null, {
        requiresKey: 'api_key_koboldcpp',
        readOnlyReason: 'Model list is loaded from the backend; manage it in the native UI',
    }),
    textgenAdapter('togetherai', 'Together AI', '#model_togetherai_select', 'togetherai_model', {
        requiresKey: 'api_key_togetherai',
    }),
    textgenAdapter('llamacpp', 'llama.cpp', '#llamacpp_model', 'llamacpp_model', {
        requiresKey: 'api_key_llamacpp',
    }),
    textgenAdapter('ollama', 'Ollama', '#ollama_model', 'ollama_model', {
        requiresKey: null,
    }),
    textgenAdapter('infermaticai', 'InfermaticAI', '#model_infermaticai_select', 'infermaticai_model', {
        requiresKey: 'api_key_infermaticai',
    }),
    textgenAdapter('dreamgen', 'DreamGen', '#model_dreamgen_select', 'dreamgen_model', {
        requiresKey: 'api_key_dreamgen',
    }),
    textgenAdapter('openrouter', 'OpenRouter (Text)', '#openrouter_model', 'openrouter_model', {
        requiresKey: 'api_key_openrouter',
    }),
    textgenAdapter('featherless', 'Featherless', '#featherless_model', 'featherless_model', {
        requiresKey: 'api_key_featherless',
    }),
    textgenAdapter('huggingface', 'HuggingFace (TGI)', null, null, {
        requiresKey: 'api_key_huggingface',
        readOnlyReason: 'HuggingFace text generation is fixed to the tgi model',
    }),
    textgenAdapter('generic', 'Generic (OpenAI-compatible)', '#generic_model_textgenerationwebui', 'generic_model', {
        requiresKey: 'api_key_generic',
    }),

    // Other main APIs.
    createAdapter({
        key: 'novel:-',
        label: 'NovelAI',
        mainApi: 'novel',
        modelControl: '#model_novel_select',
        modelField: 'model_novel',
        connectButton: '#api_button_novel',
        requiresKey: 'api_key_novel',
        settingsBlock: '#novel_api',
    }),
    createAdapter({
        key: 'kobold:-',
        label: 'KoboldAI Classic',
        mainApi: 'kobold',
        readOnlyReason: 'Read-only provider; manage it in the native UI',
        settingsBlock: '#kobold_api_block',
    }),
    createAdapter({
        key: 'koboldhorde:-',
        label: 'AI Horde',
        mainApi: 'koboldhorde',
        modelControl: '#horde_model',
        requiresKey: 'api_key_horde',
        settingsBlock: '#kobold_api_block',
        readOnlyReason: 'AI Horde uses multi-select; manage it in the native UI',
        supportsModel: () => false,
    }),
];

/** Native adapter registry keyed by `<mainApi>:<sourceOrType>`. */
export const NATIVE_ADAPTERS = Object.fromEntries(
    ADAPTER_LIST.map((adapter) => [adapter.key, adapter]),
);

/** Look up a native adapter, or null when the key is unknown. */
export function getNativeAdapter(key) {
    if (typeof key !== 'string') {
        return null;
    }
    return NATIVE_ADAPTERS[key] ?? null;
}

/**
 * Register a native adapter at runtime (public API interop).
 * Callers must invalidate the catalog entry cache afterwards.
 */
export function registerNativeAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object' || typeof adapter.key !== 'string' || adapter.key.length === 0) {
        throw new TypeError('[omtp] registerNativeAdapter requires an adapter with a key');
    }
    NATIVE_ADAPTERS[adapter.key] = Object.freeze({ ...adapter });
    return NATIVE_ADAPTERS[adapter.key];
}
