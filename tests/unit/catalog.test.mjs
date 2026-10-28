import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_EXPECTATIONS, validateCatalog } from '../../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/omtp-catalog.json'), 'utf8'));
const adapterKeys = JSON.parse(fs.readFileSync(path.join(root, 'tools/native-adapter-keys.json'), 'utf8'));

test('bundled catalog validates against native adapter keys', () => {
  const result = validateCatalog(catalog, { expectedProviders: CATALOG_EXPECTATIONS.providers, minModels: CATALOG_EXPECTATIONS.minModels, adapterKeys });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(catalog.stats, { providers: result.providers, models: result.models });
});

test('catalog models are chat-only with no internal ids', () => {
  for (const provider of Object.values(catalog.providers)) {
    for (const model of provider.models) {
      assert.equal(model.kind, 'chat', `${provider.id}/${model.id}`);
      assert.ok(!/^(?:tab_|chat_)/.test(model.id), `internal model leaked: ${provider.id}/${model.id}`);
    }
  }
});

test('non-chat-only providers remain present with empty model lists', () => {
  for (const id of ['cloudflare-workers-ai', 'local', 'typesafe', 'web']) {
    assert.ok(catalog.providers[id], id);
    assert.equal(catalog.providers[id].models.length, 0);
  }
});
