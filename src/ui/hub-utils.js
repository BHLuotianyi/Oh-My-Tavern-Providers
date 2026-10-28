/**
 * Shared helpers for the hub modules: element factories that need hub styling,
 * settings access, entry keys and small formatting utilities.
 */
import * as store from '../store.js';
import { tr } from './dom.js';

/**
 * Small Font Awesome capability marker for a model row.
 * @param {string} icon FA icon class suffix
 * @param {string} title Tooltip text
 * @returns {HTMLElement}
 */
export function capabilityIcon(icon, title) {
    const element = document.createElement('i');
    element.className = `omtp-capability fa-solid ${icon}`;
    element.title = title;
    element.setAttribute('aria-label', title);
    return element;
}

/**
 * Show a toast, degrading to the console when toastr is unavailable.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 */
export function toast(message, type = 'info') {
    const text = String(message ?? '');
    if (!text) {
        return;
    }
    try {
        const toastr = globalThis.toastr;
        if (toastr && typeof toastr[type] === 'function') {
            toastr[type](text, 'OMTP');
            return;
        }
    } catch {
        // fall through to console
    }
    if (type === 'error') {
        console.error('[omtp]', text);
    } else {
        console.log('[omtp]', text);
    }
}

/**
 * Put a live-refresh button into its busy or idle state.
 * @param {HTMLElement|null} button
 * @param {boolean} busy
 */
export function setLiveRefreshState(button, busy) {
    if (!button) {
        return;
    }
    if (busy) {
        button.textContent = '⏳ ' + tr('omtp_syncing', 'Syncing…');
        return;
    }
    button.textContent = '🔄 ' + tr('omtp_refresh_live_models', 'Refresh live models');
}

/** @returns {object} */
export function settings() {
    try {
        return store.getSettings() || {};
    } catch {
        return {};
    }
}

/** @param {object} patch */
export function persist(patch) {
    try {
        store.updateSettings(patch);
    } catch (error) {
        console.warn('[omtp] could not save settings', error);
    }
}

/** @param {object|null|undefined} ref */
export function refKey(ref) {
    if (!ref) {
        return '';
    }
    try {
        return store.getEntryKey(ref);
    } catch {
        return `${ref.kind}/${ref.provider}/${ref.model}`;
    }
}

/** @param {object} entry */
export function entryKey(entry) {
    if (!entry) {
        return '';
    }
    return entry.key || refKey(entry);
}

/** @param {object} entry */
export function refOf(entry) {
    return { kind: entry.kind, provider: entry.provider, model: entry.model };
}

/** @param {object|null} a @param {object|null} b */
export function sameRef(a, b) {
    return Boolean(a && b) && a.kind === b.kind && a.provider === b.provider && a.model === b.model;
}

/** @param {object} entry */
export function sourceOf(entry) {
    if (!entry) {
        return 'Native';
    }
    if (entry.kind === 'profile') {
        return 'Profile';
    }
    if (entry.kind === 'omp') {
        return 'OMTP';
    }
    return entry.source === 'Translated' ? 'Translated' : 'Native';
}

/** @param {object} entry */
export function sourceLabel(entry) {
    const source = sourceOf(entry);
    const key = `omtp_source_${source.toLowerCase()}`;
    return tr(key, source);
}

/** @param {object} entry */
export function isFavoriteEntry(entry) {
    const key = entryKey(entry);
    return (settings().favorites || []).some((ref) => refKey(ref) === key);
}

/** @param {object} entry */
export function isRecentEntry(entry) {
    const key = entryKey(entry);
    return (settings().recents || []).some((ref) => refKey(ref) === key);
}

/** @param {object} entry @returns {number} */
export function findQuickSlot(entry) {
    const key = entryKey(entry);
    const slots = settings().quickSlots || [];
    return slots.findIndex((ref) => ref && refKey(ref) === key);
}

/** @param {unknown} value */
export function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? new Intl.NumberFormat().format(number) : '—';
}

/** @returns {string|null} */
export function currentAvatar() {
    try {
        const chid = globalThis.this_chid;
        if (chid === undefined || chid === null) {
            return null;
        }
        const character = globalThis.characters?.[chid];
        return character?.avatar ?? null;
    } catch {
        return null;
    }
}

/**
 * Escape a value for use inside a CSS attribute selector.
 * @param {string} value
 */
export function cssEscape(value) {
    if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
}

/** @param {EventTarget|null} target */
export function isEditableTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
