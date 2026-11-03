import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/omtp-catalog.json'), 'utf8'));

test('catalog stats match its provider and model lists', () => {
  // `npm run validate` checks the catalog itself; the counters are what the
  // hub displays, so they must not drift from the bundled snapshot.
  const providers = Object.keys(catalog.providers).length;
  const models = Object.values(catalog.providers).reduce((sum, provider) => sum + provider.models.length, 0);
  assert.deepEqual(catalog.stats, { providers, models });
});

test('catalog models have no internal completion ids', () => {
  for (const provider of Object.values(catalog.providers)) {
    for (const model of provider.models) {
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
