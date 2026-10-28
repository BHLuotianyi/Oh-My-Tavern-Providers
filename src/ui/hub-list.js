/**
 * Model list rendering and row selection for the hub.
 */
import { MAX_SEARCH_RESULTS } from '../constants.js';
import {
    personalityBadge,
    personalityFor,
    personalityTooltip,
    roleplayBadge,
    roleplayTooltip,
} from '../personality.js';
import * as aboutPanel from './about-panel.js';
import * as loginPanel from './login-panel.js';
import * as usagePanel from './usage-panel.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import {
    capabilityIcon,
    entryKey,
    findQuickSlot,
    formatNumber,
    isFavoriteEntry,
    isRecentEntry,
    refKey,
    refOf,
    sameRef,
    settings,
    sourceLabel,
    sourceOf,
} from './hub-utils.js';
import { filteredEntries, getCurrentRef } from './hub-catalog.js';
import { renderDetails, renderProviderHeader, toggleFavorite } from './hub-details.js';
import { refreshHub } from './hub-quick.js';

/**
 * Entries that belong to the active tab.
 * @returns {object[]}
 */
export function entriesForTab() {
    const list = filteredEntries();
    switch (state.currentTab) {
        case 'favorites':
            return list.filter((entry) => isFavoriteEntry(entry));
        case 'recent':
            return list.filter((entry) => isRecentEntry(entry));
        case 'profiles':
            return list.filter((entry) => entry.kind === 'profile');
        default:
            return list;
    }
}

/**
 * Rank search matches: exact provider/model, exact model id, favorites,
 * recents, then fuzzy matches.
 * @param {string} query
 * @param {object[]} base
 * @returns {object[]}
 */
function searchEntries(query, base) {
    const raw = query.trim();
    if (!raw) {
        return base;
    }
    const lower = raw.toLowerCase();
    const favoriteKeys = new Set((settings().favorites || []).map((ref) => refKey(ref)));
    const recentKeys = new Set((settings().recents || []).map((ref) => refKey(ref)));
    const baseByKey = new Map(base.map((entry) => [entryKey(entry), entry]));
    /** @type {Map<string, object>} */
    const candidates = new Map();

    const add = (entry) => {
        const key = entryKey(entry);
        if (baseByKey.has(key) && !candidates.has(key)) {
            candidates.set(key, entry);
        }
    };

    for (const entry of base) {
        const providerModel = `${entry.provider}/${entry.model}`.toLowerCase();
        const model = String(entry.model ?? '').toLowerCase();
        if (providerModel === lower || model === lower) {
            add(entry);
        }
    }

    if (state.fuse) {
        try {
            for (const result of state.fuse.search(raw)) {
                add(result.item);
            }
        } catch (error) {
            console.warn('[omtp] search failed', error);
        }
    } else {
        for (const entry of base) {
            const haystack = [entry.model, entry.modelLabel, entry.provider, entry.providerLabel]
                .map((value) => String(value ?? '').toLowerCase());
            if (haystack.some((value) => value.includes(lower))) {
                add(entry);
            }
        }
    }

    const tier = (entry) => {
        const key = entryKey(entry);
        const providerModel = `${entry.provider}/${entry.model}`.toLowerCase();
        if (providerModel === lower) {
            return 0;
        }
        if (String(entry.model ?? '').toLowerCase() === lower) {
            return 1;
        }
        if (favoriteKeys.has(key)) {
            return 2;
        }
        if (recentKeys.has(key)) {
            return 3;
        }
        return 4;
    };

    return [...candidates.values()]
        .sort((a, b) => tier(a) - tier(b))
        .slice(0, MAX_SEARCH_RESULTS);
}

/**
 * Append a section title to the model list.
 * @param {HTMLElement} container
 * @param {string} text
 */
function appendSectionTitle(container, text) {
    container.append(el('div', 'omtp-section-title', text));
}

/**
 * Append an empty-state row.
 * @param {HTMLElement} container
 * @param {string} text
 */
function appendEmptyState(container, text) {
    container.append(el('div', 'omtp-empty-state', text));
}

/** Show the model filters and footer except on the static About page. */
function syncTabChrome() {
    const hidden = state.currentTab === 'about';
    document.querySelector('#omtp-tabs .omtp-tab-filters')?.classList.toggle('omtp-hidden', hidden);
    document.getElementById('omtp-hub-footer')?.classList.toggle('omtp-hidden', hidden);
}

/**
 * Render the model list for the current tab/search/provider.
 */
export function renderList() {
    const listElement = document.getElementById('omtp-model-list');
    if (!listElement) {
        return;
    }
    syncTabChrome();
    const manager = document.getElementById('omtp-provider-manager');
    const body = document.getElementById('omtp-hub-body');
    if (state.currentTab === 'usage' || state.currentTab === 'about') {
        renderStaticPanel(listElement, manager, body);
        return;
    }
    usagePanel.disposeUsagePanel();
    aboutPanel.disposeAboutPanel();
    if (state.currentTab === 'providers') {
        renderLoginPanel(listElement, manager, body);
        return;
    }
    renderModelList(listElement, manager, body);
}

/**
 * Mount the usage/about panel in place of the model list.
 */
function renderStaticPanel(listElement, manager, body) {
    state.rowEntries = [];
    listElement.replaceChildren();
    listElement.hidden = true;
    body?.classList.add('omtp-manager-open');
    body?.classList.toggle('omtp-about-open', state.currentTab === 'about');
    if (!manager) {
        return;
    }
    loginPanel.disposeLoginPanel();
    manager.hidden = false;
    if (state.currentTab === 'usage') {
        aboutPanel.disposeAboutPanel();
        Promise.resolve(usagePanel.mountUsagePanel(manager))
            .catch((error) => console.warn('[omtp] usage panel failed', error));
        return;
    }
    usagePanel.disposeUsagePanel();
    Promise.resolve(aboutPanel.mountAboutPanel(manager))
        .catch((error) => console.warn('[omtp] about panel failed', error));
}

/**
 * Mount the sign-in roster in place of the model list.
 */
function renderLoginPanel(listElement, manager, body) {
    state.rowEntries = [];
    listElement.replaceChildren();
    listElement.hidden = true;
    body?.classList.add('omtp-manager-open');
    if (!manager) {
        return;
    }
    manager.hidden = false;
    Promise.resolve(loginPanel.mountLoginPanel(manager, {
        onChanged: () => refreshHub().catch(() => {}),
    }))
        // Entering the tab must honour whatever is already in the search box.
        .then(() => loginPanel.setLoginFilter(state.searchQuery))
        .catch((error) => console.warn('[omtp] login panel failed', error));
}

/**
 * Render the model rows for the current tab, provider and search query.
 */
function renderModelList(listElement, manager, body) {
    if (manager && !manager.hidden) {
        loginPanel.disposeLoginPanel();
        manager.hidden = true;
    }
    listElement.hidden = false;
    body?.classList.remove('omtp-manager-open');
    body?.classList.remove('omtp-about-open');
    listElement.replaceChildren();
    state.rowEntries = [];
    const renderedKeys = new Set();
    const appendRow = (entry) => {
        const key = entryKey(entry);
        if (renderedKeys.has(key)) {
            return;
        }
        renderedKeys.add(key);
        state.rowEntries.push(entry);
        listElement.append(renderRow(entry, state.rowEntries.length - 1));
    };
    const query = state.searchQuery.trim();
    if (query) {
        renderSearchResults(listElement, query, appendRow);
        return;
    }
    if (state.currentTab === 'profiles') {
        renderTabRows(listElement, filteredEntries().filter((entry) => entry.kind === 'profile'), appendRow);
        return;
    }
    if (state.currentTab === 'favorites') {
        renderTabRows(listElement, filteredEntries().filter((entry) => isFavoriteEntry(entry)), appendRow);
        return;
    }
    if (state.currentTab === 'recent') {
        renderTabRows(listElement, filteredEntries().filter((entry) => isRecentEntry(entry)), appendRow);
        return;
    }
    renderDashboard(listElement, appendRow);
}

/**
 * Render a favorites/recents/profiles tab.
 */
function renderTabRows(listElement, list, appendRow) {
    if (!list.length) {
        appendEmptyState(listElement, tr('omtp_no_results', 'No models match your search.'));
        return;
    }
    list.forEach(appendRow);
}

/**
 * Render grouped search hits, best match first.
 */
function renderSearchResults(listElement, query, appendRow) {
    // With a provider selected the query filters inside it, so typing first
    // and then clicking a provider keeps the search meaningful.
    const scope = state.selectedProvider
        ? filteredEntries().filter((entry) => entry.kind !== 'profile'
            && (entry.providerId === state.selectedProvider || entry.provider === state.selectedProvider))
        : entriesForTab();
    const results = searchEntries(query, scope);
    if (!results.length) {
        const elsewhere = state.selectedProvider ? searchEntries(query, entriesForTab()).length : 0;
        appendEmptyState(listElement, elsewhere
            ? trf('omtp_no_results_in_provider', 'No match in this provider. ${0} matches elsewhere.', elsewhere)
            : tr('omtp_no_results', 'No models match your search.'));
        return;
    }
    // Group hits by provider so every section has its own refresh button;
    // section order follows the ranking (best match first).
    /** @type {Map<string, any[]>} */
    const byProvider = new Map();
    for (const entry of results) {
        const pid = String(entry.providerId || entry.provider || '');
        if (!byProvider.has(pid)) {
            byProvider.set(pid, []);
        }
        byProvider.get(pid).push(entry);
    }
    for (const [pid, groupEntries] of byProvider) {
        listElement.append(renderProviderHeader(pid, groupEntries.length));
        groupEntries.forEach(appendRow);
    }
}

/**
 * Render the pinned favorites/recents or the models of the selected provider.
 */
function renderDashboard(listElement, appendRow) {
    // The dashboard (no provider selected) shows pinned entries; a provider view
    // shows only that provider's models. Pinned entries for providers that are
    // not signed in are hidden — the "All models" view lists what can be used.
    const usable = (entry) => entry.available !== false;
    if (!state.selectedProvider) {
        const favorites = filteredEntries().filter((entry) => isFavoriteEntry(entry) && usable(entry));
        const recents = filteredEntries().filter((entry) => isRecentEntry(entry) && usable(entry));
        if (favorites.length) {
            appendSectionTitle(listElement, tr('omtp_favorites_section', 'Favorites'));
            favorites.forEach(appendRow);
        }
        if (recents.length) {
            appendSectionTitle(listElement, tr('omtp_recents_section', 'Recent'));
            recents.forEach(appendRow);
        }
    }
    if (state.selectedProvider) {
        const models = filteredEntries().filter((entry) => entry.kind !== 'profile'
            && (entry.providerId === state.selectedProvider || entry.provider === state.selectedProvider));
        if (models.length) {
            listElement.append(renderProviderHeader(state.selectedProvider, models.length));
            models.forEach(appendRow);
        } else {
            appendEmptyState(listElement, tr('omtp_provider_not_configured', 'This provider is not signed in or configured. Use the panel on the right, or import from OMP.'));
        }
    } else {
        // Must honour the active filters; the dashboard fallback used to list
        // everything regardless of "mainstream only" / "scored only".
        const availableAll = filteredEntries().filter((entry) => entry.kind !== 'profile' && entry.available !== false);
        if (availableAll.length) {
            appendSectionTitle(listElement, 'All available models');
            availableAll.forEach(appendRow);
        }
    }
    if (!state.rowEntries.length) {
        appendEmptyState(listElement, tr('omtp_select_provider_hint', 'Pick a provider on the left or search for a model.'));
    }
}

/**
 * Build a single model row.
 * @param {object} entry
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderRow(entry, index) {
    const key = entryKey(entry);
    const row = document.createElement('div');
    row.className = 'omtp-model-row';
    row.dataset.key = key;
    row.dataset.index = String(index);
    row.tabIndex = -1;
    row.setAttribute('role', 'option');
    const selected = state.selectedEntryKey === key;
    row.setAttribute('aria-selected', String(selected));
    if (selected) {
        row.classList.add('omtp-active');
    }
    const currentRef = getCurrentRef();
    if (currentRef && sameRef(currentRef, refOf(entry))) {
        row.classList.add('omtp-current');
        row.title = tr('omtp_model_in_use_hint', 'Currently in use');
    }
    if (state.highlightKey === key) {
        row.classList.add('omtp-row-flash');
    }
    if (entry.available === false) {
        row.classList.add('omtp-unavailable', 'omtp-disabled');
    }

    const main = el('div', 'omtp-row-main');
    const name = el('div', 'omtp-row-name', entry.modelLabel || entry.model);
    const metaParts = [entry.providerLabel || entry.provider, entry.model];
    if (entry.contextWindow) {
        metaParts.push(formatNumber(entry.contextWindow));
    }
    const meta = el('div', 'omtp-row-meta', metaParts.join(' · '));
    if (entry.isLive) {
        const liveBadge = el('span', 'omtp-live-badge', tr('omtp_live_badge', 'live'));
        liveBadge.title = tr('omtp_live_badge_hint', 'Confirmed live via the provider API');
        meta.append(' · ', liveBadge);
    }
    if (entry.available === false) {
        const keyBadge = el('span', 'omtp-missing-key-badge', tr('omtp_missing_key', 'no key'));
        meta.append(' · ', keyBadge);
    }
    const personality = personalityFor(entry);
    if (personality) {
        const pb = el('span', 'omtp-row-pb', personalityBadge(personality.record));
        pb.title = personalityTooltip(personality.record);
        const rp = el('span', 'omtp-row-pb omtp-row-rp', roleplayBadge(personality.record));
        rp.title = roleplayTooltip(personality.record);
        name.append(' ', pb, ' ', rp);
    }
    main.append(name, meta);
    const badge = el('span', `omtp-badge omtp-badge-${sourceOf(entry).toLowerCase()}`, sourceLabel(entry));

    const capabilities = el('span', 'omtp-capabilities');
    if (entry.supportsTools) {
        capabilities.append(capabilityIcon('fa-screwdriver-wrench', 'Tools'));
    }
    if (entry.reasoning) {
        capabilities.append(capabilityIcon('fa-brain', 'Reasoning'));
    }
    if (Array.isArray(entry.input) && entry.input.includes('image')) {
        capabilities.append(capabilityIcon('fa-image', 'Image input'));
    }

    const status = el('span', `omtp-status-dot ${entry.available === false ? 'omtp-bad' : 'omtp-ok'}`);
    status.title = entry.available === false
        ? (entry.unsupportedReason || tr('omtp_status_unavailable', 'Unavailable'))
        : tr('omtp_status_available', 'Available');

    const slotIndex = findQuickSlot(entry);
    const slotBadge = slotIndex >= 0 ? el('span', 'omtp-slot-badge', String(slotIndex + 1)) : null;
    if (slotBadge) {
        slotBadge.title = `Quick slot ${slotIndex + 1}`;
    }

    const favorite = isFavoriteEntry(entry);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'omtp-star' + (favorite ? ' omtp-on' : '');
    star.textContent = '★';
    star.title = favorite ? tr('omtp_unfavorite', 'Unfavorite') : tr('omtp_favorite', 'Favorite');
    star.setAttribute('aria-label', star.title);
    star.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(entry);
    });

    row.append(main, capabilities, badge, status);
    if (slotBadge) {
        row.append(slotBadge);
    }
    row.append(star);
    if (entry.unsupportedReason) {
        row.title = entry.unsupportedReason;
    }
    row.addEventListener('click', () => selectEntry(entry));
    return row;
}

/**
 * Select an entry in the details pane.
 * @param {object} entry
 */
function selectEntry(entry) {
    state.selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
}

/**
 * Update row highlight classes without rebuilding the list (keeps scroll).
 */
export function highlightSelectedRow() {
    document.querySelectorAll('#omtp-model-list .omtp-model-row').forEach((row) => {
        const active = row.dataset.key === state.selectedEntryKey;
        row.classList.toggle('omtp-active', active);
        row.setAttribute('aria-selected', String(active));
    });
}
