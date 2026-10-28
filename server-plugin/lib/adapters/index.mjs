/**
 * Gateway protocol adapter registry.
 *
 * Each sibling module exports `{ id, chat(req, ctx), listModels?(ctx) }`.
 * Modules are loaded lazily so one broken adapter cannot take down the whole
 * gateway or prevent native/translated OMTP entries from working.
 */

export const ADAPTER_IDS = Object.freeze([
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

/** @type {Record<string, () => Promise<any>>} */
const LOADERS = {
    openai: () => import('./openai.mjs'),
    anthropic: () => import('./anthropic.mjs'),
    google: () => import('./google.mjs'),
    'google-vertex': () => import('./google-vertex.mjs'),
    antigravity: () => import('./antigravity.mjs'),
    responses: () => import('./responses.mjs'),
    'azure-responses': () => import('./azure-responses.mjs'),
    bedrock: () => import('./bedrock.mjs'),
    ollama: () => import('./ollama.mjs'),
};

/** @type {Map<string, any|null>} */
const cache = new Map();

/**
 * @param {string} id
 * @returns {boolean}
 */
export function hasAdapter(id) {
    return Object.prototype.hasOwnProperty.call(LOADERS, id);
}

/**
 * @param {string} id
 * @returns {Promise<any|null>}
 */
export async function getAdapter(id) {
    if (!hasAdapter(id)) return null;
    if (cache.has(id)) return cache.get(id);
    try {
        const module = await LOADERS[id]();
        const adapter = module?.default && typeof module.default.chat === 'function' ? module.default : module;
        if (!adapter || typeof adapter.chat !== 'function') {
            console.error(`[omtp] adapter '${id}' does not export chat(req, ctx)`);
            cache.set(id, null);
            return null;
        }
        cache.set(id, adapter);
        return adapter;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[omtp] failed to load adapter '${id}': ${message}`);
        cache.set(id, null);
        return null;
    }
}
