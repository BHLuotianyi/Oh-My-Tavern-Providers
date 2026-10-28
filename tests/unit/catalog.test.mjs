import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCatalog, validateCatalog } from '../../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/omtp-catalog.json'), 'utf8'));
const adapterKeys = JSON.parse(fs.readFileSync(path.join(root, 'tools/native-adapter-keys.json'), 'utf8'));
const map = JSON.parse(fs.readFileSync(path.join(root, 'tools/provider-map.source.json'), 'utf8'));

test('bundled catalog has 99 providers and 5770 chat models', () => {
  assert.equal(Object.keys(catalog.providers).length, 99);
  assert.equal(catalog.stats.models, 5770);
});

test('bundled catalog validates against native adapter keys', () => {
  const result = validateCatalog(catalog, { expectedProviders: 99, minModels: 5700, adapterKeys });
  assert.deepEqual(result.errors, []);
});

test('every catalog provider has exactly one mapping outcome', () => {
  for (const provider of Object.values(catalog.providers)) {
    assert.ok(provider.stAdapter || provider.gatewayAdapter || provider.unsupportedReason, provider.id);
  }
});

test('catalog model keys are unique and chat-only', () => {
  const seen = new Set();
  for (const provider of Object.values(catalog.providers)) {
    for (const model of provider.models) {
      const key = `${provider.id}/${model.id}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
      assert.equal(model.kind, 'chat');
      assert.ok(Array.isArray(model.input));
      assert.ok(!/^(?:tab_|chat_)/.test(model.id), `internal model leaked: ${key}`);
    }
  }
  assert.equal(seen.size, 5770);
});

test('non-chat-only providers remain present with empty model lists', () => {
  for (const id of ['cloudflare-workers-ai', 'local', 'typesafe', 'web']) {
    assert.ok(catalog.providers[id], id);
    assert.equal(catalog.providers[id].models.length, 0);
  }
});

test('normalizer is deterministic for provider metadata', (t) => {
  const modelsPath = process.env.OMP_ROOT ? path.join(process.env.OMP_ROOT, 'packages/catalog/src/models.json') : '/home/winster42/test/oh-my-pi/packages/catalog/src/models.json';
  const rulesPath = path.join(path.dirname(modelsPath), 'compat/rules.json');
  if (!fs.existsSync(modelsPath) || !fs.existsSync(rulesPath)) return t.skip('local OMP catalog not available');
  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const normalized = normalizeCatalog(models, rules, map, { generatedAt: 'fixed' });
  assert.equal(normalized.providers.anthropic.label, 'Anthropic (Claude Pro/Max)');
  assert.deepEqual(normalized.providers.anthropic.authKinds, ['api-key', 'oauth']);
  assert.equal(normalized.providers.anthropic.stAdapter, 'openai:claude');
  assert.equal(normalized.providers.anthropic.gatewayAdapter, 'anthropic');
  assert.equal(normalized.providers.azure.gatewayAdapter, 'azure-responses');
  assert.ok(normalized.providers.azure.baseUrl);
});
