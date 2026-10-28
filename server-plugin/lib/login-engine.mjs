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
 * Providers whose policy uses a `custom` login (Cursor, Copilot, Devin, …)
 * need per-provider code. The ones we have ported live in `custom-logins/`
 * and register themselves below; everything else is reported as
 * `loginNeedsHook` and can still be imported from OMP.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { logError } from './redact.mjs';
import { HOOKS as CODEX_HOOKS } from './custom-logins/openai-codex-device.mjs';
import { HOOKS as KILO_HOOKS } from './custom-logins/kilo.mjs';

/** Sessions live for this long before they are garbage-collected. */
const SESSION_TTL_MS = 10 * 60_000;
/** Device-code polling safety margin (seconds added to the server interval). */
const DEVICE_POLL_SLACK_S = 1;

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
 * Strings for the loopback callback page. The browser opens it directly, so
 * the locale comes from the client that started the session (falling back to
 * `Accept-Language`), never from the server's own settings.
 */
const CALLBACK_TEXT = {
    en: {
        title: 'OMTP sign-in',
        done: 'Login complete. You can close this tab and return to SillyTavern.',
        failed: 'Login failed. You can close this tab and start again from SillyTavern.',
        missing: 'The provider did not return an authorization code.',
    },
    'zh-cn': {
        title: 'OMTP 登录',
        done: '登录成功，可以关闭此页面并返回 SillyTavern。',
        failed: '登录失败，可以关闭此页面并在 SillyTavern 中重试。',
        missing: '服务商没有返回授权码。',
    },
};

/**
 * Pick the closest supported locale.
 * @param {string|undefined} requested
 * @param {string|undefined} acceptLanguage
 * @returns {'en'|'zh-cn'}
 */
export function pickLocale(requested, acceptLanguage) {
    const candidates = [];
    if (requested) candidates.push(String(requested).toLowerCase());
    for (const part of String(acceptLanguage || '').toLowerCase().split(',')) {
        const tag = part.split(';')[0].trim();
        if (tag) candidates.push(tag);
    }
    for (const tag of candidates) {
        if (tag.startsWith('zh')) return 'zh-cn';
        if (tag.startsWith('en')) return 'en';
    }
    return 'en';
}

/**
 * Minimal standalone page for the callback.
 * @param {'done'|'failed'|'missing'} outcome
 * @param {string} locale
 */
function callbackPage(outcome, locale) {
    const text = CALLBACK_TEXT[locale] || CALLBACK_TEXT.en;
    const message = text[outcome];
    const accent = outcome === 'done' ? '#3ba55d' : '#e05252';
    return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#15141b;color:#e6e6ef;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:26rem;padding:2rem 2.25rem;border:1px solid #2c2b38;border-radius:14px;background:#1c1b24;box-shadow:0 12px 32px rgba(0,0,0,.35)}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:${accent};border:1px solid ${accent}}
p{margin:1rem 0 0}
</style>
</head>
<body>
<div class="card">
<div class="badge">OMTP</div>
<p>${message}</p>
</div>
</body>
</html>`;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * Resolve a policy value that may be a literal, a base64 blob or an env hook.
 * @param {{value?: string, encoding?: string, hook?: string}|string|undefined} field
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
            const fromEnv = env[name];
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

/** Replace `{name}` placeholders in a policy string. */
export function fillTemplate(text, vars) {
    return String(text).replace(/\{([a-z_]+)\}/gi, (match, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match
    ));
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
export function createState() {
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
    const base = policyValue(login?.authorizeUrl, env);
    if (!base) {
        throw new Error('This provider has no authorize URL');
    }
    const url = new URL(base);
    const clientId = policyValue(login.clientId, env);
    const standard = login.standardAuthorizeParams !== false;
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
 * Turn a pasted value into an authorization code. Accepts a bare code, a full
 * redirect URL, or `code=…&state=…`.
 * @param {string} raw
 * @returns {{code: string, state?: string}}
 */
export function parseAuthorizationInput(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('Paste the authorization code or the full redirect URL');
    }
    if (/^https?:\/\//i.test(text)) {
        const url = new URL(text);
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || undefined;
        if (!code) throw new Error('That URL has no `code` parameter');
        return { code, state };
    }
    const match = /(?:^|[?&])code=([^&]+)/.exec(text);
    if (match) {
        const stateMatch = /(?:^|[?&])state=([^&]+)/.exec(text);
        return { code: decodeURIComponent(match[1]), state: stateMatch ? decodeURIComponent(stateMatch[1]) : undefined };
    }
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
 * @param {{provider?: string, now?: number}} [options]
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
 */
function tokenRequestBody(login, params, redirectUri) {
    const standard = login.token?.standard !== false;
    /** @type {Record<string, string>} */
    const body = {};
    if (standard) {
        body.client_id = policyValue(login.clientId);
        if (redirectUri) body.redirect_uri = redirectUri;
        Object.assign(body, params);
        const secret = policyValue(login.clientSecret);
        if (secret) body.client_secret = secret;
    }
    const vars = {
        ...params,
        redirect_uri: redirectUri,
        client_id: policyValue(login.clientId),
        code: params.code || '',
        code_verifier: params.code_verifier || '',
        state: params.state || '',
    };
    for (const [key, value] of Object.entries(login.token?.params || {})) {
        body[key] = fillTemplate(String(value), vars);
    }
    return body;
}

/**
 * POST to a token endpoint.
 * @param {string} url
 * @param {Record<string, string>} body
 * @param {'json'|'form'} mode
 * @param {Record<string,string>} headers
 * @param {typeof fetch} doFetch
 */
async function postToken(url, body, mode, headers, doFetch) {
    const init = { method: 'POST', headers: { Accept: 'application/json', ...headers } };
    if (mode === 'form') {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(body).toString();
    } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const response = await doFetch(url, init);
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (!response.ok) {
        const message = json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${response.status}`;
        throw new Error(`Token exchange failed: ${message}`);
    }
    return json ?? {};
}

/**
 * Exchange an authorization code.
 *
 * @param {object} login
 * @param {{code: string, verifier?: string, redirectUri: string, provider?: string}} options
 * @returns {Promise<object>} structured credential
 */
export async function exchangeCode(login, { code, verifier, redirectUri, provider = '', result = '' }, doFetch = fetch) {
    const params = { code, grant_type: 'authorization_code' };
    if (login.pkce && verifier) params.code_verifier = verifier;
    const body = tokenRequestBody(login, params, redirectUri);
    const token = await postToken(policyValue(login.token?.url), body, login.token?.body || 'json', login.token?.headers || {}, doFetch);
    return mapCredential(login.credential, token, { provider, result });
}

/**
 * Start a device authorization grant.
 *
 * @param {object} login
 * @param {{provider?: string, env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUri: string, verificationUriComplete?: string, interval: number, expiresIn: number}>}
 */
export async function startDeviceAuthorization(login, { env = process.env } = {}, doFetch = fetch) {
    const device = login.device;
    if (!device?.url) {
        throw new Error('This provider does not expose a device authorization endpoint');
    }
    const base = policyValue(login.baseUrl, env);
    const url = policyValue(device.url, env).replace('{base}', base);
    const body = { client_id: policyValue(login.clientId, env) };
    for (const [key, value] of Object.entries(device.params || {})) {
        body[key] = String(value);
    }
    const response = await postToken(url, body, device.body || 'form', device.headers || {}, doFetch);
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
 * Poll the token endpoint until the device grant completes.
 *
 * @param {object} login
 * @param {{deviceCode: string, interval: number, expiresIn: number, provider?: string}} grant
 * @param {{signal?: AbortSignal, env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<object>} structured credential
 */
export async function pollDeviceToken(login, grant, { signal, env = process.env } = {}, doFetch = fetch) {
    const deadline = Date.now() + grant.expiresIn * 1000;
    let interval = Math.max(1, grant.interval) + DEVICE_POLL_SLACK_S;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new Error('Login canceled');
        }
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        if (signal?.aborted) {
            throw new Error('Login canceled');
        }
        const base = policyValue(login.baseUrl, env);
        const url = policyValue(login.token?.url, env).replace('{base}', base);
        const body = tokenRequestBody(login, {
            device_code: grant.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }, '');
        try {
            const token = await postToken(url, body, login.token?.body || 'form', login.token?.headers || {}, doFetch);
            return mapCredential(login.credential, token, { provider: grant.provider || '', result: login.result || '' });
        } catch (error) {
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

function sweep() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.startedAt > SESSION_TTL_MS) {
            session.cancel?.();
            sessions.delete(id);
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
    sessions.set(id, { ...session, id, startedAt: Date.now(), status: 'pending' });
    return sessions.get(id);
}

/**
 * Start a login flow for one provider.
 *
 * @param {string} providerId
 * @param {object} login compiled policy (`provider.authLogin`)
 * @param {{keyStore:any, env?: Record<string,string|undefined>, doFetch?: typeof fetch}} deps
 * @returns {Promise<{id: string, kind: string, url?: string, userCode?: string, redirectUri?: string, instructions?: string}>}
 */
export async function startLogin(providerId, login, { keyStore, env = process.env, doFetch = fetch, locale } = {}) {
    if (!login?.kind) {
        throw new Error('This provider has no login flow');
    }
    const uiLocale = pickLocale(locale, '');
    if (login.kind === 'oauth-code') {
        const state = createState();
        const pkce = login.pkce ? createPkcePair() : { verifier: '', challenge: '' };
        const callback = login.callback || {};
        const redirectUri = `http://${callback.hostname || 'localhost'}:${callback.port || 54545}${callback.path || '/callback'}`;
        const session = remember({
            providerId,
            kind: 'oauth-code',
            login,
            state,
            verifier: pkce.verifier,
            redirectUri,
            locale: uiLocale,
            keyStore,
            doFetch,
            env,
        });
        session.server = await listenForCode(session);
        const url = buildAuthorizeUrl(login, { state, challenge: pkce.challenge, redirectUri, env });
        return { id: session.id, kind: 'oauth-code', url, redirectUri, instructions: login.instructions || '' };
    }

    if (login.kind === 'device-code') {
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
        session.promise = pollDeviceToken(login, session.grant, { signal: session.controller.signal, env }, doFetch)
            .then(async (credential) => {
                await keyStore.setProviderConfig(credentialTarget(login, providerId), { apiKey: credentialToStore(credential) });
                session.status = 'done';
                session.credential = credential;
            })
            .catch((error) => {
                if (session.status === 'pending') {
                    session.status = 'error';
                    session.error = String(error?.message || error);
                }
            });
        return {
            id: session.id,
            kind: 'device-code',
            url: grant.verificationUriComplete || grant.verificationUri,
            userCode: grant.userCode,
            instructions: fillTemplate(login.instructions || '', { user_code: grant.userCode, verification_uri: grant.verificationUri }),
        };
    }

    if (login.kind === 'custom') {
        const hookName = String(login.hook || '');
        const hook = CUSTOM_HOOKS.get(hookName);
        if (!hook) {
            throw new Error(`Login hook "${hookName || 'unknown'}" needs provider-specific code; sign in with omp and import the credential`);
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
            locale: uiLocale,
        });
        session.controller = controller;
        session.promise = started.waitForCompletion({ signal: controller.signal })
            .then(async (credential) => {
                await keyStore.setProviderConfig(credentialTarget(login, providerId), { apiKey: credentialToStore(credential) });
                session.credential = credential;
                session.status = 'done';
            })
            .catch((error) => {
                if (session.status === 'pending') {
                    session.status = 'error';
                    session.error = String(error?.message || error);
                }
            });
        return {
            id: session.id,
            kind: 'device-code',
            url: started.url,
            userCode: started.userCode,
            instructions: started.instructions || '',
        };
    }

    throw new Error(`Login kind "${login.kind}" needs provider-specific code; import the session from OMP instead`);
}

/**
 * Bind a loopback listener that completes the session when the browser hits the
 * callback URL. Falls back to manual paste when the port is taken.
 * @param {any} session
 * @returns {Promise<http.Server|null>}
 */
async function listenForCode(session) {
    const { callback = {} } = session.login;
    const port = Number(callback.port) || 54545;
    session.port = port;
    // One listener per port: a stale session from an abandoned flow would
    // otherwise keep the port and serve the new flow's callback with the old
    // locale/state.
    for (const [id, other] of sessions) {
        if (other !== session && other.port === port && other.cancel) {
            other.cancel();
            sessions.delete(id);
        }
    }
    const path = callback.path || '/callback';
    const hostname = callback.hostname || 'localhost';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://${hostname}:${port}`);
        if (url.pathname !== path) {
            res.writeHead(404).end('Not found');
            return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const locale = pickLocale(session.locale, req.headers['accept-language']);
        if (error) {
            session.status = 'error';
            session.error = url.searchParams.get('error_description') || error;
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(callbackPage('failed', locale));
            session.cancel?.();
            return;
        }
        if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(callbackPage('missing', locale));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage('done', locale));
        finishWithCode(session, { code, state }).catch((err) => logError('callback exchange failed', err));
    });
    return new Promise((resolve) => {
        server.once('error', (error) => {
            logError(`callback listener on ${port} failed`, error);
            resolve(null);
        });
        server.listen(port, hostname, () => {
            session.cancel = () => {
                try {
                    server.close();
                    // Keep-alive sockets keep the port bound; drop them so the
                    // next flow can bind immediately.
                    server.closeAllConnections?.();
                } catch {
                    // ignore
                }
            };
            resolve(server);
        });
    });
}

/**
 * Complete an `oauth-code` session from a callback or a pasted value.
 * @param {any} session
 * @param {{code: string, state?: string}} input
 */
/**
 * Provider id a completed login writes to (`store-as` aliases share models).
 * @param {any} login
 * @param {string} providerId
 */
function credentialTarget(login, providerId) {
    const target = String(login?.storeAs || '');
    return target || providerId;
}

function credentialToStore(credential) {
    if (credential?.type === 'api-key' && credential.access) {
        return String(credential.access);
    }
    return JSON.stringify(credential);
}

async function finishWithCode(session, input) {
    if (session.status !== 'pending') return;
    if (session.state && input.state && input.state !== session.state) {
        session.status = 'error';
        session.error = 'State mismatch — restart the login';
        return;
    }
    try {
        const credential = await exchangeCode(session.login, {
            code: input.code,
            verifier: session.verifier,
            redirectUri: session.redirectUri,
            provider: session.providerId,
            result: session.login.result || '',
        }, session.doFetch);
        await session.keyStore.setProviderConfig(credentialTarget(session.login, session.providerId), {
            apiKey: credentialToStore(credential),
        });
        session.credential = credential;
        session.status = 'done';
    } catch (error) {
        session.status = 'error';
        session.error = String(error?.message || error);
    } finally {
        session.cancel?.();
    }
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
    if (session.status !== 'pending') throw new Error(`Login is already ${session.status}`);
    if (session.kind !== 'oauth-code') throw new Error('This login does not accept a pasted code');
    await finishWithCode(session, parseAuthorizationInput(raw));
    return session;
}

/**
 * Cancel and forget a session.
 * @param {string} id
 */
export function cancelLogin(id) {
    const session = getSession(id);
    if (!session) return false;
    session.controller?.abort();
    session.cancel?.();
    sessions.delete(String(id));
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
