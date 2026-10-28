import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector, rankEntries, resolveSelector } from '../../src/selector.js';

const entries = [
  { key: 'st/openai:openai/gpt-5.6', kind: 'st', provider: 'openai:openai', model: 'gpt-5.6', providerLabel: 'OpenAI', modelLabel: 'GPT 5.6' },
  { key: 'omp/cerebras/llama-4', kind: 'omp', provider: 'cerebras', model: 'llama-4', providerLabel: 'Cerebras', modelLabel: 'Llama 4' },
  { key: 'omp/openrouter/z-ai/glm-4.7', kind: 'omp', provider: 'openrouter', model: 'z-ai/glm-4.7', providerLabel: 'OpenRouter', modelLabel: 'GLM 4.7' },
];

test('parseSelector recognizes provider/model, quick slots, aliases and levels', () => {
  assert.deepEqual(parseSelector('openai:openai/gpt-5.6', { providers: ['openai:openai'] }), {
    raw: 'openai:openai/gpt-5.6', kind: 'ref', provider: 'openai:openai', model: 'gpt-5.6', level: null,
  });
  assert.equal(parseSelector('@3').kind, 'slot');
  assert.equal(parseSelector('@3').slot, 2);
  assert.equal(parseSelector('@fav').alias, 'favorites');
  assert.equal(parseSelector('@recent').alias, 'recents');
  assert.equal(parseSelector('claude:high', { entries }).level, 'high');
  assert.equal(parseSelector('z-ai/glm-4.7:high', { entries }).level, 'high');
});

test('rankEntries prioritizes exact provider/model, then exact model', () => {
  const ranked = rankEntries(entries, 'openai:openai/gpt-5.6', {});
  assert.equal(ranked[0].key, 'st/openai:openai/gpt-5.6');
  const byModel = rankEntries(entries, 'llama-4', {});
  assert.equal(byModel[0].key, 'omp/cerebras/llama-4');
});

test('rankEntries uses recents/favorites and substring fallback', () => {
  const ranked = rankEntries(entries, '', { favorites: [{ kind: 'omp', provider: 'cerebras', model: 'llama-4' }] });
  assert.equal(ranked[0].key, 'omp/cerebras/llama-4');
  const found = rankEntries(entries, 'glm', {});
  assert.equal(found[0].key, 'omp/openrouter/z-ai/glm-4.7');
});

test('resolveSelector returns an entry and level', () => {
  const result = resolveSelector('cerebras/llama-4:high', entries, { providers: ['cerebras'] });
  assert.equal(result.entry.key, 'omp/cerebras/llama-4');
  assert.equal(result.level, 'high');
  const missing = resolveSelector('no-such-model', entries, {});
  assert.ok(missing.error);
});
