import test from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_PROVIDERS, clearUsageCache, fetchProviderUsage } from '../../server-plugin/lib/usage.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('codex usage maps rate-limit windows to used percentages', async () => {
    clearUsageCache();
    const calls = [];
    const doFetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return json({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { used_percent: 4.5, resets_in_seconds: 3600 },
                secondary_window: { used_percent: 91, resets_at: '2026-11-01T00:00:00Z' },
            },
        });
    };
    const usage = await fetchProviderUsage('openai-codex', { apiKey: '{"access":"tok","accountId":"acc-1"}', label: 'ChatGPT' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.equal(usage.plan, 'plus');
    assert.equal(usage.windows.length, 2);
    assert.equal(usage.windows[0].usedPercent, 4.5);
    assert.equal(usage.windows[1].usedPercent, 91);
    assert.equal(usage.windows[1].remainingPercent, 9);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'acc-1');
});

test('antigravity usage combines group and window names', async () => {
    clearUsageCache();
    const doFetch = async () => json({
        groups: [
            {
                displayName: 'Gemini Models',
                buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.625, resetTime: '2026-10-31T05:49:05Z' },
                    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 },
                ],
            },
        ],
    });
    const usage = await fetchProviderUsage('google-antigravity', { apiKey: '{"access":"tok"}' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.equal(usage.windows[0].label, 'Gemini Models · Weekly');
    assert.equal(usage.windows[0].usedPercent, 37.5);
    assert.equal(usage.windows[1].label, 'Gemini Models · Five hour');
    assert.equal(usage.windows[1].usedPercent, 0);
});

test('providers without an adapter or credentials report why', async () => {
    clearUsageCache();
    assert.equal(USAGE_PROVIDERS.has('openrouter'), false);
    const unsupported = await fetchProviderUsage('openrouter', { apiKey: 'sk-1' }, { doFetch: async () => json({}) });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.ok, false);

    const noCredential = await fetchProviderUsage('openai-codex', { apiKey: '' }, { doFetch: async () => json({}) });
    assert.equal(noCredential.supported, true);
    assert.equal(noCredential.error, 'No credentials');
});

test('a failing endpoint surfaces the HTTP status instead of throwing', async () => {
    clearUsageCache();
    const usage = await fetchProviderUsage('anthropic', { apiKey: '{"access":"tok"}' }, {
        doFetch: async () => json({ error: 'nope' }, 429),
    });
    assert.equal(usage.ok, false);
    assert.equal(usage.error, 'HTTP 429');
});

test('successful readings are cached until a refresh is requested', async () => {
    clearUsageCache();
    let calls = 0;
    const doFetch = async () => {
        calls += 1;
        return json({ rate_limit: { primary_window: { used_percent: 10 } } });
    };
    await fetchProviderUsage('openai-codex', { apiKey: '{"access":"tok"}' }, { doFetch });
    await fetchProviderUsage('openai-codex', { apiKey: '{"access":"tok"}' }, { doFetch });
    assert.equal(calls, 1);
    await fetchProviderUsage('openai-codex', { apiKey: '{"access":"tok"}' }, { doFetch, refresh: true });
    assert.equal(calls, 2);
});

test('deepseek reports its prepaid balance instead of a window', async () => {
    clearUsageCache();
    const doFetch = async (url, init) => {
        assert.equal(String(url), 'https://api.deepseek.com/user/balance');
        assert.equal(init.headers.Authorization, 'Bearer sk-ds');
        return json({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '12.345', granted_balance: '0.00', topped_up_balance: '12.345' }],
        });
    };
    const usage = await fetchProviderUsage('deepseek', { apiKey: 'sk-ds' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.equal(usage.windows.length, 0);
    assert.equal(usage.balances.length, 1);
    assert.equal(usage.balances[0].amount, '12.35');
    assert.equal(usage.balances[0].currency, 'CNY');
});

test('opencode-go maps rolling/weekly/monthly percentages', async () => {
    clearUsageCache();
    const doFetch = async (url, init) => {
        assert.equal(String(url), 'https://opencode.ai/zen/go/v1/usage');
        assert.match(init.headers['User-Agent'], /^omtp-model-hub/);
        return json({
            usage: {
                rolling: { percent: 20, status: 'ok', resetsAt: '2026-10-28T20:00:00Z' },
                weekly: { percent: 85, status: 'warning', resetsAt: '2026-10-31T00:00:00Z' },
                monthly: { percent: 100, status: 'exhausted', resetsAt: '2026-11-20T00:00:00Z' },
            },
        });
    };
    const usage = await fetchProviderUsage('opencode-go', { apiKey: 'op-key' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.deepEqual(usage.windows.map((w) => w.usedPercent), [20, 85, 100]);
    assert.equal(usage.windows[1].resetAt, '2026-10-31T00:00:00.000Z');
});

test('github-copilot derives used percent from quota snapshots', async () => {
    clearUsageCache();
    const doFetch = async (url, init) => {
        assert.equal(String(url), 'https://api.github.com/copilot_internal/user');
        assert.equal(init.headers.Authorization, 'Bearer ghu-token');
        return json({
            copilot_plan: 'individual',
            quota_reset_date: '2026-11-01T00:00:00Z',
            quota_snapshots: {
                premium_interactions: { entitlement: 300, remaining: 60, percent_remaining: 20, unlimited: false },
                chat: { entitlement: 0, remaining: 0, unlimited: true },
            },
        });
    };
    const usage = await fetchProviderUsage('github-copilot', { apiKey: 'ghu-token' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.equal(usage.plan, 'individual');
    assert.equal(usage.windows[0].label, 'Premium interactions');
    assert.equal(usage.windows[0].usedPercent, 80);
});

test('zai sends the raw token and maps percentage limits', async () => {
    clearUsageCache();
    const doFetch = async (url, init) => {
        assert.equal(String(url), 'https://api.z.ai/api/monitor/usage/quota/limit');
        assert.equal(init.headers.Authorization, 'raw-token');
        return json({
            success: true,
            data: {
                level: 'pro',
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 12.5, nextResetTime: 1793000000000 },
                    { type: 'TIME_LIMIT', currentValue: 3, usage: 10, nextResetTime: 1793000000 },
                ],
            },
        });
    };
    const usage = await fetchProviderUsage('zai', { apiKey: 'raw-token' }, { doFetch });
    assert.equal(usage.ok, true);
    assert.equal(usage.plan, 'pro');
    assert.equal(usage.windows[0].usedPercent, 12.5);
    assert.equal(usage.windows[1].usedPercent, 30);
});

test('minimax reads model_remains buckets and honours base_resp', async () => {
    clearUsageCache();
    const okFetch = async () => json({
        base_resp: { status_code: 0 },
        model_remains: [{
            model_name: 'General',
            current_interval_remaining_percent: 75,
            current_interval_status: 1,
            end_time: 1793000000,
            current_weekly_remaining_percent: 40,
            current_weekly_status: 2,
            weekly_end_time: 1793500000,
        }],
    });
    const usage = await fetchProviderUsage('minimax-code', { apiKey: 'mm-key' }, { doFetch: okFetch });
    assert.equal(usage.ok, true);
    assert.deepEqual(usage.windows.map((w) => w.label), ['General · 5 hour', 'General · Weekly']);
    assert.deepEqual(usage.windows.map((w) => w.usedPercent), [25, 60]);
    assert.equal(usage.windows[1].note, 'exhausted');

    clearUsageCache();
    const failure = await fetchProviderUsage('minimax-code', { apiKey: 'mm-key' }, {
        doFetch: async () => json({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
    });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /1004/);
});

test('xai reads weekly credits and monthly included quota', async () => {
    clearUsageCache();
    const usage = await fetchProviderUsage('xai-oauth', { apiKey: '{"access":"grok"}' }, {
        doFetch: async (url, init) => {
            assert.equal(String(url), 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
            assert.equal(init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
            return json({
                config: {
                    creditUsagePercent: 42,
                    currentPeriod: { end: '2026-11-02T00:00:00Z' },
                    monthlyLimit: { val: 200 },
                    used: { val: 50 },
                },
            });
        },
    });
    assert.equal(usage.ok, true);
    assert.equal(usage.windows[0].label, 'Weekly credits');
    assert.equal(usage.windows[0].usedPercent, 42);
    assert.equal(usage.windows[1].usedPercent, 25);
});
