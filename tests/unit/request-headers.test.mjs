import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureInstallId, INSTALL_ID_FILE } from '../../server-plugin/lib/config.mjs';
import {
    applyRequestHeaders,
    deriveSessionId,
    normalizeRequestHeaders,
    requestHeaderPolicy,
} from '../../server-plugin/lib/request-headers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const POLICY = Object.freeze({
    sessionHeader: 'x-opencode-session',
    sessionPrefix: 'ses_',
    sessionForce: true,
    spoofUserAgent: 'opencode/latest/2.0.6/cli',
});

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-headers-'));
}

test('policy validation rejects malformed declarations', () => {
    assert.throws(() => normalizeRequestHeaders('p', null), /must be an object/);
    assert.throws(() => normalizeRequestHeaders('p', { sessionHeader: 'bad header' }), /sessionHeader/);
    assert.throws(() => normalizeRequestHeaders('p', { sessionPrefix: 'ses_\n' }), /sessionPrefix/);
    assert.throws(() => normalizeRequestHeaders('p', { spoofUserAgent: 'x\r\ny' }), /spoofUserAgent/);
    assert.throws(() => normalizeRequestHeaders('p', {}), /declares nothing/);
    assert.deepEqual(normalizeRequestHeaders('p', { ...POLICY }), { ...POLICY });
    assert.equal(requestHeaderPolicy({ requestHeaders: { sessionHeader: 'x' } }).sessionHeader, 'x');
    assert.equal(requestHeaderPolicy({}), null);
});

test('install id is a stable 0600 UUID per root', async () => {
    const root = tempRoot();
    const first = await ensureInstallId(root);
    const second = await ensureInstallId(root);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const file = path.join(root, INSTALL_ID_FILE);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), first);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const other = await ensureInstallId(tempRoot());
    assert.notEqual(other, first);
});

test('derived session ids are deterministic, isolated and opaque', () => {
    const install = '7f1c2a44-8a1b-4c65-9d2e-3f0a1b2c3d4e';
    const a = deriveSessionId(install, 'opencode-go', 'chat one');
    assert.equal(a, deriveSessionId(install, 'opencode-go', 'chat one'));
    assert.notEqual(a, deriveSessionId(install, 'opencode-go', 'chat two'));
    assert.notEqual(a, deriveSessionId(install, 'opencode-zen', 'chat one'));
    assert.notEqual(a, deriveSessionId('other-install', 'opencode-go', 'chat one'));
    assert.match(a, /^ses_[0-9A-Za-z]{24}$/);
    assert.ok(!a.includes('chat'));
});

test('session header forces the derived id but user headers win elsewhere', () => {
    const headers = { 'X-Opencode-Session': 'stale', 'X-Keep': 'yes' };
    applyRequestHeaders(headers, {
        policy: POLICY,
        providerId: 'opencode-go',
        chatId: 'chat one',
        installId: 'install',
        stUserAgent: 'SillyTavern/1.13.0',
        spoof: false,
    });
    const session = deriveSessionId('install', 'opencode-go', 'chat one');
    assert.equal(headers['x-opencode-session'], session);
    assert.equal(headers['X-Opencode-Session'], undefined);
    assert.equal(headers['X-Keep'], 'yes');
    // Spoof off forwards the caller's own UA.
    assert.equal(headers['User-Agent'], 'SillyTavern/1.13.0');
});

test('spoof on replaces the UA; no chat id falls back to the install id', () => {
    const headers = { 'User-Agent': 'stdlib' };
    applyRequestHeaders(headers, {
        policy: POLICY,
        providerId: 'opencode-go',
        chatId: '',
        installId: 'install',
        stUserAgent: 'SillyTavern/1.13.0',
        spoof: true,
    });
    assert.equal(headers['x-opencode-session'], 'install');
    assert.equal(headers['User-Agent'], POLICY.spoofUserAgent);
    assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent').length, 1);
});

test('providers without a policy keep their headers untouched', () => {
    const headers = { Authorization: 'Bearer key' };
    applyRequestHeaders(headers, { policy: null, providerId: 'openrouter', chatId: 'c', installId: 'i' });
    assert.deepEqual(headers, { Authorization: 'Bearer key' });
});

test('bundled catalog declares the opencode identity policy', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog/omtp-catalog.json'), 'utf8'));
    for (const id of ['opencode-go', 'opencode-zen']) {
        const provider = catalog.providers[id];
        assert.ok(provider, id);
        assert.equal(provider.stAdapter, null);
        assert.equal(provider.gatewayAdapter, 'openai');
        assert.deepEqual(provider.requestHeaders, { ...POLICY });
    }
});
