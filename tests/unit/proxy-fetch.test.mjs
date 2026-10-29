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

test('proxyFor ignores proxy URLs that are not http or https', () => {
    const socks = { ALL_PROXY: 'socks5://user:pass@proxy.lan:1080' };
    assert.equal(proxyFor(new URL('http://example.com/v1'), socks), null);
    assert.equal(proxyFor(new URL('https://example.com/v1'), socks), null);

    const mixed = { ALL_PROXY: 'socks5://proxy.lan:1080', HTTP_PROXY: 'http://http.lan:3128' };
    assert.equal(proxyFor(new URL('http://example.com/v1'), mixed)?.hostname, 'http.lan');
    assert.equal(proxyFor(new URL('https://example.com/v1'), mixed)?.hostname, 'http.lan');

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

test('installProxyFetch falls back to the system proxy and can be restored', () => {
    const original = globalThis.fetch;
    try {
        const installed = installProxyFetch({
            env: {},
            platform: 'darwin',
            run: () => '  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n',
        });
        assert.equal(installed, true);
        assert.notEqual(globalThis.fetch, original);
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
