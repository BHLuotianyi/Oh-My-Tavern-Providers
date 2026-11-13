import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    clientEnvNames,
    loadOAuthClients,
    loginEnv,
    providerEnvPrefix,
    resolveOAuthClient,
} from '../../server-plugin/lib/oauth-clients.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-oauth-clients-'));

test('client credentials come from the local file, never the source tree', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'oauth-clients.json'), JSON.stringify({
        'google-antigravity': { clientId: 'local-id', clientSecret: 'local-secret' },
        'openai-codex': { clientId: 'codex-id' },
        broken: 'not-an-object',
        empty: {},
    }));
    assert.deepEqual(loadOAuthClients(root)['google-antigravity'], { clientId: 'local-id', clientSecret: 'local-secret' });
    assert.equal(loadOAuthClients(root).broken, undefined);
    assert.equal(loadOAuthClients(root).empty, undefined);

    const resolved = resolveOAuthClient(root, 'google-antigravity', {});
    assert.equal(resolved.clientId, 'local-id');
    assert.equal(resolved.clientSecret, 'local-secret');

    // Login engine overlay exposes exactly the env names the catalog references.
    assert.deepEqual(loginEnv(root, 'google-antigravity', {}), {
        OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID: 'local-id',
        OMTP_GOOGLE_ANTIGRAVITY_CLIENT_SECRET: 'local-secret',
    });
    assert.deepEqual(clientEnvNames('google-gemini-cli'), {
        clientId: ['OMTP_GOOGLE_GEMINI_CLI_CLIENT_ID'],
        clientSecret: ['OMTP_GOOGLE_GEMINI_CLI_CLIENT_SECRET'],
    });
    assert.equal(providerEnvPrefix('xai-oauth'), 'XAI_OAUTH');

    // Environment variables win over the file.
    const fromEnv = resolveOAuthClient(root, 'google-antigravity', {
        OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID: 'env-id',
        OMTP_GOOGLE_ANTIGRAVITY_CLIENT_SECRET: 'env-secret',
    });
    assert.deepEqual(fromEnv, { clientId: 'env-id', clientSecret: 'env-secret' });
});

test('missing or malformed local config resolves to empty credentials', () => {
    const root = tempRoot();
    assert.deepEqual(resolveOAuthClient(root, 'anthropic', {}), { clientId: '', clientSecret: '' });
    fs.writeFileSync(path.join(root, 'oauth-clients.json'), '{ nope');
    assert.deepEqual(loadOAuthClients(root), {});
});

test('catalog layers keep public client ids but never secrets', async () => {
    const { stripCatalogCredentials } = await import('../../server-plugin/lib/catalog-normalize.mjs');
    const providers = {
        'google-gemini-cli': {
            authLogin: {
                clientId: { value: 'NjgxMjU1ODA5Mzk1LW9vOGZ0', encoding: 'base64' },
                clientSecret: { value: 'R09DU1BYLTR1SGdNUG0t', encoding: 'base64' },
                kind: 'oauth-code',
            },
        },
        'openai-codex': { authLogin: { clientId: { value: 'test-codex-client' } } },
        anthropic: { authLogin: { clientId: { value: 'test-anthropic-client', encoding: 'base64' } } },
        plain: { label: 'No login' },
    };
    const stripped = stripCatalogCredentials(providers);
    // Providers in LOCAL_ONLY_CLIENTS keep both halves on the user's machine.
    assert.deepEqual(stripped['google-gemini-cli'].authLogin.clientId, {
        value: '',
        encoding: 'base64',
        env: ['OMTP_GOOGLE_GEMINI_CLI_CLIENT_ID'],
    });
    assert.deepEqual(stripped['google-gemini-cli'].authLogin.clientSecret, {
        value: '',
        encoding: 'base64',
        env: ['OMTP_GOOGLE_GEMINI_CLI_CLIENT_SECRET'],
    });
    // A client id is a public app identifier, so it ships (upstream does too).
    assert.deepEqual(stripped['openai-codex'].authLogin.clientId, {
        value: 'test-codex-client',
        env: ['OMTP_OPENAI_CODEX_CLIENT_ID'],
    });
    assert.deepEqual(stripped.anthropic.authLogin.clientId, {
        value: 'test-anthropic-client',
        encoding: 'base64',
        env: ['OMTP_ANTHROPIC_CLIENT_ID'],
    });
    assert.equal(stripped['google-gemini-cli'].authLogin.kind, 'oauth-code');
    assert.equal(stripped.plain.label, 'No login');
    // Input untouched.
    assert.equal(providers['openai-codex'].authLogin.clientId.value, 'test-codex-client');
});

test('token refresh falls back to the catalog client id', async () => {
    const { resolveAccessToken } = await import('../../server-plugin/lib/oauth.mjs');
    const root = tempRoot();
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'next', expires_in: 3600 }), { status: 200 });
    };
    // Expired structured credential with no local oauth-clients.json: the public
    // client id in the catalog policy is the only source.
    const resolved = {
        id: 'anthropic',
        keySource: 'omtp',
        apiKey: JSON.stringify({ type: 'oauth', access: 'stale', refresh: 'refresh-token', expires: 1 }),
    };
    const result = await resolveAccessToken(resolved, null, doFetch, root, {
        clientId: { value: 'catalog-client' },
    });
    assert.equal(result.apiKey, 'fresh');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.client_id, 'catalog-client');
    assert.equal(body.refresh_token, 'refresh-token');
    fs.rmSync(root, { recursive: true, force: true });
});

test('generic refresh refreshes an oauth-code policy and writes back to the storeAs row', async () => {
    const { resolveAccessToken } = await import('../../server-plugin/lib/oauth.mjs');
    const root = tempRoot();
    const calls = [];
    const writes = [];
    const jwtPayload = Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fresh' },
        'https://api.openai.com/profile': { email: 'fresh@example.com' },
    })).toString('base64url');
    const freshAccess = `e30.${jwtPayload}.sig`;
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body || '') });
        return new Response(JSON.stringify({
            access_token: freshAccess,
            refresh_token: 'next-refresh',
            expires_in: 3600,
        }), { status: 200 });
    };
    const keyStore = {
        root,
        async getProviderConfig() { return {}; },
        async setProviderConfig(target, patch) { writes.push({ target, patch }); },
    };
    const resolved = {
        id: 'openai-codex-alias',
        keySource: 'omtp',
        apiKey: JSON.stringify({
            type: 'oauth',
            provider: 'openai-codex-alias',
            access: 'stale-access',
            refresh: 'old-refresh',
            expires: 1,
        }),
    };
    const policy = {
        kind: 'oauth-code',
        storeAs: 'openai-codex',
        clientId: { value: 'codex-client' },
        token: { url: { value: 'https://auth.openai.com/oauth/token' }, body: 'form', standard: true },
        afterExchange: 'openai-codex-profile',
        credential: {
            access: { path: 'access_token' },
            refresh: { path: 'refresh_token' },
            expires: { mode: 'seconds', path: 'expires_in', skewMs: 0 },
        },
    };
    try {
        const result = await resolveAccessToken(resolved, keyStore, doFetch, root, policy);
        assert.equal(result.refreshError, null);
        assert.equal(result.apiKey, freshAccess);
        assert.equal(result.credential.accountId, 'acct-fresh');
        assert.equal(result.credential.email, 'fresh@example.com');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
        const params = new URLSearchParams(calls[0].body);
        assert.equal(params.get('grant_type'), 'refresh_token');
        assert.equal(params.get('refresh_token'), 'old-refresh');
        assert.equal(params.get('client_id'), 'codex-client');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].target, 'openai-codex');
        assert.equal(JSON.parse(writes[0].patch.apiKey).access, freshAccess);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveAccessToken re-reads stored credential inside the refresh lock', async () => {
    const { resolveAccessToken } = await import('../../server-plugin/lib/oauth.mjs');
    const root = tempRoot();
    let fetchCalls = 0;
    const doFetch = async () => {
        fetchCalls += 1;
        throw new Error('must not refresh when store already has a fresh token');
    };
    const freshCred = {
        type: 'oauth',
        access: 'already-fresh',
        refresh: 'rotated-refresh',
        expires: Date.now() + 3_600_000,
    };
    const keyStore = {
        root,
        async getProviderConfig(id) {
            assert.equal(id, 'kimi-code');
            return { apiKey: JSON.stringify(freshCred) };
        },
    };
    const resolved = {
        id: 'kimi-code',
        keySource: 'omtp',
        apiKey: JSON.stringify({ type: 'oauth', access: 'stale', refresh: 'old-refresh', expires: 1 }),
    };
    const policy = {
        kind: 'device-code',
        clientId: { value: 'kimi-client' },
        token: { url: { value: 'https://auth.kimi.com/api/oauth/token' }, body: 'form', standard: true },
        credential: { access: { path: 'access_token' }, refresh: { path: 'refresh_token' } },
    };
    try {
        const result = await resolveAccessToken(resolved, keyStore, doFetch, root, policy);
        assert.equal(result.refreshError, null);
        assert.equal(result.apiKey, 'already-fresh');
        assert.equal(fetchCalls, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveAccessToken reports a clear error when refresh is unsupported by policy', async () => {
    const { resolveAccessToken } = await import('../../server-plugin/lib/oauth.mjs');
    const resolved = {
        id: 'xai-oauth',
        keySource: 'omtp',
        apiKey: JSON.stringify({ type: 'oauth', access: 'stale', refresh: 'refresh-token', expires: 1 }),
    };
    const result = await resolveAccessToken(resolved, null, async () => { throw new Error('no network'); }, '', {
        kind: 'device-code',
        token: { url: { hook: 'xai-token-endpoint' } },
        credential: { access: { path: 'access_token' }, refresh: { path: 'refresh_token' } },
    });
    assert.equal(result.apiKey, 'stale');
    assert.match(String(result.refreshError?.message || ''), /xai-token-endpoint/);
});
