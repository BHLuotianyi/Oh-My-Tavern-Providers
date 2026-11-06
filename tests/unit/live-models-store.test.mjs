import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    LIVE_MODELS_FILE,
    LIVE_MODELS_MAX_AGE_MS,
    LIVE_MODELS_MAX_PROVIDERS,
    LIVE_MODELS_STORE_VERSION,
    loadLiveModels,
    saveLiveModels,
} from '../../server-plugin/lib/live-models-store.mjs';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-live-models-'));
}

function readStore(root) {
    return JSON.parse(fs.readFileSync(path.join(root, LIVE_MODELS_FILE), 'utf8'));
}

test('successful probe results are written to the data directory and reload', async () => {
    const root = tempRoot();
    const now = 1_700_000_000_000;
    const cache = new Map([
        ['openai', { models: [{ id: 'gpt-x', name: 'GPT X' }], at: now }],
        ['anthropic', { models: [{ id: 'claude-x' }], at: now + 1000 }],
    ]);

    const result = await saveLiveModels(root, cache, now + 2000);
    assert.deepEqual(result, { providers: 2, dropped: 0 });

    const stored = readStore(root);
    assert.equal(stored.version, LIVE_MODELS_STORE_VERSION);
    assert.deepEqual(stored.providers.openai, { at: now, models: [{ id: 'gpt-x', name: 'GPT X' }] });

    const loaded = await loadLiveModels(root, now + 2000);
    assert.deepEqual([...loaded.keys()].sort(), ['anthropic', 'openai']);
    assert.deepEqual(loaded.get('anthropic'), cache.get('anthropic'));
});

test('the cache file is private to the account', async () => {
    const root = tempRoot();
    await saveLiveModels(root, new Map([['openai', { models: [{ id: 'gpt-x' }], at: Date.now() }]]));
    const mode = fs.statSync(path.join(root, LIVE_MODELS_FILE)).mode & 0o777;
    assert.equal(mode, 0o600);
});

test('expired entries are dropped on read and on write', async () => {
    const root = tempRoot();
    const now = 1_800_000_000_000;
    fs.writeFileSync(path.join(root, LIVE_MODELS_FILE), JSON.stringify({
        version: LIVE_MODELS_STORE_VERSION,
        providers: {
            stale: { at: now - LIVE_MODELS_MAX_AGE_MS - 1, models: [{ id: 'old' }] },
            fresh: { at: now - 1000, models: [{ id: 'new' }] },
        },
    }));

    const loaded = await loadLiveModels(root, now);
    assert.deepEqual([...loaded.keys()], ['fresh']);

    loaded.set('another-stale', { models: [{ id: 'old' }], at: now - LIVE_MODELS_MAX_AGE_MS - 1 });
    const result = await saveLiveModels(root, loaded, now);
    assert.deepEqual(result, { providers: 1, dropped: 1 });
    assert.deepEqual(Object.keys(readStore(root).providers), ['fresh']);
});

test('missing, corrupt or foreign payloads load as an empty cache', async () => {
    const empty = tempRoot();
    assert.equal((await loadLiveModels(empty)).size, 0);

    for (const raw of [
        '{not json',
        JSON.stringify({ version: 99, providers: { a: { at: 1, models: [{ id: 'a' }] } } }),
        JSON.stringify({ version: LIVE_MODELS_STORE_VERSION, providers: [] }),
        JSON.stringify(null),
    ]) {
        const root = tempRoot();
        fs.writeFileSync(path.join(root, LIVE_MODELS_FILE), raw);
        assert.equal((await loadLiveModels(root, 1_000_000)).size, 0, raw);
    }
});

test('malformed model lists never make it back into the cache', async () => {
    const root = tempRoot();
    const now = 1_000_000;
    fs.writeFileSync(path.join(root, LIVE_MODELS_FILE), JSON.stringify({
        version: LIVE_MODELS_STORE_VERSION,
        providers: {
            empty: { at: now, models: [] },
            junk: { at: now, models: 'nope' },
            partial: { at: now, models: [{ id: 'kept' }, { name: 'no id' }, null, 'str'] },
            noTime: { models: [{ id: 'x' }] },
        },
    }));

    const loaded = await loadLiveModels(root, now);
    assert.deepEqual([...loaded.keys()], ['partial']);
    assert.deepEqual(loaded.get('partial').models, [{ id: 'kept' }]);
});

test('only the newest providers are persisted', async () => {
    const root = tempRoot();
    const cache = new Map();
    for (let index = 0; index < LIVE_MODELS_MAX_PROVIDERS + 5; index += 1) {
        cache.set(`provider-${index}`, { models: [{ id: `model-${index}` }], at: 1000 + index });
    }

    const result = await saveLiveModels(root, cache, 2000);
    assert.deepEqual(result, { providers: LIVE_MODELS_MAX_PROVIDERS, dropped: 5 });
    const providers = readStore(root).providers;
    assert.equal(Object.keys(providers).length, LIVE_MODELS_MAX_PROVIDERS);
    assert.ok(!providers['provider-0']);
    assert.ok(providers[`provider-${LIVE_MODELS_MAX_PROVIDERS + 4}`]);
});

test('freshness decides cache hits, stale fallbacks and misses', async () => {
    const { freshLiveModels, staleLiveModels, LIVE_MODELS_TTL } = await import('../../server-plugin/lib/live-models-store.mjs');
    const now = 1_000_000;
    const cache = new Map([
        ['fresh', { models: [{ id: 'a' }], at: now - 1000 }],
        ['stale', { models: [{ id: 'b' }], at: now - LIVE_MODELS_TTL - 1000 }],
        ['expired', { models: [{ id: 'c' }], at: now - LIVE_MODELS_MAX_AGE_MS - 1 }],
        ['empty', { models: [], at: now }],
    ]);

    assert.equal(freshLiveModels(cache, 'fresh', { now }).models[0].id, 'a');
    assert.equal(freshLiveModels(cache, 'stale', { now }), null);
    assert.equal(freshLiveModels(cache, 'missing', { now }), null);

    assert.equal(staleLiveModels(cache, 'stale', { now }).models[0].id, 'b');
    assert.equal(staleLiveModels(cache, 'fresh', { now }).models[0].id, 'a');
    assert.equal(staleLiveModels(cache, 'expired', { now }), null);
    assert.equal(staleLiveModels(cache, 'empty', { now }), null);
    assert.equal(staleLiveModels(null, 'fresh', { now }), null);
});

test('a restart keeps the last successful list as a stale fallback', async () => {
    const root = tempRoot();
    const now = 2_000_000_000_000;
    const cache = new Map([['openai', { models: [{ id: 'gpt-x' }], at: now - 60_000 }]]);
    await saveLiveModels(root, cache, now);

    // Next boot, long after the in-process freshness window: the probe would
    // be retried, but a failure still has the persisted list to fall back to.
    const restarted = await loadLiveModels(root, now + 3_600_000);
    const { freshLiveModels, staleLiveModels } = await import('../../server-plugin/lib/live-models-store.mjs');
    assert.equal(freshLiveModels(restarted, 'openai', { now: now + 3_600_000 }), null);
    assert.deepEqual(staleLiveModels(restarted, 'openai', { now: now + 3_600_000 }).models, [{ id: 'gpt-x' }]);
});
