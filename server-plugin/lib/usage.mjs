/**
 * Provider quota/usage reporting.
 *
 * Mirrors OMP's `packages/ai/src/usage/*`: every provider exposes a different
 * endpoint and payload, so each gets a small adapter that returns the same
 * shape. Only providers with a documented endpoint are listed; everything else
 * reports `supported: false` instead of guessing.
 *
 * Shape returned by `fetchProviderUsage`:
 *   {
 *     id, label, supported, ok, plan, source, error?,
 *     fetchedAt, cached?,
 *     windows: [{ label, usedPercent, remainingPercent, resetAt, note }],
 *     balances: [{ label, amount, currency, note }],
 *   }
 */
import { parseStructuredCredential } from './oauth.mjs';

const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

/** @type {Map<string, {at:number, value:any}>} */
const cache = new Map();

/**
 * Resolve the token a usage endpoint expects.
 * @param {any} resolved Provider config from the key store.
 */
function credentialsOf(resolved) {
    const raw = String(resolved?.apiKey || '').trim();
    const structured = parseStructuredCredential(raw);
    return {
        structured,
        token: structured?.access || raw,
        project: structured?.projectId || resolved?.extraConfig?.project || '',
        accountId: structured?.accountId || structured?.orgId || '',
        baseUrl: String(resolved?.baseUrl || '').replace(/\/+$/, ''),
    };
}

/** @param {unknown} value */
function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** @param {unknown} value */
function toIso(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value > 1e12 ? value : value * 1000).toISOString();
    }
    if (typeof value === 'string' && value.trim()) {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && /\d{9,}/.test(value)) {
            return new Date(asNumber > 1e12 ? asNumber : asNumber * 1000).toISOString();
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
    return null;
}

/**
 * @param {{label:string, usedPercent?:number, remainingPercent?:number, resetAt?:string|null, note?:string}} window
 */
function normalizeWindow({ label, usedPercent, remainingPercent, resetAt = null, note = '' }) {
    let used = usedPercent;
    if (used === undefined && remainingPercent !== undefined) {
        used = 100 - remainingPercent;
    }
    if (used === undefined) {
        return null;
    }
    used = Math.max(0, Math.min(100, used));
    return {
        label,
        usedPercent: Math.round(used * 10) / 10,
        remainingPercent: Math.round((100 - used) * 10) / 10,
        resetAt,
        note,
    };
}

/** Failure result for a usage endpoint that answered with a non-2xx status. */
function httpFailure(response) {
    return { ok: false, error: `HTTP ${response.status}` };
}

/**
 * Assemble an adapter result; `ok` is true when any window or balance was
 * found, otherwise `emptyMessage` explains why not.
 * @param {{windows?: any[], balances?: any[], plan?: string, source: string, emptyMessage?: string}} result
 */
function usageResult({ windows = [], balances = [], plan = '', source, emptyMessage = '' }) {
    const ok = windows.length > 0 || balances.length > 0;
    return { ok, plan, source, windows, balances, error: ok ? '' : emptyMessage };
}

/**
 * POST with a JSON body and a hard timeout.
 * @param {typeof fetch} doFetch
 */
async function postJson(doFetch, url, body, headers) {
    return doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

async function getJson(doFetch, url, headers) {
    return doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

/** ChatGPT / Codex subscription windows (`GET /wham/usage`). */
async function codexUsage(id, resolved, doFetch) {
    const { token, accountId, baseUrl } = credentialsOf(resolved);
    const base = baseUrl || 'https://chatgpt.com/backend-api';
    const headers = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'omtp-model-hub',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    };
    const response = await getJson(doFetch, `${base}/wham/usage`, headers);
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const rateLimit = payload?.rate_limit || {};
    const windows = [
        normalizeWindow({
            label: 'Primary window',
            usedPercent: toNumber(rateLimit.primary_window?.used_percent),
            resetAt: toIso(rateLimit.primary_window?.resets_at ?? rateLimit.primary_window?.resets_in_seconds),
        }),
        normalizeWindow({
            label: 'Secondary window',
            usedPercent: toNumber(rateLimit.secondary_window?.used_percent),
            resetAt: toIso(rateLimit.secondary_window?.resets_at ?? rateLimit.secondary_window?.resets_in_seconds),
        }),
    ].filter(Boolean);
    return usageResult({
        windows,
        plan: payload?.plan_type || '',
        source: 'wham/usage',
        emptyMessage: 'No usage windows in the response',
    });
}

/** Claude Pro/Max (`GET /api/oauth/usage`). */
async function anthropicUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const headers = {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli/2.0.0 (external, cli)',
    };
    const response = await getJson(doFetch, 'https://api.anthropic.com/api/oauth/usage', headers);
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const entries = [
        ['5h', 'Five hour', payload?.five_hour],
        ['7d', 'Seven day', payload?.seven_day],
        ['7d-opus', 'Seven day (Opus)', payload?.seven_day_opus],
        ['7d-sonnet', 'Seven day (Sonnet)', payload?.seven_day_sonnet],
    ];
    const windows = entries
        .map(([, label, bucket]) => normalizeWindow({
            label,
            usedPercent: toNumber(bucket?.utilization),
            resetAt: toIso(bucket?.resets_at),
        }))
        .filter(Boolean);
    // Per-model limits reported alongside the shared windows.
    for (const limit of payload?.limits || []) {
        const model = limit?.scope?.model?.display_name;
        const label = model ? `7 day (${model})` : String(limit?.kind || 'Limit');
        const normalized = normalizeWindow({
            label,
            usedPercent: toNumber(limit?.percent),
            resetAt: toIso(limit?.resets_at),
        });
        if (normalized) windows.push(normalized);
    }
    const balances = [];
    const spend = payload?.spend;
    if (spend?.enabled && spend?.limit?.amount_minor !== undefined) {
        const scale = 10 ** (toNumber(spend.limit.exponent) ?? 2);
        const balance = normalizeBalance({
            label: 'Extra usage',
            amount: (toNumber(spend.used?.amount_minor) || 0) / scale,
            currency: spend.limit.currency || 'USD',
            note: `limit ${(toNumber(spend.limit.amount_minor) || 0) / scale}`,
        });
        if (balance) balances.push(balance);
    }
    return usageResult({ windows, balances, source: 'api/oauth/usage', emptyMessage: 'No usage buckets' });
}

/** Google Antigravity / Gemini CLI quota summary. */
async function antigravityUsage(id, resolved, doFetch) {
    const { token, project, baseUrl } = credentialsOf(resolved);
    const base = baseUrl || (id === 'google-gemini-cli'
        ? 'https://cloudcode-pa.googleapis.com'
        : 'https://daily-cloudcode-pa.googleapis.com');
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: '*/*',
        'User-Agent': 'antigravity/hub/2.19.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)',
    };
    const response = await postJson(doFetch, `${base}/v1internal:retrieveUserQuotaSummary`, { project }, headers);
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    // Groups carry the model family ("Gemini Models", "Claude and GPT models");
    // bucket names only say "Weekly Limit Remaining", so combine both.
    const groups = Array.isArray(payload?.groups) && payload.groups.length
        ? payload.groups
        : [{ displayName: '', buckets: payload?.buckets || [] }];
    const labels = { weekly: 'Weekly', '5h': 'Five hour', daily: 'Daily', '24h': 'Daily' };
    const windows = [];
    for (const group of groups) {
        for (const bucket of group?.buckets || []) {
            const remaining = toNumber(bucket?.remainingFraction);
            const windowName = labels[String(bucket?.window || '').toLowerCase()] || '';
            const fallback = String(bucket?.displayName || bucket?.bucketId || '').replace(/\s*Remaining$/i, '');
            const label = [group?.displayName, windowName || fallback].filter(Boolean).join(' · ') || 'Quota';
            const normalized = normalizeWindow({
                label,
                remainingPercent: remaining === undefined ? undefined : remaining * 100,
                resetAt: toIso(bucket?.resetTime),
                note: bucket?.disabled ? 'disabled' : '',
            });
            if (normalized) windows.push(normalized);
        }
    }
    return usageResult({ windows, source: 'retrieveUserQuotaSummary', emptyMessage: 'No quota buckets' });
}

const LIMIT_LABELS = { TIME_LIMIT: 'Request window', CREDIT_LIMIT: 'Credits' };

/** Z.AI / GLM coding plan quota limits. */
async function zaiUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const origin = baseUrl || 'https://api.z.ai';
    const response = await getJson(doFetch, `${origin}/api/monitor/usage/quota/limit`, {
        // Z.AI expects the raw token here, not a Bearer prefix.
        Authorization: token,
        Accept: 'application/json',
        'User-Agent': 'omtp-model-hub',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const limits = payload?.data?.limits || [];
    const windows = limits
        .map((limit) => {
            const used = toNumber(limit?.percentage);
            const usedFromValues = (() => {
                const current = toNumber(limit?.currentValue);
                const total = toNumber(limit?.usage ?? limit?.number);
                if (current === undefined || !total) return undefined;
                return (current / total) * 100;
            })();
            const label = LIMIT_LABELS[limit?.type] || 'Token quota';
            return normalizeWindow({
                label,
                usedPercent: used ?? usedFromValues,
                resetAt: toIso(limit?.nextResetTime),
                note: [toNumber(limit?.number), limit?.unit].filter((v) => v !== undefined).join(' '),
            });
        })
        .filter(Boolean);
    return usageResult({
        windows,
        plan: payload?.data?.level || '',
        source: 'monitor/usage/quota/limit',
        emptyMessage: 'No quota limits',
    });
}

/** Kimi coding plan usage. */
async function kimiUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const response = await getJson(doFetch, 'https://api.kimi.com/coding/v1/usages', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'omtp-model-hub',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    /** @type {{label: string, detail: any}[]} */
    const rows = [];
    if (payload?.usage && typeof payload.usage === 'object') {
        rows.push({ label: 'Usage', detail: payload.usage });
    }
    for (const limit of payload?.limits || []) {
        rows.push({ label: String(limit?.title || limit?.name || 'Limit'), detail: limit?.detail || limit });
    }
    for (const [key, value] of Object.entries(payload?.usages || {})) {
        rows.push({ label: key, detail: value });
    }
    const windows = rows
        .map(({ label, detail }) => {
            const used = toNumber(detail?.used);
            const limit = toNumber(detail?.limit);
            const remaining = toNumber(detail?.remaining);
            const ratio = toNumber(detail?.used_ratio);
            let usedPercent;
            if (ratio !== undefined) usedPercent = ratio * 100;
            else if (used !== undefined && limit) usedPercent = (used / limit) * 100;
            else if (remaining !== undefined && limit) usedPercent = 100 - (remaining / limit) * 100;
            return normalizeWindow({
                label,
                usedPercent,
                resetAt: toIso(detail?.reset_at ?? detail?.resetAt ?? detail?.reset_time ?? detail?.reset_in ?? detail?.ttl),
            });
        })
        .filter(Boolean);
    return usageResult({ windows, source: 'coding/v1/usages', emptyMessage: 'No usage rows' });
}

/** MiniMax coding plan remains. */
async function minimaxUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const base = baseUrl || (id === 'minimax-code-cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io');
    const response = await getJson(doFetch, `${base}/v1/token_plan/remains`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'omtp-model-hub',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    // The endpoint answers 200 even on failure; status_code 0 means success.
    if (payload?.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return { ok: false, error: `status ${payload.base_resp.status_code}: ${payload.base_resp.status_msg || ''}`.trim() };
    }
    const windows = [];
    for (const remain of payload?.model_remains || []) {
        const name = String(remain?.model_name || 'Token plan');
        const intervalRemaining = toNumber(remain?.current_interval_remaining_percent);
        const intervalStatus = toNumber(remain?.current_interval_status);
        if (intervalRemaining !== undefined && intervalStatus !== 3) {
            windows.push(normalizeWindow({
                label: `${name} · 5 hour`,
                usedPercent: Math.max(0, 100 - intervalRemaining),
                resetAt: toIso(remain?.end_time),
                note: intervalStatus === 2 ? 'exhausted' : '',
            }));
        }
        const weeklyRemaining = toNumber(remain?.current_weekly_remaining_percent);
        const weeklyStatus = toNumber(remain?.current_weekly_status);
        if (weeklyRemaining !== undefined && weeklyStatus !== 3) {
            windows.push(normalizeWindow({
                label: `${name} · Weekly`,
                usedPercent: Math.max(0, 100 - weeklyRemaining),
                resetAt: toIso(remain?.weekly_end_time),
                note: weeklyStatus === 2 ? 'exhausted' : '',
            }));
        }
    }
    return usageResult({ windows: windows.filter(Boolean), source: 'token_plan/remains' });
}

/**
 * Balance/credit report for providers that expose money or credits instead of
 * percentage windows.
 * @param {{label:string, amount:string|number, currency?:string, note?:string}} balance
 */
function normalizeBalance({ label, amount, currency = '', note = '' }) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return null;
    return {
        label,
        amount: value.toFixed(2),
        currency,
        note,
    };
}

/** DeepSeek prepaid balance (`GET /user/balance`). */
async function deepseekUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const response = await getJson(doFetch, 'https://api.deepseek.com/user/balance', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const balances = infos
        .map((info) => normalizeBalance({
            label: 'Balance',
            amount: info?.total_balance,
            currency: info?.currency || '',
            note: payload?.is_available === false ? 'unavailable' : '',
        }))
        .filter(Boolean);
    return usageResult({ balances, source: 'user/balance', emptyMessage: 'No balance fields' });
}

/** Command Code credits + rolling windows. */
async function commandcodeUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const origin = baseUrl || 'https://api.commandcode.ai';
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const [whoamiResponse, creditsResponse] = await Promise.all([
        getJson(doFetch, `${origin}/alpha/whoami`, headers),
        getJson(doFetch, `${origin}/alpha/billing/credits`, headers),
    ]);
    if (!creditsResponse.ok) return httpFailure(creditsResponse);
    const whoami = whoamiResponse.ok ? await whoamiResponse.json() : {};
    const credits = await creditsResponse.json();
    const orgId = whoami?.org?.id;
    const scoped = orgId
        ? await getJson(doFetch, `${origin}/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`, headers).catch(() => null)
        : null;
    const body = scoped?.ok ? await scoped.json() : credits;
    const windows = [];
    const limits = body?.windowLimits || {};
    for (const [key, label] of [['fiveHour', 'Five hour'], ['weekly', 'Weekly']]) {
        const window = limits[key];
        const used = toNumber(window?.used);
        const cap = toNumber(window?.cap);
        if (used === undefined || !cap) continue;
        windows.push(normalizeWindow({
            label,
            usedPercent: (used / cap) * 100,
            resetAt: toIso(window?.resetAt),
            note: window?.exceeded ? 'exceeded' : '',
        }));
    }
    const creditsInfo = body?.credits || {};
    const total = ['monthlyCredits', 'purchasedCredits', 'freeCredits']
        .map((key) => toNumber(creditsInfo[key]) || 0)
        .reduce((a, b) => a + b, 0);
    const balances = total > 0
        ? [normalizeBalance({ label: 'Credits', amount: total, note: creditsInfo.planId || '' })].filter(Boolean)
        : [];
    return usageResult({
        windows: windows.filter(Boolean),
        balances,
        plan: creditsInfo.planId || '',
        source: 'alpha/billing/credits',
        emptyMessage: 'No credit fields',
    });
}

/** ClinePass plan usage limits. */
async function clinePassUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const base = 'https://api.cline.bot/api/v1';
    const response = await getJson(doFetch, `${base}/users/me/plan/usage-limits`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'Cline/3.0.58',
        'HTTP-Referer': 'https://cline.bot',
        'X-Title': 'Cline',
        'X-CLIENT-TYPE': 'cline-sdk',
        'X-CLIENT-VERSION': '3.0.58',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const labels = { five_hour: 'Five hour', weekly: 'Weekly', monthly: 'Monthly' };
    const windows = (payload?.data?.limits || [])
        .map((limit) => normalizeWindow({
            label: labels[limit?.type] || String(limit?.type || 'Quota'),
            usedPercent: toNumber(limit?.percentUsed),
            resetAt: toIso(limit?.resetsAt),
        }))
        .filter(Boolean);
    return usageResult({ windows, source: 'plan/usage-limits', emptyMessage: 'No limits' });
}

/** Synthetic rolling quota. */
async function syntheticUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const response = await getJson(doFetch, 'https://api.synthetic.new/v2/quotas', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const fiveHour = payload?.rollingFiveHourLimit;
    const weekly = payload?.weeklyTokenLimit;
    const windows = [];
    const max = toNumber(fiveHour?.max);
    const remaining = toNumber(fiveHour?.remaining);
    if (max && remaining !== undefined) {
        windows.push(normalizeWindow({
            label: 'Five hour',
            usedPercent: ((max - remaining) / max) * 100,
            resetAt: toIso(fiveHour?.nextTickAt),
            note: fiveHour?.limited ? 'exhausted' : '',
        }));
    }
    const percentRemaining = toNumber(weekly?.percentRemaining);
    if (percentRemaining !== undefined) {
        windows.push(normalizeWindow({
            label: 'Weekly',
            usedPercent: 100 - percentRemaining,
            resetAt: toIso(weekly?.nextRegenAt),
        }));
    }
    return usageResult({ windows: windows.filter(Boolean), source: 'v2/quotas' });
}

/** Charm Hyper credit balance. */
async function charmHyperUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const base = baseUrl || 'https://hyper.charm.land/v1';
    const response = await getJson(doFetch, `${base}/credits`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const balances = [normalizeBalance({ label: 'Credits', amount: payload?.balance })].filter(Boolean);
    return usageResult({ balances, source: 'v1/credits', emptyMessage: 'No balance field' });
}

/** Umans rolling request window. */
async function umansUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const base = (baseUrl || 'https://api.code.umans.ai').replace(/\/v1\/?$/, '');
    const response = await getJson(doFetch, `${base}/v1/usage`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const windows = [];
    const limit = toNumber(payload?.limits?.requests?.limit);
    const used = toNumber(payload?.usage?.weighted_in_window);
    if (limit && used !== undefined) {
        windows.push(normalizeWindow({
            label: 'Requests',
            usedPercent: (used / limit) * 100,
            resetAt: toIso(payload?.window?.resets_at),
        }));
    }
    const hardCap = toNumber(payload?.limits?.requests?.hard_cap);
    const inWindow = toNumber(payload?.usage?.requests_in_window);
    if (hardCap && inWindow !== undefined) {
        windows.push(normalizeWindow({
            label: 'Burst ceiling',
            usedPercent: (inWindow / hardCap) * 100,
            resetAt: toIso(payload?.window?.resets_at),
        }));
    }
    return usageResult({
        windows: windows.filter(Boolean),
        plan: payload?.plan?.display_name || '',
        source: 'v1/usage',
    });
}

/** OpenCode Go subscription windows. */
async function opencodeUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const response = await getJson(doFetch, 'https://opencode.ai/zen/go/v1/usage', {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'omtp-model-hub',
    });
    // A key without an active Go subscription answers 401/403.
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    if (payload?.error?.message) {
        return { ok: false, error: String(payload.error.message) };
    }
    const windows = [];
    for (const [key, label] of [['rolling', 'Five hour'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
        const bucket = payload?.usage?.[key];
        const used = toNumber(bucket?.percent);
        if (used === undefined) continue;
        windows.push(normalizeWindow({
            label,
            usedPercent: used,
            resetAt: toIso(bucket?.resetsAt),
            note: bucket?.status && bucket.status !== 'ok' ? String(bucket.status) : '',
        }));
    }
    return usageResult({ windows, plan: 'OpenCode Go', source: 'zen/go/v1/usage', emptyMessage: 'No usage windows' });
}

/** GitHub Copilot quota snapshots. */
async function copilotUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const response = await getJson(doFetch, 'https://api.github.com/copilot_internal/user', {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'copilot/1.0.82',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const windows = [];
    for (const [key, label] of [
        ['premium_interactions', 'Premium interactions'],
        ['chat', 'Chat requests'],
        ['completions', 'Completions'],
    ]) {
        const snapshot = payload?.quota_snapshots?.[key];
        if (!snapshot || snapshot.unlimited) continue;
        const entitlement = toNumber(snapshot.entitlement) || 0;
        const remaining = toNumber(snapshot.remaining) || 0;
        const percentRemaining = toNumber(snapshot.percent_remaining);
        let used;
        if (entitlement > 0) used = ((entitlement - remaining) / entitlement) * 100;
        else if (percentRemaining !== undefined) used = 100 - percentRemaining;
        windows.push(normalizeWindow({
            label,
            usedPercent: used,
            resetAt: toIso(payload?.quota_reset_date),
        }));
    }
    return usageResult({
        windows: windows.filter(Boolean),
        plan: payload?.copilot_plan || '',
        source: 'copilot_internal/user',
    });
}

/** xAI (SuperGrok) weekly credits / monthly quota. */
async function xaiUsage(id, resolved, doFetch) {
    const { token } = credentialsOf(resolved);
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'User-Agent': 'omtp-model-hub',
    };
    const response = await getJson(doFetch, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers);
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const config = payload?.config || {};
    const windows = [];
    const creditPercent = toNumber(config.creditUsagePercent);
    if (creditPercent !== undefined) {
        windows.push(normalizeWindow({
            label: 'Weekly credits',
            usedPercent: creditPercent,
            resetAt: toIso(config.currentPeriod?.end),
        }));
    }
    for (const product of config.productUsage || []) {
        const used = toNumber(product?.usagePercent);
        if (used === undefined) continue;
        windows.push(normalizeWindow({
            label: `${product?.product || 'Product'} credits`,
            usedPercent: used,
            resetAt: toIso(config.currentPeriod?.end),
        }));
    }
    const monthlyLimit = toNumber(config?.monthlyLimit?.val);
    const monthlyUsed = toNumber(config?.used?.val);
    if (monthlyLimit && monthlyUsed !== undefined) {
        windows.push(normalizeWindow({
            label: 'Monthly included',
            usedPercent: (monthlyUsed / monthlyLimit) * 100,
            resetAt: toIso(config.billingPeriodEnd),
        }));
    }
    const onDemandCap = toNumber(config?.onDemandCap?.val);
    const onDemandUsed = toNumber(config?.onDemandUsed?.val);
    if (onDemandCap && onDemandUsed !== undefined) {
        windows.push(normalizeWindow({
            label: 'On-demand',
            usedPercent: (onDemandUsed / onDemandCap) * 100,
            resetAt: null,
        }));
    }
    return usageResult({ windows: windows.filter(Boolean), source: 'v1/billing' });
}

/** Cursor usage (API keys use the legacy `/auth/usage` endpoint). */
async function cursorUsage(id, resolved, doFetch) {
    const { token, baseUrl } = credentialsOf(resolved);
    const base = (baseUrl || 'https://api2.cursor.sh').replace(/\/auth\/?$/, '');
    const response = await getJson(doFetch, `${base}/auth/usage`, {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'omtp-model-hub',
    });
    if (!response.ok) return httpFailure(response);
    const payload = await response.json();
    const windows = [];
    for (const [key, value] of Object.entries(payload || {})) {
        if (!value || typeof value !== 'object') continue;
        const used = toNumber(value.used ?? value.numRequests ?? value.amountUsed ?? value.usdUsed);
        const limit = toNumber(value.limit ?? value.maxRequestUsage ?? value.amountLimit ?? value.usdLimit);
        if (used === undefined || !limit) continue;
        const resetAt = value.billingCycleEnd || value.endOfMonth || value.resetsAt || value.nextReset || null;
        windows.push(normalizeWindow({
            label: key.replace(/_/g, ' '),
            usedPercent: (used / limit) * 100,
            resetAt: toIso(resetAt),
        }));
    }
    return usageResult({
        windows: windows.filter(Boolean),
        source: 'auth/usage',
        emptyMessage: 'No usage buckets',
    });
}

const ADAPTERS = {
    'openai-codex': codexUsage,
    'openai-codex-device': codexUsage,
    anthropic: anthropicUsage,
    'google-antigravity': antigravityUsage,
    'google-gemini-cli': antigravityUsage,
    zai: zaiUsage,
    'zai-coding-plan': zaiUsage,
    'zhipu-coding-plan': zaiUsage,
    'kimi-code': kimiUsage,
    'minimax-code': minimaxUsage,
    'minimax-code-cn': minimaxUsage,
    deepseek: deepseekUsage,
    'opencode-go': opencodeUsage,
    'github-copilot': copilotUsage,
    cursor: cursorUsage,
    'xai-oauth': xaiUsage,
    commandcode: commandcodeUsage,
    'cline-pass': clinePassUsage,
    synthetic: syntheticUsage,
    'charm-hyper': charmHyperUsage,
    umans: umansUsage,
};

/** Providers with a usage adapter. */
export const USAGE_PROVIDERS = new Set(Object.keys(ADAPTERS));

/**
 * Fetch usage for one provider.
 *
 * @param {string} providerId
 * @param {any} resolved Provider config (`apiKey`, `baseUrl`, `extraConfig`).
 * @param {{doFetch?: typeof fetch, refresh?: boolean, label?: string}} [options]
 */
export async function fetchProviderUsage(providerId, resolved, options = {}) {
    const id = String(providerId || '');
    const adapter = ADAPTERS[id];
    const label = options.label || resolved?.label || id;
    if (!adapter) {
        return { id, label, supported: false, ok: false, windows: [], error: '' };
    }
    if (!resolved?.apiKey) {
        return { id, label, supported: true, ok: false, windows: [], error: 'No credentials' };
    }
    const key = `${id}:${String(resolved.apiKey).slice(-12)}`;
    const cached = cache.get(key);
    const now = Date.now();
    if (!options.refresh && cached && now - cached.at < CACHE_TTL_MS) {
        return { ...cached.value, cached: true };
    }

    const doFetch = options.doFetch || fetch;
    let result;
    try {
        result = await adapter(id, resolved, doFetch);
    } catch (error) {
        result = { ok: false, error: String(error?.message || error) };
    }
    const value = {
        id,
        label,
        supported: true,
        ok: Boolean(result.ok),
        plan: result.plan || '',
        source: result.source || '',
        error: result.error || '',
        fetchedAt: new Date().toISOString(),
        windows: result.windows || [],
        balances: result.balances || [],
    };
    if (value.ok) {
        cache.set(key, { at: now, value });
    }
    return value;
}

/** Drop cached readings (tests, or after re-authenticating). */
export function clearUsageCache() {
    cache.clear();
}
