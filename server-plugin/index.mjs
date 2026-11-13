/**
 * SillyTavern server-plugin entry. The routes, gateway and stores live in
 * `lib/plugin.mjs`; this file only binds them to SillyTavern: its Express and
 * its secret store. `standalone.mjs` binds the same core for hosts without a
 * Node server (TauriTavern).
 */
import express from 'express';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { getUserDirectories } from '../../src/users.js';
import { DEFAULT_USER } from '../../src/constants.js';
import { init as initCore, exit } from './lib/plugin.mjs';
import { logError } from './lib/redact.mjs';

export const info = {
    id: 'omtp',
    name: 'OMTP Gateway',
    description: 'Auto-started OpenAI-compatible gateway for OMTP providers.',
};

/**
 * Provider id -> SillyTavern secret key (bundled providers only; non-bundled
 * providers must never fall back to ST secrets). The gateway has no request
 * user context, so secrets are read from the default user's directories.
 */
const ST_SECRET_BY_PROVIDER = Object.freeze({
    openai: SECRET_KEYS.OPENAI,
    anthropic: SECRET_KEYS.CLAUDE,
    google: SECRET_KEYS.MAKERSUITE,
    'google-vertex': SECRET_KEYS.VERTEXAI,
    openrouter: SECRET_KEYS.OPENROUTER,
    mistral: SECRET_KEYS.MISTRALAI,
    deepseek: SECRET_KEYS.DEEPSEEK,
    xai: SECRET_KEYS.XAI,
    groq: SECRET_KEYS.GROQ,
    zai: SECRET_KEYS.ZAI,
    moonshot: SECRET_KEYS.MOONSHOT,
    minimax: SECRET_KEYS.MINIMAX,
    'minimax-cn': SECRET_KEYS.MINIMAX,
    fireworks: SECRET_KEYS.FIREWORKS,
    nanogpt: SECRET_KEYS.NANOGPT,
    aimlapi: SECRET_KEYS.AIMLAPI,
    siliconflow: SECRET_KEYS.SILICONFLOW,
    'cloudflare-workers-ai': SECRET_KEYS.WORKERS_AI,
    perplexity: SECRET_KEYS.PERPLEXITY,
    together: SECRET_KEYS.TOGETHERAI,
    azure: SECRET_KEYS.AZURE_OPENAI,
});

/**
 * @param {string} providerId
 * @returns {string}
 */
function resolveStSecret(providerId) {
    const secretKey = ST_SECRET_BY_PROVIDER[providerId];
    if (!secretKey) return '';
    try {
        const directories = getUserDirectories(DEFAULT_USER.handle);
        return readSecret(directories, secretKey) || '';
    } catch (error) {
        logError(`failed to read ST secret for ${providerId}`, error);
        return '';
    }
}

/**
 * @param {any} router
 */
export async function init(router) {
    await initCore(router, { express, resolveStSecret });
}

export { exit };

export default { info, init, exit };
