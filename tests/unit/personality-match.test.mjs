import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPersonalityKey, normalizeName } from '../../src/personality-match.js';

const KEYS = new Set([
    'gemini-4-argon',
    'claude-opus-5-5',
    'grok-4-7',
    'muse-wonder',
    'glm-5-3',
    'qwen3-8-max',
]);

test('normalizeName folds punctuation and parentheticals', () => {
    assert.equal(normalizeName('Claude Opus 5.5 (Max, Default Fallback)'), 'claude-opus-5-5');
    assert.equal(normalizeName('GLM-5.3'), 'glm-5-3');
    assert.equal(normalizeName('Qwen3.8-Max'), 'qwen3-8-max');
    assert.equal(normalizeName(''), '');
});

test('matchPersonalityKey prefers the model segment over the label', () => {
    assert.equal(
        matchPersonalityKey({ model: 'google-antigravity/gemini-4.1-argon', modelLabel: 'Gemini 4.1 Argon' }, KEYS),
        null,
    );
    assert.equal(
        matchPersonalityKey({ model: 'google-antigravity/gemini-4-argon', modelLabel: 'Gemini 4 Argon' }, KEYS),
        'gemini-4-argon',
    );
    assert.equal(
        matchPersonalityKey({ model: 'anthropic/claude-opus-5-5', modelLabel: 'Claude Opus 5.5' }, KEYS),
        'claude-opus-5-5',
    );
});

test('matchPersonalityKey drops a purely numeric version suffix', () => {
    assert.equal(
        matchPersonalityKey({ model: 'meta/muse-wonder-1.0', modelLabel: 'Muse Wonder 1.0' }, KEYS),
        'muse-wonder',
    );
    // A version-like tail that is not purely numeric must not match.
    assert.equal(
        matchPersonalityKey({ model: 'xai/grok-4-7-xhigh', modelLabel: 'Grok 4.7 xhigh' }, KEYS),
        null,
    );
    assert.equal(
        matchPersonalityKey({ model: 'xai/grok-4', modelLabel: 'Grok 4' }, KEYS),
        null,
    );
});

test('matchPersonalityKey returns null for unknown or missing models', () => {
    assert.equal(matchPersonalityKey(null, KEYS), null);
    assert.equal(matchPersonalityKey({ model: 'local/nonexistent' }, KEYS), null);
});
