/**
 * Loopback HTTP callback listener & transport resolution for `oauth-code` flows.
 */
import http from 'node:http';
import { callbackPage, pickLocale } from './callback-page.mjs';
import { isLoopbackHost } from './net-hosts.mjs';
import { policyValue } from './oauth-clients.mjs';
import { logError } from './redact.mjs';

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
 * @param {Record<string,string|undefined>} [env]
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
    if (!isLoopbackHost(parsed.hostname) || parsed.protocol === 'https:') {
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
 * Serve one callback request: exchange the code, then report the real outcome
 * on the page. A code-less hit is not the end of the flow — proxy/AV probes and
 * link previewers request the callback path, and closing the listener there
 * would strand the session before the browser arrives. Only a real outcome
 * releases the port.
 * @param {any} session
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(session: any, input: {code: string, state?: string}, options?: {requireState?: boolean}) => Promise<any>} finishWithCode
 */
async function handleCallback(session, req, res, finishWithCode) {
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
 * @param {(session: any, input: {code: string, state?: string}, options?: {requireState?: boolean}) => Promise<any>} finishWithCode
 * @returns {import('node:http').Server}
 */
function createCallbackServer(session, finishWithCode) {
    return http.createServer((req, res) => {
        handleCallback(session, req, res, finishWithCode).catch((error) => {
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
 * Bind loopback listeners that complete the session when the browser hits the
 * callback URL. Every loopback address for the host is bound (see
 * `bindAddresses()`); the flow needs only one to succeed. A total bind failure
 * is reported to the caller, which degrades the flow to manual paste instead of
 * advertising a dead redirect URI.
 * @param {any} session
 * @param {{
 *   sessions: Map<string, any>,
 *   finishWithCode: (session: any, input: {code: string, state?: string}, options?: {requireState?: boolean}) => Promise<any>,
 *   disposeSession: (id: string, session: any) => void,
 * }} deps
 * @returns {Promise<{servers: http.Server[], error: string}>}
 */
export async function listenForCode(session, { sessions, finishWithCode, disposeSession }) {
    const { hosts, port } = session.callback;
    session.port = port;
    // One listener per port: a stale session from an abandoned flow would
    // otherwise keep the port and serve the new flow's callback with the old
    // locale/state.
    for (const [id, other] of sessions) {
        if (other !== session && other.port === port && other.cancel) {
            disposeSession(id, other);
        }
    }
    const servers = [];
    let lastError = '';
    let conflict = '';
    for (const host of hosts) {
        const server = createCallbackServer(session, finishWithCode);
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
