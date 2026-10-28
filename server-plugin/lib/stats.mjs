/**
 * Token accounting for the gateway.
 *
 * Every chat completion the gateway proxies is counted here, mirroring OMP's
 * run collector: uncached input, cache reads, cache writes, output and
 * reasoning output, plus an estimated cost from the catalog's per-million
 * prices (`models[].cost`, inherited from OMP's catalog).
 *
 * Counters live in memory and are flushed to `data/omtp/usage-stats.json` on a
 * short debounce so a restart does not lose the day's totals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logError } from './redact.mjs';

const FLUSH_DELAY_MS = 1500;
const KEEP_DAYS = 60;
/** Recent completions kept in memory so "this session" is exact, not day-bucketed. */
const MAX_EVENTS = 2000;
/** Chat-scoped counters survive restarts, but only the most recent chats are kept. */
const MAX_CHATS = 50;

/** Token buckets accumulated per model/day/chat (all others are cost counters). */
const TOKEN_KEYS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'];

/**
 * Keep at most `max` entries of a Map, dropping the ones that sort first.
 * @param {Map<string, any>} map
 * @param {number} max
 * @param {(a: [string, any], b: [string, any]) => number} compare
 */
function trimToSize(map, max, compare) {
    if (map.size <= max) return;
    const keys = [...map.entries()].sort(compare).map(([key]) => key);
    for (const key of keys.slice(0, map.size - max)) {
        map.delete(key);
    }
}

/** @type {{ input:number, cachedInput:number, cacheWrite:number, output:number, reasoning:number, requests:number, costUsd:number }} */
const emptyTotals = () => ({
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    costUsd: 0,
});

export class UsageStats {
    /**
     * @param {{root: string, now?: () => number}} options
     */
    constructor({ root, now = () => Date.now() }) {
        this.root = root;
        this.now = now;
        this.totals = emptyTotals();
        /** @type {Map<string, {model:string, provider:string, totals: ReturnType<typeof emptyTotals>, price: any}>} */
        this.byModel = new Map();
        /** @type {Map<string, ReturnType<typeof emptyTotals>>} */
        this.byDay = new Map();
        /** @type {Map<string, {totals: ReturnType<typeof emptyTotals>, byModel: Map<string, any>, at:number}>} */
        this.byChat = new Map();
        /** @type {{at:number, chatId:string, provider:string, model:string, costUsd:number, tokens:any}[]} */
        this.events = [];
        this.startedAt = new Date(now()).toISOString();
        this.flushTimer = null;
        this._load();
    }

    get file() {
        return path.join(this.root, 'usage-stats.json');
    }

    _load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (raw?.totals) this.totals = { ...emptyTotals(), ...raw.totals };
            if (raw?.startedAt) this.startedAt = raw.startedAt;
            for (const entry of raw?.byModel || []) {
                this.byModel.set(`${entry.provider}/${entry.model}`, {
                    model: entry.model,
                    provider: entry.provider,
                    totals: { ...emptyTotals(), ...entry.totals },
                    price: entry.price || null,
                });
            }
            for (const entry of raw?.byDay || []) {
                this.byDay.set(entry.day, { ...emptyTotals(), ...entry.totals });
            }
            for (const entry of raw?.byChat || []) {
                if (!entry?.chatId) continue;
                this.byChat.set(entry.chatId, {
                    totals: { ...emptyTotals(), ...entry.totals },
                    byModel: new Map((entry.byModel || []).map((row) => [`${row.provider}/${row.model}`, row])),
                    at: Number(entry.at) || 0,
                });
            }
        } catch {
            // First run or unreadable file: start empty.
        }
    }

    _flush() {
        this.flushTimer = null;
        const payload = {
            totals: this.totals,
            startedAt: this.startedAt,
            updatedAt: new Date(this.now()).toISOString(),
            byModel: [...this.byModel.values()],
            byDay: [...this.byDay.entries()].map(([day, totals]) => ({ day, totals })),
            byChat: [...this.byChat.entries()].map(([chatId, entry]) => ({
                chatId,
                totals: entry.totals,
                at: entry.at,
                byModel: [...entry.byModel.values()],
            })),
        };
        try {
            fs.mkdirSync(this.root, { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (error) {
            logError('could not persist usage stats', error);
        }
    }

    _scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => this._flush(), FLUSH_DELAY_MS);
        this.flushTimer.unref?.();
    }

    /**
     * Record one completion.
     *
     * @param {{provider:string, model:string, price?:any, usage:any, chatId?:string}} event
     */
    record({ provider, model, price, usage, chatId = '' }) {
        const input = Number(usage?.input) || 0;
        const cachedInput = Number(usage?.cachedInput) || 0;
        const cacheWrite = Number(usage?.cacheWrite) || 0;
        const output = Number(usage?.output) || 0;
        const reasoning = Number(usage?.reasoning) || 0;
        if (!input && !cachedInput && !cacheWrite && !output) {
            return null;
        }
        const costUsd = estimateCost({ input, cachedInput, cacheWrite, output }, price);
        const stamp = this.now();
        const day = new Date(stamp).toISOString().slice(0, 10);

        const add = (target) => {
            target.input += input;
            target.cachedInput += cachedInput;
            target.cacheWrite += cacheWrite;
            target.output += output;
            target.reasoning += reasoning;
            target.requests += 1;
            target.costUsd += costUsd;
        };

        this.events.push({
            at: stamp,
            chatId: String(chatId || ''),
            provider,
            model,
            costUsd,
            tokens: { input, cachedInput, cacheWrite, output, reasoning },
        });
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        add(this.totals);
        const key = `${provider}/${model}`;
        let entry = this.byModel.get(key);
        if (!entry) {
            entry = { model, provider, totals: emptyTotals(), price: price || null };
            this.byModel.set(key, entry);
        }
        add(entry.totals);
        let dayTotals = this.byDay.get(day);
        if (!dayTotals) {
            dayTotals = emptyTotals();
            this.byDay.set(day, dayTotals);
        }
        add(dayTotals);
        const chatKey = String(chatId || '').trim();
        if (chatKey) {
            let chatEntry = this.byChat.get(chatKey);
            if (!chatEntry) {
                chatEntry = { totals: emptyTotals(), byModel: new Map(), at: stamp };
                this.byChat.set(chatKey, chatEntry);
            }
            chatEntry.at = stamp;
            add(chatEntry.totals);
            const modelKey = `${provider}/${model}`;
            let chatModel = chatEntry.byModel.get(modelKey);
            if (!chatModel) {
                chatModel = { provider, model, ...emptyTotals(), price: price || null };
                chatEntry.byModel.set(modelKey, chatModel);
            }
            add(chatModel);
            trimToSize(this.byChat, MAX_CHATS, (a, b) => a[1].at - b[1].at);
        }
        trimToSize(this.byDay, KEEP_DAYS, (a, b) => a[0].localeCompare(b[0]));
        this._scheduleFlush();
    }

    /**
     * Fold the in-memory event ring into totals plus per-model rows.
     * @param {(event: {at:number, chatId:string, provider:string, model:string, costUsd:number, tokens:any}) => boolean} include
     */
    #accumulate(include) {
        const totals = emptyTotals();
        const perModel = new Map();
        let oldest = null;
        for (const event of this.events) {
            if (!include(event)) continue;
            oldest = oldest === null ? event.at : Math.min(oldest, event.at);
            totals.requests += 1;
            totals.costUsd += event.costUsd;
            for (const key of TOKEN_KEYS) {
                totals[key] += event.tokens[key] || 0;
            }
            const id = `${event.provider}/${event.model}`;
            let entry = perModel.get(id);
            if (!entry) {
                entry = { provider: event.provider, model: event.model, ...emptyTotals(), price: this.byModel.get(id)?.price || null };
                perModel.set(id, entry);
            }
            entry.requests += 1;
            entry.costUsd += event.costUsd;
            for (const key of TOKEN_KEYS) {
                entry[key] += event.tokens[key] || 0;
            }
        }
        return { totals, perModel, oldest };
    }

    /**
     * Totals for one SillyTavern chat (events carry the chat id header).
     * @param {string} chatId
     */
    #chatSnapshot(chatId) {
        const stored = this.byChat.get(chatId);
        if (stored) {
            return {
                chat: chatId,
                since: null,
                partial: false,
                totals: { ...stored.totals },
                byModel: [...stored.byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
                startedAt: this.startedAt,
                generatedAt: new Date(this.now()).toISOString(),
            };
        }
        const { totals, perModel, oldest } = this.#accumulate((event) => event.chatId === chatId);
        return {
            chat: chatId,
            since: oldest === null ? null : new Date(oldest).toISOString(),
            // Events outside the ring (older than MAX_EVENTS completions) are missing.
            partial: this.events.length > 0 && this.events[0]?.chatId !== chatId && totals.requests === 0,
            totals,
            byModel: [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd),
            startedAt: this.startedAt,
            generatedAt: new Date(this.now()).toISOString(),
        };
    }

    /**
     * Data the local dashboard (`/omtp stats`) renders beyond `snapshot()`:
     * one row per chat, already flattened.
     */
    dashboard() {
        return {
            startedAt: this.startedAt,
            byChat: [...this.byChat.entries()].map(([chatId, entry]) => ({
                chatId,
                at: entry.at,
                ...entry.totals,
            })),
        };
    }

    /**
     * Snapshot of everything, of one chat, or of everything since an ISO
     * timestamp.
     * @param {{since?: string|null, chat?: string}} [options]
     */
    snapshot({ since = null, chat = '' } = {}) {
        if (chat) {
            return this.#chatSnapshot(chat);
        }
        const cutoff = since ? Date.parse(since) : NaN;
        if (Number.isFinite(cutoff)) {
            const { totals, perModel } = this.#accumulate((event) => event.at >= cutoff);
            // True when the requested window reaches back further than the
            // in-memory event log, in which case numbers are a lower bound.
            const covered = this.events.length > 0 && this.events[0].at <= cutoff;
            return {
                since,
                partial: !covered,
                totals,
                byModel: [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd),
                startedAt: this.startedAt,
                generatedAt: new Date(this.now()).toISOString(),
            };
        }
        return {
            since: null,
            partial: false,
            totals: { ...this.totals },
            byModel: [...this.byModel.values()]
                .map((entry) => ({
                    model: entry.model,
                    provider: entry.provider,
                    ...entry.totals,
                    price: entry.price,
                }))
                .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
            byDay: [...this.byDay.entries()]
                .map(([day, totals]) => ({ day, ...totals }))
                .sort((a, b) => a.day.localeCompare(b.day)),
            startedAt: this.startedAt,
            generatedAt: new Date(this.now()).toISOString(),
        };
    }
}

/**
 * USD estimate from per-million prices.
 * @param {{input:number, cachedInput:number, cacheWrite:number, output:number}} tokens
 * @param {{input?:number, output?:number, cacheRead?:number, cacheWrite?:number}|null} price
 * @returns {number}
 */
export function estimateCost(tokens, price) {
    if (!price) return 0;
    const perMillion = (count, rate) => (Number(count) || 0) * (Number(rate) || 0) / 1_000_000;
    const cacheReadRate = price.cacheRead ?? price.input ?? 0;
    const cacheWriteRate = price.cacheWrite ?? price.input ?? 0;
    return perMillion(tokens.input, price.input)
        + perMillion(tokens.cachedInput, cacheReadRate)
        + perMillion(tokens.cacheWrite, cacheWriteRate)
        + perMillion(tokens.output, price.output);
}

/**
 * Convert an OpenAI-shaped `usage` object into our counters.
 * @param {any} usage
 */
export function tokensFromOpenAIUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    const cached = Number(details.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens) || 0;
    const cacheWrite = Number(details.cache_write_tokens ?? usage.cache_write_input_tokens) || 0;
    const reasoning = Number(
        usage.completion_tokens_details?.reasoning_tokens
        ?? usage.output_tokens_details?.reasoning_tokens
        ?? usage.reasoning_tokens,
    ) || 0;
    // OpenAI counts cached tokens inside `prompt_tokens`; our buckets are disjoint.
    const uncached = Math.max(0, prompt - cached - cacheWrite);
    if (!prompt && !completion) return null;
    return { input: uncached, cachedInput: cached, cacheWrite, output: completion, reasoning };
}

/**
 * Tap an OpenAI-style response body (JSON or SSE) and call `onUsage` once with
 * the last usage object seen.
 * @param {(usage:any) => void} onUsage
 * @param {{isStream?: boolean}} [options]
 */
export function createUsageTap(onUsage, { isStream = false } = {}) {
    let buffer = '';
    let lastUsage = null;
    const takeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
            const parsed = JSON.parse(payload);
            if (parsed?.usage) lastUsage = parsed.usage;
        } catch {
            // Partial JSON: the caller keeps the tail in `buffer`.
        }
    };
    return {
        /** @param {Buffer|string} chunk */
        push(chunk) {
            const text = String(chunk);
            if (!isStream) {
                buffer += text;
                return;
            }
            buffer += text;
            const newline = buffer.lastIndexOf('\n');
            if (newline < 0) return;
            const complete = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            for (const line of complete.split('\n')) takeLine(line);
        },
        end() {
            if (isStream) {
                if (buffer.trim()) takeLine(buffer);
            } else {
                try {
                    const parsed = JSON.parse(buffer);
                    if (parsed?.usage) lastUsage = parsed.usage;
                } catch {
                    // Not JSON: nothing to account.
                }
            }
            buffer = '';
            if (lastUsage) onUsage(lastUsage);
        },
    };
}
