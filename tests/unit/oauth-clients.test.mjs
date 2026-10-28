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

test('catalog layers never carry OAuth client material', async () => {
    const { stripCatalogCredentials } = await import('../../server-plugin/lib/catalog-normalize.mjs');
    const providers = {
        'google-antigravity': {
            authLogin: {
                clientId: { value: 'MTA3MTAwNjA2MDU5MS10', encoding: 'base64' },
                clientSecret: { value: 'R09DU1BYLUs1', encoding: 'base64' },
                kind: 'oauth-code',
            },
        },
        'openai-codex': { authLogin: { clientId: { value: 'test-codex-client' } } },
        plain: { label: 'No login' },
    };
    const stripped = stripCatalogCredentials(providers);
    assert.deepEqual(stripped['google-antigravity'].authLogin.clientId, {
        value: '',
        env: ['OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID'],
    });
    assert.deepEqual(stripped['google-antigravity'].authLogin.clientSecret, {
        value: '',
        env: ['OMTP_GOOGLE_ANTIGRAVITY_CLIENT_SECRET'],
    });
    assert.deepEqual(stripped['openai-codex'].authLogin.clientId, {
        value: '',
        env: ['OMTP_OPENAI_CODEX_CLIENT_ID'],
    });
    assert.equal(stripped['google-antigravity'].authLogin.kind, 'oauth-code');
    assert.equal(stripped.plain.label, 'No login');
    // Input untouched.
    assert.equal(providers['openai-codex'].authLogin.clientId.value, 'test-codex-client');
});
