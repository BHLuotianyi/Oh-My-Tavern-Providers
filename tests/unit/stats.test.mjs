import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStats, estimateCost, tokensFromOpenAIUsage } from '../../server-plugin/lib/stats.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-stats-'));

test('tokensFromOpenAIUsage splits cached input out of prompt_tokens', () => {
    assert.deepEqual(
        tokensFromOpenAIUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } }),
        { input: 200, cachedInput: 800, cacheWrite: 0, output: 200, reasoning: 0 },
    );
    assert.deepEqual(
        tokensFromOpenAIUsage({ input_tokens: 50, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } }),
        { input: 50, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 4 },
    );
    assert.equal(tokensFromOpenAIUsage({}), null);
    assert.equal(tokensFromOpenAIUsage(null), null);
});

test('estimateCost prices cache reads and writes separately', () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const tokens = { input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
    // 3 + 0.3 + 3.75 + 15
    assert.ok(Math.abs(estimateCost(tokens, price) - 22.05) < 1e-9);
    assert.equal(estimateCost(tokens, null), 0);
});

test('record accumulates totals, per-model rows and day buckets', () => {
    const root = tempRoot();
    let now = Date.parse('2026-10-28T10:00:00Z');
    const stats = new UsageStats({ root, now: () => now });
    const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };

    stats.record({ provider: 'p', model: 'm1', price, usage: { input: 1000, cachedInput: 500, cacheWrite: 0, output: 100, reasoning: 20 } });
    now += 60_000;
    stats.record({ provider: 'p', model: 'm2', price, usage: { input: 2000, cachedInput: 0, cacheWrite: 0, output: 400, reasoning: 0 } });

    const snapshot = stats.snapshot();
    assert.equal(snapshot.totals.requests, 2);
    assert.equal(snapshot.totals.input, 3000);
    assert.equal(snapshot.totals.cachedInput, 500);
    assert.equal(snapshot.totals.output, 500);
    assert.equal(snapshot.totals.reasoning, 20);
    assert.equal(snapshot.byModel.length, 2);
    // m2 is dearer: 2000*1 + 400*2 = 2800 micro-dollars vs 1000+50+200 = 1250.
    assert.equal(snapshot.byModel[0].model, 'm2');
    assert.equal(snapshot.byDay.length, 1);
    assert.equal(snapshot.byDay[0].day, '2026-10-28');
    fs.rmSync(root, { recursive: true, force: true });
});

test('since returns only events after the timestamp', () => {
    const root = tempRoot();
    let now = Date.parse('2026-10-28T10:00:00Z');
    const stats = new UsageStats({ root, now: () => now });
    const price = { input: 1, output: 1 };
    stats.record({ provider: 'p', model: 'm', price, usage: { input: 100, output: 10 } });
    now += 5_000;
    const since = new Date(now).toISOString();
    now += 5_000;
    stats.record({ provider: 'p', model: 'm', price, usage: { input: 300, output: 30 } });

    const session = stats.snapshot({ since });
    assert.equal(session.totals.requests, 1);
    assert.equal(session.totals.input, 300);
    assert.equal(session.partial, false);
    assert.equal(stats.snapshot().totals.requests, 2);
    fs.rmSync(root, { recursive: true, force: true });
});

test('counters survive a restart', async () => {
    const root = tempRoot();
    const stats = new UsageStats({ root });
    stats.record({ provider: 'p', model: 'm', price: { input: 1, output: 1 }, usage: { input: 10, output: 5 } });
    stats._flush();

    const reloaded = new UsageStats({ root });
    assert.equal(reloaded.snapshot().totals.requests, 1);
    assert.equal(reloaded.snapshot().totals.input, 10);
    assert.equal(reloaded.snapshot().byModel[0].model, 'm');
    fs.rmSync(root, { recursive: true, force: true });
});

test('events are attributed to their chat id', () => {
    const root = tempRoot();
    const stats = new UsageStats({ root, now: () => Date.parse('2026-10-28T10:00:00Z') });
    const price = { input: 1, output: 1 };
    stats.record({ provider: 'p', model: 'm', price, usage: { input: 100, output: 10 }, chatId: 'chat-a' });
    stats.record({ provider: 'p', model: 'm2', price, usage: { input: 50, output: 5 }, chatId: 'chat-b' });
    stats.record({ provider: 'p', model: 'm', price, usage: { input: 25, output: 0 }, chatId: 'chat-a' });

    const a = stats.snapshot({ chat: 'chat-a' });
    assert.equal(a.totals.requests, 2);
    assert.equal(a.totals.input, 125);
    assert.equal(a.byModel.length, 1);
    assert.equal(a.byModel[0].model, 'm');

    const b = stats.snapshot({ chat: 'chat-b' });
    assert.equal(b.totals.requests, 1);
    assert.equal(b.totals.input, 50);

    const unknown = stats.snapshot({ chat: 'chat-z' });
    assert.equal(unknown.totals.requests, 0);
    assert.equal(unknown.byModel.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('per-chat totals survive a restart', () => {
    const root = tempRoot();
    const stats = new UsageStats({ root });
    stats.record({ provider: 'p', model: 'm', price: { input: 1, output: 1 }, usage: { input: 10, output: 5 }, chatId: 'chat-a' });
    stats.record({ provider: 'p', model: 'm', price: { input: 1, output: 1 }, usage: { input: 20, output: 5 }, chatId: 'chat-b' });
    stats._flush();

    const reloaded = new UsageStats({ root });
    const a = reloaded.snapshot({ chat: 'chat-a' });
    assert.equal(a.totals.requests, 1);
    assert.equal(a.totals.input, 10);
    assert.equal(a.byModel[0].model, 'm');
    assert.equal(reloaded.snapshot({ chat: 'chat-b' }).totals.input, 20);
    fs.rmSync(root, { recursive: true, force: true });
});
