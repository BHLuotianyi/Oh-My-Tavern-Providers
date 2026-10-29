/**
 * Proxy support for outbound HTTP.
 *
 * Node's global `fetch` ignores `HTTPS_PROXY`/`HTTP_PROXY`, so behind a system
 * proxy every call dies as a bare `fetch failed`. This module wraps the global
 * fetch once, routing only the requests that need it through an HTTP CONNECT
 * tunnel, and falling back to the original fetch when the tunnel cannot be
 * established — a stale proxy variable must never break a machine whose VPN
 * works at the network layer (TUN/transparent hijack). Once request bytes have
 * been handed to the tunnel, a failure is rethrown instead: replaying the call
 * directly could bill a chat completion twice.
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

import { log, logError } from './redact.mjs';

/** @type {WeakSet<object>} */
const wrapped = new WeakSet();

/** Present on tunnel failures that happened after the request was written. */
const REQUEST_SENT = Symbol('proxyFetch.requestSent');

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
    if (isLocalHost(host)) return null;

    const candidates = target.protocol === 'https:'
        ? [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy, env.HTTP_PROXY, env.http_proxy]
        : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
    for (const raw of candidates) {
        if (!raw) continue;
        try {
            const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
            // Only HTTP proxies can be driven with CONNECT; a SOCKS URL would
            // otherwise burn a guaranteed failed attempt per host.
            if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
            if (!url.hostname) continue;
            return url;
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLocalHost(host) {
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    return host === '0.0.0.0';
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
function openTunnel(proxy, host, port, signal) {
    return new Promise((resolve, reject) => {
        const secureProxy = proxy.protocol === 'https:';
        const headers = { host: `${host}:${port}` };
        if (proxy.username) {
            const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        const request = (secureProxy ? https : http).request({
            host: proxy.hostname,
            port: Number(proxy.port) || (secureProxy ? 443 : 80),
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            signal,
            timeout: 30_000,
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
 * Perform one request through the proxy.
 *
 * @param {URL} target
 * @param {URL} proxy
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function tunnelRequest(target, proxy, init) {
    const secure = target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const signal = init.signal || undefined;
    if (signal?.aborted) throw signal.reason || new Error('aborted');

    const tunnel = await openTunnel(proxy, target.hostname, port, signal);
    let socket = tunnel;
    if (secure) {
        socket = tls.connect({ socket: tunnel, servername: target.hostname });
        await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
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

    // A one-shot agent hands the already-open socket to Node: the request must
    // never resolve the target hostname itself (only the proxy may do that).
    const agent = new (secure ? https.Agent : http.Agent)({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;

    let wrote = false;
    const response = await new Promise((resolve, reject) => {
        const request = (secure ? https : http).request({
            host: target.hostname,
            port,
            path: `${target.pathname}${target.search}`,
            method: init.method || 'GET',
            headers,
            signal,
            agent,
        });
        request.once('response', resolve);
        request.once('error', (error) => {
            // From here on the origin may have seen the request, so a replay
            // is not safe and the caller must surface the failure.
            if (wrote && error && typeof error === 'object') error[REQUEST_SENT] = true;
            reject(error);
        });
        if (body !== undefined) request.write(body);
        wrote = true;
        request.end();
    });

    const encoding = response.headers['content-encoding'];
    const decoder = decompressor(encoding);
    /** @type {ReadableStream|undefined} */
    let stream;
    if (decoder) {
        const piped = response.pipe(decoder);
        stream = /** @type {any} */ (Readable.toWeb(piped));
    } else if (response.statusCode !== 204 && response.statusCode !== 304 && (init.method || 'GET') !== 'HEAD') {
        stream = /** @type {any} */ (Readable.toWeb(response));
    }

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

    return new Response(stream ?? null, {
        status: response.statusCode || 200,
        statusText: response.statusMessage || '',
        headers: outHeaders,
    });
}

/**
 * Build a fetch implementation that honours proxy environment variables.
 *
 * @param {{env?: Record<string,string|undefined>, base?: typeof fetch}} [options]
 * @returns {typeof fetch}
 */
export function createProxyFetch({ env = process.env, base = globalThis.fetch } = {}) {
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
            const proxy = target ? proxyFor(target, env) : null;
            let response;
            if (!target || !proxy || !isReplayableBody(currentInit?.body) || current instanceof Request) {
                response = await base(current, currentInit);
            } else {
                try {
                    response = await tunnelRequest(target, proxy, currentInit);
                } catch (error) {
                    // The tunnel may already have delivered the request; a
                    // direct replay could bill a chat completion twice.
                    if (error && error[REQUEST_SENT]) throw error;
                    // Never let a bad proxy setting take down a working network path.
                    if (!reported.has(proxy.href)) {
                        reported.add(proxy.href);
                        logError(`proxy ${proxy.host} failed; using a direct connection`, error);
                    }
                    response = await base(current, currentInit);
                }
            }

            const location = response.headers.get('location');
            if (
                hop >= 5
                || currentInit.redirect === 'manual'
                || current instanceof Request
                || !target
                || !location
                || !REDIRECT_STATUS.has(response.status)
                || !isReplayableBody(currentInit.body)
            ) {
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
            if (downgrade) {
                delete currentInit.body;
                const headers = headerObject(currentInit.headers);
                delete headers['content-length'];
                delete headers['content-type'];
                delete headers['transfer-encoding'];
                delete headers['content-encoding'];
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
    return detail ? `${message} (${detail})` : message;
}

/**
 * Install the proxy-aware fetch as `globalThis.fetch` (idempotent).
 *
 * Adapters resolve `fetch` at call time (`ctx.fetchImpl || fetch`), so one
 * replacement covers the gateway, probes and the OAuth flows alike.
 *
 * @param {{env?: Record<string,string|undefined>, force?: boolean, system?: boolean,
 *          platform?: NodeJS.Platform, run?: (file: string, args: string[]) => string}} [options]
 * @returns {boolean} whether a proxy is configured
 */
export function installProxyFetch({ env = process.env, force = false, system = true, platform, run } = {}) {
    // Node >= 24 can route its own fetch through the environment's proxy; on
    // older runtimes the variable is inert and we must install the wrapper.
    const nodeMajor = Number(String(process.versions.node || '0').split('.')[0]) || 0;
    const nodeHandlesEnvProxy = env.NODE_USE_ENV_PROXY === '1' && nodeMajor >= 24;
    if (!force && (env.OMTP_DISABLE_PROXY === '1' || nodeHandlesEnvProxy)) {
        return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
    }
    const current = globalThis.fetch;
    if (!current || wrapped.has(current)) return false;
    const envHasProxy = Boolean(
        env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy,
    );
    const systemProxy = system && !envHasProxy ? detectSystemProxy({ platform, run }) : {};
    const effective = withSystemProxy(env, systemProxy);
    const hasProxy = Boolean(
        effective.HTTPS_PROXY || effective.https_proxy || effective.HTTP_PROXY || effective.http_proxy
        || effective.ALL_PROXY || effective.all_proxy,
    );
    if (!hasProxy) {
        log('no outbound proxy configured; requests connect directly');
        return false;
    }
    const proxyFetch = createProxyFetch({ env: effective, base: current });
    wrapped.add(proxyFetch);
    globalThis.fetch = proxyFetch;
    const proxy = proxyFor(new URL('https://example.com'), effective);
    const source = envHasProxy ? 'environment' : 'system';
    log(`outbound requests use the ${source} proxy (${proxy?.host || 'n/a'})`);
    return true;
}
