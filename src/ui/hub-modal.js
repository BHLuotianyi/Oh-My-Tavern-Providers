/**
 * Modal shell, open/close lifecycle and keyboard handling for the hub.
 */
import { Popup } from '../../../../../popup.js';
import { setOnlineStatus } from '../../../../../../script.js';
import * as engine from '../switch-engine.js';
import { API_BASE, DEFAULT_HOTKEY, QUICK_SLOT_COUNT, SEARCH_DEBOUNCE_MS } from '../constants.js';
import { supportsProviderNames } from '../provider-names.js';
import * as loginPanel from './login-panel.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import { cssEscape, entryKey, isEditableTarget, persist, settings, toast } from './hub-utils.js';
import {
    getSelectedEntry,
    loadCatalogOnce,
    loadProviderAvailability,
    mainstreamOnly,
    rebuildEntries,
    scoredOnly,
} from './hub-catalog.js';
import { highlightSelectedRow, renderList } from './hub-list.js';
import { renderDetails, toggleFavorite } from './hub-details.js';
import { assignQuickSlotFromSelection, renderAll, renderFooter, syncTabs, useQuickSlot } from './hub-quick.js';
import { renderProviderList } from './hub-sidebar.js';
import { useEntry } from './hub-actions.js';

/**
 * Poll the gateway status endpoint and paint the header pill.
 */
async function updateGatewayPill() {
    const dot = document.getElementById('omtp-gateway-dot');
    const label = document.getElementById('omtp-gateway-label');
    const pill = document.getElementById('omtp-gateway-pill');
    if (!dot || !label || !pill) return;

    const markOnline = (port) => {
        dot.className = 'omtp-status-dot omtp-dot-online';
        label.textContent = trf('omtp_gateway_online', 'Gateway online (${0})', port);
        pill.title = trf('omtp_gateway_online_hint', 'Local gateway is running (http://127.0.0.1:${0}/v1)', port);
    };

    try {
        const res = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
            const data = await res.json();
            if (data.gateway?.running || data.gateway?.listening) {
                markOnline(data.gateway.port);
                return;
            }
        }
    } catch {}
    try {
        const healthRes = await fetch('http://127.0.0.1:4100/health', { signal: AbortSignal.timeout(1500) });
        if (healthRes.ok) {
            markOnline(4100);
            return;
        }
    } catch {}

    dot.className = 'omtp-status-dot omtp-dot-offline';
    label.textContent = tr('omtp_gateway_offline', 'Gateway offline');
    pill.title = tr('omtp_gateway_offline_hint', 'Gateway not reachable — click to start it');
}

/**
 * Start/restart the gateway when the header pill is clicked.
 */
async function onGatewayPillClick() {
    try {
        const res = await fetch(`${API_BASE}/status`);
        if (res.ok) {
            const data = await res.json();
            if (data.gateway?.running || data.gateway?.listening) {
                toast(trf('omtp_gateway_started', '🟢 Gateway online (port ${0}), ${1} models', data.gateway.port, data.catalog?.models || 0), 'info');
                return;
            }
        }
        const restart = confirm(tr('omtp_gateway_restart_confirm', 'The local gateway is offline. Start/restart it?'));
        if (restart) {
            await fetch(`${API_BASE}/gateway/restart`, { method: 'POST' });
            toast(tr('omtp_gateway_starting', 'Starting the gateway…'), 'info');
            setTimeout(updateGatewayPill, 1200);
        }
    } catch (err) {
        toast(trf('omtp_gateway_action_failed', 'Gateway action failed: ${0}', err.message || err), 'error');
    }
}

/** @returns {{header: HTMLElement, search: HTMLInputElement, close: HTMLButtonElement}} */
function buildModalHeader() {
    const header = el('div');
    header.id = 'omtp-hub-header';
    const title = el('h2', null, tr('omtp_hub_title', 'OMTP Model Hub'));
    title.id = 'omtp-hub-title';
    const search = document.createElement('input');
    search.id = 'omtp-search';
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.placeholder = tr('omtp_search_placeholder', 'Search models, providers or provider/model');
    search.setAttribute('aria-label', search.placeholder);
    const close = el('button', 'menu_button', '×');
    close.id = 'omtp-hub-close';
    close.type = 'button';
    close.title = tr('omtp_close', 'Close');
    close.setAttribute('aria-label', close.title);

    const pill = el('div', 'omtp-gateway-pill');
    pill.id = 'omtp-gateway-pill';
    const dot = el('span', 'omtp-status-dot');
    dot.id = 'omtp-gateway-dot';
    const label = el('span', 'omtp-status-label', tr('omtp_gateway_checking', 'Gateway checking…'));
    label.id = 'omtp-gateway-label';
    pill.append(dot, label);
    pill.addEventListener('click', onGatewayPillClick);

    header.append(title, pill, search, close);
    return { header, search, close };
}

/**
 * Filter checkboxes, right-aligned in the tab strip.
 * @returns {HTMLElement}
 */
function buildFilters() {
    // Filters live in one right-aligned group. Order is fixed as
    // [translated names (non-English only)] [scored only] [non-mainstream] so
    // the two always-present boxes keep the same neighbours — and therefore the
    // same screen positions — in every language.
    const filters = el('div', 'omtp-tab-filters');

    // Chinese provider names: only offered where a translated form exists.
    if (supportsProviderNames(document.documentElement.lang)) {
        const namesLabel = el('label', 'omtp-mainstream-toggle');
        const namesBox = document.createElement('input');
        namesBox.type = 'checkbox';
        namesBox.id = 'omtp-provider-names';
        namesBox.checked = settings().ui?.translateProviderNames !== false;
        namesBox.addEventListener('change', () => {
            persist({ ui: { ...(settings().ui || {}), translateProviderNames: namesBox.checked } });
            renderProviderList();
            renderList();
            renderDetails();
            loginPanel.refresh();
        });
        namesLabel.append(namesBox, el('span', null, tr('omtp_filter_provider_names', '显示供应商翻译名')));
        namesLabel.title = tr('omtp_filter_provider_names_hint', 'Translated names only where an official Chinese name exists; regions are always translated');
        filters.append(namesLabel);
    }

    const scoredLabel = el('label', 'omtp-mainstream-toggle');
    const scoredBox = document.createElement('input');
    scoredBox.type = 'checkbox';
    scoredBox.id = 'omtp-scored-only';
    scoredBox.checked = scoredOnly();
    scoredBox.addEventListener('change', () => {
        persist({ ui: { ...(settings().ui || {}), scoredOnly: scoredBox.checked } });
        renderProviderList();
        renderList();
        renderFooter();
    });
    scoredLabel.append(scoredBox, el('span', null, tr('omtp_filter_scored', '仅显示有评分的模型')));
    scoredLabel.title = tr('omtp_filter_scored_hint', 'Only models that have AA-PersonalityBench data');
    filters.append(scoredLabel);

    const mainstreamLabel = el('label', 'omtp-mainstream-toggle');
    const mainstreamBox = document.createElement('input');
    mainstreamBox.type = 'checkbox';
    mainstreamBox.id = 'omtp-mainstream-only';
    // Checked = show everything; unchecked = mainstream only.
    mainstreamBox.checked = !mainstreamOnly();
    mainstreamBox.addEventListener('change', () => {
        persist({ ui: { ...(settings().ui || {}), mainstreamOnly: !mainstreamBox.checked } });
        renderProviderList();
        renderList();
        renderFooter();
    });
    mainstreamLabel.append(mainstreamBox, el('span', null, tr('omtp_filter_mainstream', '显示非主流供应商')));
    mainstreamLabel.title = tr('omtp_filter_mainstream_hint', 'Uncheck to keep only first-party labs, major platforms and local runtimes');
    filters.append(mainstreamLabel);

    return filters;
}

/**
 * Tab strip with the filter group appended.
 * @returns {HTMLElement}
 */
function buildTabs() {
    const tabs = el('div');
    tabs.id = 'omtp-tabs';
    tabs.setAttribute('role', 'tablist');
    for (const [tab, key, fallback] of [
        ['all', 'omtp_tab_all', 'All'],
        ['favorites', 'omtp_tab_favorites', 'Favorites'],
        ['recent', 'omtp_tab_recent', 'Recent'],
        ['profiles', 'omtp_tab_profiles', 'Profiles'],
        ['providers', 'omtp_tab_providers', 'Sign-in'],
        ['usage', 'omtp_tab_usage', 'Usage'],
        ['about', 'omtp_tab_about', 'About'],
    ]) {
        const button = el('button', 'omtp-tab', tr(key, fallback));
        button.type = 'button';
        button.dataset.tab = tab;
        button.setAttribute('role', 'tab');
        tabs.append(button);
    }
    tabs.append(buildFilters());
    return tabs;
}

/**
 * Left column, model list pane and details pane.
 * @returns {HTMLElement}
 */
function buildBody() {
    const body = el('div');
    body.id = 'omtp-hub-body';
    const providerList = el('aside');
    providerList.id = 'omtp-provider-list';
    providerList.setAttribute('aria-label', 'Providers');
    const pane = el('section', 'omtp-model-pane');
    const modelList = el('div');
    modelList.id = 'omtp-model-list';
    modelList.setAttribute('role', 'listbox');
    modelList.setAttribute('aria-label', 'Models');
    const manager = el('div', 'omtp-provider-manager');
    manager.id = 'omtp-provider-manager';
    manager.hidden = true;
    pane.append(modelList, manager);
    const details = el('aside');
    details.id = 'omtp-details';
    body.append(providerList, pane, details);
    return body;
}

/**
 * Bind the modal-level listeners once the shell is in the DOM.
 */
function bindModalListeners(overlay, { close, search, tabs }) {
    close.addEventListener('click', closeHub);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeHub();
        }
    });
    overlay.addEventListener('keydown', handleOverlayKeydown);
    search.addEventListener('input', onSearchInput);
    tabs.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.omtp-tab') : null;
        if (!button) {
            return;
        }
        state.currentTab = button.dataset.tab || 'all';
        syncTabs();
        renderProviderList();
        renderList();
    });
}

/**
 * Build the modal shell once and return it.
 * @returns {HTMLElement}
 */
function ensureModal() {
    if (state.modal) {
        return state.modal;
    }

    const overlay = el('div', 'omtp-hidden');
    overlay.id = 'omtp-hub-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'omtp-hub-title');

    const hub = el('div');
    hub.id = 'omtp-hub';
    const { header, search, close } = buildModalHeader();
    const quickBar = el('div');
    quickBar.id = 'omtp-quick-bar';
    // Lives beside the bar, not inside it: renderQuickBar() replaces children.
    const quickHint = el('div', 'omtp-quick-hint');
    quickHint.id = 'omtp-quick-hint';
    quickHint.hidden = true;
    const tabs = buildTabs();
    const body = buildBody();
    const footer = el('footer');
    footer.id = 'omtp-hub-footer';

    hub.append(header, quickBar, quickHint, tabs, body, footer);
    overlay.append(hub);
    document.body.append(overlay);
    bindModalListeners(overlay, { close, search, tabs });

    state.modal = overlay;
    return overlay;
}

/**
 * Remove the modal from the DOM.
 */
export function destroyModal() {
    state.modal?.remove();
    state.modal = null;
}

/**
 * Handle search input with a 120 ms debounce.
 */
function onSearchInput() {
    clearTimeout(state.searchTimer);
    const input = document.getElementById('omtp-search');
    state.searchTimer = setTimeout(() => {
        state.searchTimer = null;
        state.searchQuery = input?.value ?? '';
        state.selectedEntryKey = null;
        if (state.currentTab === 'providers') {
            // The sign-in tab filters its roster; the provider column mirrors
            // the same query over the provider index.
            loginPanel.setLoginFilter(state.searchQuery);
            renderProviderList();
            return;
        }
        renderProviderList();
        renderList();
    }, SEARCH_DEBOUNCE_MS);
}

/**
 * Open the hub modal.
 */
export function openHub(options = {}) {
    const requestedTab = typeof options?.tab === 'string' ? options.tab : '';
    if (state.isCleaningUp || !state.initialized) {
        return;
    }
    if (state.isOpen) {
        if (requestedTab) {
            showTab(requestedTab);
        }
        return;
    }
    if (requestedTab) {
        state.currentTab = requestedTab;
    }
    const overlay = ensureModal();
    state.previousFocus = document.activeElement;
    overlay.classList.remove('omtp-hidden');
    state.isOpen = true;
    if (!state.catalogLoaded) {
        loadCatalogOnce();
    } else {
        // Re-read provider state: keys can be fixed or rejected while the hub
        // was closed, and the startup validation lands after page load.
        loadProviderAvailability()
            .then(() => rebuildEntries())
            .catch(() => {});
    }
    renderAll();
    updateGatewayPill();
    if (!state.gatewayPollTimer) {
        state.gatewayPollTimer = setInterval(updateGatewayPill, 10000);
    }
    const search = document.getElementById('omtp-search');
    if (search) {
        search.value = state.searchQuery;
        setTimeout(() => search.focus(), 0);
    }
}

/**
 * SillyTavern reports "no connection" until an API call succeeds, which made a
 * page reload look disconnected even though the gateway was fine. Probe it once
 * on startup and tell SillyTavern the truth.
 */
export async function syncGatewayOnlineStatus() {
    if (state.isCleaningUp) {
        return;
    }
    let gatewayMode = false;
    try {
        gatewayMode = Boolean(engine.isGatewayMode());
    } catch {
        gatewayMode = false;
    }
    if (!gatewayMode) {
        return;
    }
    try {
        const status = await engine.getGatewayStatus({ force: true });
        if (status?.running) {
            setOnlineStatus(tr('omtp_status_connected', 'Connected'));
        }
    } catch {
        // Leave SillyTavern's own indicator alone when the probe fails.
    }
}

/**
 * Switch the open hub to a tab (no-op when closed).
 * @param {string} tab
 */
export function showTab(tab) {
    if (!state.isOpen || !tab) {
        return;
    }
    state.currentTab = tab;
    syncTabs();
    renderProviderList();
    renderList();
}

/**
 * Close the hub modal.
 */
export function closeHub() {
    if (!state.modal) {
        return;
    }
    state.modal.classList.add('omtp-hidden');
    state.isOpen = false;
    if (state.gatewayPollTimer) {
        clearInterval(state.gatewayPollTimer);
        state.gatewayPollTimer = null;
    }
    if (state.previousFocus instanceof HTMLElement && state.previousFocus.isConnected) {
        try {
            state.previousFocus.focus();
        } catch {
            // ignore
        }
    }
    state.previousFocus = null;
}

/**
 * Toggle the hub modal.
 */
export function toggleHub() {
    if (state.isOpen) {
        closeHub();
    } else {
        openHub();
    }
}

/**
 * Does the event match a hotkey string such as "alt+m" or "ctrl+shift+k"?
 * @param {KeyboardEvent} event
 * @param {string} hotkey
 */
function matchesHotkey(event, hotkey) {
    if (!hotkey) {
        return false;
    }
    const parts = hotkey.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) {
        return false;
    }
    const key = parts.pop();
    const wantsAlt = parts.includes('alt');
    const wantsCtrl = parts.includes('ctrl') || parts.includes('control');
    const wantsShift = parts.includes('shift');
    const wantsMeta = parts.includes('meta') || parts.includes('cmd');
    if (event.altKey !== wantsAlt || event.ctrlKey !== wantsCtrl || event.shiftKey !== wantsShift || event.metaKey !== wantsMeta) {
        return false;
    }
    const eventKey = String(event.key || '').toLowerCase();
    if (eventKey === key) {
        return true;
    }
    const code = String(event.code || '').toLowerCase();
    if (key.length === 1) {
        return code === `key${key}` || code === `digit${key}`;
    }
    return code === key;
}

/**
 * Extract 1..9 from a keyboard event, or 0.
 * @param {KeyboardEvent} event
 */
function digitFromEvent(event) {
    const key = String(event.key || '');
    if (/^[1-9]$/.test(key)) {
        return Number(key);
    }
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(String(event.code || ''));
    return match ? Number(match[1]) : 0;
}

/**
 * Global keyboard shortcuts: hub hotkey, Alt+1..9 switch, Alt+Shift+1..9 assign.
 * @param {KeyboardEvent} event
 */
export function handleGlobalKeydown(event) {
    if (state.isCleaningUp || Popup.util?.isPopupOpen?.()) {
        return;
    }
    if (isEditableTarget(event.target)) {
        return;
    }
    const hotkey = settings().ui?.hotkey || DEFAULT_HOTKEY;
    if (matchesHotkey(event, hotkey)) {
        event.preventDefault();
        toggleHub();
        return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const digit = digitFromEvent(event);
        if (digit >= 1 && digit <= QUICK_SLOT_COUNT) {
            event.preventDefault();
            if (event.shiftKey) {
                assignQuickSlotFromSelection(digit - 1);
            } else {
                useQuickSlot(digit - 1);
            }
        }
    }
}

/**
 * Modal keyboard handling: Esc, Tab trap, arrows, Enter, f.
 * @param {KeyboardEvent} event
 */
function handleOverlayKeydown(event) {
    if (Popup.util?.isPopupOpen?.()) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        closeHub();
        return;
    }
    if (event.key === 'Tab') {
        trapFocus(event);
        return;
    }
    const tag = event.target instanceof Element ? event.target.tagName : '';
    if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
        return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!state.rowEntries.length) {
            return;
        }
        event.preventDefault();
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (event.key === 'Enter') {
        if (!state.rowEntries.length) {
            return;
        }
        event.preventDefault();
        const entry = state.rowEntries.find((item) => entryKey(item) === state.selectedEntryKey) || state.rowEntries[0];
        useEntry(entry);
        return;
    }
    if (String(event.key).toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target)) {
        const entry = state.rowEntries.find((item) => entryKey(item) === state.selectedEntryKey) || getSelectedEntry();
        if (entry) {
            event.preventDefault();
            toggleFavorite(entry);
        }
    }
}

/**
 * Move the active row by one.
 * @param {number} delta
 */
function moveActive(delta) {
    if (!state.rowEntries.length) {
        return;
    }
    const currentIndex = state.rowEntries.findIndex((entry) => entryKey(entry) === state.selectedEntryKey);
    let next = currentIndex < 0 ? 0 : currentIndex + delta;
    next = Math.max(0, Math.min(state.rowEntries.length - 1, next));
    const entry = state.rowEntries[next];
    state.selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
    const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(state.selectedEntryKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
}

/**
 * Keep Tab focus inside the dialog.
 * @param {KeyboardEvent} event
 */
function trapFocus(event) {
    if (!state.modal) {
        return;
    }
    const focusable = [...state.modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.disabled && (element.offsetParent !== null || element === document.activeElement));
    if (!focusable.length) {
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !state.modal.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}
