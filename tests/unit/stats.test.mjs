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
    assert.equal(snapshot.byDay[0].day, new Date(Date.parse('2026-10-28T10:00:00Z')).toLocaleDateString('en-CA'));
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

test('byModel stays bounded while totals keep every request', () => {
    const root = tempRoot();
    const stats = new UsageStats({ root, now: () => Date.parse('2026-10-28T10:00:00Z') });
    for (let i = 0; i < 130; i += 1) {
        stats.record({ provider: 'p', model: `m${i}`, price: { input: 1, output: 0 }, usage: { input: i + 1, output: 0 } });
    }
    const snapshot = stats.snapshot();
    assert.equal(snapshot.totals.requests, 130);
    assert.equal(snapshot.totals.input, (130 * 131) / 2);
    assert.equal(snapshot.byModel.length, 100);
    // The cheapest rows are dropped; the most expensive model survives.
    assert.equal(snapshot.byModel[0].model, 'm129');
    assert.equal(stats.byModel.has('p/m0'), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('day buckets use the server-local date', () => {
    const root = tempRoot();
    const stamp = Date.parse('2026-10-28T23:30:00Z');
    const stats = new UsageStats({ root, now: () => stamp });
    stats.record({ provider: 'p', model: 'm', usage: { input: 1, output: 1 } });
    const snapshot = stats.snapshot();
    assert.equal(snapshot.byDay.length, 1);
    assert.equal(snapshot.byDay[0].day, new Date(stamp).toLocaleDateString('en-CA'));
    assert.match(snapshot.byDay[0].day, /^\d{4}-\d{2}-\d{2}$/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('flush persists pending counters immediately', () => {
    const root = tempRoot();
    const stats = new UsageStats({ root });
    stats.record({ provider: 'p', model: 'm', price: { input: 1, output: 1 }, usage: { input: 123, output: 4 } });
    stats.flush();
    const raw = JSON.parse(fs.readFileSync(stats.file, 'utf8'));
    assert.equal(raw.totals.requests, 1);
    assert.equal(raw.totals.input, 123);
    assert.equal(stats.flushTimer, null);
    // A second call is a no-op, not a crash.
    stats.flush();
    fs.rmSync(root, { recursive: true, force: true });
});

test('partial does not flag an empty or not-yet-full ring', () => {
    const root = tempRoot();
    let now = Date.parse('2026-10-28T10:00:00Z');
    const stats = new UsageStats({ root, now: () => now });
    const since = new Date(now - 60_000).toISOString();
    // No completions: the window is empty, not truncated.
    assert.equal(stats.snapshot({ since }).partial, false);
    assert.equal(stats.snapshot({ chat: 'chat-a' }).partial, false);

    const start = new Date(now).toISOString();
    stats.record({ provider: 'p', model: 'm', price: { input: 1, output: 1 }, usage: { input: 10, output: 1 }, chatId: 'chat-a' });
    now += 5_000;
    // Every completion is still retained, so the window is exact.
    assert.equal(stats.snapshot({ since: start }).partial, false);
    assert.equal(stats.snapshot({ chat: 'chat-a' }).partial, false);
    stats.flush();
    fs.rmSync(root, { recursive: true, force: true });
});

test('partial is driven by ring coverage once the ring is full', () => {
    const root = tempRoot();
    let now = Date.parse('2026-10-28T00:00:00Z');
    const stats = new UsageStats({ root, now: () => now });
    const firstAt = now;
    // Fill the 2000-event ring; 51 chat ids also force byChat to trim one row.
    for (let i = 0; i < 2000; i += 1) {
        stats.record({
            provider: 'p',
            model: 'm',
            price: { input: 1, output: 0 },
            usage: { input: 1, output: 0 },
            chatId: `chat-${i % 51}`,
        });
        now += 1_000;
    }

    // A window reaching behind the oldest retained event is a lower bound.
    assert.equal(stats.snapshot({ since: new Date(firstAt - 60_000).toISOString() }).partial, true);
    // Starting exactly at the oldest retained event, coverage is complete.
    assert.equal(stats.snapshot({ since: new Date(firstAt).toISOString() }).partial, false);
    // A window that starts inside the retained ring stays exact.
    assert.equal(stats.snapshot({ since: new Date(stats.events[0].at + 1).toISOString() }).partial, false);
    // A chat trimmed from byChat but still present in the ring is covered.
    const retainedOnly = stats.events.find((event) => !stats.byChat.has(event.chatId))?.chatId;
    assert.ok(retainedOnly);
    assert.equal(stats.snapshot({ chat: retainedOnly }).partial, false);
    // A chat with no retained event is a lower bound only while the ring is full.
    assert.equal(stats.snapshot({ chat: 'chat-never' }).partial, true);
    stats.flush();
    fs.rmSync(root, { recursive: true, force: true });
});
