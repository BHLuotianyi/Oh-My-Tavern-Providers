import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOmpModels } from '../../server-plugin/lib/omp-models-format.mjs';
import { normalizeCatalog } from '../../server-plugin/lib/catalog-normalize.mjs';

// Hand-encoded in OMP's compact layout: shared nodes, a boolean shape, and a
// per-API compat base patched by each model's delta.
const compact = {
    version: 1,
    keys: ['name', 'reasoning', 'api', 'cost', 'input', 'supportsX', 'supportsY', 'maxTokensField', 'output', 'baseUrl'],
    booleanShapes: [[], [1], [5, 6]],
    nodes: [
        [0, [2, 'openai-completions', 9, 'https://api.acme.test/v1'], 0, []],
        [0, [4, 3, 8, 15], 0, []],
        [1, ['text', 'image']],
        [0, [0, 'Model A', 3, [1], 4, [2]], 1, [1]],
        [0, [0, 'Model B', 3, [1]], 1, [0]],
        [0, [7, 'max_tokens'], 2, [1]],
        [0, [], 2, [3]],
        [0, [], 0, []],
    ],
    compat: [['openai-completions', [5]]],
    providers: [['acme', [0], [['a', [3], [[], [6]]], ['b', [4], [[5], [7]]]]]],
};

test('decodeOmpModels materializes the compact catalog', () => {
    const base = { api: 'openai-completions', baseUrl: 'https://api.acme.test/v1', cost: { input: 3, output: 15 } };
    assert.deepEqual(decodeOmpModels(compact), {
        acme: {
            a: {
                id: 'a', ...base, name: 'Model A', input: ['text', 'image'], reasoning: true,
                compat: { maxTokensField: 'max_tokens', supportsX: true, supportsY: true },
            },
            b: {
                id: 'b', ...base, name: 'Model B', reasoning: false,
                // supportsX removed by the delta; the base is not mutated.
                compat: { maxTokensField: 'max_tokens', supportsY: false },
            },
        },
    });
});

test('normalizeCatalog accepts both the compact and the plain models.json', () => {
    const plain = decodeOmpModels(compact);
    for (const input of [compact, plain]) {
        const catalog = normalizeCatalog(input, { providers: {} }, { exceptions: {} });
        assert.deepEqual(catalog.providers.acme.models.map((model) => model.id).sort(), ['a', 'b']);
    }
});
