/**
 * Shared "this chat" baseline for token accounting.
 *
 * The gateway keeps totals; both the usage page and the chat chip ask for the
 * slice that happened after this timestamp. It is persisted per chat id so a
 * reload keeps the same window.
 */
import { getSettings, updateSettings } from './store.js';

/** @returns {string} Current chat id, or '' when none is open. */
export function currentChatId() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const id = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx?.chatId;
        return typeof id === 'string' ? id : '';
    } catch {
        return '';
    }
}

/**
 * Reuse the stored baseline for this chat, or start a new one.
 * @param {{force?: boolean, chatId?: string}} [options] `chatId` comes from the
 *   CHAT_CHANGED event, which is more reliable than a fresh lookup.
 * @returns {string} ISO timestamp the session starts at.
 */
export function ensureUsageSession({ force = false, chatId: eventChatId } = {}) {
    const chatId = typeof eventChatId === 'string' ? eventChatId : currentChatId();
    const stored = getSettings().usageSession;
    if (!force && stored?.chatId === chatId && stored.startedAt) {
        return stored.startedAt;
    }
    const startedAt = new Date().toISOString();
    try {
        updateSettings({ usageSession: { chatId, startedAt } });
    } catch {
        // Settings unavailable: caller still gets the timestamp.
    }
    return startedAt;
}
