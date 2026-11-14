/**
 * Proxy support for outbound HTTP.
 *
 * Node's global `fetch` ignores `HTTPS_PROXY`/`HTTP_PROXY` and the OS proxy, so
 * behind Clash/v2ray every call dies as a bare `fetch failed`. This module wraps
 * the global fetch once, routing only the requests that need it through an HTTP
 * CONNECT or SOCKS5 tunnel, and falling back to the original fetch when the
 * tunnel cannot be established — a stale proxy variable must never break a
 * machine whose VPN works at the network layer (TUN/transparent hijack). Once
 * request bytes have been handed to the tunnel, a failure is rethrown instead:
 * replaying the call directly could bill a chat completion twice.
 *
 * The OS proxy is re-read while the plugin runs (cached briefly), so turning on
 * Clash's "system proxy" after SillyTavern started takes effect without a restart.
 */

import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';

import { log, logError } from './redact.mjs';
import { isPrivateHost } from './net-hosts.mjs';

/** @type {WeakSet<object>} */
const wrapped = new WeakSet();

/** Present on tunnel failures that happened after the request was written. */
const REQUEST_SENT = Symbol('proxyFetch.requestSent');

/** On a direct-connection error that followed a failed proxy attempt. */
const PROXY_FAILURE = Symbol('proxyFetch.proxyFailure');

/** Proxy schemes we can drive. */
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:']);
const PROXY_PROTOCOLS = new Set(['http:', 'https:', ...SOCKS_PROTOCOLS]);

/** How long a read of the OS proxy settings stays valid. */
const SYSTEM_PROXY_TTL_MS = 10_000;
/** Longest a request waits for a fresh read before using the previous one. */
const SYSTEM_PROXY_WAIT_MS = 1_500;
const TLS_HANDSHAKE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 300_000;
const DIAGNOSTIC_TIMEOUT_MS = 8_000;

/** A URL every proxy rule applies to; used to describe the current route. */
const PROBE_TARGET = new URL('https://example.com');

/**
 * Hosts the sign-in and chat paths depend on. Any HTTP answer, even an error
 * status, proves the route works.
 */
const DIAGNOSTIC_TARGETS = Object.freeze([
    'https://oauth2.googleapis.com/',
    'https://api.anthropic.com/',
    'https://auth.openai.com/',
    'https://api.github.com/',
]);

/** Routing chosen in the settings panel. */
const PROXY_MODES = new Set(['system', 'manual', 'direct']);

/** @typedef {{mode: 'system'|'manual'|'direct', url: string}} ProxySettings */

/** @type {ProxySettings} */
let settings = { mode: 'system', url: '' };

/**
 * The installed wrapper's view of its own routing; null while no wrapper is
 * installed (`OMTP_DISABLE_PROXY`, or Node handling the proxy itself).
 * @type {{route: () => Promise<{env: Record<string,string|undefined>, source: string}>,
 *         detected: () => {environment: string, system: string}, base: typeof fetch}|null}
 */
let installed = null;
/** Why no wrapper is installed, for the settings panel. */
let notInstalledReason = 'not-installed';

/** @type {Set<number>} */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * @param {string|undefined} value
 * @returns {string[]}
 */
function splitList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Pick the proxy for a target URL.
 *
 * @param {URL} target
 * @param {Record<string, string|undefined>} env
 * @returns {URL|null}
 */
export function proxyFor(target, env = process.env) {
    const noProxy = splitList(env.NO_PROXY || env.no_proxy);
    if (noProxy.includes('*')) return null;
    const host = target.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    const port = target.port || (target.protocol === 'https:' ? '443' : '80');
    for (const entry of noProxy) {
        let entryHost = entry;
        let entryPort = '';
        if (entryHost.startsWith('[')) {
            const close = entryHost.indexOf(']');
            if (close !== -1) {
                const rest = entryHost.slice(close + 1);
                entryHost = entryHost.slice(0, close);
                if (rest.length > 1 && rest.startsWith(':')) entryPort = rest.slice(1);
            }
        } else if ((entryHost.match(/:/g) || []).length === 1) {
            const colon = entryHost.indexOf(':');
            entryPort = entryHost.slice(colon + 1);
            entryHost = entryHost.slice(0, colon);
        }
        entryHost = entryHost
            .replace(/^\*\./, '')
            .replace(/^\./, '')
            .replace(/^\[/, '')
            .replace(/\]$/, '');
        if (!entryHost) continue;
        if (entryPort && entryPort !== port) continue;
        if (host === entryHost || host.endsWith(`.${entryHost}`)) return null;
    }
    // Loopback and private targets never need a proxy, and tunnelling them
    // through one breaks local services (Ollama, the gateway itself).
    if (isPrivateHost(host)) return null;

    const candidates = target.protocol === 'https:'
        ? [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy, env.HTTP_PROXY, env.http_proxy]
        : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
    for (const raw of candidates) {
        // CONNECT (HTTP/HTTPS) and SOCKS5 are supported; anything else
        // (SOCKS4) would burn a guaranteed failed attempt per host.
        const url = parseProxyUrl(raw);
        if (url) return url;
    }
    return null;
}

/**
 * Parse a proxy address the way people write it: `host:port`, a full URL, and
 * the quoted value `set HTTPS_PROXY="http://…"` leaves behind in cmd.exe.
 *
 * @param {unknown} raw
 * @returns {URL|null} null when empty, malformed or an unsupported scheme
 */
export function parseProxyUrl(raw) {
    const text = String(raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!text) return null;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
        return PROXY_PROTOCOLS.has(url.protocol) && url.hostname ? url : null;
    } catch {
        return null;
    }
}

/**
 * `URL.hostname` keeps the brackets of an IPv6 literal; `net`/`http` resolve
 * them as a DNS name and fail with ENOTFOUND.
 * @param {URL} proxy
 * @returns {string}
 */
function proxyHostname(proxy) {
    return proxy.hostname.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * A proxy as shown in logs and the settings panel: never its credentials.
 * @param {URL|null} proxy
 * @returns {string}
 */
function proxyLabel(proxy) {
    return proxy ? `${proxy.protocol}//${proxy.host}` : '';
}

/**
 * Open a CONNECT tunnel and return the raw socket.
 *
 * @param {URL} proxy
 * @param {string} host
 * @param {number} port
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<import('node:net').Socket>}
 */
function openTunnel(proxy, host, port, signal, timeoutMs = TLS_HANDSHAKE_TIMEOUT_MS) {
    if (SOCKS_PROTOCOLS.has(proxy.protocol)) return openSocksTunnel(proxy, host, port, signal, timeoutMs);
    return new Promise((resolve, reject) => {
        const secureProxy = proxy.protocol === 'https:';
        const headers = { host: `${host}:${port}` };
        if (proxy.username) {
            const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        const request = (secureProxy ? https : http).request({
            host: proxyHostname(proxy),
            port: Number(proxy.port) || (secureProxy ? 443 : 80),
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            signal,
            timeout: timeoutMs,
        });
        request.once('connect', (response, socket) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`proxy CONNECT ${host}:${port} -> HTTP ${response.statusCode}`));
                return;
            }
            resolve(socket);
        });
        request.once('timeout', () => request.destroy(new Error('proxy CONNECT timed out')));
        request.once('error', reject);
        request.end();
    });
}

/**
 * Open a SOCKS5 tunnel (RFC 1928, username/password per RFC 1929). The target
 * is always sent as a domain name so the proxy resolves it, which is what
 * Clash's fake-IP DNS and rule matching expect.
 *
 * @param {URL} proxy
 * @param {string} host
 * @param {number} port
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<import('node:net').Socket>}
 */
function openSocksTunnel(proxy, host, port, signal, timeoutMs = TLS_HANDSHAKE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(proxy.port) || 1080, proxyHostname(proxy));
        let buffer = Buffer.alloc(0);
        /** @type {((chunk: Buffer) => void)|null} */
        let waiter = null;
        let needed = 0;
        const fail = (error) => {
            cleanup();
            socket.destroy();
            reject(error);
        };
        const onAbort = () => fail(signal?.reason || new Error('aborted'));
        const cleanup = () => {
            socket.setTimeout(0);
            socket.removeListener('data', onData);
            socket.removeListener('error', fail);
            socket.removeListener('close', onClose);
            signal?.removeEventListener('abort', onAbort);
        };
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (waiter && buffer.length >= needed) {
                const take = waiter;
                waiter = null;
                const out = buffer.subarray(0, needed);
                buffer = buffer.subarray(needed);
                take(out);
            }
        };
        const onClose = () => fail(new Error('SOCKS proxy closed the connection'));
        /** @param {number} count */
        const read = (count) => new Promise((done) => {
            needed = count;
            waiter = done;
            onData(Buffer.alloc(0));
        });
        socket.on('data', onData);
        socket.once('error', fail);
        socket.once('close', onClose);
        socket.setTimeout(timeoutMs, () => fail(new Error('SOCKS proxy timed out')));
        signal?.addEventListener('abort', onAbort, { once: true });

        socket.once('connect', async () => {
            try {
                const user = proxy.username ? Buffer.from(decodeURIComponent(proxy.username)) : null;
                const pass = Buffer.from(decodeURIComponent(proxy.password || ''));
                socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
                const [version, method] = await read(2);
                if (version !== 5) throw new Error('not a SOCKS5 proxy');
                if (method === 2 && user) {
                    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
                    const [, status] = await read(2);
                    if (status !== 0) throw new Error('SOCKS proxy rejected the credentials');
                } else if (method !== 0) {
                    throw new Error('SOCKS proxy requires an unsupported authentication method');
                }
                const name = Buffer.from(host);
                socket.write(Buffer.concat([
                    Buffer.from([5, 1, 0, 3, name.length]),
                    name,
                    Buffer.from([port >> 8, port & 0xff]),
                ]));
                const [, reply, , type] = await read(4);
                if (reply !== 0) throw new Error(`SOCKS CONNECT ${host}:${port} -> code ${reply}`);
                const addressLength = type === 1 ? 4 : type === 4 ? 16 : (await read(1))[0];
                await read(addressLength + 2);
                cleanup();
                if (buffer.length) socket.unshift(buffer);
                resolve(socket);
            } catch (error) {
                fail(error);
            }
        });
    });
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isReplayableBody(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return true;
    if (value instanceof Uint8Array) return true;
    if (value instanceof URLSearchParams) return true;
    return false;
}

/**
 * @param {HeadersInit|undefined} init
 * @returns {Record<string,string>}
 */
function headerObject(init) {
    /** @type {Record<string,string>} */
    const out = {};
    if (!init) return out;
    if (typeof Headers !== 'undefined' && init instanceof Headers) {
        init.forEach((value, key) => { out[key] = value; });
        return out;
    }
    if (Array.isArray(init)) {
        for (const [key, value] of init) out[String(key).toLowerCase()] = String(value);
        return out;
    }
    for (const [key, value] of Object.entries(init)) {
        if (value === undefined || value === null) continue;
        out[key.toLowerCase()] = String(value);
    }
    return out;
}

/**
 * @param {string} encoding
 * @returns {import('node:stream').Transform|null}
 */
function decompressor(encoding) {
    switch (String(encoding || '').toLowerCase().trim()) {
        case 'gzip':
        case 'x-gzip':
            return zlib.createGunzip();
        case 'deflate':
            return zlib.createInflate();
        case 'br':
            return zlib.createBrotliDecompress();
        default:
            return null;
    }
}

/**
 * Convert a Node stream into a web ReadableStream without `Readable.toWeb`.
 *
 * Node 18's adapter closes its controller twice when a response body is
 * cancelled before the socket closes (redirect handling does exactly that),
 * surfacing as an uncaught `ERR_INVALID_STATE: Controller is already closed`.
 * Pulling from the async iterator gives backpressure and exactly one close
 * path on every supported Node version.
 *
 * @param {import('node:stream').Readable} source
 * @param {import('node:stream').Transform} [decoder] decompresses the source on the way out
 * @returns {ReadableStream<Uint8Array>}
 */
function nodeStreamToWeb(source, decoder) {
    const body = decoder ? source.pipe(decoder) : source;
    // `pipe` does not forward source failures, so a reset socket would leave
    // the decoder pending forever; destroy it with the error instead.
    if (decoder) source.on('error', (error) => decoder.destroy(error));
    // Keeps a late socket error from becoming an uncaught exception while no
    // pull is waiting; a pending pull still rejects through the iterator.
    body.on('error', () => {});
    const iterator = body[Symbol.asyncIterator]();
    let cancelled = false;
    return new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await iterator.next();
                // A pending pull can resolve after cancel(); touching the
                // controller then is exactly the double-close Node 18 trips on.
                if (cancelled) return;
                if (done) {
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                if (cancelled) return;
                cancelled = true;
                source.destroy();
                controller.error(error);
            }
        },
        async cancel() {
            cancelled = true;
            // Releasing the socket matters when the decoder is the piped stream.
            source.destroy();
            try {
                await iterator.return();
            } catch {
                // Socket already gone; nothing left to release.
            }
        },
    });
}

/**
 * Perform one request through the proxy.
 *
 * @param {URL} target
 * @param {URL} proxy
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function tunnelRequest(target, proxy, init, { handshakeTimeoutMs = TLS_HANDSHAKE_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const secure = target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const signal = init.signal || undefined;
    if (signal?.aborted) throw signal.reason || new Error('aborted');

    const tunnel = await openTunnel(proxy, target.hostname, port, signal, handshakeTimeoutMs);
    if (signal?.aborted) {
        tunnel.destroy();
        throw signal.reason || new Error('aborted');
    }
    let socket = tunnel;
    if (secure) {
        socket = tls.connect({ socket: tunnel, servername: target.hostname });
        await new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => {
                clearTimeout(timer);
                socket.off('secureConnect', onConnect);
                socket.off('error', onError);
                socket.off('close', onClose);
                signal?.removeEventListener('abort', onAbort);
            };
            const abortSocket = (reason) => {
                cleanup();
                // Keep a no-op error listener so destroying an active TLS
                // socket never surfaces an unhandled 'error' event.
                socket.on('error', () => {});
                socket.destroy();
                reject(reason);
            };
            const onConnect = () => {
                cleanup();
                resolve(undefined);
            };
            const onError = (error) => {
                abortSocket(error);
            };
            const onClose = () => {
                abortSocket(new Error('proxy TLS handshake closed'));
            };
            const onAbort = () => {
                abortSocket(signal?.reason || new Error('aborted'));
            };
            timer = setTimeout(() => {
                abortSocket(new Error('proxy TLS handshake timed out'));
            }, handshakeTimeoutMs);
            socket.once('secureConnect', onConnect);
            socket.once('error', onError);
            socket.once('close', onClose);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    const headers = headerObject(init.headers);
    // We decompress ourselves, so ask for a coding we understand; some servers
    // compress anyway and `decompressor` covers that.
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
    headers.connection = 'close';

    let body = init.body;
    if (body instanceof URLSearchParams) body = body.toString();
    if (body === null) body = undefined;
    if (body !== undefined && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
        headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    }

    // A one-shot agent hands the already-open socket to Node: the request must
    // never resolve the target hostname itself (only the proxy may do that).
    const agent = new (secure ? https.Agent : http.Agent)({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;

    const response = await new Promise((resolve, reject) => {
        const request = (secure ? https : http).request({
            host: target.hostname,
            port,
            path: `${target.pathname}${target.search}`,
            method: init.method || 'GET',
            headers,
            signal,
            agent,
            timeout: requestTimeoutMs,
        });
        request.once('response', resolve);
        request.once('timeout', () => request.destroy(new Error('proxy request timed out')));
        request.once('error', (error) => {
            // From here on the origin may have seen the request, so a replay
            // is not safe and the caller must surface the failure.
            if (error && typeof error === 'object') error[REQUEST_SENT] = true;
            reject(error);
        });
        request.end(body);
    });
    try {
        return toFetchResponse(response, init.method || 'GET');
    } catch (error) {
        // The origin has answered, so the request was delivered: a direct
        // replay could run a POST twice.
        response.destroy();
        if (error && typeof error === 'object') error[REQUEST_SENT] = true;
        throw error;
    }
}

/** Headers that carry credentials and must not follow a cross-origin redirect. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key'];

/** Statuses whose response must not carry a body (Fetch "null body status"). */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * Wrap a Node response as a fetch `Response`, decoding the body when needed.
 *
 * @param {import('node:http').IncomingMessage} response
 * @param {string} method
 * @returns {Response}
 */
function toFetchResponse(response, method) {
    const status = response.statusCode || 200;
    // HEAD and null-body statuses may still advertise a Content-Encoding; an
    // empty body must not reach a decoder (it fails with Z_BUF_ERROR) nor the
    // Response constructor (it rejects any body for these statuses).
    const hasBody = !NULL_BODY_STATUS.has(status) && method.toUpperCase() !== 'HEAD';
    const decoder = hasBody ? decompressor(response.headers['content-encoding']) : null;
    /** @type {ReadableStream|null} */
    let stream = null;
    if (hasBody) stream = nodeStreamToWeb(response, decoder || undefined);
    else response.resume();

    const outHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        const name = key.toLowerCase();
        if (name === 'content-encoding') continue;
        // The decoded body no longer matches the wire framing.
        if (decoder && (name === 'content-length' || name === 'transfer-encoding')) continue;
        if (Array.isArray(value)) {
            for (const entry of value) outHeaders.append(key, entry);
        } else {
            outHeaders.set(key, String(value));
        }
    }

    return new Response(stream, {
        status,
        statusText: response.statusMessage || '',
        headers: outHeaders,
    });
}

/**
 * Build a fetch implementation that honours proxy environment variables.
 *
 * @param {{env?: Record<string,string|undefined> | (() => Record<string,string|undefined>), base?: typeof fetch}} [options]
 *        `env` may be a function, re-evaluated per request; it may be async.
 * @returns {typeof fetch}
 */
export function createProxyFetch({ env = process.env, base = globalThis.fetch, handshakeTimeoutMs, requestTimeoutMs } = {}) {
    /** @type {Set<string>} */
    const reported = new Set();
    const proxyFetch = async (input, init = {}) => {
        let current = input;
        let currentInit = init;
        for (let hop = 0; ; hop += 1) {
            const raw = typeof current === 'string' ? current : current instanceof URL ? current.href : current?.url;
            let target = null;
            try {
                target = new URL(String(raw));
            } catch {
                target = null;
            }
            const proxy = target ? proxyFor(target, typeof env === 'function' ? await env() : env) : null;
            const canHandleRedirects = Boolean(target) && !(current instanceof Request) && isReplayableBody(currentInit?.body);
            const directInit = canHandleRedirects ? { ...currentInit, redirect: 'manual' } : currentInit;
            let response;
            if (!canHandleRedirects || !proxy) {
                response = await base(current, directInit);
            } else {
                try {
                    response = await tunnelRequest(target, proxy, currentInit, { handshakeTimeoutMs, requestTimeoutMs });
                } catch (error) {
                    if (currentInit.signal?.aborted) throw error;
                    // The tunnel may already have delivered the request; a
                    // direct replay could bill a chat completion twice.
                    if (error && error[REQUEST_SENT]) throw error;
                    // Never let a bad proxy setting take down a working network path.
                    if (!reported.has(proxy.href)) {
                        reported.add(proxy.href);
                        logError(`proxy ${proxy.host} failed; using a direct connection`, error);
                    }
                    try {
                        response = await base(current, directInit);
                    } catch (directError) {
                        // Both paths failed; the proxy error is the actionable one.
                        if (directError && typeof directError === 'object') {
                            directError[PROXY_FAILURE] = `proxy ${proxy.protocol}//${proxy.host}: ${error?.message || error}`;
                        }
                        throw directError;
                    }
                }
            }

            if (currentInit.redirect === 'manual' || !canHandleRedirects) {
                return response;
            }
            if (currentInit.redirect === 'error' && REDIRECT_STATUS.has(response.status)) {
                if (response.body) {
                    try { await response.body.cancel(); } catch { /* ignore */ }
                }
                throw new TypeError(`Unexpected redirect (status ${response.status}) for ${target.href}`);
            }
            const location = response.headers.get('location');
            if (hop >= 5 || !location || !REDIRECT_STATUS.has(response.status)) {
                return response;
            }
            let next;
            try {
                next = new URL(location, target);
            } catch {
                return response;
            }
            if (response.body) {
                try {
                    await response.body.cancel();
                } catch {
                    // Already consumed; the redirect still stands.
                }
            }
            const method = String(
                currentInit.method || (current instanceof Request ? current.method : 'GET'),
            ).toUpperCase();
            const downgrade = response.status === 303
                || ((response.status === 301 || response.status === 302) && method === 'POST');
            currentInit = { ...currentInit, method: downgrade && method !== 'HEAD' ? 'GET' : method };
            const crossOrigin = next.origin !== target.origin;
            if (downgrade || crossOrigin) {
                const headers = headerObject(currentInit.headers);
                if (downgrade) {
                    delete currentInit.body;
                    delete headers['content-length'];
                    delete headers['content-type'];
                    delete headers['transfer-encoding'];
                    delete headers['content-encoding'];
                }
                // Like fetch, never hand credentials to another origin; API
                // keys travel in their own headers here, so they go too.
                if (crossOrigin) {
                    for (const name of CREDENTIAL_HEADERS) delete headers[name];
                }
                currentInit.headers = headers;
            }
            current = next.href;
        }
    };
    return /** @type {typeof fetch} */ (proxyFetch);
}

/**
 * Parse a Windows `ProxyServer` value.
 *
 * Windows stores either `host:port` (applies to every protocol) or a
 * semicolon-separated `http=host:port;https=host:port;socks=host:port` list.
 *
 * @param {string} raw
 * @returns {{http?: string, https?: string, all?: string}}
 */
export function parseWindowsProxyServer(raw) {
    const text = String(raw || '').trim();
    if (!text) return {};
    /** @type {{http?: string, https?: string, all?: string}} */
    const out = {};
    if (!text.includes('=')) {
        out.all = text;
        return out;
    }
    for (const part of text.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const scheme = part.slice(0, index).trim().toLowerCase();
        const value = part.slice(index + 1).trim();
        if (!value) continue;
        if (scheme === 'http') out.http = value;
        else if (scheme === 'https') out.https = value;
        else if (scheme === 'socks' || scheme === 'socks5') {
            // CONNECT cannot drive SOCKS; remember it only as a last resort.
            out.all = out.all || `socks5://${value}`;
        }
    }
    return out;
}

/**
 * Parse `scutil --proxy` output (macOS) into env-style values.
 * @param {string} text
 * @returns {{http?: string, https?: string}}
 */
export function parseScutilProxy(text) {
    /** @type {Record<string, string>} */
    const values = {};
    for (const line of String(text || '').split('\n')) {
        const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
        if (match) values[match[1]] = match[2];
    }
    const read = (prefix) => {
        if (values[`${prefix}Enable`] !== '1') return '';
        const host = values[`${prefix}Proxy`];
        const port = values[`${prefix}Port`];
        return host ? `http://${host}${port ? `:${port}` : ''}` : '';
    };
    /** @type {{http?: string, https?: string}} */
    const out = {};
    const http = read('HTTP');
    const httpsProxy = read('HTTPS');
    if (http) out.http = http;
    if (httpsProxy) out.https = httpsProxy;
    return out;
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {string}
 */
function runCommand(file, args) {
    return String(execFileSync(file, args, {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
    }) || '');
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runCommandAsync(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, {
            encoding: 'utf8',
            timeout: 1500,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout || ''));
        });
    });
}

function parseSystemProxyCommands(platform, run) {
    if (platform === 'win32') {
        const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
        return Promise.resolve(run('reg', ['query', key, '/v', 'ProxyEnable'])).then((enabled) => {
            if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return {};
            return Promise.resolve(run('reg', ['query', key, '/v', 'ProxyServer'])).then((server) => {
                const match = server.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
                return match ? parseWindowsProxyServer(match[1].trim()) : {};
            });
        });
    }
    if (platform === 'darwin') {
        return Promise.resolve(run('scutil', ['--proxy'])).then(parseScutilProxy);
    }
    if (platform === 'linux') {
        const read = (schema, key) => Promise.resolve(run('gsettings', ['get', schema, key]))
            .then((out) => String(out || '').trim().replace(/^'|'$/g, ''));
        return read('org.gnome.system.proxy', 'mode').then(async (mode) => {
            if (mode !== 'manual') return {};
            /** @type {{http?: string, https?: string}} */
            const out = {};
            const [httpHost, httpPort, httpsHost, httpsPort] = await Promise.all([
                read('org.gnome.system.proxy.http', 'host'),
                read('org.gnome.system.proxy.http', 'port'),
                read('org.gnome.system.proxy.https', 'host'),
                read('org.gnome.system.proxy.https', 'port'),
            ]);
            if (httpHost) out.http = `http://${httpHost}${httpPort ? `:${httpPort}` : ''}`;
            if (httpsHost) out.https = `http://${httpsHost}${httpsPort ? `:${httpsPort}` : ''}`;
            return out;
        });
    }
    return Promise.resolve({});
}

/**
 * Read the operating system's proxy settings.
 *
 * A system proxy (Clash, v2ray, corporate agents) is usually configured in the
 * OS, not in the environment, so Node's fetch cannot see it at all. This is a
 * best-effort read of the platform's own settings; any failure means "no proxy".
 *
 * @param {{platform?: NodeJS.Platform, run?: (file: string, args: string[]) => string}} [options]
 * @returns {{http?: string, https?: string, all?: string}}
 */
export function detectSystemProxy({ platform = process.platform, run = runCommand } = {}) {
    try {
        if (platform === 'win32') {
            const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
            const enabled = run('reg', ['query', key, '/v', 'ProxyEnable']);
            if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return {};
            const server = run('reg', ['query', key, '/v', 'ProxyServer']);
            const match = server.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
            return match ? parseWindowsProxyServer(match[1].trim()) : {};
        }
        if (platform === 'darwin') {
            return parseScutilProxy(run('scutil', ['--proxy']));
        }
        if (platform === 'linux') {
            const mode = run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim().replace(/^'|'$/g, '');
            if (mode !== 'manual') return {};
            const read = (schema, key) => run('gsettings', ['get', schema, key]).trim().replace(/^'|'$/g, '');
            /** @type {{http?: string, https?: string}} */
            const out = {};
            const httpHost = read('org.gnome.system.proxy.http', 'host');
            const httpPort = read('org.gnome.system.proxy.http', 'port');
            if (httpHost) out.http = `http://${httpHost}${httpPort ? `:${httpPort}` : ''}`;
            const httpsHost = read('org.gnome.system.proxy.https', 'host');
            const httpsPort = read('org.gnome.system.proxy.https', 'port');
            if (httpsHost) out.https = `http://${httpsHost}${httpsPort ? `:${httpsPort}` : ''}`;
            return out;
        }
    } catch {
        // Missing tool, no desktop session, restricted registry: treat as none.
    }
    return {};
}

/**
 * Async variant of `detectSystemProxy` using non-blocking `execFile`.
 *
 * @param {{platform?: NodeJS.Platform, run?: (file: string, args: string[]) => string|Promise<string>}} [options]
 * @returns {Promise<{http?: string, https?: string, all?: string}>}
 */
export async function detectSystemProxyAsync({ platform = process.platform, run = runCommandAsync } = {}) {
    try {
        return await parseSystemProxyCommands(platform, run);
    } catch {
        return {};
    }
}
/**
 * Merge OS proxy settings into an env map without overriding explicit values.
 * @param {Record<string, string|undefined>} env
 * @param {{http?: string, https?: string, all?: string}} system
 * @returns {Record<string, string|undefined>}
 */
function withSystemProxy(env, system) {
    const merged = { ...env };
    if (!merged.HTTP_PROXY && !merged.http_proxy && system.http) merged.HTTP_PROXY = system.http;
    if (!merged.HTTPS_PROXY && !merged.https_proxy && system.https) merged.HTTPS_PROXY = system.https;
    if (!merged.ALL_PROXY && !merged.all_proxy && system.all) merged.ALL_PROXY = system.all;
    return merged;
}

/**
 * Explain a `fetch failed` rejection with the underlying network cause.
 * Undici hides ECONNREFUSED/ENOTFOUND inside `error.cause`, which made a proxy
 * problem look like an unexplainable failure in the sign-in panel.
 * @param {unknown} error
 * @returns {string}
 */
export function describeFetchFailure(error) {
    const message = String(/** @type {any} */ (error)?.message || error);
    if (!/fetch failed/i.test(message)) return message;
    const cause = /** @type {any} */ (error)?.cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(' ');
    const proxy = /** @type {any} */ (error)?.[PROXY_FAILURE];
    const parts = [detail, proxy].filter(Boolean).join('; ');
    return parts ? `${message} (${parts})` : message;
}

/**
 * Wait for `promise`, but no longer than `ms`.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<void>}
 */
function settleWithin(promise, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        promise.finally(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Normalize stored or submitted proxy settings. A manual mode without a usable
 * address falls back to `system`, so a damaged config file cannot silently
 * turn the proxy off.
 * @param {unknown} value
 * @returns {ProxySettings}
 */
export function normalizeProxySettings(value) {
    const raw = /** @type {any} */ (value) || {};
    const mode = PROXY_MODES.has(raw.mode) ? raw.mode : 'system';
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (mode === 'manual' && !parseProxyUrl(url)) return { mode: 'system', url };
    return { mode, url };
}

/**
 * Apply the settings panel's routing choice to every later request.
 * @param {unknown} value
 * @returns {ProxySettings}
 */
export function setProxySettings(value) {
    settings = normalizeProxySettings(value);
    return settings;
}

/**
 * Install the proxy-aware fetch as `globalThis.fetch` (idempotent).
 *
 * Adapters resolve `fetch` at call time (`ctx.fetchImpl || fetch`), so one
 * replacement covers the gateway, probes and the OAuth flows alike. The
 * settings panel's choice comes first (`setProxySettings`); in `system` mode
 * proxy variables win, and without a usable one the OS proxy is read.
 *
 * @param {{env?: Record<string,string|undefined>, force?: boolean, system?: boolean,
 *          platform?: NodeJS.Platform, run?: (file: string, args: string[]) => string,
 *          now?: () => number}} [options]
 * @returns {boolean} whether a proxy is configured right now
 */
export function installProxyFetch({ env = process.env, force = false, system = true, platform, run, now = Date.now } = {}) {
    // Node >= 24 can route its own fetch through the environment's proxy; on
    // older runtimes the variable is inert and we must install the wrapper.
    const nodeMajor = Number(String(process.versions.node || '0').split('.')[0]) || 0;
    const nodeHandlesEnvProxy = env.NODE_USE_ENV_PROXY === '1' && nodeMajor >= 24;
    if (!force && (env.OMTP_DISABLE_PROXY === '1' || nodeHandlesEnvProxy)) {
        notInstalledReason = env.OMTP_DISABLE_PROXY === '1' ? 'OMTP_DISABLE_PROXY' : 'NODE_USE_ENV_PROXY';
        return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
    }
    const current = globalThis.fetch;
    if (!current || wrapped.has(current)) return false;

    let systemProxy = {};
    let readAt = -Infinity;
    /** @type {Promise<void>|null} */
    let refreshing = null;
    let announced;

    const announce = (effective, source) => {
        const proxy = proxyFor(PROBE_TARGET, effective);
        const label = proxy ? `${source} proxy ${proxyLabel(proxy)}` : source === 'settings' ? 'off' : '';
        if (label === announced) return;
        announced = label;
        if (proxy) log(`outbound requests use the ${label}`);
        else if (source === 'settings') log('outbound proxy turned off in the settings; requests connect directly');
        else log('no outbound proxy configured; requests connect directly');
    };

    /** Read the OS proxy; concurrent callers share one read. */
    const refresh = () => {
        if (!refreshing) {
            refreshing = detectSystemProxyAsync({ platform, run })
                .then((next) => {
                    systemProxy = next;
                    readAt = now();
                })
                .finally(() => {
                    refreshing = null;
                });
        }
        return refreshing;
    };

    const route = async () => {
        if (settings.mode === 'direct') return { env: { NO_PROXY: '*' }, source: 'settings' };
        if (settings.mode === 'manual') {
            return {
                env: { HTTP_PROXY: settings.url, HTTPS_PROXY: settings.url, NO_PROXY: env.NO_PROXY || env.no_proxy },
                source: 'manual',
            };
        }
        // `env` is read live: SillyTavern's requestProxy sets `all_proxy` at runtime.
        if (!system || proxyFor(PROBE_TARGET, env)) return { env, source: 'environment' };
        // Wait for a fresh read instead of answering from the last one. A
        // sign-in's token exchange is often the first request in minutes, so a
        // stale "no proxy" sent it direct right after the user had turned the
        // system proxy on. The read is asynchronous: only this request waits.
        if (now() - readAt >= SYSTEM_PROXY_TTL_MS) await settleWithin(refresh(), SYSTEM_PROXY_WAIT_MS);
        return { env: withSystemProxy(env, systemProxy), source: 'system' };
    };

    const resolveEnv = async () => {
        const { env: effective, source } = await route();
        announce(effective, source);
        return effective;
    };

    // Warm the first read so the first request does not pay for it.
    if (system && !proxyFor(PROBE_TARGET, env)) refresh();

    const proxyFetch = createProxyFetch({ env: resolveEnv, base: current });
    wrapped.add(proxyFetch);
    globalThis.fetch = proxyFetch;
    installed = {
        route,
        base: current,
        detected: () => ({
            environment: proxyLabel(proxyFor(PROBE_TARGET, env)),
            system: proxyLabel(proxyFor(PROBE_TARGET, withSystemProxy({}, systemProxy))),
        }),
    };
    return Boolean(proxyFor(PROBE_TARGET, env));
}

/**
 * The routing in effect right now, for the settings panel. Credentials in a
 * proxy URL never leave through `effective`/`detected`.
 * @returns {Promise<{mode: string, url: string, installed: boolean, reason: string,
 *                    effective: string, source: string, detected: {environment: string, system: string}}>}
 */
export async function getProxyStatus() {
    if (!installed) {
        return { ...settings, installed: false, reason: notInstalledReason, effective: '', source: 'none', detected: { environment: '', system: '' } };
    }
    const { env, source } = await installed.route();
    const proxy = proxyFor(PROBE_TARGET, env);
    return {
        ...settings,
        installed: true,
        reason: '',
        effective: proxyLabel(proxy),
        source: proxy || source === 'settings' ? source : 'none',
        detected: installed.detected(),
    };
}

/**
 * One reachability check over a single route, with no fallback, so the result
 * names the hop that failed.
 * @param {URL} target
 * @param {URL|null} proxy
 * @param {typeof fetch} base
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status?: number, ms: number, error?: string}>}
 */
async function probeRoute(target, proxy, base, timeoutMs) {
    const started = Date.now();
    const init = { method: 'GET', redirect: /** @type {const} */ ('manual'), signal: AbortSignal.timeout(timeoutMs) };
    try {
        const response = proxy
            ? await tunnelRequest(target, proxy, init, { handshakeTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs })
            : await base(target.href, init);
        try {
            await response.body?.cancel();
        } catch {
            // Only the status line matters here.
        }
        return { ok: true, status: response.status, ms: Date.now() - started };
    } catch (error) {
        // http.request reports an aborted signal as a bare AbortError.
        return { ok: false, ms: Date.now() - started, error: init.signal.aborted ? 'timed out' : describeFetchFailure(error) };
    }
}

/**
 * Check the hosts sign-in depends on, through the proxy in effect and directly,
 * so a failing login can be traced to "no proxy found", "proxy unreachable",
 * "proxy cannot reach the host" or "blocked without a proxy".
 * @param {{targets?: readonly string[], timeoutMs?: number}} [options]
 */
export async function diagnoseProxy({ targets = DIAGNOSTIC_TARGETS, timeoutMs = DIAGNOSTIC_TIMEOUT_MS } = {}) {
    const status = await getProxyStatus();
    const active = status.installed ? installed : null;
    const env = active ? (await active.route()).env : {};
    const base = active ? active.base : globalThis.fetch;
    const results = await Promise.all(targets.map(async (href) => {
        const target = new URL(href);
        const proxy = proxyFor(target, env);
        const [viaProxy, direct] = await Promise.all([
            proxy ? probeRoute(target, proxy, base, timeoutMs) : null,
            probeRoute(target, null, base, timeoutMs),
        ]);
        return { host: target.host, proxy: viaProxy, direct };
    }));
    return { ...status, results };
}
