/**
 * OAuth client credentials — resolved per installation.
 *
 * Installed-app `clientId` values are public identifiers and their
 * `clientSecret`s are explicitly non-confidential (RFC 8252 §8.1). The bundled
 * catalog therefore ships the public pair for providers whose sign-in must work
 * out of the box (e.g. `google-antigravity`); `catalog-normalize.mjs` scrubs
 * every other provider to env-var references. Values resolve from, in order:
 *
 *   1. the process environment (any name the catalog references), and
 *   2. `<OMTP data dir>/oauth-clients.json`:
 *        { "google-antigravity": { "clientId": "…", "clientSecret": "…" },
 *          "openai-codex":       { "clientId": "…" } }
 *
 * Overrides are local to the installation; user tokens never pass through here.
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
 * Resolve a policy value that may be a literal, a base64 blob or an env hook.
 * @param {{value?: string, encoding?: string, hook?: string, env?: string[], fallback?: string}|string|undefined} field
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function policyValue(field, env = process.env) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    if (field.hook) {
        // Hook-backed values are provider code we do not ship; the literal
        // fallback (if any) is still usable.
        return field.fallback || '';
    }
    if (Array.isArray(field.env)) {
        for (const name of field.env) {
            const fromEnv = env?.[name];
            if (fromEnv) return fromEnv;
        }
    }
    const value = String(field.value ?? '');
    if (field.encoding === 'base64') {
        try {
            return Buffer.from(value, 'base64').toString('utf8');
        } catch {
            return value;
        }
    }
    return value;
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
