/**
 * Model list rendering and row selection for the hub.
 */
import { MAX_SEARCH_RESULTS, PROFILE_PROVIDER_ID } from '../constants.js';
import {
    personalityBadge,
    personalityFor,
    personalityTooltip,
    roleplayBadge,
    roleplayTooltip,
} from '../personality.js';
import * as aboutPanel from './about-panel.js';
import { appendProfilesToolbar } from './hub-profile-pane.js';
import { activeProfileId } from './hub-profile-store.js';
import * as loginPanel from './login-panel.js';
import * as usagePanel from './usage-panel.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import {
    capabilityIcon,
    cssEscape,
    entryKey,
    formatNumber,
    refKey,
    refOf,
    sameRef,
    settings,
    sourceLabel,
    sourceOf,
} from './hub-utils.js';
import { filteredEntries, getCurrentRef, providerLabel } from './hub-catalog.js';
import { openDetailsPane, renderDetails, renderProviderHeader, toggleFavorite } from './hub-details.js';
import { refreshHub } from './hub-quick.js';

/** Rows rendered synchronously per batch for large provider/dashboard views. */
const WINDOW_BATCH_SIZE = 150;

/** @type {{listElement: HTMLElement, entries: object[], cursor: number, baseIndex: number, ctx: object, loadMoreBtn: HTMLButtonElement|null}|null} */
let pendingBatch = null;

/**
 * Compute per-render lookup context once instead of per row.
 * @returns {{currentRef: object|null, favoriteKeys: Set<string>, recentKeys: Set<string>, slotByKey: Map<string, number>, activeProfile: string|null}}
 */
function buildRowContext() {
    const currentSettings = settings();
    const favoriteKeys = new Set((currentSettings.favorites || []).map((ref) => refKey(ref)));
    const recentKeys = new Set((currentSettings.recents || []).map((ref) => refKey(ref)));
    const slotByKey = new Map();
    const slots = currentSettings.quickSlots || [];
    for (let i = 0; i < slots.length; i += 1) {
        const ref = slots[i];
        if (ref) {
            const key = refKey(ref);
            if (!slotByKey.has(key)) {
                slotByKey.set(key, i);
            }
        }
    }
    return {
        currentRef: getCurrentRef(),
        favoriteKeys,
        recentKeys,
        slotByKey,
        activeProfile: activeProfileId(),
    };
}

/**
 * Entries that belong to the active tab.
 * @param {object} [ctx]
 * @returns {object[]}
 */
export function entriesForTab(ctx = buildRowContext()) {
    const list = filteredEntries();
    switch (state.currentTab) {
        case 'favorites':
            return list.filter((entry) => ctx.favoriteKeys.has(entryKey(entry)));
        case 'recent':
            return list.filter((entry) => ctx.recentKeys.has(entryKey(entry)));
        case 'profiles':
            return list.filter((entry) => entry.kind === 'profile');
        default:
            return list;
    }
}

/**
 * Provider name as the row/sidebar renders it, including the translated form.
 * @param {object} entry
 * @returns {string}
 */
function displayProviderName(entry) {
    return providerLabel(entry.providerId || entry.provider, entry.providerLabel || entry.provider);
}

/**
 * Check whether an entry matches a lower-cased substring needle across the
 * fields shown in its row.
 * @param {object} entry
 * @param {string} lower
 * @returns {boolean}
 */
function entryMatchesSubstring(entry, lower) {
    return String(entry.model ?? '').toLowerCase().includes(lower)
        || String(entry.modelLabel ?? '').toLowerCase().includes(lower)
        || String(entry.provider ?? '').toLowerCase().includes(lower)
        || String(entry.providerLabel ?? '').toLowerCase().includes(lower)
        || displayProviderName(entry).toLowerCase().includes(lower);
}

/**
 * Rank search matches: exact provider/model, exact model id, favorites,
 * recents, then fuzzy matches. When a provider is selected, computes both
 * in-provider hits and the elsewhere count in one pass.
 * @param {string} query
 * @param {object[]} tabEntries
 * @param {((entry: object) => boolean)|null} inScope
 * @param {object} ctx
 * @returns {{results: object[], elsewhere: number}}
 */
function searchEntries(query, tabEntries, inScope, ctx) {
    const raw = query.trim();
    if (!raw) {
        const results = inScope ? tabEntries.filter(inScope) : tabEntries;
        return { results, elsewhere: 0 };
    }
    const lower = raw.toLowerCase();
    const tabByKey = new Map(tabEntries.map((entry) => [entryKey(entry), entry]));
    /** @type {Map<string, object>} */
    const candidates = new Map();
    /** @type {Set<string>} */
    const elsewhereKeys = new Set();

    if (state.fuse) {
        try {
            for (const result of state.fuse.search(raw, { limit: MAX_SEARCH_RESULTS })) {
                const entry = result.item;
                const key = entryKey(entry);
                if (!tabByKey.has(key)) {
                    continue;
                }
                if (!inScope || inScope(entry)) {
                    if (!candidates.has(key)) {
                        candidates.set(key, entry);
                    }
                } else if (elsewhereKeys.size < MAX_SEARCH_RESULTS) {
                    elsewhereKeys.add(key);
                }
            }
        } catch (error) {
            console.warn('[omtp] search failed', error);
        }
    }

    // Single pass for exact matches and localized substring matches (the fuzzy
    // index only stores raw labels, not translated provider names).
    for (const entry of tabEntries) {
        const key = entryKey(entry);
        const scoped = !inScope || inScope(entry);
        const modelLower = String(entry.model ?? '').toLowerCase();
        const exact = modelLower === lower || `${entry.provider}/${entry.model}`.toLowerCase() === lower;
        if (exact) {
            if (scoped) {
                candidates.set(key, entry);
            } else if (candidates.size === 0 && elsewhereKeys.size < MAX_SEARCH_RESULTS) {
                elsewhereKeys.add(key);
            }
            continue;
        }
        if (scoped) {
            if (candidates.size < MAX_SEARCH_RESULTS && !candidates.has(key) && entryMatchesSubstring(entry, lower)) {
                candidates.set(key, entry);
            }
        } else if (candidates.size === 0 && elsewhereKeys.size < MAX_SEARCH_RESULTS && !elsewhereKeys.has(key)) {
            if (entryMatchesSubstring(entry, lower)) {
                elsewhereKeys.add(key);
            }
        }
    }

    const tier = (entry) => {
        const key = entryKey(entry);
        const modelLower = String(entry.model ?? '').toLowerCase();
        if (`${entry.provider}/${entry.model}`.toLowerCase() === lower) {
            return 0;
        }
        if (modelLower === lower) {
            return 1;
        }
        if (ctx.favoriteKeys.has(key)) {
            return 2;
        }
        if (ctx.recentKeys.has(key)) {
            return 3;
        }
        return 4;
    };

    const results = [...candidates.values()]
        .sort((a, b) => tier(a) - tier(b))
        .slice(0, MAX_SEARCH_RESULTS);

    return {
        results,
        elsewhere: results.length ? 0 : elsewhereKeys.size,
    };
}

/**
 * Append a section title to the target container/fragment.
 * @param {ParentNode} container
 * @param {string} text
 */
function appendSectionTitle(container, text) {
    container.append(el('div', 'omtp-section-title', text));
}

/**
 * Append an empty-state row.
 * @param {ParentNode} container
 * @param {string} text
 */
function appendEmptyState(container, text) {
    container.append(el('div', 'omtp-empty-state', text));
}

/** Show the model filters and footer counts except on the static About page. */
function syncTabChrome() {
    const hidden = state.currentTab === 'about';
    document.querySelector('#omtp-tabs .omtp-tab-filters')?.classList.toggle('omtp-hidden', hidden);
    // The footer itself stays: its left side carries the version/update status.
    document.querySelector('#omtp-hub-footer .omtp-footer-counts')?.classList.toggle('omtp-hidden', hidden);
}

/**
 * Update the load-more button label or remove it when all rows are rendered.
 */
function syncLoadMoreButton() {
    if (!pendingBatch) {
        return;
    }
    const remaining = pendingBatch.entries.length - pendingBatch.cursor;
    if (remaining <= 0) {
        pendingBatch.loadMoreBtn?.remove();
        pendingBatch = null;
        return;
    }
    const nextCount = Math.min(WINDOW_BATCH_SIZE, remaining);
    const label = trf('omtp_load_more', 'Show ${0} more (${1} remaining)', nextCount, remaining);
    if (!pendingBatch.loadMoreBtn) {
        const button = el('button', 'omtp-load-more menu_button', label);
        button.type = 'button';
        button.addEventListener('click', () => flushNextBatch());
        pendingBatch.loadMoreBtn = button;
        pendingBatch.listElement.append(button);
    } else {
        pendingBatch.loadMoreBtn.textContent = label;
    }
}

/**
 * Append the next batch of deferred rows into the list via DocumentFragment.
 */
function flushNextBatch() {
    if (!pendingBatch) {
        return;
    }
    const { listElement, entries, cursor, baseIndex, ctx, loadMoreBtn } = pendingBatch;
    const end = Math.min(entries.length, cursor + WINDOW_BATCH_SIZE);
    const fragment = document.createDocumentFragment();
    for (let i = cursor; i < end; i += 1) {
        fragment.append(renderRow(entries[i], baseIndex + i, ctx));
    }
    pendingBatch.cursor = end;
    if (loadMoreBtn && loadMoreBtn.parentNode === listElement) {
        listElement.insertBefore(fragment, loadMoreBtn);
    } else {
        listElement.append(fragment);
    }
    syncLoadMoreButton();
}

/**
 * Ensure the row for `key` has been materialized in the DOM (used before
 * keyboard navigation or quick-slot scroll jumps past the initial batch).
 * @param {string|null} key
 */
export function ensureRowRendered(key) {
    if (!pendingBatch || !key) {
        return;
    }
    if (document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(key)}"]`)) {
        return;
    }
    const targetIndex = pendingBatch.entries.findIndex((entry) => entryKey(entry) === key);
    if (targetIndex < 0) {
        return;
    }
    while (pendingBatch && pendingBatch.cursor <= targetIndex) {
        flushNextBatch();
    }
}

function attachBatchScrollListener(listElement) {
    if (listElement.dataset.omtpScrollBound === '1') {
        return;
    }
    listElement.dataset.omtpScrollBound = '1';
    listElement.addEventListener('scroll', () => {
        if (!pendingBatch || pendingBatch.listElement !== listElement) {
            return;
        }
        if (listElement.scrollTop + listElement.clientHeight >= listElement.scrollHeight - 320) {
            flushNextBatch();
        }
    }, { passive: true });
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
    pendingBatch = null;
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
    pendingBatch = null;
    state.rowEntries = [];
    listElement.replaceChildren();
    listElement.hidden = true;
    body?.classList.add('omtp-manager-open');
    // About hides the provider column; Sign-in must bring it back.
    body?.classList.remove('omtp-about-open');
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
    attachBatchScrollListener(listElement);

    pendingBatch = null;
    state.rowEntries = [];
    const ctx = buildRowContext();
    const fragment = document.createDocumentFragment();
    const renderedKeys = new Set();

    const reserveEntry = (entry) => {
        const key = entryKey(entry);
        if (renderedKeys.has(key)) {
            return -1;
        }
        renderedKeys.add(key);
        state.rowEntries.push(entry);
        return state.rowEntries.length - 1;
    };

    const appendRow = (entry) => {
        const index = reserveEntry(entry);
        if (index < 0) {
            return;
        }
        fragment.append(renderRow(entry, index, ctx));
    };

    const appendBatchedRows = (entries) => {
        const accepted = [];
        const baseIndex = state.rowEntries.length;
        for (const entry of entries) {
            if (reserveEntry(entry) >= 0) {
                accepted.push(entry);
            }
        }
        const immediateCount = Math.min(accepted.length, WINDOW_BATCH_SIZE);
        for (let i = 0; i < immediateCount; i += 1) {
            fragment.append(renderRow(accepted[i], baseIndex + i, ctx));
        }
        if (accepted.length > immediateCount) {
            pendingBatch = {
                listElement,
                entries: accepted,
                cursor: immediateCount,
                baseIndex,
                ctx,
                loadMoreBtn: null,
            };
        }
    };

    const query = state.searchQuery.trim();
    if (query) {
        renderSearchResults(fragment, query, appendRow, ctx);
        listElement.replaceChildren(fragment);
        return;
    }
    if (state.currentTab === 'profiles') {
        const profiles = filteredEntries().filter((entry) => entry.kind === 'profile');
        appendProfilesToolbar(fragment);
        if (!profiles.length) {
            appendEmptyState(fragment, tr(
                'omtp_profiles_empty',
                'No connection profiles yet — record the current connection or create an empty profile above.',
            ));
            listElement.replaceChildren(fragment);
            return;
        }
        renderTabRows(fragment, profiles, appendBatchedRows);
        listElement.replaceChildren(fragment);
        syncLoadMoreButton();
        return;
    }
    if (state.currentTab === 'favorites') {
        renderTabRows(
            fragment,
            filteredEntries().filter((entry) => ctx.favoriteKeys.has(entryKey(entry))),
            appendBatchedRows,
            tr('omtp_favorites_empty', 'No favorites yet — star a model to pin it here.'),
        );
        listElement.replaceChildren(fragment);
        syncLoadMoreButton();
        return;
    }
    if (state.currentTab === 'recent') {
        renderTabRows(
            fragment,
            filteredEntries().filter((entry) => ctx.recentKeys.has(entryKey(entry))),
            appendBatchedRows,
            tr('omtp_recents_empty', 'No recently used models yet.'),
        );
        listElement.replaceChildren(fragment);
        syncLoadMoreButton();
        return;
    }
    renderDashboard(fragment, appendRow, appendBatchedRows, ctx);
    listElement.replaceChildren(fragment);
    syncLoadMoreButton();
}

/**
 * Render a favorites/recents/profiles tab.
 */
function renderTabRows(container, list, appendBatched, emptyText) {
    if (!list.length) {
        // An empty tab and a search with no hits are different problems; the
        // search message made an untouched Favorites tab look filtered.
        appendEmptyState(container, state.searchQuery
            ? tr('omtp_no_results', 'No models match your search.')
            : emptyText);
        return;
    }
    appendBatched(list);
}

/**
 * Render grouped search hits, best match first.
 */
function renderSearchResults(container, query, appendRow, ctx) {
    // With a provider selected the query filters inside it, so typing first
    // and then clicking a provider keeps the search meaningful.
    const tabEntries = entriesForTab(ctx);
    const inScope = state.selectedProvider === PROFILE_PROVIDER_ID
        ? (entry) => entry.kind === 'profile'
        : state.selectedProvider
            ? (entry) => entry.kind !== 'profile'
                && (entry.providerId === state.selectedProvider || entry.provider === state.selectedProvider)
            : null;
    const { results, elsewhere } = searchEntries(query, tabEntries, inScope, ctx);
    if (!results.length) {
        appendEmptyState(container, elsewhere
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
        container.append(renderProviderHeader(pid, groupEntries.length));
        groupEntries.forEach(appendRow);
    }
}

/**
 * Render the pinned favorites/recents or the models of the selected provider.
 */
function renderDashboard(container, appendRow, appendBatched, ctx) {
    // The dashboard (no provider selected) shows pinned entries; a provider view
    // shows only that provider's models. Pinned entries for providers that are
    // not signed in are hidden — the "All models" view lists what can be used.
    const usable = (entry) => entry.available !== false;
    const entries = filteredEntries();
    if (!state.selectedProvider) {
        const favorites = entries.filter((entry) => ctx.favoriteKeys.has(entryKey(entry)) && usable(entry));
        const recents = entries.filter((entry) => ctx.recentKeys.has(entryKey(entry)) && usable(entry));
        if (favorites.length) {
            appendSectionTitle(container, tr('omtp_favorites_section', 'Favorites'));
            favorites.forEach(appendRow);
        }
        if (recents.length) {
            appendSectionTitle(container, tr('omtp_recents_section', 'Recent'));
            recents.forEach(appendRow);
        }
    }
    if (state.selectedProvider === PROFILE_PROVIDER_ID) {
        const profiles = entries.filter((entry) => entry.kind === 'profile');
        appendProfilesToolbar(container);
        if (!profiles.length) {
            appendEmptyState(container, tr(
                'omtp_profiles_empty',
                'No connection profiles yet — record the current connection or create an empty profile above.',
            ));
            return;
        }
        container.append(renderProviderHeader(state.selectedProvider, profiles.length));
        appendBatched(profiles);
        return;
    }
    if (state.selectedProvider) {
        const models = entries.filter((entry) => entry.kind !== 'profile'
            && (entry.providerId === state.selectedProvider || entry.provider === state.selectedProvider));
        if (models.length) {
            container.append(renderProviderHeader(state.selectedProvider, models.length));
            appendBatched(models);
        } else {
            appendEmptyState(container, tr('omtp_provider_not_configured', 'This provider is not signed in or configured. Use the panel on the right, or import from OMP.'));
        }
    } else {
        // Must honour the active filters; the dashboard fallback used to list
        // everything regardless of "mainstream only" / "scored only".
        const availableAll = entries.filter((entry) => entry.kind !== 'profile' && entry.available !== false);
        if (availableAll.length) {
            appendSectionTitle(container, tr('omtp_all_available_models', 'All available models'));
            appendBatched(availableAll);
        }
    }
    if (!state.rowEntries.length) {
        if (!state.catalogLoaded && state.catalogLoading) {
            appendEmptyState(container, tr('omtp_catalog_loading_models', 'Loading models…'));
            return;
        }
        appendEmptyState(container, tr('omtp_select_provider_hint', 'Pick a provider on the left or search for a model.'));
    }
}

/**
 * Build a single model row.
 * @param {object} entry
 * @param {number} index
 * @param {{currentRef: object|null, favoriteKeys: Set<string>, recentKeys: Set<string>, slotByKey: Map<string, number>, activeProfile: string|null}} ctx
 * @returns {HTMLElement}
 */
function renderRow(entry, index, ctx) {
    const key = entryKey(entry);
    const row = document.createElement('div');
    row.className = 'omtp-model-row';
    row.dataset.key = key;
    row.dataset.index = String(index);
    row.id = `omtp-row-${index}`;
    row.tabIndex = -1;
    row.setAttribute('role', 'option');
    const selected = state.selectedEntryKey === key;
    row.setAttribute('aria-selected', String(selected));
    if (selected) {
        row.classList.add('omtp-active');
    }
    if (ctx.currentRef && sameRef(ctx.currentRef, refOf(entry))) {
        row.classList.add('omtp-current');
        row.title = tr('omtp_model_in_use_hint', 'Currently in use');
    }
    if (state.highlightKey === key) {
        row.classList.add('omtp-row-flash');
    }
    if (entry.available === false) {
        row.classList.add('omtp-unavailable');
    }

    const main = el('div', 'omtp-row-main');
    const name = el('div', 'omtp-row-name', entry.modelLabel || entry.model);
    const metaParts = entry.kind === 'profile'
        ? [entry.profile?.model || tr('omtp_profile_meta', 'Saved connection')]
        : [displayProviderName(entry), entry.model];
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
    if (entry.kind === 'profile' && Boolean(entry.model) && ctx.activeProfile === entry.model) {
        const activeBadge = el('span', 'omtp-profile-active-badge', tr('omtp_profile_active', 'In use'));
        activeBadge.title = tr('omtp_profile_active_hint', 'SillyTavern is currently using this connection profile');
        meta.append(' · ', activeBadge);
        row.classList.add('omtp-profile-current');
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
        capabilities.append(capabilityIcon('fa-screwdriver-wrench', tr('omtp_cap_tools', 'Tools')));
    }
    if (entry.reasoning) {
        capabilities.append(capabilityIcon('fa-brain', tr('omtp_cap_reasoning', 'Reasoning')));
    }
    if (Array.isArray(entry.input) && entry.input.includes('image')) {
        capabilities.append(capabilityIcon('fa-image', tr('omtp_cap_image', 'Image input')));
    }

    const status = el('span', `omtp-status-dot ${entry.available === false ? 'omtp-bad' : 'omtp-ok'}`);
    status.title = entry.available === false
        ? (entry.unsupportedReason || tr('omtp_status_unavailable', 'Unavailable'))
        : tr('omtp_status_available', 'Available');

    const slotIndex = ctx.slotByKey.has(key) ? ctx.slotByKey.get(key) : -1;
    const slotBadge = slotIndex >= 0 ? el('span', 'omtp-slot-badge', String(slotIndex + 1)) : null;
    if (slotBadge) {
        slotBadge.title = trf('omtp_quick_slot_n', 'Quick slot ${0}', slotIndex + 1);
    }

    const favorite = ctx.favoriteKeys.has(key);
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
    row.addEventListener('click', () => {
        selectEntry(entry);
        openDetailsPane();
    });
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
    document.querySelectorAll('#omtp-model-list .omtp-model-row.omtp-active').forEach((row) => {
        if (row.dataset.key !== state.selectedEntryKey) {
            row.classList.remove('omtp-active');
            row.setAttribute('aria-selected', 'false');
        }
    });
    let activeRow = null;
    if (state.selectedEntryKey) {
        ensureRowRendered(state.selectedEntryKey);
        const matched = document.querySelectorAll(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(state.selectedEntryKey)}"]`);
        matched.forEach((row) => {
            row.classList.add('omtp-active');
            row.setAttribute('aria-selected', 'true');
            if (!activeRow) {
                activeRow = row;
            }
        });
    }
    // The list is a listbox; without this screen readers never hear which row
    // the arrow keys moved to.
    const list = document.getElementById('omtp-model-list');
    if (list) {
        if (activeRow?.id) {
            list.setAttribute('aria-activedescendant', activeRow.id);
        } else {
            list.removeAttribute('aria-activedescendant');
        }
    }
}
