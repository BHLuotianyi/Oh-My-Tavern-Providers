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
import http from 'node:http';
import crypto from 'node:crypto';
import { logError } from './redact.mjs';
import { applyAfterExchange } from './after-exchange.mjs';
import { HOOKS as CODEX_HOOKS } from './custom-logins/openai-codex-device.mjs';
import { HOOKS as KILO_HOOKS } from './custom-logins/kilo.mjs';
import { policyValue } from './oauth-clients.mjs';
import { describeFetchFailure } from './proxy-fetch.mjs';

/** Policy-value resolution lives with the credential helpers. */
export { policyValue };

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
        mismatch: 'This callback does not belong to the current sign-in; SillyTavern is still waiting for it.',
        manual: 'If SillyTavern did not switch to signed in by itself, copy the address below, paste it into the input box in SillyTavern and click Submit.',
        copy: 'Copy',
        copied: 'Copied',
    },
    'zh-cn': {
        title: 'OMTP 登录',
        done: '登录成功，可以关闭此页面并返回 SillyTavern。',
        failed: '登录失败，可以关闭此页面并在 SillyTavern 中重试。',
        missing: '服务商没有返回授权码。',
        mismatch: '此回调不属于当前登录请求，SillyTavern 仍在等待登录完成。',
        manual: '如果此时酒馆页面没有自动成功，请复制以下内容到输入框并点击提交。',
        copy: '复制',
        copied: '已复制',
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
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Minimal standalone page for the callback.
 * @param {'done'|'failed'|'missing'|'mismatch'} outcome
 * @param {string} locale
 * @param {string} [requestUrl] full callback URL, for the manual paste fallback
 */
function callbackPage(outcome, locale, requestUrl = '') {
    const text = CALLBACK_TEXT[locale] || CALLBACK_TEXT.en;
    const message = text[outcome];
    const accent = outcome === 'done' ? '#3ba55d' : '#e05252';
    const manual = requestUrl ? `
<p class="hint">${text.manual}</p>
<input id="cb-url" readonly value="${escapeHtml(requestUrl)}" spellcheck="false">
<button id="cb-copy" type="button">${text.copy}</button>
<script>
document.getElementById('cb-copy').addEventListener('click', async () => {
    const field = document.getElementById('cb-url');
    field.select();
    try { await navigator.clipboard.writeText(field.value); } catch { document.execCommand('copy'); }
    const button = document.getElementById('cb-copy');
    button.textContent = ${JSON.stringify(text.copied)};
});
</script>` : '';
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
.hint{margin:1.25rem 0 .5rem;font-size:.9rem;color:#b9b8c6}
input{width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #3a3948;border-radius:8px;background:#12111a;color:#e6e6ef;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
button{margin-top:.6rem;padding:.45rem .9rem;border:1px solid #3a3948;border-radius:8px;background:#262533;color:#e6e6ef;font:inherit;font-size:.85rem;cursor:pointer}
</style>
</head>
<body>
<div class="card">
<div class="badge">OMTP</div>
<p>${message}</p>${manual}
</div>
</body>
</html>`;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

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
    const base = policyValue(login?.authorizeUrl, env);
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
    let response;
    try {
        response = await doFetch(url, init);
    } catch (error) {
        // Undici reports every network problem as a bare `fetch failed`; show
        // the underlying cause (ECONNREFUSED, ENOTFOUND, proxy refused, …).
        throw new Error(`Token exchange request failed: ${describeFetchFailure(error)}`);
    }
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${describeTokenError(response.status, json, text)}`);
    }
    return json ?? {};
}

/**
 * Exchange an authorization code.
 *
 * @param {object} login
 * @param {{code: string, state?: string, verifier?: string, redirectUri: string, provider?: string}} options
 * @returns {Promise<{credential: object, raw: unknown}>} structured credential and the token response body
 */
async function exchangeCode(login, { code, state = '', verifier, redirectUri, provider = '', result = '' }, doFetch = fetch, env = process.env) {
    const params = { code, grant_type: 'authorization_code' };
    if (login.pkce && verifier) params.code_verifier = verifier;
    const body = tokenRequestBody(login, params, redirectUri, env, state);
    const token = await postToken(policyValue(login.token?.url), body, login.token?.body || 'json', login.token?.headers || {}, doFetch);
    return { credential: mapCredential(login.credential, token, { provider, result }), raw: token };
}

/**
 * Start a device authorization grant.
 *
 * @param {object} login
 * @param {{provider?: string, env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUri: string, verificationUriComplete?: string, interval: number, expiresIn: number}>}
 */
async function startDeviceAuthorization(login, { env = process.env } = {}, doFetch = fetch) {
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
 * @returns {Promise<{credential: object, raw: unknown}>} structured credential and the token response body
 */
async function pollDeviceToken(login, grant, { signal, env = process.env } = {}, doFetch = fetch) {
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
        }, '', env);
        try {
            const token = await postToken(url, body, login.token?.body || 'form', login.token?.headers || {}, doFetch);
            return {
                credential: mapCredential(login.credential, token, { provider: grant.provider || '', result: login.result || '' }),
                raw: token,
            };
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
            // Device-code/custom sessions poll in the background; aborting only
            // the oauth-code listener would let an abandoned poll complete and
            // silently write a credential.
            session.controller?.abort();
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

/** Hosts that resolve to this machine's loopback interface. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Drop the brackets `new URL()` keeps around an IPv6 literal. */
function bareHostname(host) {
    return String(host || '').replace(/^\[/, '').replace(/\]$/, '');
}

/** Format a bare host for use inside a URL (IPv6 literals need brackets). */
function urlHost(host) {
    const bare = bareHostname(host);
    return bare.includes(':') ? `[${bare}]` : bare;
}

/**
 * Addresses to bind for a loopback callback.
 *
 * `server.listen(port, 'localhost')` binds only the first address
 * `dns.lookup` returns, so on a host whose `/etc/hosts` lists `::1` first the
 * IPv4 loopback is refused. A client that tries the other family — a browser
 * without IPv6, a proxy that dials `127.0.0.1`, a webview — then never
 * delivers the code. Bind every loopback address and keep the first that
 * works.
 *
 * @param {string} hostname
 * @returns {string[]}
 */
function bindAddresses(hostname) {
    const host = bareHostname(hostname || 'localhost');
    return host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
}

/**
 * Resolve the callback transport for one `oauth-code` policy.
 *
 * The catalog may declare its own redirect URI (`callback.redirectUri`, e.g.
 * GitLab Duo's `GITLAB_REDIRECT_URI` override or Codex's fixed
 * `http://localhost:1455/auth/callback`). A declared URI is advertised
 * verbatim and never moved to another port: the provider validates it against
 * a registered callback, so a random port would be rejected after the user
 * already granted consent.
 *
 * Only an HTTP loopback URI can be served by our listener. A custom scheme
 * (`zcode://`, `vscode://`) belongs to an OS handler this plugin does not
 * install, and a remote HTTP callback never reaches this process, so those
 * flows collect the code by pasting it back instead.
 *
 * @param {any} callback compiled `login.callback`
 * @param {Record<string,string|undefined>} env
 * @returns {{redirectUri:string, baseUrl:string, hostname:string, hosts:string[], port:number, path:string, reason:''|'manual'|'native'|'scheme'|'remote'|'invalid'}}
 */
export function resolveCallbackOptions(callback = {}, env = process.env) {
    const hostname = bareHostname(callback.hostname || 'localhost');
    const path = callback.path || '/callback';
    const port = Number(callback.port) || 54545;
    const baseUrl = `http://${urlHost(hostname)}:${port}`;
    const local = { redirectUri: `${baseUrl}${path}`, baseUrl, hostname, hosts: bindAddresses(hostname), port, path, reason: '' };
    const declared = String(policyValue(callback.redirectUri, env) || '').trim();
    if (!declared) {
        if (callback.nativeScheme) return { ...local, reason: 'native' };
        return callback.manualOnly ? { ...local, reason: 'manual' } : local;
    }
    /** A declared URI this process cannot serve: advertise it, collect the code by paste. */
    const pasteOnly = (reason) => ({ redirectUri: declared, baseUrl: local.baseUrl, hostname, hosts: [], port, path, reason });
    let parsed;
    try {
        parsed = new URL(declared);
    } catch {
        return { ...local, redirectUri: declared, reason: 'invalid' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        // `nativeScheme` says the policy expected an OS-registered handler;
        // spell out that this plugin has none.
        return pasteOnly(callback.nativeScheme ? 'native' : 'scheme');
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname) || parsed.protocol === 'https:') {
        return pasteOnly('remote');
    }
    return {
        redirectUri: declared,
        // The declared origin keeps the provider's host form (including IPv6
        // brackets), so the paste URL and the page URL stay byte-identical.
        baseUrl: parsed.origin,
        hostname: bareHostname(parsed.hostname),
        hosts: bindAddresses(parsed.hostname),
        port: parsed.port ? Number.parseInt(parsed.port, 10) : 80,
        path: parsed.pathname || path,
        reason: callback.manualOnly ? 'manual' : '',
    };
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
        const { servers, error } = await listenForCode(session);
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
        session.cancel?.();
        sessions.delete(session.id);
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
 * @param {{keyStore:any, env?: Record<string,string|undefined>, doFetch?: typeof fetch}} deps
 * @returns {Promise<{id: string, kind: string, url?: string, userCode?: string, redirectUri?: string, manual?: boolean, instructions?: string}>}
 */
export async function startLogin(providerId, login, { keyStore, env = process.env, doFetch = fetch, locale } = {}) {
    if (!login?.kind) {
        throw new Error('This provider has no login flow');
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
 * Serve one callback request: exchange the code, then report the real outcome
 * on the page. A code-less hit is not the end of the flow — proxy/AV probes and
 * link previewers request the callback path, and closing the listener there
 * would strand the session before the browser arrives. Only a real outcome
 * releases the port.
 * @param {any} session
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleCallback(session, req, res) {
    const { path, baseUrl } = session.callback;
    // `req.url` is an absolute-form target when a proxy forwards the request
    // (`GET http://localhost:54545/callback?…`). Resolving it against the
    // callback origin keeps path matching working and keeps the pasted URL a
    // single, valid URL instead of `http://host:porthttp://…`.
    const url = new URL(req.url || '/', baseUrl);
    if (url.pathname !== path) {
        res.writeHead(404).end('Not found');
        return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const locale = pickLocale(session.locale, req.headers['accept-language']);
    // The page must reflect the real outcome: it used to claim success before
    // the token exchange ran, so a proxy failure looked like a completed
    // sign-in that never reached SillyTavern.
    const callbackUrl = url.href;
    const page = (outcome, status) => {
        if (outcome !== 'missing') {
            res.once('finish', () => session.cancel?.());
        }
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage(outcome, locale, callbackUrl));
    };
    // A callback that does not carry this session's state is not the
    // provider's redirect for it (another page, a stale tab): answer without
    // touching the session or releasing the port, or any page could abort an
    // in-progress sign-in with `?error=…`.
    if (session.state && state !== session.state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage('mismatch', locale, callbackUrl));
        return;
    }
    if (error) {
        session.status = 'error';
        session.error = url.searchParams.get('error_description') || error;
        page('failed', 400);
        return;
    }
    if (!code) {
        page('missing', 400);
        return;
    }
    /** @type {NodeJS.Timeout|undefined} */
    let guard;
    await Promise.race([
        finishWithCode(session, { code, state }, { requireState: true }).catch((err) => logError('callback exchange failed', err)),
        // A tunneled POST may spend up to 30 s in CONNECT alone (see
        // `openTunnel`), so the page has to outwait that before it reports a
        // failure the session does not share.
        new Promise((resolve) => { guard = setTimeout(resolve, 60_000); guard.unref?.(); }),
    ]);
    clearTimeout(guard);
    if (session.status === 'done') {
        page('done', 200);
    } else {
        page('failed', 400);
    }
}

/**
 * Callback listener for one bound address. A rejected handler logs and drops
 * the socket; the browser is already gone.
 * @param {any} session
 * @returns {import('node:http').Server}
 */
function createCallbackServer(session) {
    return http.createServer((req, res) => {
        handleCallback(session, req, res).catch((error) => {
            logError('callback handler failed', error);
            try {
                res.destroy();
            } catch {
                // the client is already gone
            }
        });
    });
}

/**
 * Bind loopback listeners that complete the session when the browser hits the
 * callback URL. Every loopback address for the host is bound (see
 * `bindAddresses()`); the flow needs only one to succeed. A total bind failure
 * is reported to the caller, which degrades the flow to manual paste instead of
 * advertising a dead redirect URI.
 * @param {any} session
 * @returns {Promise<{servers: http.Server[], error: string}>}
 */
async function listenForCode(session) {
    const { hosts, port } = session.callback;
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
    const servers = [];
    let lastError = '';
    let conflict = '';
    for (const host of hosts) {
        const server = createCallbackServer(session);
        const error = await bind(server, port, host);
        if (!error) {
            servers.push(server);
            continue;
        }
        // A missing family (IPv6 disabled, address not configured) is fine as
        // long as another address answered. A port already held by another
        // process is not: the advertised `localhost` may resolve to that
        // process, so the flow degrades to paste instead of serving the wrong
        // service.
        if (/EADDRINUSE/.test(error)) conflict = conflict || error;
        else lastError = error;
        closeServers([server]);
    }
    if (!servers.length || conflict) {
        closeServers(servers);
        return { servers: [], error: conflict || lastError };
    }
    session.cancel = () => closeServers(servers);
    return { servers, error: '' };
}

/**
 * Close every bound listener and drop its keep-alive sockets so the port is
 * free for the next flow.
 * @param {http.Server[]} servers
 */
function closeServers(servers) {
    for (const server of servers) {
        try {
            server.close();
            // Keep-alive sockets keep the port bound; drop them so the next
            // flow can bind immediately.
            server.closeAllConnections?.();
        } catch {
            // ignore
        }
    }
}

/**
 * Listen on one address and report the failure instead of throwing.
 * @param {http.Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<string>} empty on success, an error code/message otherwise
 */
function bind(server, port, host) {
    return new Promise((resolve) => {
        /** Resolve once and detach both listeners. */
        const settle = (value) => {
            server.removeListener('error', onError);
            server.removeListener('listening', onListening);
            resolve(value);
        };
        const onError = (error) => settle(error?.code || error?.message || String(error));
        const onListening = () => settle('');
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(port, host);
        } catch (error) {
            // `listen` rejects some inputs synchronously (out-of-range port,
            // unresolvable host); treat those like an unavailable port.
            settle(error?.code || error?.message || String(error));
        }
    });
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
 * Run the policy's after-exchange hook and persist the credential when a
 * background flow settles, recording the failure on the session instead of
 * throwing.
 * @param {any} session
 * @param {Promise<{credential: object, raw?: unknown}>} promise exchange result
 * @param {string} target provider id the credential is stored under
 * @param {any} keyStore
 */
function completeInBackground(session, promise, target, keyStore) {
    session.promise = promise
        .then(async ({ credential, raw }) => {
            // Hooks enrich (mint keys, resolve projects) after the exchange and
            // before storing, so the key store only ever holds a usable one.
            const enriched = await applyAfterExchange(session.login?.afterExchange, credential, {
                provider: session.providerId,
                phase: 'login',
                raw,
                fetch: session.doFetch,
                env: session.env,
            });
            await keyStore.setProviderConfig(target, { apiKey: credentialToStore(enriched) });
            session.credential = enriched;
            session.status = 'done';
        })
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
            // Hooks enrich (recover identity, mint a durable key) after the exchange
            // and before storing, so the key store only ever holds a usable one.
            const enriched = await applyAfterExchange(session.login.afterExchange, credential, {
                provider: session.providerId,
                phase: 'login',
                raw,
                fetch: session.doFetch,
                env: session.env,
            });
            await session.keyStore.setProviderConfig(credentialTarget(session.login, session.providerId), {
                apiKey: credentialToStore(enriched),
            });
            session.credential = enriched;
            session.status = 'done';
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
