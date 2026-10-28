import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyStore } from '../../server-plugin/lib/key-store.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-keystore-'));
}

test('key store encrypts provider configs and round-trips them', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('mock', {
    label: 'Mock',
    adapter: 'openai',
    baseUrl: 'http://127.0.0.1:4199/v1',
    apiKey: 'secret-value',
    custom: true,
    models: [{ id: 'echo', name: 'Echo' }],
  });

  const raw = fs.readFileSync(path.join(root, 'providers.json'), 'utf8');
  assert.ok(!raw.includes('secret-value'));
  assert.match(raw, /enc:v1:/);
  assert.equal(fs.statSync(path.join(root, 'master.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'providers.json')).mode & 0o777, 0o600);

  const config = await store.getProviderConfig('mock');
  assert.equal(config.apiKey, 'secret-value');
  assert.equal(config.label, 'Mock');
  assert.equal(config.models[0].id, 'echo');
});

test('key store reports unreadable ciphertext without corrupting it', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('mock', { apiKey: 'first' });
  const file = path.join(root, 'providers.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.providers.mock = 'enc:v1:AA==:BB==:CC==';
  fs.writeFileSync(file, JSON.stringify(raw));
  const result = await store.getConfigSafe('mock');
  assert.equal(result.unreadable, true);
  assert.deepEqual(result.config, {});
  assert.ok(fs.readFileSync(file, 'utf8').includes('enc:v1:AA=='));
});

test('key resolution order prefers OMTP store over ST and env', async () => {
  const root = tempRoot();
  const store = new KeyStore({
    root,
    resolveStSecret: () => 'st-key',
    env: { MOCK_API_KEY: 'env-key' },
  });
  const provider = { id: 'mock', gatewayAdapter: 'openai', baseUrl: 'http://x/v1', authKind: 'api-key', models: [] };
  let resolved = await store.resolveProvider(provider);
  assert.equal(resolved.apiKey, 'st-key');
  assert.equal(resolved.keySource, 'st');
  await store.setProviderConfig('mock', { apiKey: 'omtp-key' });
  resolved = await store.resolveProvider(provider);
  assert.equal(resolved.apiKey, 'omtp-key');
  assert.equal(resolved.keySource, 'omtp');
});
