import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStatsServer, stopStatsServer, statsServerStatus, dashboardSnapshot, DASHBOARD_HEADER, DASHBOARD_VERSION } from '../../server-plugin/lib/stats-server.mjs';
import { UsageStats } from '../../server-plugin/lib/stats.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-stats-server-'));

function seed(stats) {
    stats.record({
        provider: 'google-antigravity',
        model: 'gemini-3.8-flash',
        price: { input: 0.3, output: 2.5, cacheRead: 0.03 },
        chatId: 'chat-a',
        usage: { input: 500, cachedInput: 1000, cacheWrite: 0, output: 40, reasoning: 12 },
    });
    stats.record({
        provider: 'deepseek',
        model: 'deepseek-chat',
        price: { input: 0.27, output: 1.1 },
        chatId: 'chat-b',
        usage: { input: 100, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0 },
    });
}

test('stats dashboard serves the page, the JSON API and its handshake', async (t) => {
    const stats = new UsageStats({ root: tempRoot() });
    seed(stats);
    const { url, port } = await ensureStatsServer({ stats, chat: 'chat-a', lang: 'zh-cn', port: 0 });
    t.after(() => stopStatsServer());
    assert.ok(port > 0);
    assert.equal(statsServerStatus()?.port, port);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.equal(page.headers.get(DASHBOARD_HEADER), String(DASHBOARD_VERSION));
    assert.match(url, /chat=chat-a/);
    assert.match(url, /lang=zh-cn/);
    const html = await page.text();
    assert.match(html, /OMTP stats/);
    assert.match(html, /\/api\/stats/);

    const handshake = await fetch(`http://127.0.0.1:${port}/__omtp_stats__`);
    assert.deepEqual(await handshake.json(), { ok: true, version: DASHBOARD_VERSION });

    const api = await fetch(`http://127.0.0.1:${port}/api/stats?chat=chat-a`);
    const data = await api.json();
    assert.equal(data.window.totals.requests, 1);
    assert.equal(data.window.totals.cachedInput, 1000);
    assert.equal(data.allTime.totals.requests, 2);
    assert.equal(data.byChat.length, 2);
    assert.equal(data.byChat[0].chatId, 'chat-a');
    assert.ok(data.allTime.totals.costUsd > 0);

    // Second call reuses the running listener instead of binding again.
    const again = await ensureStatsServer({ stats, chat: 'chat-a', lang: 'zh-cn', port: 0 });
    assert.equal(again.port, port);
    assert.equal(again.reused, true);
    assert.match(again.url, /chat=chat-a/);

    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(notFound.status, 404);
    const badMethod = await fetch(`http://127.0.0.1:${port}/api/stats`, { method: 'POST' });
    assert.equal(badMethod.status, 405);
});

test('dashboard snapshot exposes per-chat rows without mutating totals', () => {
    const stats = new UsageStats({ root: tempRoot() });
    seed(stats);
    const snapshot = dashboardSnapshot(stats, { chat: 'chat-b' });
    assert.equal(snapshot.window.totals.requests, 1);
    assert.equal(snapshot.window.totals.input, 100);
    assert.equal(snapshot.allTime.totals.requests, 2);
    const chatB = snapshot.byChat.find((row) => row.chatId === 'chat-b');
    assert.equal(chatB.requests, 1);
    assert.equal(stats.snapshot().totals.requests, 2);
});
