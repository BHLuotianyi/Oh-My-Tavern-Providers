import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

import {
    createProxyFetch,
    describeFetchFailure,
    detectSystemProxy,
    installProxyFetch,
    parseScutilProxy,
    parseWindowsProxyServer,
    proxyFor,
} from '../../server-plugin/lib/proxy-fetch.mjs';

const listen = (server) => new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
});

const startProxy = async (targetPort) => {
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.pipe(socket).pipe(upstream);
        });
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
    });
    const port = await listen(proxy);
    return { proxy, port };
};

test('proxyFor honours scheme, NO_PROXY and loopback', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.internal' };
    assert.equal(proxyFor(new URL('https://api.deepseek.com/v1/models'), env)?.port, '7890');
    assert.equal(proxyFor(new URL('http://api.deepseek.com/v1/models'), env), null);
    assert.equal(proxyFor(new URL('https://api.internal/x'), env), null);
    assert.equal(proxyFor(new URL('http://127.0.0.1:4100/v1/models'), env), null);
    assert.equal(proxyFor(new URL('https://api.deepseek.com'), {}), null);
    const all = { ALL_PROXY: 'http://user:pass@proxy.lan:1080' };
    assert.equal(proxyFor(new URL('http://example.com'), all)?.hostname, 'proxy.lan');
});

test('createProxyFetch tunnels through a CONNECT proxy and decodes gzip', async () => {
    const payload = JSON.stringify({ models: [{ id: 'deepseek-chat' }] });
    const origin = http.createServer((req, res) => {
        assert.equal(req.url, '/v1/models');
        assert.equal(req.headers['x-test'], 'yes');
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(payload));
    });
    const originPort = await listen(origin);

    let tunneled = 0;
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
        tunneled += 1;
        const upstream = net.connect(originPort, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.pipe(socket).pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
    });
    const proxyPort = await listen(proxy);

    try {
        const doFetch = createProxyFetch({
            env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
        });
        const response = await doFetch('http://origin.test/v1/models', { headers: { 'x-test': 'yes' } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-encoding'), null);
        assert.deepEqual(await response.json(), JSON.parse(payload));
        assert.equal(tunneled, 1);
    } finally {
        await close(proxy);
        await close(origin);
    }
});

test('a dead proxy falls back to the direct connection instead of failing', async () => {
    const fallback = async () => new Response('direct', { status: 200 });
    const doFetch = createProxyFetch({ env: { HTTP_PROXY: 'http://127.0.0.1:9' }, base: fallback });
    const response = await doFetch('http://origin.test/v1/models');
    assert.equal(await response.text(), 'direct');
});

test('a tunnel that dies after the request is written rejects instead of falling back', async () => {
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', () => socket.destroy());
        socket.on('error', () => {});
    });
    const proxyPort = await listen(proxy);
    let direct = 0;
    try {
        const doFetch = createProxyFetch({
            env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
            base: () => {
                direct += 1;
                return new Response('direct', { status: 200 });
            },
        });
        await assert.rejects(doFetch('http://origin.test/v1/chat/completions', {
            method: 'POST',
            body: '{"prompt":"charge-me-once"}',
        }));
        assert.equal(direct, 0);
    } finally {
        await close(proxy);
    }
});

test('NO_PROXY matches wildcard prefixes and bracketed IPv6 entries', () => {
    const env = {
        HTTPS_PROXY: 'http://proxy.lan:7890',
        NO_PROXY: '*.corp.example,[2001:db8::1]:8443',
    };
    assert.equal(proxyFor(new URL('https://api.corp.example/v1'), env), null);
    assert.equal(proxyFor(new URL('https://corp.example/v1'), env), null);
    assert.equal(proxyFor(new URL('https://[2001:db8::1]:8443/v1'), env), null);
    assert.equal(proxyFor(new URL('https://[2001:db8::1]:9443/v1'), env)?.port, '7890');

    const hostOnly = { HTTPS_PROXY: 'http://proxy.lan:7890', NO_PROXY: '[2001:db8::2],2001:db8::3' };
    assert.equal(proxyFor(new URL('https://[2001:db8::2]/v1'), hostOnly), null);
    assert.equal(proxyFor(new URL('https://[2001:db8::3]:5555/v1'), hostOnly), null);
    assert.equal(proxyFor(new URL('https://[2001:db8::4]/v1'), hostOnly)?.port, '7890');
});

test('proxyFor accepts http, https and socks5 proxies only', () => {
    const socks = { ALL_PROXY: 'socks5://user:pass@proxy.lan:1080' };
    assert.equal(proxyFor(new URL('https://example.com/v1'), socks)?.protocol, 'socks5:');
    assert.equal(proxyFor(new URL('https://example.com/v1'), { ALL_PROXY: 'socks4://proxy.lan:1080' }), null);

    const mixed = { ALL_PROXY: 'socks5://proxy.lan:1080', HTTP_PROXY: 'http://http.lan:3128' };
    assert.equal(proxyFor(new URL('http://example.com/v1'), mixed)?.hostname, 'http.lan');
    assert.equal(proxyFor(new URL('https://example.com/v1'), mixed)?.hostname, 'proxy.lan');

    const httpAll = { ALL_PROXY: 'http://all.lan:8888' };
    assert.equal(proxyFor(new URL('https://example.com/v1'), httpAll)?.hostname, 'all.lan');
});

test('decoded responses drop stale content-length and transfer-encoding', async () => {
    const payload = JSON.stringify({ ok: true });
    const compressed = zlib.gzipSync(payload);
    const origin = http.createServer((req, res) => {
        if (req.url === '/gzip') {
            res.writeHead(200, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': String(compressed.length),
            });
            res.end(compressed);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(payload.length) });
        res.end(payload);
    });
    const originPort = await listen(origin);
    const { proxy, port } = await startProxy(originPort);
    try {
        const doFetch = createProxyFetch({ env: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
        const gzipped = await doFetch('http://origin.test/gzip');
        assert.equal(gzipped.headers.get('content-encoding'), null);
        assert.equal(gzipped.headers.get('content-length'), null);
        assert.equal(gzipped.headers.get('transfer-encoding'), null);
        assert.equal(await gzipped.text(), payload);

        const plain = await doFetch('http://origin.test/plain');
        assert.equal(plain.headers.get('content-length'), String(payload.length));
        assert.equal(await plain.text(), payload);
    } finally {
        await close(proxy);
        await close(origin);
    }
});

test('a socket reset mid-body fails the decoded body instead of hanging', { timeout: 5000 }, async () => {
    const gz = zlib.gzipSync(Buffer.alloc(64 * 1024, 'a'));
    const origin = http.createServer((req, res) => {
        const gzip = req.url === '/gzip';
        res.writeHead(200, { 'content-type': 'text/plain', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        // A prefix that decompresses fine; only the reset can end the body.
        res.write(gzip ? gz.subarray(0, gz.length - 10) : Buffer.alloc(64 * 1024, 'a'));
        setTimeout(() => res.socket.destroy(), 20);
    });
    const originPort = await listen(origin);
    const { proxy, port } = await startProxy(originPort);
    try {
        const doFetch = createProxyFetch({ env: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
        for (const path of ['/plain', '/gzip']) {
            const response = await doFetch(`http://origin.test${path}`);
            await assert.rejects(response.text());
        }
    } finally {
        await close(proxy);
        await close(origin);
    }
});

test('null-body statuses and HEAD with a content-encoding are delivered once, without a body', async () => {
    const hits = [];
    const origin = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(req.url === '/204' ? 204 : 200, { 'content-encoding': 'gzip', 'x-origin': 'yes' });
        res.end();
    });
    const originPort = await listen(origin);
    const { proxy, port } = await startProxy(originPort);
    try {
        const doFetch = createProxyFetch({ env: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
        const noContent = await doFetch('http://origin.test/204', { method: 'POST', body: '{}' });
        assert.equal(noContent.status, 204);
        assert.equal(noContent.headers.get('x-origin'), 'yes');
        assert.equal(await noContent.text(), '');
        const head = await doFetch('http://origin.test/head', { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        // A failed Response construction used to fall back to a direct replay.
        assert.deepEqual(hits, ['POST /204', 'HEAD /head']);
    } finally {
        await close(proxy);
        await close(origin);
    }
});

test('redirects are followed, rewriting methods and re-entering the proxy decision', async () => {
    let loopHits = 0;
    const origin = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (req.url === '/to-get') {
                res.writeHead(302, { location: '/echo' });
                res.end();
                return;
            }
            if (req.url === '/to-303') {
                res.writeHead(303, { location: '/echo' });
                res.end();
                return;
            }
            if (req.url === '/keep-307') {
                res.writeHead(307, { location: '/echo' });
                res.end();
                return;
            }
            if (req.url === '/keep-308') {
                res.writeHead(308, { location: '/echo' });
                res.end();
                return;
            }
            if (req.url === '/to-direct') {
                res.writeHead(302, { location: `http://127.0.0.1:${origin.address().port}/echo` });
                res.end();
                return;
            }
            if (req.url === '/keep-auth') {
                res.writeHead(307, { location: '/echo-auth' });
                res.end();
                return;
            }
            if (req.url === '/cross-auth') {
                res.writeHead(307, { location: `http://127.0.0.1:${origin.address().port}/echo-auth` });
                res.end();
                return;
            }
            if (req.url === '/echo-auth') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ authorization: req.headers.authorization || '', apiKey: req.headers['x-api-key'] || '', other: req.headers['x-other'] || '' }));
                return;
            }
            if (req.url === '/loop') {
                loopHits += 1;
                res.writeHead(302, { location: '/loop' });
                res.end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ method: req.method, body }));
        });
    });
    const originPort = await listen(origin);
    const { proxy, port } = await startProxy(originPort);
    const directFetch = globalThis.fetch;
    const direct = [];
    try {
        const doFetch = createProxyFetch({
            env: { HTTP_PROXY: `http://127.0.0.1:${port}` },
            base: (input, init) => {
                direct.push(String(input));
                return directFetch(input, init);
            },
        });
        const posted = { method: 'POST', body: 'payload' };

        const get302 = await doFetch('http://origin.test/to-get', posted);
        assert.deepEqual(await get302.json(), { method: 'GET', body: '' });

        const get303 = await doFetch('http://origin.test/to-303', posted);
        assert.deepEqual(await get303.json(), { method: 'GET', body: '' });

        const keep307 = await doFetch('http://origin.test/keep-307', posted);
        assert.deepEqual(await keep307.json(), { method: 'POST', body: 'payload' });

        const keep308 = await doFetch('http://origin.test/keep-308', posted);
        assert.deepEqual(await keep308.json(), { method: 'POST', body: 'payload' });

        const viaDirect = await doFetch('http://origin.test/to-direct');
        assert.deepEqual(await viaDirect.json(), { method: 'GET', body: '' });
        assert.deepEqual(direct, [`http://127.0.0.1:${originPort}/echo`]);

        // Credentials stay on their origin; unrelated headers still follow.
        const secrets = { headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'key', 'X-Other': 'kept' } };
        const sameOrigin = await doFetch('http://origin.test/keep-auth', secrets);
        assert.deepEqual(await sameOrigin.json(), { authorization: 'Bearer secret', apiKey: 'key', other: 'kept' });
        const crossOrigin = await doFetch('http://origin.test/cross-auth', secrets);
        assert.deepEqual(await crossOrigin.json(), { authorization: '', apiKey: '', other: 'kept' });

        const manual = await doFetch('http://origin.test/to-get', { redirect: 'manual' });
        assert.equal(manual.status, 302);
        assert.equal(manual.headers.get('location'), '/echo');
        await manual.text();

        loopHits = 0;
        const looped = await doFetch('http://origin.test/loop');
        assert.equal(looped.status, 302);
        assert.equal(loopHits, 6);
        await looped.text();
    } finally {
        await close(proxy);
        await close(origin);
    }
});


test('Windows registry proxy values are parsed in both forms', () => {
    assert.deepEqual(parseWindowsProxyServer('127.0.0.1:7890'), { all: '127.0.0.1:7890' });
    assert.deepEqual(
        parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080'),
        { http: '127.0.0.1:7890', https: '127.0.0.1:7891', all: 'socks5://127.0.0.1:1080' },
    );
    assert.deepEqual(parseWindowsProxyServer(''), {});
});

test('macOS scutil output becomes http/https proxies only when enabled', () => {
    const text = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`;
    assert.deepEqual(parseScutilProxy(text), { http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7891' });
    assert.deepEqual(parseScutilProxy('  HTTPEnable : 0\n  HTTPProxy : 127.0.0.1\n'), {});
});

test('detectSystemProxy reads the platform settings and never throws', () => {
    const windows = detectSystemProxy({
        platform: 'win32',
        run: (_file, args) => {
            const value = args[args.length - 1];
            if (value === 'ProxyEnable') return '    ProxyEnable    REG_DWORD    0x1';
            if (value === 'ProxyServer') return '    ProxyServer    REG_SZ    127.0.0.1:7890';
            return '';
        },
    });
    assert.deepEqual(windows, { all: '127.0.0.1:7890' });

    const linux = detectSystemProxy({
        platform: 'linux',
        run: (_file, args) => {
            const key = args[args.length - 1];
            if (args[1] === 'org.gnome.system.proxy' && key === 'mode') return "'manual'";
            if (key === 'host') return "'127.0.0.1'";
            if (key === 'port') return '7890';
            return '';
        },
    });
    assert.deepEqual(linux, { http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890' });

    const broken = detectSystemProxy({ platform: 'linux', run: () => { throw new Error('no gsettings'); } });
    assert.deepEqual(broken, {});
});

test('installProxyFetch falls back to the system proxy and can be restored', async () => {
    const original = globalThis.fetch;
    let probed = 0;
    try {
        globalThis.fetch = async () => new Response('direct');
        installProxyFetch({
            env: {},
            platform: 'darwin',
            run: () => {
                probed += 1;
                return '  HTTPEnable : 1\n  HTTPPort : 9\n  HTTPProxy : 127.0.0.1\n';
            },
        });
        assert.notEqual(globalThis.fetch, original);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(probed, 1);
        const res = await fetch('http://origin.test/');
        assert.equal(await res.text(), 'direct');
    } finally {
        globalThis.fetch = original;
    }
});

test('describeFetchFailure exposes the undici cause', () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' });
    assert.match(describeFetchFailure(error), /fetch failed \(ECONNREFUSED/);
    assert.equal(describeFetchFailure(new Error('boom')), 'boom');
});

test('createProxyFetch tunnels through a SOCKS5 proxy with credentials', async () => {
    const origin = http.createServer((req, res) => res.end(`origin ${req.headers.host}`));
    const originPort = await listen(origin);
    const seen = [];
    const socks = net.createServer((socket) => {
        let stage = 0;
        socket.on('data', (chunk) => {
            if (stage === 0) {
                seen.push(`methods:${[...chunk.subarray(2)].join(',')}`);
                socket.write(Buffer.from([5, 2]));
                stage = 1;
            } else if (stage === 1) {
                const ulen = chunk[1];
                seen.push(`auth:${chunk.subarray(2, 2 + ulen)}:${chunk.subarray(3 + ulen)}`);
                socket.write(Buffer.from([1, 0]));
                stage = 2;
            } else if (stage === 2) {
                const host = chunk.subarray(5, 5 + chunk[4]).toString();
                seen.push(`connect:${host}:${chunk.readUInt16BE(5 + chunk[4])}`);
                const upstream = net.connect(originPort, '127.0.0.1', () => {
                    socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                    upstream.pipe(socket).pipe(upstream);
                });
                upstream.on('error', () => socket.destroy());
                stage = 3;
            }
        });
    });
    const socksPort = await listen(socks);
    try {
        const doFetch = createProxyFetch({
            env: { ALL_PROXY: `socks5://u:p%40ss@127.0.0.1:${socksPort}` },
            base: () => { throw new Error('must not connect directly'); },
        });
        const response = await doFetch('http://origin.test:8080/x');
        assert.equal(await response.text(), 'origin origin.test:8080');
        assert.deepEqual(seen, ['methods:0,2', 'auth:u:p@ss', 'connect:origin.test:8080']);
    } finally {
        await close(socks);
        await close(origin);
    }
});

test('installProxyFetch picks up a system proxy enabled after startup without blocking requests', async () => {
    const original = globalThis.fetch;
    const origin = http.createServer((req, res) => res.end('via proxy'));
    const { proxy, port } = await startProxy(await listen(origin));
    let clashOn = false;
    let clock = 0;
    try {
        globalThis.fetch = async () => new Response('direct');
        const installed = installProxyFetch({
            env: {},
            platform: 'darwin',
            now: () => clock,
            run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return clashOn ? `  HTTPEnable : 1\n  HTTPPort : ${port}\n  HTTPProxy : 127.0.0.1\n` : '';
            },
        });
        assert.equal(installed, false);
        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.equal(await (await fetch('http://origin.test/')).text(), 'direct');
        clashOn = true;
        assert.equal(await (await fetch('http://origin.test/')).text(), 'direct', 'cached until the TTL passes');
        clock += 60_000;
        // First request after TTL triggers background refresh without blocking on the 20ms probe.
        const start = Date.now();
        assert.equal(await (await fetch('http://origin.test/')).text(), 'direct');
        assert.ok(Date.now() - start < 20);
        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.equal(await (await fetch('http://origin.test/')).text(), 'via proxy');
    } finally {
        globalThis.fetch = original;
        await close(proxy);
        await close(origin);
    }
});

test('a direct failure after a failed proxy names the proxy error', async () => {
    const doFetch = createProxyFetch({
        env: { HTTP_PROXY: 'http://127.0.0.1:9' },
        base: async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        },
    });
    const error = await doFetch('http://origin.test/').catch((caught) => caught);
    assert.match(describeFetchFailure(error), /UND_ERR_CONNECT_TIMEOUT; proxy http:\/\/127\.0\.0\.1:9: .*ECONNREFUSED/);
});

test('tunnel TLS handshake times out against a TLS-less blackhole server and honours AbortSignal (M5)', { timeout: 5000 }, async () => {
    // Blackhole TCP server: accepts connection and never sends ServerHello.
    const sockets = new Set();
    const blackhole = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    const blackholePort = await listen(blackhole);
    const { proxy, port: proxyPort } = await startProxy(blackholePort);
    try {
        let directCalls = 0;
        const doFetch = createProxyFetch({
            env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
            handshakeTimeoutMs: 60,
            base: async () => {
                directCalls += 1;
                throw new TypeError('fetch failed');
            },
        });
        const timedOut = await doFetch('https://origin.test/').catch((err) => err);
        assert.match(describeFetchFailure(timedOut), /TLS handshake timed out/);
        assert.equal(directCalls, 1);

        // Caller abort during TLS handshake rejects immediately without falling back to direct.
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('caller cancelled')), 30);
        const aborted = await doFetch('https://origin.test/', { signal: controller.signal }).catch((err) => err);
        assert.match(String(aborted?.message || aborted), /caller cancelled/);
        assert.equal(directCalls, 1);

        // Non-TLS blackhole server exercises requestTimeoutMs fallback when no signal is passed.
        const plainFetch = createProxyFetch({
            env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
            requestTimeoutMs: 60,
            base: async () => {
                throw new Error('should not fall back after request was written');
            },
        });
        const reqTimedOut = await plainFetch('http://origin.test/').catch((err) => err);
        assert.match(String(reqTimedOut?.message || reqTimedOut), /request timed out/);
    } finally {
        for (const s of sockets) s.destroy();
        await close(proxy);
        await close(blackhole);
    }
});

test('tunneled POST sends Content-Length and redirects honour error mode and cross-origin stripping on direct path', async () => {
    const seen = [];
    // A second port is a different origin. Avoid `localhost` here: Node 18
    // resolves it to ::1 first while these servers bind 127.0.0.1 only.
    const target = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            authorization: req.headers.authorization || '',
            xApiKey: req.headers['x-api-key'] || '',
            apiKey: req.headers['api-key'] || '',
            googKey: req.headers['x-goog-api-key'] || '',
            other: req.headers['x-other'] || '',
        }));
    });
    const targetPort = await listen(target);
    const origin = http.createServer((req, res) => {
        if (req.url === '/post') {
            seen.push({ contentLength: req.headers['content-length'], transferEncoding: req.headers['transfer-encoding'] });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/echo` });
        res.end();
    });
    const originPort = await listen(origin);
    const { proxy, port } = await startProxy(originPort);
    try {
        const doFetch = createProxyFetch({ env: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
        const postRes = await doFetch('http://origin.test/post', { method: 'POST', body: '{"hello":"world"}' });
        assert.equal(postRes.status, 200);
        await postRes.text();
        assert.deepEqual(seen[0], { contentLength: '17', transferEncoding: undefined });

        await assert.rejects(doFetch('http://origin.test/redir', { redirect: 'error' }), TypeError);

        // Direct-to-direct cross-origin redirect must strip all credential headers.
        const directOnly = createProxyFetch({ env: {} });
        await assert.rejects(directOnly(`http://127.0.0.1:${originPort}/redir`, { redirect: 'error' }), TypeError);
        const cross = await directOnly(`http://127.0.0.1:${originPort}/redir`, {
            headers: {
                Authorization: 'Bearer sec',
                'X-Api-Key': 'k1',
                'Api-Key': 'k2',
                'X-Goog-Api-Key': 'k3',
                'X-Other': 'kept',
            },
        });
        assert.deepEqual(await cross.json(), { authorization: '', xApiKey: '', apiKey: '', googKey: '', other: 'kept' });
    } finally {
        await close(proxy);
        await close(origin);
        await close(target);
    }
});
