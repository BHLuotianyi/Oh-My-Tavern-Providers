/**
 * Structured (OAuth) credentials, mirroring OMP's `api-key-format "structured"`.
 *
 * A structured credential is stored in the key store as a JSON string:
 *   {"type":"oauth","access":"…","refresh":"…","expires":<ms epoch>,"projectId":"…"}
 * The shape matches OMP's `auth_credentials.data` rows so imported OMP logins
 * work unchanged. Refresh parameters come from OMP's auth rules
 * (packages/catalog/src/compat/rules/auth/*.kdl).
 */
import { applyAfterExchange } from './after-exchange.mjs';
import { CLAUDE_CODE_SDK_VERSION } from './client-versions.mjs';
import { headersForHook } from './custom-logins/kimi-fingerprint.mjs';
import { mapCredential, postToken, resolvePolicyUrl } from './login-engine.mjs';
import { loginEnv, policyValue, resolveOAuthClient } from './oauth-clients.mjs';
import { logError } from './redact.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const REFRESH_SKEW_MS = 300_000;

/**
 * Providers whose OAuth rows OMTP can use and refresh without a catalog login
 * policy (e.g. OMP-imported sessions). Client credentials are not stored here:
 * see `oauth-clients.mjs` for how they are resolved locally.
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
 * @param {any} login
 * @returns {string}
 */
function credentialStorageId(providerId, login) {
    return String(login?.storeAs || providerId || '');
}

/**
 * @param {string} providerId
 * @param {{access:string, refresh?:string, [k:string]:any}} credential
 * @param {typeof fetch} doFetch
 * @param {string} [root] OMTP data dir holding `oauth-clients.json`
 * @param {any} [login] compiled login policy (public client id fallback & generic refresh)
 */
async function refreshCredential(providerId, credential, doFetch, root = '', login = null) {
    if (!credential?.refresh) {
        throw new Error(`No refresh token for ${providerId}`);
    }
    const local = resolveOAuthClient(root, providerId);
    const spec = Object.hasOwn(OAUTH_PROVIDERS, providerId) ? OAUTH_PROVIDERS[providerId] : null;
    if (spec) {
        // Providers whose client id ships in the catalog (a public app identifier)
        // refresh without any local configuration; Google-family ones never do.
        const clientId = local.clientId || policyValue(login?.clientId);
        const clientSecret = local.clientSecret || policyValue(login?.clientSecret);
        if (!clientId || (spec.needsSecret && !clientSecret)) {
            throw new Error(
                `OAuth client credentials for ${providerId} are not configured; `
                + 'add them to data/omtp/oauth-clients.json or the matching environment variables (see docs/gateway.md).',
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
        const next = {
            ...credential,
            access: json.access_token,
            refresh: typeof json.refresh_token === 'string' ? json.refresh_token : credential.refresh,
            expires: Date.now() + Number(json.expires_in || 3600) * 1000 - REFRESH_SKEW_MS,
        };
        if (login?.afterExchange) {
            return applyAfterExchange(login.afterExchange, next, {
                provider: providerId,
                phase: 'refresh',
                raw: json,
                fetch: doFetch,
                stored: credential,
            });
        }
        return next;
    }

    // Generic refresh from the compiled login policy.
    if (!login?.token?.url || !login?.credential?.refresh?.path) {
        throw new Error(`OAuth token refresh is not supported for ${providerId}`);
    }
    const env = { ...process.env, ...loginEnv(root, providerId) };
    const tokenUrl = resolvePolicyUrl(login.token.url, login, env);
    if (!tokenUrl) {
        const hook = login.token.url?.hook;
        throw new Error(
            hook
                ? `OAuth token refresh for ${providerId} needs provider hook "${hook}" which OMTP does not ship`
                : `OAuth token refresh for ${providerId} has no token endpoint URL`,
        );
    }
    const clientId = local.clientId || policyValue(login.clientId, env);
    const clientSecret = local.clientSecret || policyValue(login.clientSecret, env);
    const standard = login.token?.standard !== false;
    if (standard && !clientId) {
        throw new Error(
            `OAuth client credentials for ${providerId} are not configured; `
            + 'add them to data/omtp/oauth-clients.json or the matching environment variables (see docs/gateway.md).',
        );
    }
    /** @type {Record<string, string>} */
    const body = {
        grant_type: 'refresh_token',
        refresh_token: credential.refresh,
    };
    if (clientId) body.client_id = clientId;
    if (clientSecret) body.client_secret = clientSecret;

    const hookHeaders = login.headersHook && root ? headersForHook(login.headersHook, root) : {};
    const headers = { ...hookHeaders, ...(login.token?.headers || {}) };
    const timeoutMs = Number(login.token?.timeoutMs) || 20_000;
    const token = await postToken(tokenUrl, body, login.token?.body || 'form', headers, doFetch, {
        timeoutMs,
        label: `OAuth refresh for ${providerId}`,
    });
    const mapped = mapCredential(login.credential, token, { provider: providerId, result: login.result || '' });
    const next = {
        ...credential,
        ...mapped,
        refresh: mapped.refresh || credential.refresh,
    };
    if (mapped.expires === undefined) {
        delete next.expires;
    }
    return applyAfterExchange(login.afterExchange, next, {
        provider: providerId,
        phase: 'refresh',
        raw: token,
        fetch: doFetch,
        env,
        stored: credential,
    });
}

/** @type {Map<string, Promise<{apiKey:string, credential:any, refreshError:any}>>} */
const inFlightRefreshes = new Map();

/**
 * Resolve a usable access token for a structured credential, refreshing and
 * persisting it when it is expired. Non-structured keys pass through.
 *
 * @param {{id:string, apiKey?:string, keySource?:string}} resolved
 * @param {{setProviderConfig?:Function, getProviderConfig?:Function, root?:string}|null} keyStore
 * @param {typeof fetch} [doFetch]
 * @param {string} [root] OMTP data dir holding `oauth-clients.json`
 * @param {any} [login] compiled login policy, for the public client id fallback and generic refresh
 * @returns {Promise<{apiKey:string, credential:any|null, refreshError:any}>}
 */
export async function resolveAccessToken(resolved, keyStore, doFetch = globalThis.fetch, root = '', login = null) {
    const credential = parseStructuredCredential(resolved?.apiKey);
    if (!credential) return { apiKey: resolved?.apiKey || '', credential: null, refreshError: null };
    const expires = Number(credential.expires || 0);
    if (expires && expires > Date.now() + 60_000) return { apiKey: credential.access, credential, refreshError: null };
    if (!credential.refresh) return { apiKey: credential.access, credential, refreshError: null };

    // Rotating refresh tokens are single-use. Without a per-provider lock,
    // concurrent requests each refresh, and the last writer invalidates the
    // access tokens handed to all the others.
    const storageId = credentialStorageId(resolved.id, login);
    const key = storageId || 'anonymous';
    let pending = inFlightRefreshes.get(key);
    if (!pending) {
        pending = (async () => {
            let activeCredential = credential;
            try {
                // Re-read inside the lock so a caller carrying a pre-refresh
                // snapshot does not replay an already-rotated refresh token.
                if (keyStore?.getProviderConfig && resolved.keySource === 'omtp' && storageId) {
                    try {
                        const storedCfg = await keyStore.getProviderConfig(storageId);
                        const latest = parseStructuredCredential(storedCfg?.apiKey);
                        if (latest) {
                            activeCredential = latest;
                            const latestExpires = Number(latest.expires || 0);
                            if ((latestExpires && latestExpires > Date.now() + 60_000) || !latest.refresh) {
                                return { apiKey: latest.access, credential: latest, refreshError: null };
                            }
                        }
                    } catch {
                        // Fall back to the caller's credential snapshot on read failure.
                    }
                }
                const next = await refreshCredential(resolved.id, activeCredential, doFetch, root || keyStore?.root || '', login);
                if (keyStore?.setProviderConfig && resolved.keySource === 'omtp') {
                    const serialized = next?.type === 'api-key' && next.access ? String(next.access) : JSON.stringify(next);
                    await keyStore.setProviderConfig(storageId, { apiKey: serialized });
                }
                return { apiKey: next.access, credential: next, refreshError: null };
            } catch (error) {
                logError(`oauth refresh failed for ${resolved.id}`, error);
                // Keep the old token for compatibility, but surface the failure
                // instead of pretending the credential is healthy.
                return { apiKey: activeCredential.access, credential: activeCredential, refreshError: error };
            } finally {
                inFlightRefreshes.delete(key);
            }
        })();
        inFlightRefreshes.set(key, pending);
    }
    return pending;
}
