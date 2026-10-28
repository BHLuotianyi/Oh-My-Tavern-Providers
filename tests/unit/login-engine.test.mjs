import test from 'node:test';
import assert from 'node:assert/strict';
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

    assert.equal(started.kind, 'device-code');
    assert.equal(started.userCode, 'ABCD-1234');
    assert.match(started.url, /^https:\/\/auth\.openai\.com\/codex\/device$/);
    assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
    assert.match(calls[0].body, /test-codex-client/);

    // Leave no polling loop behind.
    assert.equal(cancelLogin(started.id), true);
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
