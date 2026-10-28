/**
 * Usage panel — per-provider quota, mirroring `omp usage`.
 *
 * The server normalises every provider's quota endpoint into
 * `{ windows: [{ label, usedPercent, remainingPercent, resetAt }] }`; this file
 * only renders it.
 */
import { getRequestHeaders } from '../../../../../../script.js';
import { API_BASE } from '../constants.js';
import { currentChatId, ensureUsageSession } from '../usage-session.js';
import { tr, trf } from './dom.js';

let host = null;
let loading = false;
/** Session baseline: token totals are counted from this moment until the chat changes. */
let sessionStartedAt = ensureUsageSession();

/**
 * Start a new "this session" window (called on chat change).
 * @param {string} [chatId] Chat id from the CHAT_CHANGED event.
 */
export function resetUsageSession(chatId) {
    sessionStartedAt = ensureUsageSession({ force: true, chatId });
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function api(path, init = {}) {
    const headers = { ...getRequestHeaders(), ...(init.headers || {}) };
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }
    return data;
}

/** @param {string|null} iso */
function resetText(iso) {
    if (!iso) return '';
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return '';
    const minutes = Math.round((at - Date.now()) / 60000);
    if (minutes <= 0) return tr('omtp_usage_reset_soon', 'resets now');
    if (minutes < 60) return trf('omtp_usage_reset_minutes', 'resets in ${0} min', minutes);
    const hours = Math.round(minutes / 60);
    if (hours < 48) return trf('omtp_usage_reset_hours', 'resets in ${0} h', hours);
    return trf('omtp_usage_reset_days', 'resets in ${0} d', Math.round(hours / 24));
}

/** Server-side balance labels → the two localized forms we ship. */
function balanceLabel(label) {
    if (label === 'Credits') return tr('omtp_usage_credits', 'Credits');
    return tr('omtp_usage_balance', 'Balance');
}

/**
 * Localised reason for a row without numbers. The server reports English
 * technical text; only the two known cases are translated.
 * @param {any} row
 * @returns {string}
 */
function describeError(row) {
    if (row.supported === false) {
        return tr('omtp_usage_unsupported', 'No usage endpoint for this provider');
    }
    if (row.error === 'No credentials') {
        return tr('omtp_usage_no_credentials', 'No credentials');
    }
    if (/^HTTP (401|403)/.test(row.error || '')) {
        return trf('omtp_usage_unauthorized', 'Credentials rejected (${0})', row.error);
    }
    if (row.error) {
        return trf('omtp_usage_failed', 'Read failed: ${0}', row.error);
    }
    return tr('omtp_usage_unavailable', 'No usage data');
}

/** @param {number} percent */
function toneFor(percent) {
    if (percent >= 90) return ' omtp-usage-critical';
    if (percent >= 70) return ' omtp-usage-warn';
    return '';
}

function renderRow(row) {
    const card = el('div', 'omtp-usage-card');
    const head = el('div', 'omtp-usage-head');
    head.append(el('span', 'omtp-usage-name', row.label || row.id));
    if (row.plan) head.append(el('span', 'omtp-usage-plan', row.plan));
    card.append(head);

    if (!row.ok) {
        card.append(el('div', 'omtp-usage-error', describeError(row)));
        return card;
    }

    for (const balance of row.balances || []) {
        const line = el('div', 'omtp-usage-window');
        const top = el('div', 'omtp-usage-window-head');
        top.append(el('span', 'omtp-usage-window-label', balanceLabel(balance.label)));
        top.append(el('span', 'omtp-usage-percent', `${balance.amount}${balance.currency ? ` ${balance.currency}` : ''}`));
        line.append(top);
        if (balance.note) line.append(el('div', 'omtp-usage-reset', balance.note));
        card.append(line);
    }

    for (const window of row.windows || []) {
        const line = el('div', 'omtp-usage-window');
        const top = el('div', 'omtp-usage-window-head');
        top.append(el('span', 'omtp-usage-window-label', window.label || ''));
        const used = Number(window.usedPercent ?? 0);
        top.append(el('span', 'omtp-usage-percent', `${Math.round(used)}%`));
        const bar = el('div', 'omtp-usage-bar');
        const fill = el('span', 'omtp-usage-fill' + toneFor(used));
        fill.style.width = `${Math.max(1, Math.min(100, used))}%`;
        bar.append(fill);
        line.append(top, bar);
        const meta = resetText(window.resetAt);
        if (meta) line.append(el('div', 'omtp-usage-reset', meta));
        card.append(line);
    }
    return card;
}

/** @param {number} tokens */
function formatTokens(tokens) {
    const value = Number(tokens) || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
}

/** @param {number} usd */
function formatUsd(usd) {
    const value = Number(usd) || 0;
    if (!value) return '$0';
    if (value < 0.001) return `$${value.toFixed(6)}`;
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
}

/**
 * Token totals: session (since the chat opened) and all-time, plus the
 * per-model table.
 */
async function renderStats(container) {
    const chatId = currentChatId();
    const sessionQuery = chatId
        ? `/stats?chat=${encodeURIComponent(chatId)}`
        : `/stats?since=${encodeURIComponent(sessionStartedAt)}`;
    const [session, total] = await Promise.all([
        api(sessionQuery).catch(() => null),
        api('/stats').catch(() => null),
    ]);
    if (!session && !total) {
        return;
    }

    const block = el('div', 'omtp-stats');
    block.append(el('div', 'omtp-stats-title', tr('omtp_stats_title', 'Token usage')));

    const addSummary = (label, data) => {
        const t = data?.totals || {};
        const line = el('div', 'omtp-stats-summary');
        line.append(el('span', 'omtp-stats-label', label));
        const parts = [
            trf('omtp_stats_requests', '${0} requests', t.requests || 0),
            trf('omtp_stats_input', 'input ${0}', formatTokens(t.input)),
            trf('omtp_stats_cached', 'cached ${0}', formatTokens(t.cachedInput)),
            trf('omtp_stats_output', 'output ${0}', formatTokens(t.output)),
            ...(t.reasoning ? [trf('omtp_stats_reasoning', 'reasoning ${0}', formatTokens(t.reasoning))] : []),
            trf('omtp_stats_cost', '≈ ${0}', formatUsd(t.costUsd)),
        ];
        line.append(el('span', 'omtp-stats-values', parts.join(' · ')));
        return line;
    };

    block.append(addSummary(tr('omtp_stats_session', 'This chat'), session));
    block.append(addSummary(tr('omtp_stats_total', 'All time'), total));

    const sessionModels = (session?.byModel || []).filter((row) => row.requests > 0);
    const models = (sessionModels.length ? sessionModels : (total?.byModel || []).filter((row) => row.requests > 0)).slice(0, 8);
    if (models.length) {
        const table = el('div', 'omtp-stats-models');
        const head = el('div', 'omtp-stats-row omtp-stats-row-head');
        for (const key of ['model', 'req', 'input', 'cached', 'output', 'cost']) {
            head.append(el('span', 'omtp-stats-cell', tr(`omtp_stats_col_${key}`, STATS_COLUMNS[key])));
        }
        table.append(head);
        for (const row of models) {
            const line = el('div', 'omtp-stats-row');
            line.append(el('span', 'omtp-stats-cell omtp-stats-model', `${row.provider}/${row.model}`));
            line.append(el('span', 'omtp-stats-cell', String(row.requests)));
            line.append(el('span', 'omtp-stats-cell', formatTokens(row.input)));
            line.append(el('span', 'omtp-stats-cell', formatTokens(row.cachedInput)));
            line.append(el('span', 'omtp-stats-cell', formatTokens(row.output)));
            line.append(el('span', 'omtp-stats-cell', formatUsd(row.costUsd)));
            table.append(line);
        }
        block.append(table);
    }
    block.append(el('div', 'omtp-stats-note', tr('omtp_stats_note', 'Costs are estimates from catalog prices; cache reads use the cached-input rate.')));
    container.append(block);
}

const STATS_COLUMNS = {
    model: 'Model',
    req: 'Req',
    input: 'Input',
    cached: 'Cached',
    output: 'Output',
    cost: 'Cost',
};

/**
 * Fetch and render the usage page.
 * @param {{refresh?: boolean}} [options]
 */
export async function refreshUsage({ refresh = false } = {}) {
    if (!host || loading) return;
    loading = true;
    host.replaceChildren(el('div', 'omtp-muted', tr('omtp_usage_loading', 'Reading quotas…')));
    try {
        const data = await api(`/usage${refresh ? '?refresh=true' : ''}`);
        const rows = Array.isArray(data.providers) ? data.providers : [];
        host.replaceChildren();
        if (!rows.length) {
            host.append(el('div', 'omtp-empty-state', tr('omtp_usage_empty', 'No provider exposes quota data.')));
            return;
        }
        await renderStats(host).catch(() => {});
        const list = el('div', 'omtp-usage-list');
        for (const row of rows) {
            list.append(renderRow(row));
        }
        host.append(list);
        const footer = el('div', 'omtp-usage-footer');
        footer.append(el('span', 'omtp-usage-source', tr('omtp_usage_source', 'Quotas come from each provider\'s own usage endpoint')));
        const refreshButton = el('button', 'menu_button', tr('omtp_usage_refresh', 'Refresh'));
        refreshButton.type = 'button';
        refreshButton.addEventListener('click', () => {
            refreshUsage({ refresh: true }).catch(() => {});
        });
        footer.append(refreshButton);
        host.append(footer);
    } catch (error) {
        host.replaceChildren(el('div', 'omtp-usage-error', String(error.message || error)));
    } finally {
        loading = false;
    }
}

/** @param {HTMLElement} container */
export async function mountUsagePanel(container) {
    host = container;
    sessionStartedAt = ensureUsageSession();
    await refreshUsage();
}

export function disposeUsagePanel() {
    host = null;
}
