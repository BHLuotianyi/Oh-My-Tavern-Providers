import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyStore, KeyStoreUnreadableError } from '../../server-plugin/lib/key-store.mjs';

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

test('signing out also drops the key inherited from SillyTavern secrets', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => 'st-key' });
  const provider = { id: 'deepseek', gatewayAdapter: 'openai', baseUrl: 'http://x/v1', authKind: 'api-key', models: [] };

  // No OMTP config at all: the key is read straight from SillyTavern.
  let resolved = await store.resolveProvider(provider);
  assert.equal(resolved.keySource, 'st');
  assert.equal(resolved.available, true);

  await store.clearProviderKey('deepseek');

  resolved = await store.resolveProvider(provider);
  assert.equal(resolved.keySource, 'none');
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.available, false);

  // Saving a key in OMTP restores normal behaviour for a later sign-out.
  await store.setProviderConfig('deepseek', { apiKey: 'omtp-key', ignoreStSecret: false });
  await store.clearProviderKey('deepseek');
  resolved = await store.resolveProvider(provider);
  assert.equal(resolved.keySource, 'none');
});

test('concurrent writes keep every provider', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('seed', { apiKey: 'seed-key' });

  const [alpha, beta] = await Promise.all([
    store.setProviderConfig('alpha', { apiKey: 'alpha-key' }),
    store.setProviderConfig('beta', { apiKey: 'beta-key' }),
  ]);
  assert.equal(alpha.hasKey, true);
  assert.equal(beta.hasKey, true);

  const stored = JSON.parse(fs.readFileSync(path.join(root, 'providers.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.providers).sort(), ['alpha', 'beta', 'seed']);
  assert.equal((await store.getProviderConfig('seed')).apiKey, 'seed-key');
  assert.equal((await store.getProviderConfig('alpha')).apiKey, 'alpha-key');
  assert.equal((await store.getProviderConfig('beta')).apiKey, 'beta-key');
});

test('a concurrent write cannot resurrect a signed-out key', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('mock', { apiKey: 'mock-key' });

  await Promise.all([
    store.clearProviderKey('mock'),
    store.setProviderConfig('other', { apiKey: 'other-key' }),
  ]);

  const mock = await store.getProviderConfig('mock');
  assert.equal(mock.apiKey, undefined);
  assert.equal(mock.ignoreStSecret, true);
  assert.equal((await store.getProviderConfig('other')).apiKey, 'other-key');
});

test('concurrent first writes share one master key', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });

  await Promise.all([
    store.setProviderConfig('alpha', { apiKey: 'alpha-key' }),
    store.setProviderConfig('beta', { apiKey: 'beta-key' }),
  ]);

  const masterKey = fs.readFileSync(path.join(root, 'master.key'), 'utf8').trim();
  assert.match(masterKey, /^[0-9a-f]{64}$/);
  assert.equal((await store.getProviderConfig('alpha')).apiKey, 'alpha-key');
  assert.equal((await store.getProviderConfig('beta')).apiKey, 'beta-key');
});

test('saving refuses to overwrite unreadable ciphertext', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('mock', { apiKey: 'first' });
  const file = path.join(root, 'providers.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.providers.mock = 'enc:v1:AA==:BB==:CC==';
  fs.writeFileSync(file, JSON.stringify(raw));
  const before = fs.readFileSync(file, 'utf8');

  await assert.rejects(store.setProviderConfig('mock', { apiKey: 'second' }), KeyStoreUnreadableError);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a corrupt providers.json is never overwritten', async () => {
  const root = tempRoot();
  const store = new KeyStore({ root, resolveStSecret: () => '' });
  await store.setProviderConfig('mock', { apiKey: 'first' });
  const file = path.join(root, 'providers.json');
  fs.writeFileSync(file, '{ not json');

  await assert.rejects(store.setProviderConfig('mock', { apiKey: 'second' }), KeyStoreUnreadableError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});
