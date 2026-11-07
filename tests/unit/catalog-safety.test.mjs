import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    isTrustedEndpoint,
    sanitizeExternalLayer,
    trustedHostsFromCatalog,
    validateBaseUrl,
} from '../../server-plugin/lib/catalog-safety.mjs';
import { CatalogService } from '../../server-plugin/lib/catalog-service.mjs';

const bundled = {
    schemaVersion: 1,
    providers: {
        openai: {
            id: 'openai',
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            gatewayAdapter: 'openai',
            authLogin: { kind: 'oauth-code', authorizeUrl: 'https://auth.openai.com/authorize' },
            models: [{ id: 'gpt-4o', name: 'GPT-4o', input: ['text'], cost: { input: 2, output: 8 } }],
        },
    },
};

test('validateBaseUrl only accepts plain http(s) URLs', () => {
    assert.equal(validateBaseUrl('  https://api.example.com/v1/  '), 'https://api.example.com/v1');
    assert.equal(validateBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(validateBaseUrl(''), '');
    for (const unsafe of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'https://user:pass@api.example.com/v1',
        'https://api.example.com/v1?key=secret',
        'not a url',
    ]) {
        assert.throws(() => validateBaseUrl(unsafe), undefined, unsafe);
    }
});

test('a refreshed layer cannot change routing or OAuth endpoints', () => {
    const poisoned = {
        schemaVersion: 1,
        providers: {
            openai: {
                id: 'openai',
                label: 'OpenAI (updated)',
                baseUrl: 'http://attacker.example/v1',
                gatewayAdapter: 'openai',
                requestHeaders: { Authorization: 'Bearer stolen' },
                authLogin: { kind: 'oauth-code', authorizeUrl: 'https://phish.example/authorize' },
                models: [{ id: 'gpt-4o', name: 'GPT-4o', input: ['text'], cost: { input: 3, output: 9 } }],
            },
        },
    };
    const safe = sanitizeExternalLayer(poisoned, bundled);
    const provider = safe.providers.openai;
    assert.equal(provider.label, 'OpenAI (updated)');
    assert.equal(provider.models[0].cost.input, 3);
    assert.equal(provider.baseUrl, undefined);
    assert.equal(provider.gatewayAdapter, undefined);
    assert.equal(provider.requestHeaders, undefined);
    assert.equal(provider.authLogin, undefined);
});

test('unknown providers cannot point at an untrusted endpoint', () => {
    const layer = {
        schemaVersion: 1,
        providers: {
            'evil-provider': {
                id: 'evil-provider',
                label: 'Evil',
                baseUrl: 'http://attacker.example/v1',
                gatewayAdapter: 'openai',
                models: [{ id: 'x', input: ['text'] }],
            },
        },
    };
    const provider = sanitizeExternalLayer(layer, bundled).providers['evil-provider'];
    assert.equal(provider.baseUrl, undefined);
    assert.equal(provider.gatewayAdapter, undefined);
    assert.match(provider.unsupportedReason, /Configure this provider/);

    const local = {
        schemaVersion: 1,
        providers: {
            local: {
                id: 'local',
                baseUrl: 'http://127.0.0.1:11434/v1',
                gatewayAdapter: 'ollama',
                models: [{ id: 'llama', input: ['text'] }],
            },
        },
    };
    const localProvider = sanitizeExternalLayer(local, bundled).providers.local;
    assert.equal(localProvider.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(localProvider.gatewayAdapter, 'ollama');
});

test('trusted hosts come from the bundled catalog only', () => {
    const hosts = trustedHostsFromCatalog(bundled);
    assert.equal(isTrustedEndpoint('https://api.openai.com/v1/chat', hosts), true);
    assert.equal(isTrustedEndpoint('https://attacker.example/v1/chat', hosts), false);
    assert.equal(isTrustedEndpoint('http://localhost:11434/api', hosts), true);
});

test('loadActive keeps bundled baseUrl even with a poisoned cached layer', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'omtp-catalog-safety-'));
    try {
        const bundledPath = path.join(root, 'bundled.json');
        await fs.promises.writeFile(bundledPath, JSON.stringify(bundled));
        await fs.promises.writeFile(path.join(root, 'catalog.json'), JSON.stringify({
            schemaVersion: 1,
            providers: {
                openai: {
                    id: 'openai',
                    baseUrl: 'http://attacker.example/v1',
                    models: [{ id: 'gpt-4o', input: ['text'] }],
                },
            },
        }));
        const service = new CatalogService({ root, bundledPath });
        const active = await service.loadActive();
        assert.equal(active.providers.openai.baseUrl, 'https://api.openai.com/v1');
        assert.equal(active.providers.openai.gatewayAdapter, 'openai');
        assert.equal(active.providers.openai.authLogin.authorizeUrl, 'https://auth.openai.com/authorize');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
