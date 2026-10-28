/**
 * Compact, terminal-style model picker.
 *
 * Mirrors omp's alt+p overlay: a bottom-anchored list with a search line, a
 * `> ` cursor, the current model marked `●`, cyclic ↑/↓, page keys and a
 * two-step Esc (clear query, then close). It is deliberately separate from the
 * hub so `/switch` stays a one-keystroke affair.
 */
import { tr, trf } from './dom.js';

/** Rows visible at once; the list scrolls inside this window. */
const WINDOW_ROWS = 9;

/** @type {HTMLElement|null} */
let overlay = null;
/** @type {HTMLElement|null} */
let listEl = null;
/** @type {HTMLElement|null} */
let inputEl = null;
/** @type {HTMLElement|null} */
let statusEl = null;
/** @type {object[]} */
let items = [];
/** @type {object[]} */
let filtered = [];
let cursor = 0;
let offset = 0;
/** @type {((entry: object) => void)|null} */
let onPick = null;
/** @type {Function|null} */
let rank = null;
/** @type {string} */
let currentKey = '';
/** @type {HTMLElement|null} */
let previousFocus = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Rank the model list for the current query.
 * @param {string} query
 * @returns {object[]}
 */
function applyQuery(query) {
    const raw = String(query || '').trim();
    if (!raw) {
        return items;
    }
    if (typeof rank === 'function') {
        try {
            const ranked = rank(raw, items);
            if (Array.isArray(ranked)) {
                return ranked;
            }
        } catch (error) {
            console.debug('[omtp] quick picker ranking failed', error);
        }
    }
    const needle = raw.toLowerCase();
    return items.filter((entry) => String(entry.key || '').toLowerCase().includes(needle)
        || String(entry.model || '').toLowerCase().includes(needle)
        || String(entry.provider || '').toLowerCase().includes(needle));
}

function rowText(entry) {
    const provider = entry.provider ? `${entry.provider}/` : '';
    return `${provider}${entry.model}`;
}

function renderList() {
    if (!listEl) {
        return;
    }
    listEl.replaceChildren();
    if (!filtered.length) {
        listEl.append(el('div', 'omtp-picker-empty', tr('omtp_picker_no_match', 'No models match.')));
        return;
    }
    if (cursor < offset) {
        offset = cursor;
    }
    if (cursor >= offset + WINDOW_ROWS) {
        offset = cursor - WINDOW_ROWS + 1;
    }
    const end = Math.min(filtered.length, offset + WINDOW_ROWS);
    for (let index = offset; index < end; index += 1) {
        const entry = filtered[index];
        const selected = index === cursor;
        const row = el('div', 'omtp-picker-row' + (selected ? ' omtp-picker-row-active' : ''));
        row.dataset.index = String(index);
        row.append(el('span', 'omtp-picker-cursor', selected ? '> ' : '  '));
        const provider = entry.provider ? `${entry.provider}/` : '';
        if (provider) {
            row.append(el('span', 'omtp-picker-provider', provider));
        }
        row.append(el('span', 'omtp-picker-model', String(entry.model || '')));
        if (entry.key && entry.key === currentKey) {
            row.append(el('span', 'omtp-picker-current', ' ●'));
        }
        if (entry.available === false) {
            row.append(el('span', 'omtp-picker-locked', ` · ${tr('omtp_missing_key', 'no key')}`));
        }
        row.addEventListener('mousedown', (event) => {
            event.preventDefault();
            cursor = index;
            commit();
        });
        listEl.append(row);
    }
    if (filtered.length > WINDOW_ROWS) {
        statusEl.textContent = `${cursor + 1}/${filtered.length}`;
    } else {
        statusEl.textContent = '';
    }
}

function refresh(query) {
    filtered = applyQuery(query);
    cursor = 0;
    offset = 0;
    renderList();
}

function close() {
    if (!overlay) {
        return;
    }
    overlay.remove();
    overlay = null;
    listEl = null;
    inputEl = null;
    statusEl = null;
    items = [];
    filtered = [];
    onPick = null;
    rank = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        try {
            previousFocus.focus();
        } catch {
            // ignore
        }
    }
    previousFocus = null;
}

function commit() {
    const entry = filtered[cursor];
    if (!entry || entry.available === false) {
        return;
    }
    const handler = onPick;
    close();
    try {
        handler?.(entry);
    } catch (error) {
        console.warn('[omtp] quick picker apply failed', error);
    }
}

function onKeyDown(event) {
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            if (filtered.length) {
                cursor = (cursor + 1) % filtered.length;
                renderList();
            }
            break;
        case 'ArrowUp':
            event.preventDefault();
            if (filtered.length) {
                cursor = (cursor - 1 + filtered.length) % filtered.length;
                renderList();
            }
            break;
        case 'PageDown':
            event.preventDefault();
            cursor = Math.min(filtered.length - 1, cursor + WINDOW_ROWS);
            renderList();
            break;
        case 'PageUp':
            event.preventDefault();
            cursor = Math.max(0, cursor - WINDOW_ROWS);
            renderList();
            break;
        case 'Home':
            event.preventDefault();
            cursor = 0;
            renderList();
            break;
        case 'End':
            event.preventDefault();
            cursor = Math.max(0, filtered.length - 1);
            renderList();
            break;
        case 'Enter':
            event.preventDefault();
            commit();
            break;
        case 'Escape':
            event.preventDefault();
            if (inputEl?.value) {
                inputEl.value = '';
                refresh('');
            } else {
                close();
            }
            break;
        default:
            break;
    }
}

/**
 * Open the picker.
 *
 * @param {object} options
 * @param {object[]} options.items selectable entries
 * @param {string} [options.currentKey] key of the entry to mark as current
 * @param {string} [options.title]
 * @param {string} [options.hint]
 * @param {(entry: object) => void} options.onPick
 * @param {(query: string, items: object[]) => object[]} [options.rank]
 */
export function openQuickPicker({ items: list, currentKey: key, title, hint, onPick: pick, rank: rankFn } = {}) {
    close();
    items = Array.isArray(list) ? list.filter((entry) => entry && entry.available !== false) : [];
    currentKey = String(key || '');
    onPick = typeof pick === 'function' ? pick : null;
    rank = typeof rankFn === 'function' ? rankFn : null;

    overlay = el('div', 'omtp-picker-overlay');
    const box = el('div', 'omtp-picker');

    const header = el('div', 'omtp-picker-header');
    header.append(el('span', 'omtp-picker-title', title || tr('omtp_picker_title', 'Switch model')));
    header.append(el('span', 'omtp-picker-hint', hint || tr('omtp_picker_hint', 'session-only')));
    box.append(header);

    const searchRow = el('div', 'omtp-picker-search');
    searchRow.append(el('span', 'omtp-picker-search-icon', '🔍'));
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'omtp-picker-input';
    inputEl.placeholder = tr('omtp_picker_search', 'Search provider/model');
    inputEl.addEventListener('input', () => refresh(inputEl.value));
    inputEl.addEventListener('keydown', onKeyDown);
    searchRow.append(inputEl);
    statusEl = el('span', 'omtp-picker-status', '');
    searchRow.append(statusEl);
    box.append(searchRow);

    listEl = el('div', 'omtp-picker-list');
    box.append(listEl);

    const footer = el('div', 'omtp-picker-footer');
    footer.textContent = tr(
        'omtp_picker_footer',
        '↑↓ move · enter apply · type to search · esc clear/close',
    );
    box.append(footer);

    overlay.append(box);
    overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) {
            close();
        }
    });
    document.body.append(overlay);

    previousFocus = document.activeElement;
    refresh('');
    if (!items.length) {
        statusEl.textContent = tr('omtp_picker_empty', 'No usable models');
    }
    setTimeout(() => inputEl?.focus(), 0);
    return { close };
}

/** Close the picker if it is open. */
export function closeQuickPicker() {
    close();
}

/** True when the picker is on screen. */
export function isQuickPickerOpen() {
    return Boolean(overlay);
}
