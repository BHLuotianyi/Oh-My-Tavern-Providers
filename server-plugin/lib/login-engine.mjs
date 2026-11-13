/**
 * Generic OAuth login engine.
 *
 * OMP declares each provider's login flow declaratively (see
 * `packages/catalog/src/compat/rules/auth/*.kdl` → `auth.providers[].login`).
 * The compiled policy is shipped inside our catalog, so a single engine can
 * drive every `oauth-code` and `device-code` provider:
 *
 *   oauth-code   PKCE + a loopback callback listener (or manual paste)
 *   device-code  device authorization grant with polling
 *
 * Both completion paths run the policy's `afterExchange` hook (see
 * `after-exchange.mjs`) after the token exchange and before the credential is
 * stored, so identity recovery, project provisioning and durable key minting
 * are visible to the key store.
 *
 * Providers whose policy uses a `custom` login (Cursor, Copilot, Devin, …)
 * need per-provider code. The ones we have ported live in `custom-logins/`
 * and are imported below; everything else is reported as `loginNeedsHook` and
 * can still be imported from OMP.
 */
import crypto from 'node:crypto';
import { clearTimeout as clearExpiryTimer, setTimeout as setExpiryTimer } from 'node:timers';
import { applyAfterExchange } from './after-exchange.mjs';
import { listenForCode, resolveCallbackOptions } from './callback-listener.mjs';
import { pickLocale } from './callback-page.mjs';
import { HOOKS as KILO_HOOKS } from './custom-logins/kilo.mjs';
import { headerHookSupported } from './custom-logins/kimi-fingerprint.mjs';
import { HOOKS as CODEX_HOOKS } from './custom-logins/openai-codex-device.mjs';
import { policyValue } from './oauth-clients.mjs';
import { describeFetchFailure } from './proxy-fetch.mjs';

/** Policy-value resolution lives with the credential helpers. */
export { policyValue, pickLocale, resolveCallbackOptions };

/** Sessions live for this long before they are garbage-collected. */
const SESSION_TTL_MS = 10 * 60_000;
/** Device-code polling safety margin (seconds added to the server interval). */
const DEVICE_POLL_SLACK_S = 1;
/** Default token-endpoint request timeout. */
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/** @type {Map<string, any>} */
const sessions = new Map();

/**
 * `custom` login hooks we implement ourselves, keyed by policy `login.hook`.
 * Every hook returns `{url, userCode?, instructions, waitForCompletion}`.
 * @type {Map<string, (deps: object) => Promise<object>>}
 */
const CUSTOM_HOOKS = new Map([
    ...Object.entries(CODEX_HOOKS),
    ...Object.entries(KILO_HOOKS),
]);

/**
 * @param {string|undefined} hook
 * @returns {boolean} Whether this `custom` hook has a local implementation.
 */
export function customHookSupported(hook) {
    return Boolean(hook) && CUSTOM_HOOKS.has(String(hook));
}

/**
 * Return the name of a provider hook that `policy` needs to run a login flow
 * but OMTP does not ship (hook-backed URL/field with no literal fallback,
 * unsupported `headersHook`, or unsupported `custom` hook), else `null`.
 *
 * @param {any} policy compiled `provider.authLogin`
 * @returns {string|null}
 */
export function missingLoginHook(policy) {
    if (!policy || typeof policy !== 'object') return null;
    if (policy.kind === 'custom') {
        return customHookSupported(policy.hook) ? null : String(policy.hook || 'custom');
    }
    if (policy.headersHook && !headerHookSupported(policy.headersHook)) {
        return String(policy.headersHook);
    }
    const fields = [
        policy.authorizeUrl,
        policy.device?.url,
        policy.token?.url,
        policy.baseUrl,
        policy.authUrl,
        policy.clientId,
        policy.clientSecret,
        policy.callback?.redirectUri,
    ];
    for (const field of fields) {
        if (field && typeof field === 'object' && field.hook && !field.fallback) {
            return String(field.hook);
        }
    }
    return null;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/** Replace `{name}` placeholders in a policy string. */
export function fillTemplate(text, vars) {
    return String(text).replace(/\{([a-z_]+)\}/gi, (match, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match
    ));
}

/**
 * Resolve a policy URL field and substitute `{base}` / `{auth}` placeholders
 * from the compiled policy's `baseUrl` / `authUrl` fields.
 * @param {any} field
 * @param {any} login
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolvePolicyUrl(field, login, env = process.env) {
    const raw = policyValue(field, env);
    if (!raw) return '';
    const vars = {};
    const base = policyValue(login?.baseUrl, env);
    if (base) vars.base = base;
    const auth = policyValue(login?.authUrl, env);
    if (auth) vars.auth = auth;
    return fillTemplate(raw, vars);
}

/**
 * PKCE pair (RFC 7636).
 * @returns {{verifier: string, challenge: string}}
 */
export function createPkcePair() {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/** @returns {string} */
function createState() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Build the authorize URL for an `oauth-code` policy.
 *
 * @param {object} login compiled login policy
 * @param {{state: string, challenge?: string, redirectUri: string, env?: Record<string,string|undefined>}} options
 * @returns {string}
 */
export function buildAuthorizeUrl(login, { state, challenge, redirectUri, env = process.env }) {
    const base = resolvePolicyUrl(login?.authorizeUrl, login, env);
    if (!base) {
        throw new Error('This provider has no authorize URL');
    }
    const url = new URL(base);
    const clientId = policyValue(login.clientId, env);
    const standard = login.standardAuthorizeParams !== false;
    // A scrubbed catalog client id (see `catalog-normalize.mjs`) would send
    // `client_id=` and the provider answers `invalid_request`. Say what to set
    // instead of opening a broken consent page.
    if (standard && !clientId) {
        throw new Error(missingClientIdMessage(login));
    }
    if (standard) {
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        if (login.state !== 'none' && state) {
            url.searchParams.set('state', state);
        }
        const scopes = Array.isArray(login.scopes) ? login.scopes : [];
        if (scopes.length) {
            url.searchParams.set('scope', scopes.join(login.scopeSeparator || ' '));
        }
        if (login.pkce && challenge) {
            url.searchParams.set('code_challenge', challenge);
            url.searchParams.set('code_challenge_method', 'S256');
        }
    }
    const vars = { redirect_uri: redirectUri, code_challenge: challenge || '', state: state || '', client_id: clientId };
    for (const [key, value] of Object.entries(login.authorizeParams || {})) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, fillTemplate(String(value), vars));
        }
    }
    return url.toString();
}

/**
 * Actionable error for a provider whose OAuth client id was never supplied.
 * @param {any} login
 * @returns {string}
 */
function missingClientIdMessage(login) {
    const names = Array.isArray(login?.clientId?.env) ? login.clientId.env.filter(Boolean) : [];
    const hint = names.length
        ? `set ${names.join(' or ')}`
        : "set the provider's OMTP_*_CLIENT_ID variable";
    return `This provider needs an OAuth client id: ${hint}, or add "clientId" to data/omtp/oauth-clients.json`;
}

/**
 * Turn a pasted value into an authorization code. Accepts a bare code, the
 * `code#state` string Anthropic's manual page shows, a full redirect URL, or
 * `code=…&state=…`.
 * @param {string} raw
 * @returns {{code: string, state?: string}}
 */
export function parseAuthorizationInput(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('Paste the authorization code or the full redirect URL');
    }
    if (/^https?:\/\//i.test(text)) {
        // A proxy that forwards an absolute-form request makes the callback
        // page advertise `http://host:porthttp://host:port/…`; raising here
        // would tell the user to paste a valid URL they never had. Fall
        // through to the query parsing below instead.
        let url;
        try {
            url = new URL(text);
        } catch {
            // Not a URL after all: the `code=` scan below still applies.
        }
        if (url) {
            const code = url.searchParams.get('code') || '';
            const state = url.searchParams.get('state') || undefined;
            if (!code) throw new Error('That URL has no `code` parameter');
            return { code, state };
        }
    }
    const match = /(?:^|[?&])code=([^&]+)/.exec(text);
    if (match) {
        const stateMatch = /(?:^|[?&])state=([^&]+)/.exec(text);
        return { code: decodeURIComponent(match[1]), state: stateMatch ? decodeURIComponent(stateMatch[1]) : undefined };
    }
    const hash = text.indexOf('#');
    if (hash > 0) return { code: text.slice(0, hash), state: text.slice(hash + 1) || undefined };
    return { code: text };
}

/**
 * Read a dotted path (`account.uuid`) out of a token response.
 * @param {any} source
 * @param {string|undefined} path
 */
function readPath(source, path) {
    if (!path) return undefined;
    let current = source;
    for (const part of String(path).split('.')) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Map a token response onto our structured credential shape.
 *
 * @param {object} credential policy `login.credential`
 * @param {any} token token endpoint JSON
 * @param {{provider?: string, now?: number, result?: string}} [options]
 * @returns {{type: string, access: string, refresh?: string, expires?: number, [k: string]: any}}
 */
export function mapCredential(credential, token, { provider = '', now = Date.now(), result = '' } = {}) {
    const access = readPath(token, credential?.access?.path) ?? token?.access_token;
    if (typeof access !== 'string' || !access) {
        throw new Error('Token response did not contain an access token');
    }
    if (result === 'api-key') {
        // The flow yields a durable API key, not a refreshable session.
        return { type: 'api-key', provider, access };
    }
    const out = { type: 'oauth', provider, access };
    const refresh = readPath(token, credential?.refresh?.path) ?? token?.refresh_token;
    if (typeof refresh === 'string' && refresh) {
        out.refresh = refresh;
    }
    const expiry = credential?.expires;
    if (expiry?.mode !== 'never') {
        const expiresIn = Number(readPath(token, expiry?.path) ?? token?.expires_in);
        if (Number.isFinite(expiresIn) && expiresIn > 0) {
            out.expires = now + expiresIn * 1000;
        }
    }
    const accountId = readPath(token, credential?.accountId?.path);
    if (accountId) out.accountId = String(accountId);
    const email = readPath(token, credential?.email?.path);
    if (email) out.email = String(email);
    const orgId = readPath(token, credential?.orgId?.path);
    if (orgId) out.orgId = String(orgId);
    const orgName = readPath(token, credential?.orgName?.path);
    if (orgName) out.orgName = String(orgName);
    if (typeof token?.id_token === 'string') {
        out.idToken = token.id_token;
    }
    return out;
}

/**
 * Build the token-exchange request body.
 * @param {object} login
 * @param {Record<string, string>} params
 * @param {string} redirectUri
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [state] the session's verified state, for `{state}` templates
 */
function tokenRequestBody(login, params, redirectUri, env = process.env, state = '') {
    const standard = login.token?.standard !== false;
    /** @type {Record<string, string>} */
    const body = {};
    if (standard) {
        body.client_id = policyValue(login.clientId, env);
        if (redirectUri) body.redirect_uri = redirectUri;
        Object.assign(body, params);
        const secret = policyValue(login.clientSecret, env);
        if (secret) body.client_secret = secret;
    }
    const vars = {
        ...params,
        redirect_uri: redirectUri,
        client_id: policyValue(login.clientId, env),
        code: params.code || '',
        code_verifier: params.code_verifier || '',
        state,
    };
    for (const [key, value] of Object.entries(login.token?.params || {})) {
        body[key] = fillTemplate(String(value), vars);
    }
    return body;
}

/**
 * Render a token-endpoint error field. RFC 6749 endpoints send strings
 * (`error`, `error_description`); Anthropic answers rate limits and other API
 * failures with `{error: {type, message}}`, which must not become
 * "[object Object]".
 * @param {unknown} value
 * @returns {string}
 */
function describeErrorValue(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (!value || typeof value !== 'object') return '';
    const code = describeErrorValue(value.code ?? value.type ?? value.error);
    const message = describeErrorValue(value.message ?? value.error_description ?? value.description);
    if (code && message && code !== message) return `${code}: ${message}`;
    return code || message || JSON.stringify(value);
}

/**
 * @param {number} status
 * @param {any} json parsed body, or null
 * @param {string} text raw body
 */
function describeTokenError(status, json, text) {
    const error = describeErrorValue(json?.error);
    const description = describeErrorValue(json?.error_description);
    let detail;
    if (error && description && error !== description) detail = `${error}: ${description}`;
    else detail = error || description || describeErrorValue(json?.message) || text.trim().slice(0, 200);
    return detail ? `HTTP ${status} ${detail}` : `HTTP ${status}`;
}

/**
 * POST to a token endpoint.
 * @param {string} url
 * @param {Record<string, string>} body
 * @param {'json'|'form'} mode
 * @param {Record<string,string>} headers
 * @param {typeof fetch} doFetch
 * @param {{signal?: AbortSignal, timeoutMs?: number, label?: string}} [options]
 */
export async function postToken(url, body, mode, headers, doFetch, { signal, timeoutMs = TOKEN_REQUEST_TIMEOUT_MS, label = 'Token exchange' } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const init = { method: 'POST', headers: { Accept: 'application/json', ...headers }, signal: reqSignal };
    if (mode === 'form') {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(body).toString();
    } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    let response;
    let text;
    try {
        response = await doFetch(url, init);
        text = await response.text();
    } catch (error) {
        // Undici reports every network problem as a bare `fetch failed`; show
        // the underlying cause (ECONNREFUSED, ENOTFOUND, proxy refused, …).
        const err = /** @type {Error & {transient?: boolean}} */ (new Error(`${label} request failed: ${describeFetchFailure(error)}`));
        err.transient = true;
        throw err;
    }
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (!response.ok) {
        throw new Error(`${label} failed: ${describeTokenError(response.status, json, text)}`);
    }
    return json ?? {};
}

/**
 * Exchange an authorization code.
 *
 * @param {object} login
 * @param {{code: string, state?: string, verifier?: string, redirectUri: string, provider?: string, result?: string}} options
 * @returns {Promise<{credential: object, raw: unknown}>} structured credential and the token response body
 */
async function exchangeCode(login, { code, state = '', verifier, redirectUri, provider = '', result = '' }, doFetch = fetch, env = process.env) {
    const params = { code, grant_type: 'authorization_code' };
    if (login.pkce && verifier) params.code_verifier = verifier;
    const body = tokenRequestBody(login, params, redirectUri, env, state);
    const url = resolvePolicyUrl(login.token?.url, login, env);
    const timeoutMs = Number(login.token?.timeoutMs) || TOKEN_REQUEST_TIMEOUT_MS;
    const token = await postToken(url, body, login.token?.body || 'json', login.token?.headers || {}, doFetch, { timeoutMs });
    return { credential: mapCredential(login.credential, token, { provider, result }), raw: token };
}

/**
 * Start a device authorization grant.
 *
 * @param {object} login
 * @param {{env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUri: string, verificationUriComplete?: string, interval: number, expiresIn: number}>}
 */
async function startDeviceAuthorization(login, { env = process.env } = {}, doFetch = fetch) {
    const device = login.device;
    if (!device?.url) {
        throw new Error('This provider does not expose a device authorization endpoint');
    }
    const url = resolvePolicyUrl(device.url, login, env);
    const body = { client_id: policyValue(login.clientId, env) };
    for (const [key, value] of Object.entries(device.params || {})) {
        body[key] = String(value);
    }
    const timeoutMs = Number(device.timeoutMs) || TOKEN_REQUEST_TIMEOUT_MS;
    const response = await postToken(url, body, device.body || 'form', device.headers || {}, doFetch, { timeoutMs });
    const map = login.response || {};
    const deviceCode = readPath(response, map.deviceCode || 'device_code');
    const userCode = readPath(response, map.userCode || 'user_code');
    const verificationUri = readPath(response, map.verificationUri || 'verification_uri');
    if (!deviceCode || !verificationUri) {
        throw new Error('Device authorization response was incomplete');
    }
    return {
        deviceCode: String(deviceCode),
        userCode: userCode ? String(userCode) : '',
        verificationUri: String(verificationUri),
        verificationUriComplete: readPath(response, map.verificationUriComplete || 'verification_uri_complete') || undefined,
        interval: Number(readPath(response, map.interval || 'interval')) || 5,
        expiresIn: Number(readPath(response, map.expiresIn || 'expires_in')) || 600,
    };
}

/**
 * Sleep for `ms`, resolving early if `signal` aborts. Timer is `.unref()`ed
 * so an abandoned poll never keeps the process alive.
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 */
function sleepPoll(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/**
 * Poll the token endpoint until the device grant completes.
 *
 * @param {object} login
 * @param {{deviceCode: string, interval: number, expiresIn: number, provider?: string}} grant
 * @param {{signal?: AbortSignal, env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{credential: object, raw: unknown}>} structured credential and the token response body
 */
async function pollDeviceToken(login, grant, { signal, env = process.env } = {}, doFetch = fetch) {
    const deadline = Date.now() + grant.expiresIn * 1000;
    let interval = Math.max(1, grant.interval) + DEVICE_POLL_SLACK_S;
    const timeoutMs = Number(login.token?.timeoutMs) || TOKEN_REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new Error('Login canceled');
        }
        await sleepPoll(interval * 1000, signal);
        if (signal?.aborted) {
            throw new Error('Login canceled');
        }
        const url = resolvePolicyUrl(login.token?.url, login, env);
        const body = tokenRequestBody(login, {
            device_code: grant.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }, '', env);
        try {
            const token = await postToken(url, body, login.token?.body || 'form', login.token?.headers || {}, doFetch, { signal, timeoutMs });
            return {
                credential: mapCredential(login.credential, token, { provider: grant.provider || '', result: login.result || '' }),
                raw: token,
            };
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Login canceled');
            }
            // Retry transient network failures until the device code expires.
            if (error?.transient) {
                continue;
            }
            const message = String(error?.message || error);
            if (/authorization_pending|slow_down/i.test(message)) {
                if (/slow_down/i.test(message)) interval += 5;
                continue;
            }
            throw error;
        }
    }
    throw new Error('Device authorization timed out');
}

/* ------------------------------------------------------------------ */
/* Session management                                                 */
/* ------------------------------------------------------------------ */

/**
 * Stop any active listeners/polls for a session and remove it from `sessions`.
 * @param {string} id
 * @param {any} session
 */
function disposeSession(id, session) {
    clearExpiryTimer(session.expiryTimer);
    session.expiryTimer = null;
    // Device-code/custom sessions poll in the background; aborting only
    // the oauth-code listener would let an abandoned poll complete and
    // silently write a credential.
    session.controller?.abort();
    session.cancel?.();
    sessions.delete(id);
}

function sweep() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.startedAt > SESSION_TTL_MS) {
            disposeSession(id, session);
        }
    }
}

/**
 * @param {object} session
 * @returns {{id: string}}
 */
function remember(session) {
    sweep();
    const id = crypto.randomBytes(12).toString('hex');
    const entry = { ...session, id, startedAt: Date.now(), status: 'pending', expiryTimer: null };
    const timer = setExpiryTimer(() => {
        if (sessions.get(id) === entry && Date.now() - entry.startedAt >= SESSION_TTL_MS) {
            disposeSession(id, entry);
        }
    }, SESSION_TTL_MS);
    timer.unref?.();
    entry.expiryTimer = timer;
    sessions.set(id, entry);
    return entry;
}

/**
 * Explain why the browser cannot hand the code back automatically, so the
 * paste box does not look like a mysterious extra step.
 * @param {string} reason `resolveCallbackOptions().reason` or `bind`
 * @param {{redirectUri:string, hostname:string, port:number}} options
 * @param {string} [bindError] bind failure code/message
 * @returns {string}
 */
function manualHint(reason, options, bindError) {
    const paste = 'After signing in, copy the redirect URL (or the authorization code) and paste it into SillyTavern.';
    switch (reason) {
        case 'manual':
            return `This provider completes sign-in by manual entry. ${paste}`;
        case 'native':
            return `This provider redirects to ${options.redirectUri}, a custom scheme, and SillyTavern has no OS handler for it. ${paste}`;
        case 'scheme':
            return `This provider redirects to ${options.redirectUri}, a custom scheme this plugin cannot capture. ${paste}`;
        case 'remote':
            return `This provider redirects to ${options.redirectUri}, which does not reach this SillyTavern server. ${paste}`;
        case 'invalid':
            return `This provider's redirect URI (${options.redirectUri}) could not be parsed. ${paste}`;
        case 'bind':
            return `Port ${options.port} on ${options.hostname} is already in use${bindError ? ` (${bindError})` : ''}, so the browser callback cannot be received. Free the port and restart the sign-in, or ${paste.charAt(0).toLowerCase()}${paste.slice(1)}`;
        default:
            return '';
    }
}

/**
 * @param {string|undefined} instructions policy instructions
 * @param {string} note manual-paste note (empty when the listener handles the callback)
 * @returns {string}
 */
function composeInstructions(instructions, note) {
    const base = String(instructions || '').trim();
    if (!base) return note;
    return note ? `${base}\n\n${note}` : base;
}

/**
 * Start an `oauth-code` flow: bind the loopback listener (unless the policy or
 * the bind result makes the code arrive by paste) and build the authorize URL.
 * @param {string} providerId
 * @param {object} login compiled login policy
 * @param {{keyStore:any, env:Record<string,string|undefined>, doFetch:typeof fetch, locale:'en'|'zh-cn'}} deps
 * @returns {Promise<{id:string, kind:string, url:string, redirectUri:string, manual:boolean, instructions:string}>}
 */
async function startOauthCode(providerId, login, { keyStore, env, doFetch, locale }) {
    // Policies without a state parameter (OpenRouter) get none back on the
    // callback; expecting one there would reject every browser redirect.
    const state = login.state === 'none' ? '' : createState();
    const pkce = login.pkce ? createPkcePair() : { verifier: '', challenge: '' };
    const options = resolveCallbackOptions(login.callback || {}, env);
    const session = remember({
        providerId,
        kind: 'oauth-code',
        login,
        state,
        verifier: pkce.verifier,
        redirectUri: options.redirectUri,
        callback: options,
        locale,
        keyStore,
        doFetch,
        env,
    });
    // Manual-only policies never bind a listener: the browser has no way back
    // to this process, so the code arrives through the paste box instead.
    let reason = options.reason;
    if (!reason) {
        const { servers, error } = await listenForCode(session, { sessions, finishWithCode, disposeSession });
        if (servers.length) {
            session.servers = servers;
        } else {
            // A held port must not leave the UI advertising a redirect URI
            // nobody is listening on; the flow stays usable by falling back to
            // paste instead of failing the sign-in.
            reason = 'bind';
            session.bindError = error;
        }
    }
    let url;
    try {
        url = buildAuthorizeUrl(login, { state, challenge: pkce.challenge, redirectUri: options.redirectUri, env });
    } catch (error) {
        // A refused authorize URL (e.g. the client id was never configured)
        // must not leave the listener holding the port for the next attempt.
        disposeSession(session.id, session);
        throw error;
    }
    return {
        id: session.id,
        kind: 'oauth-code',
        url,
        redirectUri: options.redirectUri,
        manual: Boolean(reason),
        instructions: composeInstructions(login.instructions, reason ? manualHint(reason, options, session.bindError) : ''),
    };
}

/**
 * Start a device authorization grant and poll it in the background.
 * @param {string} providerId
 * @param {object} login compiled login policy
 * @param {{keyStore:any, env:Record<string,string|undefined>, doFetch:typeof fetch}} deps
 * @returns {Promise<{id:string, kind:string, url:string, userCode:string, instructions:string}>}
 */
async function startDeviceCode(providerId, login, { keyStore, env, doFetch }) {
    const grant = await startDeviceAuthorization(login, { env }, doFetch);
    const session = remember({
        providerId,
        kind: 'device-code',
        login,
        grant: { ...grant, provider: providerId },
        keyStore,
        doFetch,
        env,
    });
    session.controller = new AbortController();
    completeInBackground(session, pollDeviceToken(login, session.grant, { signal: session.controller.signal, env }, doFetch), credentialTarget(login, providerId), keyStore);
    return {
        id: session.id,
        kind: 'device-code',
        url: grant.verificationUriComplete || grant.verificationUri,
        userCode: grant.userCode,
        instructions: fillTemplate(login.instructions || '', { user_code: grant.userCode, verification_uri: grant.verificationUri }),
    };
}

/**
 * Start a provider-specific `custom` hook.
 * @param {string} providerId
 * @param {object} login compiled login policy
 * @param {{keyStore:any, env:Record<string,string|undefined>, doFetch:typeof fetch, locale:'en'|'zh-cn'}} deps
 * @returns {Promise<{id:string, kind:string, url:string, userCode:string, instructions:string}>}
 */
async function startCustomHook(providerId, login, { keyStore, env, doFetch, locale }) {
    const hookName = String(login.hook || '');
    const hook = CUSTOM_HOOKS.get(hookName);
    if (!hook) {
        throw new Error(`This login needs a provider hook OMTP does not ship: ${hookName || 'unknown'}`);
    }
    const controller = new AbortController();
    const started = await hook({ providerId, login, env, doFetch, signal: controller.signal });
    const session = remember({
        providerId,
        kind: 'custom',
        hook: hookName,
        login,
        keyStore,
        doFetch,
        env,
        locale,
    });
    session.controller = controller;
    completeInBackground(
        session,
        started.waitForCompletion({ signal: controller.signal }).then((credential) => ({ credential })),
        credentialTarget(login, providerId),
        keyStore,
    );
    return {
        id: session.id,
        kind: 'custom',
        url: started.url,
        userCode: started.userCode,
        instructions: started.instructions || '',
    };
}

/**
 * Start a login flow for one provider.
 *
 * @param {string} providerId
 * @param {object} login compiled policy (`provider.authLogin`)
 * @param {{keyStore:any, env?: Record<string,string|undefined>, doFetch?: typeof fetch, locale?: string}} deps
 * @returns {Promise<{id: string, kind: string, url?: string, userCode?: string, redirectUri?: string, manual?: boolean, instructions?: string}>}
 */
export async function startLogin(providerId, login, { keyStore, env = process.env, doFetch = fetch, locale } = {}) {
    if (!login?.kind) {
        throw new Error('This provider has no login flow');
    }
    const missingHook = missingLoginHook(login);
    if (missingHook) {
        throw new Error(`This login needs a provider hook OMTP does not ship: ${missingHook}`);
    }
    const uiLocale = pickLocale(locale, '');
    if (login.kind === 'oauth-code') {
        return startOauthCode(providerId, login, { keyStore, env, doFetch, locale: uiLocale });
    }
    if (login.kind === 'device-code') {
        return startDeviceCode(providerId, login, { keyStore, env, doFetch });
    }
    if (login.kind === 'custom') {
        return startCustomHook(providerId, login, { keyStore, env, doFetch, locale: uiLocale });
    }
    throw new Error(`Login kind "${login.kind}" needs provider-specific code; import the session from OMP instead`);
}

/**
 * Provider id a completed login writes to (`store-as` aliases share models).
 * @param {any} login
 * @param {string} providerId
 * @returns {string}
 */
function credentialTarget(login, providerId) {
    const target = String(login?.storeAs || '');
    return target || providerId;
}

/**
 * Serialize a credential for the key store: durable keys stay plain strings,
 * OAuth sessions become structured JSON.
 * @param {any} credential
 * @returns {string}
 */
function credentialToStore(credential) {
    if (credential?.type === 'api-key' && credential.access) {
        return String(credential.access);
    }
    return JSON.stringify(credential);
}

/**
 * Run the policy's after-exchange hook and persist the credential to the key
 * store before marking the session `done`.
 * @param {any} session
 * @param {object} credential
 * @param {unknown} raw
 * @param {string} target
 * @param {any} keyStore
 */
async function storeCredential(session, credential, raw, target, keyStore) {
    // Hooks enrich (recover identity, mint a durable key, resolve projects)
    // after the exchange and before storing, so the key store only ever holds
    // a usable credential.
    const enriched = await applyAfterExchange(session.login?.afterExchange, credential, {
        provider: session.providerId,
        phase: 'login',
        raw,
        fetch: session.doFetch,
        env: session.env,
        signal: session.controller?.signal,
    });
    await keyStore.setProviderConfig(target, { apiKey: credentialToStore(enriched) });
    session.credential = enriched;
    session.status = 'done';
}

/**
 * Persist a background login flow when it settles, recording any failure on
 * the session instead of throwing.
 * @param {any} session
 * @param {Promise<{credential: object, raw?: unknown}>} promise exchange result
 * @param {string} target provider id the credential is stored under
 * @param {any} keyStore
 */
function completeInBackground(session, promise, target, keyStore) {
    session.promise = promise
        .then(({ credential, raw }) => storeCredential(session, credential, raw, target, keyStore))
        .catch((error) => {
            if (session.status === 'pending') {
                session.status = 'error';
                session.error = String(error?.message || error);
            }
        });
}

/**
 * Complete an `oauth-code` session from a callback or a pasted value.
 * @param {any} session
 * @param {{code: string, state?: string}} input
 * @param {{requireState?: boolean}} [options] true for the loopback callback,
 *   where omitting `state` would defeat the CSRF binding
 */
async function finishWithCode(session, input, { requireState = false } = {}) {
    // A second callback hit (reload, prefetch) or a paste while the exchange
    // runs must share it: redeeming the same code twice fails upstream and
    // used to overwrite a stored login with an error.
    if (session.exchanging) return session.exchanging;
    if (session.status !== 'pending') return;
    // A missing state used to short-circuit this check entirely. Browser
    // callbacks must carry the exact state; a user pasting a bare code is an
    // explicit action and may omit it, but a *wrong* state is always rejected.
    const stateMismatch = session.state && input.state !== session.state;
    if (stateMismatch && (requireState || input.state !== undefined)) {
        session.status = 'error';
        session.error = 'State missing or mismatched — paste the full callback URL or restart the login';
        return;
    }
    session.exchanging = (async () => {
        try {
            const { credential, raw } = await exchangeCode(session.login, {
                code: input.code,
                // The session's own state: finishWithCode already rejected a
                // mismatch, and a bare pasted code carries none. Anthropic
                // rejects an empty `state` with "Invalid request format".
                state: session.state || '',
                verifier: session.verifier,
                redirectUri: session.redirectUri,
                provider: session.providerId,
                result: session.login.result || '',
            }, session.doFetch, session.env);
            await storeCredential(session, credential, raw, credentialTarget(session.login, session.providerId), session.keyStore);
        } catch (error) {
            session.status = 'error';
            session.error = String(error?.message || error);
        } finally {
            session.exchanging = null;
        }
    })();
    // The listener is closed by the caller: cancelling here would destroy the
    // connection the callback page is still being written to.
    return session.exchanging;
}

/**
 * @param {string} id
 * @returns {any|null}
 */
export function getSession(id) {
    sweep();
    return sessions.get(String(id || '')) || null;
}

/**
 * Feed a pasted code/redirect URL into a pending session.
 * @param {string} id
 * @param {string} raw
 */
export async function submitCode(id, raw) {
    const session = getSession(id);
    if (!session) throw new Error('Unknown or expired login session');
    if (session.kind !== 'oauth-code') throw new Error('This login does not accept a pasted code');
    if (session.status === 'done') return session;
    if (session.status === 'error') {
        // A failed exchange (proxy down, wrong code) must stay retryable: the
        // user pastes the callback URL again instead of restarting the flow.
        session.status = 'pending';
        session.error = '';
    }
    if (session.status !== 'pending') throw new Error(`Login is already ${session.status}`);
    await finishWithCode(session, parseAuthorizationInput(raw));
    session.cancel?.();
    return session;
}

/**
 * Cancel and forget a session.
 * @param {string} id
 */
export function cancelLogin(id) {
    const session = getSession(id);
    if (!session) return false;
    disposeSession(String(id), session);
    return true;
}

/**
 * Public view of a session (never leaks tokens).
 * @param {any} session
 */
export function describeSession(session) {
    if (!session) return { status: 'unknown' };
    const credential = session.credential;
    return {
        status: session.status,
        kind: session.kind,
        provider: session.providerId,
        error: session.error || null,
        account: credential?.email || credential?.accountId || null,
    };
}
