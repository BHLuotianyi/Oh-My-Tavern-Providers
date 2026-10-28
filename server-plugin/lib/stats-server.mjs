/**
 * Local statistics dashboard, mirroring `omp stats`.
 *
 * `omp stats` starts a loopback HTTP server that serves a single-page dashboard
 * over the harness' usage database. We do the same for the gateway's own token
 * accounting: `/omtp stats` asks this module for a URL, and the page polls
 * `/api/stats` for the current numbers.
 *
 * Every response carries `x-omtp-stats-dashboard`, so a second SillyTavern
 * process can tell a live OMTP dashboard apart from an unrelated service on the
 * same port. The server binds to loopback only and shuts itself down after
 * {@link IDLE_MS} without a request; the plugin's `exit()` also stops it.
 */
import http from 'node:http';
import { log, logError } from './redact.mjs';

/** Marks our own dashboard; bumped when the API shape changes. */
export const DASHBOARD_HEADER = 'x-omtp-stats-dashboard';
export const DASHBOARD_VERSION = 1;
/** `omp stats`' default port; we start here and fall back to an ephemeral one. */
export const PREFERRED_PORT = 3847;
export const BIND_HOST = '127.0.0.1';
/** Idle shutdown window: a forgotten tab should not keep a port open forever. */
export const IDLE_MS = 30 * 60 * 1000;

/** @type {{server: import('node:http').Server, port: number, url: string, timer: NodeJS.Timeout|null}|null} */
let current = null;
/** @type {Promise<{url:string, port:number, reused:boolean}>|null} */
let starting = null;

/**
 * Snapshot source: anything with `snapshot()` (the `UsageStats` class).
 * @typedef {{snapshot: (options?: {since?: string|null, chat?: string}) => any}} StatsSource
 */

/**
 * @param {number} port
 * @param {string} chat
 * @param {string} [lang] UI language handed to the page (`zh-cn`, `en`, …)
 */
function dashboardUrl(port, chat, lang = '') {
    const base = `http://${BIND_HOST}:${port}/`;
    const params = new URLSearchParams();
    if (chat) params.set('chat', chat);
    if (lang) params.set('lang', lang);
    const query = params.toString();
    return query ? `${base}?${query}` : base;
}

/**
 * Probe a port for a live OMTP dashboard (same version).
 * @returns {Promise<boolean>}
 */
async function probeDashboard(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    try {
        const response = await fetch(`http://${BIND_HOST}:${port}/__omtp_stats__`, { signal: controller.signal });
        return response.ok && Number(response.headers.get(DASHBOARD_HEADER)) === DASHBOARD_VERSION;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} body @param {string} type */
function send(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'content-type': type,
        [DASHBOARD_HEADER]: String(DASHBOARD_VERSION),
        'x-omtp-stats-hostname': BIND_HOST,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} payload
 * @param {number} [status]
 */
function sendJson(res, payload, status = 200) {
    send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

/**
 * Build the request handler.
 * @param {StatsSource} stats
 */
function createHandler(stats) {
    /** @param {import('node:http').IncomingMessage} req */
    return (req, res) => {
        touch();
        const url = new URL(req.url || '/', `http://${BIND_HOST}`);
        const path = url.pathname;

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, { ok: false, error: 'method not allowed' }, 405);
            return;
        }
        if (path === '/' || path === '/index.html') {
            send(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
            return;
        }
        if (path === '/__omtp_stats__') {
            sendJson(res, { ok: true, version: DASHBOARD_VERSION });
            return;
        }
        if (path === '/favicon.ico') {
            send(res, 204, '');
            return;
        }
        if (path === '/api/stats') {
            const chat = url.searchParams.get('chat') || '';
            const since = url.searchParams.get('since') || null;
            try {
                sendJson(res, { ok: true, ...dashboardSnapshot(stats, { chat, since }) });
            } catch (error) {
                logError('stats dashboard snapshot failed', error);
                sendJson(res, { ok: false, error: 'snapshot failed' }, 500);
            }
            return;
        }
        sendJson(res, { ok: false, error: 'not found' }, 404);
    };
}

/**
 * Everything the page renders: the window it asked for, the all-time totals and
 * the per-chat table.
 * @param {StatsSource} stats
 * @param {{chat?: string, since?: string|null}} options
 */
export function dashboardSnapshot(stats, { chat = '', since = null } = {}) {
    const allTime = stats.snapshot();
    const live = chat ? stats.snapshot({ chat }) : (since ? stats.snapshot({ since }) : allTime);
    /** @type {Map<string, any>} */
    const chats = new Map();
    const source = stats.dashboard ? stats.dashboard() : null;
    for (const row of source?.byChat || []) {
        chats.set(row.chatId, row);
    }
    return {
        chat,
        since,
        window: live,
        allTime,
        byChat: [...chats.values()]
            .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.at || 0) - (a.at || 0))
            .slice(0, 50),
        startedAt: allTime?.startedAt || null,
        generatedAt: new Date().toISOString(),
    };
}

/** Reset the idle-shutdown timer after any request. */
function touch() {
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
        stopStatsServer();
    }, IDLE_MS);
    current.timer.unref?.();
}

/**
 * Start (or reuse) the dashboard server.
 *
 * Reuse order: this process' own server → another OMTP dashboard already on the
 * preferred port → a fresh listener on the preferred port → an ephemeral port.
 *
 * @param {{stats: StatsSource, chat?: string, lang?: string, port?: number}} options
 * @returns {Promise<{url:string, port:number, reused:boolean}>}
 */
export async function ensureStatsServer({ stats, chat = '', lang = '', port: requestedPort = PREFERRED_PORT }) {
    if (current) {
        touch();
        return { url: dashboardUrl(current.port, chat, lang), port: current.port, reused: true };
    }
    if (starting) return starting;

    starting = (async () => {
        if (requestedPort && await probeDashboard(requestedPort)) {
            return { url: dashboardUrl(requestedPort, chat, lang), port: requestedPort, reused: true };
        }

        const handler = createHandler(stats);
        /** @param {number} port */
        const listen = (port) => new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.once('error', reject);
            server.listen(port, BIND_HOST, () => {
                server.removeListener('error', reject);
                resolve(server);
            });
        });

        /** @type {import('node:http').Server} */
        let server;
        let port = requestedPort;
        try {
            server = await listen(requestedPort);
            port = server.address().port;
        } catch (error) {
            if (error?.code !== 'EADDRINUSE' || !requestedPort) throw error;
            server = await listen(0);
            port = server.address().port;
        }
        server.unref?.();
        current = { server, port, url: dashboardUrl(port), timer: null };
        server.on('close', () => {
            if (current?.server === server) current = null;
        });
        touch();
        log(`stats dashboard listening on ${dashboardUrl(port)}`);
        return { url: dashboardUrl(port, chat, lang), port, reused: false };
    })()
        .catch((error) => {
            logError('could not start stats dashboard', error);
            throw error;
        })
        .finally(() => {
            starting = null;
        });

    return starting;
}

/**
 * Current dashboard address, if one is running in this process.
 * @returns {{url:string, port:number}|null}
 */
export function statsServerStatus() {
    return current ? { url: current.url, port: current.port } : null;
}

/** Stop the dashboard server. Safe to call when nothing is running. */
export function stopStatsServer() {
    if (!current) return;
    const { server, timer } = current;
    if (timer) clearTimeout(timer);
    current = null;
    try {
        server.close();
    } catch (error) {
        logError('could not stop stats dashboard', error);
    }
}

/* eslint-disable */
const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMTP stats</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232563eb'/%3E%3Crect x='8' y='17' width='4' height='8' rx='1' fill='%23ffffff'/%3E%3Crect x='14' y='11' width='4' height='14' rx='1' fill='%23ffffff'/%3E%3Crect x='20' y='7' width='4' height='18' rx='1' fill='%23ffffff'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
  --surface: #f9fafb; --accent: #2563eb; --success: #16a34a; --warning: #d97706; --error: #dc2626;
  --c1: #2563eb; --c2: #16a34a; --c3: #d97706; --c4: #9333ea;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --border: #262a33;
    --surface: #161a21; --accent: #60a5fa; --success: #4ade80; --warning: #fbbf24; --error: #f87171;
    --c1: #60a5fa; --c2: #4ade80; --c3: #fbbf24; --c4: #c084fc; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
.meta { color: var(--muted); font-size: 12px; }
.spacer { flex: 1 1 auto; }
.controls { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
select, button { font: inherit; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
select#chat { max-width: 260px; }
button { cursor: pointer; }
button:hover, select:hover { border-color: var(--accent); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.card .value { font-size: 22px; font-variant-numeric: tabular-nums; margin-top: 4px; }
.card .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
section { margin-bottom: 28px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted);
  margin: 0 0 10px; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
tbody tr:hover { background: var(--surface); }
tbody tr.pickable { cursor: pointer; }
tbody tr.active { background: var(--surface); box-shadow: inset 2px 0 0 var(--accent); }
.model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.chart { display: flex; align-items: flex-end; gap: 4px; height: 140px; padding: 8px 8px 26px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow-x: auto; }
.bar { flex: 0 0 18px; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; position: relative; }
.bar i { display: block; background: var(--c1); border-radius: 3px 3px 0 0; min-height: 2px; opacity: .85; }
.bar span { position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); white-space: nowrap;
  font-size: 9px; color: var(--muted); }
.bar:hover i { opacity: 1; }
.empty { color: var(--muted); font-size: 12px; padding: 12px 0; }
footer { color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); padding-top: 12px; }
.err { color: var(--error); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1 data-i18n="title">OMTP stats</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <span class="controls">
    <label><span data-i18n="range">Range</span>
      <select id="range">
        <option value="chat" data-i18n="range_chat">This chat</option>
        <option value="24h" data-i18n="range_24h">Last 24 h</option>
        <option value="window" data-i18n="range_window">Since start</option>
        <option value="all" data-i18n="range_all">All time</option>
      </select>
    </label>
    <select id="chat" hidden></select>
    <label><input type="checkbox" id="live" checked> <span data-i18n="live">Live</span></label>
    <button id="refresh" data-i18n="refresh">Refresh</button>
  </span>
</header>

<div class="cards" id="cards"></div>

<section>
  <h2 data-i18n="daily">Daily usage</h2>
  <div class="chart" id="chart"></div>
</section>

<section>
  <h2 data-i18n="models">Models</h2>
  <div id="models"></div>
</section>

<section>
  <h2 data-i18n="chats">Chats</h2>
  <div id="chats"></div>
</section>

<footer>
  <span data-i18n="footer">Costs are estimates from catalog prices; cached input uses the cache-read rate.</span>
  <span id="status"></span>
</footer>

<script>
(function () {
  var DICT = {
    en: {
      title: 'OMTP stats',
      range: 'Range', range_chat: 'This chat', range_24h: 'Last 24 h',
      range_window: 'Since start', range_all: 'All time',
      live: 'Live', refresh: 'Refresh',
      requests: 'Requests', input: 'Input', cached: 'Cached', output: 'Output', cost: 'Cost',
      reasoning: 'Reasoning',
      sub_input: 'uncached prompt tokens', sub_cached: 'of prompt', sub_output: 'completion tokens',
      sub_reasoning: 'thinking tokens', sub_cost: 'estimated', since: 'since',
      daily: 'Daily usage', models: 'Models', chats: 'Chats',
      col_model: 'Model', col_chat: 'Chat', col_req: 'Req', col_input: 'Input',
      col_cached: 'Cached', col_output: 'Output', col_reasoning: 'Reasoning', col_cost: 'Cost',
      col_last: 'Last used',
      empty: 'Nothing here yet.', empty_chart: 'No usage recorded yet.',
      updated: 'updated', refresh_failed: 'refresh failed',
      active: 'current',
      footer: 'Costs are estimates from catalog prices; cached input uses the cache-read rate.',
      chat_option: 'req',
    },
    zh: {
      title: 'OMTP 统计',
      range: '范围', range_chat: '当前对话', range_24h: '最近 24 小时',
      range_window: '安装以来', range_all: '累计',
      live: '自动刷新', refresh: '刷新',
      requests: '请求数', input: '输入', cached: '缓存', output: '输出', cost: '费用',
      reasoning: '推理',
      sub_input: '非缓存输入 token', sub_cached: '占输入', sub_output: '完成 token',
      sub_reasoning: '思考 token', sub_cost: '预估', since: '自',
      daily: '每日用量', models: '按模型', chats: '按对话',
      col_model: '模型', col_chat: '对话', col_req: '请求', col_input: '输入',
      col_cached: '缓存', col_output: '输出', col_reasoning: '推理', col_cost: '费用',
      col_last: '最后使用',
      empty: '暂无数据', empty_chart: '还没有用量记录。',
      updated: '更新于', refresh_failed: '刷新失败',
      active: '当前',
      footer: '费用按目录单价估算，缓存读取按缓存单价计。',
      chat_option: '次',
    },
  };

  var params = new URLSearchParams(location.search);
  var chatId = params.get('chat') || '';
  var lang = (params.get('lang') || navigator.language || 'en').toLowerCase();
  var T = lang.indexOf('zh') === 0 ? DICT.zh : DICT.en;
  document.documentElement.lang = lang.indexOf('zh') === 0 ? 'zh-CN' : 'en';

  var state = { data: null, timer: null, range: chatId ? 'chat' : 'all', chat: chatId };

  function t(key) { return T[key] != null ? T[key] : key; }
  function fill(key, value) { return String(t(key)).replace('{0}', value); }

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function usd(n) {
    n = Number(n) || 0;
    if (!n) return '$0';
    if (n < 0.01) return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + n.toFixed(n < 1 ? 4 : 2);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function tile(label, value, sub) {
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + value +
      '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  /** Localize the static labels once. */
  function localize() {
    document.title = t('title');
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
  }

  function pickWindow(d) {
    if (state.range === 'all') return d.allTime;
    return d.window;
  }

  function renderCards(d) {
    var w = pickWindow(d);
    var tot = (w && w.totals) || {};
    var totalInput = (tot.input || 0) + (tot.cachedInput || 0);
    var hit = totalInput ? ((tot.cachedInput || 0) / totalInput * 100) : 0;
    var sub = state.range === 'chat' && state.chat ? esc(state.chat) :
      state.range === 'all' ? t('since') + ' ' + esc((d.startedAt || '').slice(0, 10)) : '';
    document.getElementById('cards').innerHTML =
      tile(t('requests'), fmt(tot.requests), sub) +
      tile(t('input'), fmt(tot.input), t('sub_input')) +
      tile(t('cached'), fmt(tot.cachedInput), hit.toFixed(1) + '% ' + t('sub_cached')) +
      tile(t('output'), fmt(tot.output), t('sub_output')) +
      (tot.reasoning ? tile(t('reasoning'), fmt(tot.reasoning), t('sub_reasoning')) : '') +
      tile(t('cost'), usd(tot.costUsd), t('sub_cost'));
  }

  function renderChart(d) {
    var days = (d.allTime && d.allTime.byDay) || [];
    var chart = document.getElementById('chart');
    if (!days.length) { chart.innerHTML = '<div class="empty">' + esc(t('empty_chart')) + '</div>'; return; }
    var max = Math.max.apply(null, days.map(function (x) {
      return (x.input || 0) + (x.cachedInput || 0) + (x.output || 0);
    }).concat([1]));
    chart.innerHTML = days.slice(-60).map(function (x) {
      var tokens = (x.input || 0) + (x.cachedInput || 0) + (x.output || 0);
      var pct = Math.max(2, Math.round(tokens / max * 100));
      var title = x.day + ' · ' + fmt(tokens) + ' tokens · ' + usd(x.costUsd) + ' · ' + (x.requests || 0) + ' ' + t('chat_option');
      return '<div class="bar" title="' + title + '"><i style="height:' + pct + '%"></i>' +
        '<span>' + esc((x.day || '').slice(5)) + '</span></div>';
    }).join('');
  }

  function table(rows, head, mapper, rowAttrs) {
    if (!rows || !rows.length) return '<div class="empty">' + esc(t('empty')) + '</div>';
    return '<table><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r, i) {
        var attrs = rowAttrs ? rowAttrs(r, i) : '';
        return '<tr' + attrs + '>' + mapper(r).map(function (c, j) {
          return j === 0 ? '<td class="model">' + c + '</td>' : '<td>' + c + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function renderModels(d) {
    var rows = (pickWindow(d) && pickWindow(d).byModel) || [];
    document.getElementById('models').innerHTML = table(
      rows,
      [t('col_model'), t('col_req'), t('col_input'), t('col_cached'), t('col_output'), t('col_reasoning'), t('col_cost')],
      function (r) {
        return [
          esc(r.provider + '/' + r.model),
          fmt(r.requests), fmt(r.input), fmt(r.cachedInput), fmt(r.output),
          fmt(r.reasoning), usd(r.costUsd),
        ];
      },
    );
  }

  /** Chat picker: every recorded chat, most expensive first. */
  function renderChatOptions(d) {
    var select = document.getElementById('chat');
    var rows = d.byChat || [];
    select.hidden = state.range !== 'chat';
    if (state.range !== 'chat') return;
    if (!rows.some(function (r) { return r.chatId === state.chat; }) && rows.length) {
      state.chat = rows[0].chatId;
    }
    select.innerHTML = rows.map(function (r) {
      var label = r.chatId + ' · ' + (r.requests || 0) + ' ' + t('chat_option') + ' · ' + usd(r.costUsd);
      return '<option value="' + esc(r.chatId) + '"' + (r.chatId === state.chat ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('') || '<option value="">' + esc(t('empty')) + '</option>';
    if (!rows.length) state.chat = '';
  }

  function renderChats(d) {
    var rows = d.byChat || [];
    document.getElementById('chats').innerHTML = table(
      rows,
      [t('col_chat'), t('col_req'), t('col_input'), t('col_cached'), t('col_output'), t('col_cost'), t('col_last')],
      function (r) {
        return [
          esc(r.chatId) + (r.chatId === state.chat ? ' <span style="color:var(--accent)">●</span>' : ''),
          fmt(r.requests), fmt(r.input), fmt(r.cachedInput), fmt(r.output), usd(r.costUsd),
          r.at ? esc(new Date(r.at).toLocaleString()) : '',
        ];
      },
      function (r) {
        return ' class="pickable' + (r.chatId === state.chat ? ' active' : '') + '" data-chat="' + esc(r.chatId) + '"';
      },
    );
    var body = document.querySelector('#chats tbody');
    if (body) {
      body.addEventListener('click', function (event) {
        var row = event.target.closest('tr[data-chat]');
        if (!row) return;
        state.chat = row.getAttribute('data-chat');
        state.range = 'chat';
        document.getElementById('range').value = 'chat';
        load();
      });
    }
  }

  function render(d) {
    state.data = d;
    if (!state.chat && d.chat) state.chat = d.chat;
    document.getElementById('meta').textContent = t('updated') + ' ' + new Date(d.generatedAt).toLocaleTimeString();
    renderCards(d);
    renderChart(d);
    renderModels(d);
    renderChatOptions(d);
    renderChats(d);
    document.getElementById('status').textContent = '';
  }

  async function load() {
    var query = new URLSearchParams();
    if (state.range === 'chat' && state.chat) query.set('chat', state.chat);
    if (state.range === '24h') query.set('since', new Date(Date.now() - 864e5).toISOString());
    var status = document.getElementById('status');
    try {
      var res = await fetch('/api/stats' + (query.toString() ? '?' + query : ''), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
    } catch (e) {
      status.className = 'err';
      status.textContent = ' · ' + t('refresh_failed') + ': ' + e.message;
    }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    if (document.getElementById('live').checked) state.timer = setInterval(load, 5000);
  }

  document.getElementById('range').addEventListener('change', function (e) {
    state.range = e.target.value;
    load();
  });
  document.getElementById('chat').addEventListener('change', function (e) {
    state.chat = e.target.value;
    load();
  });
  document.getElementById('live').addEventListener('change', schedule);
  document.getElementById('refresh').addEventListener('click', load);

  localize();
  document.getElementById('range').value = state.range;
  load();
  schedule();
})();
</script>
</body>
</html>`;
