import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyStore, KeyStoreUnreadableError } from '../../server-plugin/lib/key-store.mjs';

test('a corrupted master.key is backed up, never silently regenerated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-master-'));
    try {
        const store = new KeyStore({ root, resolveStSecret: () => '' });
        await store.setProviderConfig('mock', { apiKey: 'first-key' });
        const keyFile = path.join(root, 'master.key');
        const original = fs.readFileSync(keyFile, 'utf8');

        fs.writeFileSync(keyFile, 'truncated\n');
        const reopened = new KeyStore({ root, resolveStSecret: () => '' });
        await assert.rejects(
            () => reopened.setProviderConfig('mock', { apiKey: 'should-not-be-written' }),
            KeyStoreUnreadableError,
        );
        assert.equal(fs.readFileSync(keyFile, 'utf8'), 'truncated\n');
        await assert.rejects(() => reopened.getProviderConfig('mock'), KeyStoreUnreadableError);
        const corruptBackups = fs.readdirSync(root).filter((name) => name.startsWith('master.key.corrupt-'));
        assert.equal(corruptBackups.length, 1);
        // The user can recover everything by restoring the backed-up key.
        fs.writeFileSync(keyFile, original);
        const restored = new KeyStore({ root, resolveStSecret: () => '' });
        assert.equal((await restored.getProviderConfig('mock')).apiKey, 'first-key');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
