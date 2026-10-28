/**
 * OAuth client credentials — resolved locally, never shipped.
 *
 * OAuth `clientId` values are public identifiers and installed-app
 * `clientSecret`s are explicitly non-confidential (RFC 8252 §8.1), yet they
 * still trigger secret scanners and do not belong in a source tree. The bundled
 * catalog therefore carries only env-var references; the actual values come
 * from, in order:
 *
 *   1. the process environment (any name the catalog references), and
 *   2. `<OMTP data dir>/oauth-clients.json`:
 *        { "google-antigravity": { "clientId": "…", "clientSecret": "…" },
 *          "openai-codex":       { "clientId": "…" } }
 *
 * Both are local to the installation, so nothing secret is committed.
 */
import fs from 'node:fs';
import path from 'node:path';

const CLIENTS_FILE = 'oauth-clients.json';

/** @type {{file: string, mtime: number, data: Record<string, {clientId?:string, clientSecret?:string}>}|null} */
let cache = null;

/**
 * `google-antigravity` -> `GOOGLE_ANTIGRAVITY`
 * @param {string} providerId
 */
export function providerEnvPrefix(providerId) {
    return String(providerId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Env-var names the catalog references for a provider.
 * @param {string} providerId
 */
export function clientEnvNames(providerId) {
    const prefix = providerEnvPrefix(providerId);
    return {
        clientId: [`OMTP_${prefix}_CLIENT_ID`],
        clientSecret: [`OMTP_${prefix}_CLIENT_SECRET`],
    };
}

/**
 * Read the local client file, tolerating absence and malformed JSON.
 * @param {string} root
 * @returns {Record<string, {clientId?:string, clientSecret?:string}>}
 */
export function loadOAuthClients(root) {
    const file = path.join(String(root || ''), CLIENTS_FILE);
    if (cache?.file === file) {
        let mtime = 0;
        try {
            mtime = fs.statSync(file).mtimeMs;
        } catch {
            mtime = 0;
        }
        if (mtime === cache.mtime) return cache.data;
    }
    let data = {};
    let mtime = 0;
    try {
        mtime = fs.statSync(file).mtimeMs;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            data = {};
            for (const [providerId, entry] of Object.entries(parsed)) {
                if (!entry || typeof entry !== 'object') continue;
                const clientId = typeof entry.clientId === 'string' ? entry.clientId.trim() : '';
                const clientSecret = typeof entry.clientSecret === 'string' ? entry.clientSecret.trim() : '';
                if (clientId || clientSecret) data[providerId] = { clientId, clientSecret };
            }
        }
    } catch {
        // Missing or unreadable file: no local clients.
    }
    cache = { file, mtime, data };
    return data;
}

/**
 * Resolve one provider's client credentials from env or the local file.
 * @param {string} root
 * @param {string} providerId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{clientId:string, clientSecret:string}}
 */
export function resolveOAuthClient(root, providerId, env = process.env) {
    const names = clientEnvNames(providerId);
    const local = loadOAuthClients(root)?.[providerId] || {};
    const pick = (list, fallback) => {
        for (const name of list) {
            if (env?.[name]) return env[name];
        }
        return fallback || '';
    };
    return {
        clientId: pick(names.clientId, local.clientId),
        clientSecret: pick(names.clientSecret, local.clientSecret),
    };
}

/**
 * Environment overlay for the login engine: the catalog references
 * `OMTP_<PROVIDER>_CLIENT_ID/_SECRET`, and those names get the local values.
 * @param {string} root
 * @param {string} providerId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loginEnv(root, providerId, env = process.env) {
    const names = clientEnvNames(providerId);
    const resolved = resolveOAuthClient(root, providerId, env);
    const overlay = {};
    if (resolved.clientId) overlay[names.clientId[0]] = resolved.clientId;
    if (resolved.clientSecret) overlay[names.clientSecret[0]] = resolved.clientSecret;
    return overlay;
}
