import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
    buildAuthorizeUrl,
    cancelLogin,
    createPkcePair,
    customHookSupported,
    fillTemplate,
    getSession,
    mapCredential,
    parseAuthorizationInput,
    pickLocale,
    policyValue,
    startLogin,
    submitCode,
} from '../../server-plugin/lib/login-engine.mjs';

const anthropicPolicy = {
    kind: 'oauth-code',
    scopes: ['user:inference', 'user:profile'],
    scopeSeparator: ' ',
    pkce: true,
    state: 'hex',
    standardAuthorizeParams: true,
    authorizeParams: { code: 'true' },
    clientId: { value: 'dGVzdC1jbGllbnQtaWQ=', encoding: 'base64' },
    authorizeUrl: { value: 'https://claude.ai/oauth/authorize' },
    token: { url: { value: 'https://api.anthropic.com/v1/oauth/token' }, body: 'json', standard: true, params: { state: '{state}' } },
    credential: {
        access: { path: 'access_token' },
        refresh: { path: 'refresh_token' },
        expires: { mode: 'seconds', path: 'expires_in', skewMs: 300000 },
        email: { path: 'account.email_address' },
    },
};

const openrouterPolicy = {
    kind: 'oauth-code',
    pkce: true,
    state: 'none',
    standardAuthorizeParams: false,
    authorizeParams: { callback_url: '{redirect_uri}', code_challenge: '{code_challenge}', code_challenge_method: 'S256' },
    authorizeUrl: { value: 'https://openrouter.ai/auth' },
    token: { url: { value: 'https://openrouter.ai/api/v1/auth/keys' }, body: 'json', standard: false, params: { code: '{code}', code_verifier: '{code_verifier}' } },
    credential: { access: { path: 'key' }, expires: { mode: 'never' } },
};

test('policyValue decodes base64 client ids and prefers env overrides', () => {
    assert.equal(policyValue({ value: 'dGVzdC1jbGllbnQtaWQ=', encoding: 'base64' }), 'test-client-id');
    assert.equal(policyValue({ value: 'https://api.example.com', env: ['OMTP_TEST_BASE'] }, { OMTP_TEST_BASE: 'http://localhost:1' }), 'http://localhost:1');
    assert.equal(policyValue(undefined), '');
});

test('buildAuthorizeUrl emits the standard PKCE parameters', () => {
    const url = new URL(buildAuthorizeUrl(anthropicPolicy, {
        state: 'abc123',
        challenge: 'challenge-value',
        redirectUri: 'http://localhost:54545/callback',
    }));
    assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'test-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:54545/callback');
    assert.equal(url.searchParams.get('state'), 'abc123');
    assert.equal(url.searchParams.get('scope'), 'user:inference user:profile');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code'), 'true');
});

test('buildAuthorizeUrl honours non-standard parameter sets', () => {
    const url = new URL(buildAuthorizeUrl(openrouterPolicy, {
        state: 'ignored',
        challenge: 'chal',
        redirectUri: 'http://localhost:54549/callback',
    }));
    assert.equal(url.searchParams.get('client_id'), null);
    assert.equal(url.searchParams.get('state'), null);
    assert.equal(url.searchParams.get('response_type'), null);
    assert.equal(url.searchParams.get('callback_url'), 'http://localhost:54549/callback');
    assert.equal(url.searchParams.get('code_challenge'), 'chal');
});

test('createPkcePair produces an S256 challenge for its verifier', () => {
    const { verifier, challenge } = createPkcePair();
    assert.ok(verifier.length >= 43);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('parseAuthorizationInput accepts codes, redirect URLs and query fragments', () => {
    assert.deepEqual(parseAuthorizationInput('abc'), { code: 'abc' });
    assert.deepEqual(
        parseAuthorizationInput('http://localhost:54545/callback?code=xyz&state=st'),
        { code: 'xyz', state: 'st' },
    );
    assert.deepEqual(parseAuthorizationInput('code=xyz&state=st'), { code: 'xyz', state: 'st' });
    assert.throws(() => parseAuthorizationInput('   '));
    assert.throws(() => parseAuthorizationInput('http://localhost/callback?state=only'));
});

test('mapCredential maps token responses onto the stored shape', () => {
    const credential = mapCredential(anthropicPolicy.credential, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        account: { email_address: 'user@example.com' },
    }, { provider: 'anthropic', now: 1000 });
    assert.equal(credential.type, 'oauth');
    assert.equal(credential.access, 'access-1');
    assert.equal(credential.refresh, 'refresh-1');
    assert.equal(credential.expires, 1000 + 3600_000);
    assert.equal(credential.email, 'user@example.com');
});

test('mapCredential keeps durable keys as plain credentials', () => {
    const credential = mapCredential(openrouterPolicy.credential, { key: 'sk-or-123' }, { provider: 'openrouter', result: 'api-key' });
    assert.deepEqual(credential, { type: 'api-key', provider: 'openrouter', access: 'sk-or-123' });
});

test('mapCredential rejects responses without an access token', () => {
    assert.throws(() => mapCredential(anthropicPolicy.credential, { refresh_token: 'x' }), /access token/i);
});

test('fillTemplate substitutes known placeholders only', () => {
    assert.equal(fillTemplate('Enter code: {user_code}', { user_code: 'AB-12' }), 'Enter code: AB-12');
    assert.equal(fillTemplate('{unknown}', {}), '{unknown}');
});

test('pickLocale follows the client, then Accept-Language, then English', () => {
    assert.equal(pickLocale('zh-CN', ''), 'zh-cn');
    assert.equal(pickLocale('', 'zh-Hans-CN,zh;q=0.9,en;q=0.5'), 'zh-cn');
    assert.equal(pickLocale('fr-FR', 'fr-FR,fr;q=0.9'), 'en');
    assert.equal(pickLocale(undefined, undefined), 'en');
});

test('only ported custom hooks are advertised as runnable', () => {
    assert.equal(customHookSupported('openai-codex-device'), true);
    assert.equal(customHookSupported('kilo'), true);
    assert.equal(customHookSupported('github-copilot'), false);
    assert.equal(customHookSupported(''), false);
});

test('startLogin refuses custom hooks we do not implement', async () => {
    await assert.rejects(
        startLogin('github-copilot', { kind: 'custom', hook: 'github-copilot' }, { keyStore: {} }),
        /needs provider-specific code/,
    );
});

test('openai-codex-device hook requests a user code and polls the device endpoint', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        if (String(url).endsWith('/usercode')) {
            return new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 0 }), { status: 200 });
        }
        if (String(url).endsWith('/deviceauth/token')) {
            return new Response('pending', { status: 403 });
        }
        throw new Error(`unexpected ${url}`);
    };
    const started = await startLogin('openai-codex', {
        kind: 'custom',
        hook: 'openai-codex-device',
    }, { keyStore: {}, doFetch, env: { OMTP_OPENAI_CODEX_CLIENT_ID: 'test-codex-client' } });

    assert.equal(started.kind, 'custom');
    assert.equal(started.userCode, 'ABCD-1234');
    assert.match(started.url, /^https:\/\/auth\.openai\.com\/codex\/device$/);
    assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
    assert.match(calls[0].body, /test-codex-client/);

    // Leave no polling loop behind.
    assert.equal(cancelLogin(started.id), true);
});

test('openai-codex-device hook falls back to the catalog client id', async () => {
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        if (String(url).endsWith('/usercode')) {
            return new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 0 }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
    };
    const started = await startLogin('openai-codex', {
        kind: 'custom',
        hook: 'openai-codex-device',
        clientId: { value: 'catalog-codex-client', env: ['OMTP_OPENAI_CODEX_CLIENT_ID'] },
    }, { keyStore: {}, doFetch, env: {} });
    try {
        assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
        assert.match(calls[0].body, /catalog-codex-client/);
    } finally {
        cancelLogin(started.id);
    }
});

test('openai-codex-device hook exchanges authorization code with resolved client_id and stores credential', async () => {
    const calls = [];
    const stored = {};
    const jwtPayload = Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
        'https://api.openai.com/profile': { email: 'user@example.com' },
    })).toString('base64url');
    const fakeJwt = `e30.${jwtPayload}.sig`;

    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? String(init.body) : '' });
        if (String(url).endsWith('/usercode')) {
            return new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 0 }), { status: 200 });
        }
        if (String(url).endsWith('/deviceauth/token')) {
            return new Response(JSON.stringify({ authorization_code: 'code-123', code_verifier: 'ver-456' }), { status: 200 });
        }
        if (String(url).endsWith('/oauth/token')) {
            return new Response(JSON.stringify({ access_token: fakeJwt, refresh_token: 'ref-789', expires_in: 3600 }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
    };

    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
        const started = await startLogin('openai-codex', {
            kind: 'custom',
            hook: 'openai-codex-device',
        }, {
            keyStore: {
                async setProviderConfig(target, patch) {
                    stored[target] = patch;
                },
            },
            doFetch,
            env: { OMTP_OPENAI_CODEX_CLIENT_ID: 'resolved-codex-client' },
        });
        const session = getSession(started.id);
        await session.promise;
        assert.equal(session.status, 'done');
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }

    const tokenCall = calls.find((c) => c.url === 'https://auth.openai.com/oauth/token');
    assert.ok(tokenCall, 'expected token exchange request');
    const params = new URLSearchParams(tokenCall.body);
    assert.equal(params.get('client_id'), 'resolved-codex-client');
    assert.equal(params.get('code'), 'code-123');
    assert.equal(params.get('code_verifier'), 'ver-456');
    assert.ok(stored['openai-codex']?.apiKey, 'expected credential stored under openai-codex');
    const parsedCred = JSON.parse(stored['openai-codex'].apiKey);
    assert.equal(parsedCred.accountId, 'acct-1');
    assert.equal(parsedCred.email, 'user@example.com');
});

test('openai-codex-device hook refuses to start without a local client id', async () => {
    await assert.rejects(
        startLogin('openai-codex', { kind: 'custom', hook: 'openai-codex-device' }, {
            keyStore: {},
            env: {},
            doFetch: async () => { throw new Error('must not call the network'); },
        }),
        /client credentials for openai-codex are not configured/,
    );
});

test('kimi fingerprint headers identify the CLI and stay stable per install', async () => {
    const { headersForHook, headerHookSupported } = await import('../../server-plugin/lib/custom-logins/kimi-fingerprint.mjs');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-kimi-'));
    const first = headersForHook('kimi-fingerprint', root);
    assert.equal(first['X-Msh-Platform'], 'kimi_cli');
    assert.match(first['User-Agent'], /^KimiCLI\//);
    assert.equal(first['X-Msh-Device-Name'], os.hostname());
    assert.equal(headersForHook('kimi-fingerprint', root)['X-Msh-Device-Id'], first['X-Msh-Device-Id']);
    assert.deepEqual(headersForHook('unknown-hook', root), {});
    assert.equal(headerHookSupported('kimi-fingerprint'), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('buildAuthorizeUrl refuses a standard flow with no local client id', () => {
    // `stripCatalogCredentials` leaves `{ value: '', env: [...] }` behind; an
    // empty client_id makes Google answer `invalid_request`.
    assert.throws(
        () => buildAuthorizeUrl({
            ...anthropicPolicy,
            clientId: { value: '', env: ['OMTP_ANTHROPIC_CLIENT_ID'] },
        }, {
            state: 'state',
            challenge: 'challenge',
            redirectUri: 'http://localhost:54545/callback',
            env: {},
        }),
        /OMTP_ANTHROPIC_CLIENT_ID/,
    );
});

test('oauth-code exchange sends the locally resolved client id', async () => {
    const stored = {};
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        return new Response(JSON.stringify({
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
        }), { status: 200 });
    };
    const policy = {
        ...anthropicPolicy,
        clientId: { value: '', env: ['OMTP_ANTHROPIC_CLIENT_ID'] },
        token: { url: { value: 'https://api.anthropic.com/v1/oauth/token' }, body: 'json', standard: true },
        // A random high port keeps parallel test files from colliding; a busy
        // port only falls back to the manual paste path.
        callback: { port: 50_000 + Math.floor(Math.random() * 10_000), path: '/callback' },
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: {
            async setProviderConfig(target, patch) {
                stored[target] = patch;
            },
        },
        env: { OMTP_ANTHROPIC_CLIENT_ID: 'local-client-id' },
        doFetch,
    });
    try {
        assert.match(started.url, /client_id=local-client-id/);
        await submitCode(started.id, 'auth-code');
        assert.equal(getSession(started.id).status, 'done');

        const tokenCall = calls.find((call) => call.url === 'https://api.anthropic.com/v1/oauth/token');
        assert.ok(tokenCall, 'expected a token exchange request');
        const body = JSON.parse(tokenCall.body);
        assert.equal(body.client_id, 'local-client-id');
        assert.equal(body.code, 'auth-code');
        assert.ok(stored.anthropic?.apiKey, 'expected the credential to be stored');
    } finally {
        cancelLogin(started.id);
    }
});

test('callback reports the real exchange result and stays retryable', async () => {
    const port = 51_000 + Math.floor(Math.random() * 8_000);
    let attempts = 0;
    // First exchange fails the way a proxy-blocked machine fails; the retry works.
    const doFetch = async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
    };
    const stored = {};
    const policy = {
        ...anthropicPolicy,
        callback: { hostname: '127.0.0.1', port, path: '/callback' },
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: { async setProviderConfig(target, patch) { stored[target] = patch; } },
        doFetch,
    });
    try {
        const state = new URL(started.url).searchParams.get('state');
        const callbackUrl = `http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`;
        const response = await fetch(callbackUrl);
        const html = await response.text();

        // The page must not claim success when the token exchange failed.
        assert.equal(response.status, 400);
        assert.match(html, /Login failed/);
        assert.ok(html.includes(callbackUrl.replace(/&/g, '&amp;')), 'the page shows the URL to paste');
        assert.match(html, /paste it into the input box/);
        assert.equal(getSession(started.id).status, 'error');

        // Pasting that URL into SillyTavern retries instead of failing with
        // "Login is already error".
        const session = await submitCode(started.id, callbackUrl);
        assert.equal(session.status, 'done');
        assert.ok(stored.anthropic?.apiKey, 'expected the retry to store the credential');
    } finally {
        cancelLogin(started.id);
    }
});

test('sweep aborts a background device poll', async () => {
    const doFetch = async (url) => {
        if (String(url).endsWith('/usercode')) {
            return new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 0 }), { status: 200 });
        }
        return new Response('pending', { status: 403 });
    };
    const started = await startLogin('openai-codex', {
        kind: 'custom',
        hook: 'openai-codex-device',
    }, { keyStore: {}, doFetch, env: { OMTP_OPENAI_CODEX_CLIENT_ID: 'test-codex-client' } });
    const session = getSession(started.id);
    assert.equal(session.controller.signal.aborted, false);

    // Any session lookup sweeps expired sessions.
    session.startedAt = Date.now() - 11 * 60_000;
    getSession('missing');

    assert.equal(session.controller.signal.aborted, true);
    assert.equal(getSession(started.id), null);
});

test('a declared loopback redirect URI is advertised verbatim and bound', async () => {
    const port = 52_000 + Math.floor(Math.random() * 8_000);
    const redirectUri = `http://127.0.0.1:${port}/custom/callback`;
    const stored = {};
    const policy = {
        ...anthropicPolicy,
        clientId: { value: '', env: ['OMTP_ANTHROPIC_CLIENT_ID'] },
        callback: {
            port: 1,
            path: '/callback',
            hostname: 'localhost',
            portFallback: false,
            redirectUri: { value: redirectUri },
        },
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: { async setProviderConfig(target, patch) { stored[target] = patch; } },
        env: { OMTP_ANTHROPIC_CLIENT_ID: 'local-client-id' },
        doFetch: async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 }),
    });
    try {
        assert.equal(started.redirectUri, redirectUri);
        assert.equal(started.manual, false);
        assert.equal(new URL(started.url).searchParams.get('redirect_uri'), redirectUri);

        // The listener follows the declared URI's path, not the policy's.
        const wrongPath = await fetch(`http://127.0.0.1:${port}/callback?code=x`);
        assert.equal(wrongPath.status, 404);

        const state = new URL(started.url).searchParams.get('state');
        const response = await fetch(`${redirectUri}?code=auth-code&state=${state}`);
        assert.equal(response.status, 200);
        assert.equal(getSession(started.id).status, 'done');
        assert.ok(stored.anthropic?.apiKey, 'expected the credential to be stored');
    } finally {
        cancelLogin(started.id);
    }
});

test('a non-http redirect URI starts no listener and asks for a pasted code', async () => {
    const policy = {
        ...anthropicPolicy,
        clientId: { value: 'client-id' },
        callback: {
            port: 0,
            path: '/callback',
            hostname: 'localhost',
            manualOnly: true,
            nativeScheme: true,
            redirectUri: { value: 'zcode://zai-auth/callback' },
        },
    };
    const started = await startLogin('zai-coding-plan', policy, {
        keyStore: { async setProviderConfig() {} },
        doFetch: async () => new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 }),
    });
    try {
        assert.equal(started.redirectUri, 'zcode://zai-auth/callback');
        assert.equal(started.manual, true);
        assert.equal(getSession(started.id).server, undefined);
        assert.equal(new URL(started.url).searchParams.get('redirect_uri'), 'zcode://zai-auth/callback');
        // The catalog's generic instructions stay, followed by our explanation.
        assert.match(started.instructions, /no OS handler/i);
        assert.match(started.instructions, /paste it into SillyTavern/i);

        await submitCode(started.id, 'auth-code');
        assert.equal(getSession(started.id).status, 'done');
    } finally {
        cancelLogin(started.id);
    }
});

test('manualOnly policies never bind the callback port', async () => {
    const port = 54_000 + Math.floor(Math.random() * 5_000);
    const policy = {
        ...anthropicPolicy,
        clientId: { value: 'client-id' },
        callback: { port, path: '/callback', hostname: '127.0.0.1', manualOnly: true },
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: { async setProviderConfig() {} },
        doFetch: async () => { throw new Error('must not exchange'); },
    });
    try {
        assert.equal(started.manual, true);
        assert.equal(started.redirectUri, `http://127.0.0.1:${port}/callback`);
        assert.match(started.instructions, /manual entry/i);
        assert.equal(getSession(started.id).server, undefined);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/callback?code=x`));
    } finally {
        cancelLogin(started.id);
    }
});

test('a busy callback port degrades to manual paste instead of a dead redirect', async () => {
    const port = 55_000 + Math.floor(Math.random() * 4_500);
    const blocker = http.createServer((req, res) => res.end('blocked'));
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    const stored = {};
    const policy = {
        ...anthropicPolicy,
        clientId: { value: 'client-id' },
        callback: { port, path: '/callback', hostname: '127.0.0.1' },
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: { async setProviderConfig(target, patch) { stored[target] = patch; } },
        doFetch: async () => new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 }),
    });
    try {
        assert.equal(started.manual, true);
        assert.match(started.instructions, /already in use/i);
        assert.match(started.instructions, /EADDRINUSE/);
        assert.equal(getSession(started.id).server, undefined);

        // The flow stays usable: the code can still be pasted in.
        await submitCode(started.id, 'auth-code');
        assert.equal(getSession(started.id).status, 'done');
        assert.ok(stored.anthropic?.apiKey, 'expected the pasted exchange to store the credential');
    } finally {
        cancelLogin(started.id);
        await new Promise((resolve) => blocker.close(resolve));
    }
});

test('zai-mint-key stores the durable key minted after the exchange', async () => {
    const stored = {};
    const calls = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    const doFetch = async (url, init) => {
        const href = String(url);
        calls.push({ url: href, body: init?.body ? String(init.body) : '' });
        if (href === 'https://zcode.z.ai/api/v1/oauth/token') {
            return json({ code: 0, data: { zai: { access_token: 'oauth-access' } }, refresh_token: 'refresh-1' });
        }
        if (href === 'https://api.z.ai/api/auth/z/login') {
            return json({ code: 200, data: { access_token: 'biz-token' } });
        }
        if (href === 'https://api.z.ai/api/biz/customer/getCustomerInfo') {
            return json({
                code: 200,
                data: {
                    organizations: [{
                        organizationId: 'org-1',
                        isDefault: true,
                        projects: [{ projectId: 'proj-1', isDefault: true }],
                    }],
                },
            });
        }
        if (href === 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys') {
            return init?.method === 'POST'
                ? json({ code: 200, data: { apiKey: 'key-1' } })
                : json({ code: 200, data: { list: [] } });
        }
        if (href === 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-1') {
            return json({ code: 200, data: { secretKey: 'secret-1' } });
        }
        throw new Error(`unexpected ${href}`);
    };
    const policy = {
        kind: 'oauth-code',
        scopes: [],
        pkce: false,
        state: 'hex',
        standardAuthorizeParams: true,
        clientId: { value: 'zai-client' },
        authorizeUrl: { value: 'https://chat.z.ai/api/oauth/authorize' },
        callback: {
            port: 0,
            path: '/callback',
            hostname: 'localhost',
            manualOnly: true,
            nativeScheme: true,
            redirectUri: { value: 'zcode://zai-auth/callback' },
        },
        token: {
            url: { value: 'https://zcode.z.ai/api/v1/oauth/token' },
            body: 'json',
            standard: false,
            params: { provider: 'zai', code: '{code}', redirect_uri: '{redirect_uri}', state: '{state}' },
        },
        afterExchange: 'zai-mint-key',
        credential: {
            access: { path: 'data.zai.access_token' },
            refresh: { path: 'refresh_token' },
            expires: { mode: 'never' },
        },
        storeAs: 'zai',
    };
    const started = await startLogin('zai-coding-plan', policy, {
        keyStore: { async setProviderConfig(target, patch) { stored[target] = patch; } },
        doFetch,
        env: {},
    });
    try {
        await submitCode(started.id, 'auth-code');
        const session = getSession(started.id);
        assert.equal(session.status, 'done');
        assert.equal(session.credential.access, 'key-1.secret-1');
        assert.equal(JSON.parse(stored.zai.apiKey).access, 'key-1.secret-1');

        const tokenCall = calls.find((call) => call.url.endsWith('/oauth/token'));
        assert.equal(JSON.parse(tokenCall.body).redirect_uri, 'zcode://zai-auth/callback');
    } finally {
        cancelLogin(started.id);
    }
});

test('an unknown after-exchange hook leaves the login successful', async () => {
    const port = 56_000 + Math.floor(Math.random() * 3_000);
    const stored = {};
    const policy = {
        ...anthropicPolicy,
        clientId: { value: 'client-id' },
        callback: { port, path: '/callback', hostname: '127.0.0.1' },
        afterExchange: 'not-implemented-here',
    };
    const started = await startLogin('anthropic', policy, {
        keyStore: { async setProviderConfig(target, patch) { stored[target] = patch; } },
        doFetch: async () => new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 }),
    });
    try {
        await submitCode(started.id, 'auth-code');
        const session = getSession(started.id);
        assert.equal(session.status, 'done');
        assert.equal(session.credential.access, 'access');
        assert.equal(JSON.parse(stored.anthropic.apiKey).access, 'access');
    } finally {
        cancelLogin(started.id);
    }
});
