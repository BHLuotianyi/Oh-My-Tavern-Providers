import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCost, UsageStats } from '../../server-plugin/lib/stats.mjs';

const price = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 };

test('reasoning inside the completion is billed once', () => {
    // OpenAI semantics: the 500k completion already contains 300k reasoning.
    const cost = estimateCost({ input: 0, cachedInput: 0, cacheWrite: 0, output: 500_000, reasoning: 300_000 }, price);
    assert.equal(cost, 4);
    // A distinct reasoning rate applies to the reasoning share only.
    const split = estimateCost({ input: 0, cachedInput: 0, cacheWrite: 0, output: 500_000, reasoning: 300_000 }, { ...price, reasoning: 10 });
    assert.equal(split, 0.2 * 8 + 0.3 * 10);
});

test('a zero cache price means "unknown" and falls back to the input rate', () => {
    const cost = estimateCost({ input: 0, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 0 }, price);
    assert.equal(cost, 4);
    assert.equal(estimateCost({ input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0 }, null), 0);
});

test('a reasoning-only usage event is still recorded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-stats-'));
    try {
        const stats = new UsageStats({ root, now: () => Date.now() });
        stats.record({ provider: 'p', model: 'm', price, usage: { reasoning: 1000 } });
        assert.equal(stats.totals.reasoning, 1000);
        assert.equal(stats.totals.requests, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('time-window stats survive a restart instead of silently reporting zero', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-stats-'));
    const now = Date.parse('2026-11-07T12:00:00Z');
    try {
        const first = new UsageStats({ root, now: () => now });
        first.record({
            provider: 'p', model: 'm', price,
            usage: { input: 1000, output: 500, reasoning: 300 },
            chatId: 'chat-1',
        });
        first.flush();

        const second = new UsageStats({ root, now: () => now });
        const snapshot = second.snapshot({ since: '2026-11-07T00:00:00Z' });
        assert.equal(snapshot.totals.requests, 1);
        assert.equal(snapshot.totals.output, 500);
        assert.equal(snapshot.totals.reasoning, 300);
        assert.equal(snapshot.partial, false);
        assert.ok(snapshot.totals.costUsd > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
