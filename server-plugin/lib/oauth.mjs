/**
 * Structured (OAuth) credentials, mirroring OMP's `api-key-format "structured"`.
 *
 * A structured credential is stored in the key store as a JSON string:
 *   {"type":"oauth","access":"…","refresh":"…","expires":<ms epoch>,"projectId":"…"}
 * The shape matches OMP's `auth_credentials.data` rows so imported OMP logins
 * work unchanged. Refresh parameters come from OMP's auth rules
 * (packages/catalog/src/compat/rules/auth/*.kdl).
 */
import { logError } from './redact.mjs';
import { resolveOAuthClient, policyValue } from './oauth-clients.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLAUDE_CODE_SDK_VERSION = '0.112.1';
const REFRESH_SKEW_MS = 300_000;

/**
 * Providers whose OAuth rows OMTP can use and refresh. Client credentials are
 * not stored here: see `oauth-clients.mjs` for how they are resolved locally.
 */
export const OAUTH_PROVIDERS = Object.freeze({
    'google-antigravity': { kind: 'google', requiresProject: true, needsSecret: true },
    'google-gemini-cli': { kind: 'google', requiresProject: true, needsSecret: true },
    anthropic: { kind: 'anthropic', requiresProject: false, needsSecret: false },
});

/**
 * @param {unknown} apiKey
 * @returns {null | {type?:string, access:string, refresh?:string, expires?:number, projectId?:string, [k:string]:any}}
 */
export function parseStructuredCredential(apiKey) {
    if (typeof apiKey !== 'string') return null;
    const trimmed = apiKey.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        const access = parsed?.access ?? parsed?.token ?? parsed?.accessToken;
        if (typeof access !== 'string' || !access) return null;
        return { ...parsed, access };
    } catch {
        return null;
    }
}

/**
 * @param {string} providerId
 * @param {{access:string, refresh?:string}} credential
 * @param {typeof fetch} doFetch
 * @param {string} [root] OMTP data dir holding `oauth-clients.json`
 * @param {any} [login] compiled login policy (public client id fallback)
 */
async function refreshCredential(providerId, credential, doFetch, root = '', login = null) {
    const spec = OAUTH_PROVIDERS[providerId];
    if (!spec || !credential.refresh) throw new Error(`No refresh token for ${providerId}`);
    const local = resolveOAuthClient(root, providerId);
    // Providers whose client id ships in the catalog (a public app identifier)
    // refresh without any local configuration; Google-family ones never do.
    const clientId = local.clientId || policyValue(login?.clientId);
    const clientSecret = local.clientSecret || policyValue(login?.clientSecret);
    if (!clientId || (spec.needsSecret && !clientSecret)) {
        throw new Error(
            `OAuth client credentials for ${providerId} are not configured; `
            + 'add them to data/omtp/oauth-clients.json (see README) or the matching environment variables.',
        );
    }
    let response;
    if (spec.kind === 'google') {
        response = await doFetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: credential.refresh,
                client_id: clientId,
                client_secret: clientSecret,
            }).toString(),
            signal: AbortSignal.timeout(20_000),
        });
    } else {
        response = await doFetch(ANTHROPIC_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-beta': 'oauth-2025-04-20',
                'User-Agent': `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`,
            },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: clientId }),
            signal: AbortSignal.timeout(20_000),
        });
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OAuth refresh for ${providerId} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const json = await response.json();
    if (typeof json?.access_token !== 'string') throw new Error(`OAuth refresh for ${providerId} returned no access_token`);
    return {
        ...credential,
        access: json.access_token,
        refresh: typeof json.refresh_token === 'string' ? json.refresh_token : credential.refresh,
        expires: Date.now() + Number(json.expires_in || 3600) * 1000 - REFRESH_SKEW_MS,
    };
}

/**
 * Resolve a usable access token for a structured credential, refreshing and
 * persisting it when it is expired. Non-structured keys pass through.
 *
 * @param {{id:string, apiKey?:string, keySource?:string}} resolved
 * @param {{setProviderConfig?:Function}|null} keyStore
 * @param {typeof fetch} [doFetch]
 * @param {any} [login] compiled login policy, for the public client id fallback
 * @returns {Promise<{apiKey:string, credential:any|null}>}
 */
export async function resolveAccessToken(resolved, keyStore, doFetch = globalThis.fetch, root = '', login = null) {
    const credential = parseStructuredCredential(resolved?.apiKey);
    if (!credential) return { apiKey: resolved?.apiKey || '', credential: null };
    const expires = Number(credential.expires || 0);
    if (expires && expires > Date.now() + 60_000) return { apiKey: credential.access, credential };
    if (!credential.refresh) return { apiKey: credential.access, credential };
    try {
        const next = await refreshCredential(resolved.id, credential, doFetch, root || keyStore?.root || '', login);
        if (keyStore?.setProviderConfig && resolved.keySource === 'omtp') {
            await keyStore.setProviderConfig(resolved.id, { apiKey: JSON.stringify(next) });
        }
        return { apiKey: next.access, credential: next };
    } catch (error) {
        logError(`oauth refresh failed for ${resolved.id}`, error);
        return { apiKey: credential.access, credential };
    }
}
