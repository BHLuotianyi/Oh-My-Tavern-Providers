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
    assert.deepEqual(loginEnv(root, 'anthropic', {}), {});
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
