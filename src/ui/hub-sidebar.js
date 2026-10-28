/**
 * Provider sidebar and sign-in roster navigation for the hub.
 */
import * as catalogApi from '../catalog.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import { cssEscape, entryKey, setLiveRefreshState } from './hub-utils.js';
import {
    buildProviderGroups,
    filteredEntries,
    isMainstreamProvider,
    mainstreamOnly,
    partitionProviders,
    providerGroupFromStatus,
    providerLabel,
    rebuildEntries,
    scoredOnly,
    sidebarSections,
    visibleEntries,
} from './hub-catalog.js';
import { entriesForTab, highlightSelectedRow, renderList } from './hub-list.js';
import { renderDetails } from './hub-details.js';
import { syncTabs } from './hub-quick.js';

/**
 * The "All models" row that heads both sidebar variants.
 * @param {number} count
 * @returns {HTMLElement}
 */
function createAllProvidersItem(count) {
    const item = el('button', 'omtp-provider-item' + (state.selectedProvider === null ? ' omtp-active' : ''));
    item.type = 'button';
    item.dataset.provider = '';
    item.append(
        el('span', 'omtp-provider-label', tr('omtp_all_models', 'All models')),
        el('span', 'omtp-count', String(count)),
    );
    item.addEventListener('click', () => selectProvider(null));
    return item;
}

/**
 * Append the provider sections (labs first) to a sidebar list.
 * @param {HTMLElement} listElement
 * @param {{unlocked: any[], invalid: any[], locked: any[]}} buckets
 */
function appendSidebarSections(listElement, { unlocked, invalid, locked }) {
    for (const [index, section] of sidebarSections(unlocked, invalid, locked).entries()) {
        if (index > 0) {
            listElement.append(el('div', 'omtp-provider-separator'));
        }
        for (const group of section) {
            listElement.append(renderProviderSidebarItem(group));
        }
    }
}

/**
 * Sidebar for the sign-in tab: every provider we know about, bucketed and
 * filtered by the same query that filters the login roster.
 * @param {HTMLElement} listElement
 */
function renderLoginProviderList(listElement) {
    const query = state.searchQuery.trim().toLowerCase();
    /** @type {Map<string, any>} */
    const map = new Map();
    const add = (id, label, status) => {
        map.set(id, providerGroupFromStatus(id, label, status));
    };
    for (const entry of visibleEntries()) {
        if (entry.kind === 'profile') continue;
        const pid = entry.providerId || entry.provider;
        if (map.has(pid)) continue;
        add(pid, entry.providerLabel || pid, state.providerAvailability.get(String(pid)));
    }
    for (const [id, status] of state.providerAvailability) {
        if (!map.has(id)) {
            add(id, status.label, status);
        }
    }
    const matches = (group) => (!query
        || `${group.label} ${group.id}`.toLowerCase().includes(query))
        && (!mainstreamOnly() || group.id === state.selectedProvider || isMainstreamProvider(group.id));
    const all = [...map.values()].filter(matches);
    state.providerGroups = new Map(all.map((group) => [group.id, group]));

    const availableTotal = [...map.values()].filter((group) => group.unlocked).length;
    const allItem = createAllProvidersItem(availableTotal);
    listElement.replaceChildren(allItem);

    if (!all.length) {
        listElement.append(el('div', 'omtp-empty-state', trf('omtp_login_no_results', 'No provider matches “${0}”.', state.searchQuery.trim())));
        return;
    }
    appendSidebarSections(listElement, partitionProviders(all));
}

/**
 * Render the provider sidebar.
 */
export function renderProviderList() {
    const listElement = document.getElementById('omtp-provider-list');
    if (!listElement) {
        return;
    }
    // The sign-in tab indexes providers, not models, and so does its search:
    // the column shows exactly the providers the login roster is showing.
    if (state.currentTab === 'providers') {
        renderLoginProviderList(listElement);
        return;
    }
    // While searching, the sidebar only lists providers that own a match.
    const query = state.searchQuery.trim().toLowerCase();
    const list = query
        ? entriesForTab().filter((entry) => {
            const haystack = [
                entry.model,
                entry.modelLabel,
                entry.provider,
                entry.providerLabel,
                entry.key,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(query);
        })
        : filteredEntries();
    const { allMap } = buildProviderGroups(list);
    let buckets = partitionProviders([...allMap.values()]);
    // Providers whose model list is empty (local runtimes, OAuth-only plans)
    // still belong in the column: the live probe fills them on first click.
    if (!query && !scoredOnly()) {
        for (const [id, status] of state.providerAvailability) {
            if (allMap.has(id)) {
                continue;
            }
            allMap.set(id, providerGroupFromStatus(id, status.label, status));
        }
        buckets = partitionProviders([...allMap.values()]);
    }
    if (mainstreamOnly()) {
        const keep = (group) => group.id === state.selectedProvider || isMainstreamProvider(group.id);
        buckets = {
            unlocked: buckets.unlocked.filter(keep),
            invalid: buckets.invalid.filter(keep),
            locked: buckets.locked.filter(keep),
        };
    }
    state.providerGroups = allMap;
    if (state.selectedProvider && !allMap.has(state.selectedProvider)) {
        // While searching the sidebar only lists providers with a match; keep
        // the selection unless the provider is gone from the catalog entirely.
        const stillKnown = visibleEntries().some((entry) => String(entry.providerId || entry.provider) === String(state.selectedProvider));
        if (!stillKnown) {
            state.selectedProvider = null;
        }
    }
    listElement.replaceChildren();

    const availableTotal = list.filter((entry) => entry.available !== false && entry.kind !== 'profile').length;
    listElement.append(createAllProvidersItem(availableTotal));
    appendSidebarSections(listElement, buckets);
}

/** @param {any} group */
function providerItemTitle(group) {
    if (group.unlocked) {
        return `${group.label} — ${group.availableCount} models`;
    }
    if (group.invalid) {
        return trf('omtp_provider_invalid_title', '${0} — key rejected: ${1}', group.label, group.reason || 'auth error');
    }
    return trf('omtp_provider_locked_title', '${0} (no credentials / not signed in)', group.label);
}

/** @param {any} group */
function providerDotClass(group) {
    if (group.unlocked) {
        return 'omtp-dot-online';
    }
    if (group.invalid) {
        return 'omtp-dot-invalid';
    }
    return 'omtp-dot-offline';
}

/**
 * One provider row in the sidebar.
 * @param {any} group
 * @returns {HTMLElement}
 */
function renderProviderSidebarItem(group) {
    const active = state.selectedProvider === group.id ? ' omtp-active' : '';
    const item = el('button', 'omtp-provider-item' + (group.unlocked ? '' : ' omtp-provider-locked') + active);
    item.type = 'button';
    item.dataset.provider = group.id;
    item.title = providerItemTitle(group);
    const row = el('span', 'omtp-provider-item-row');
    row.append(
        el('span', 'omtp-sidebar-dot ' + providerDotClass(group)),
        el('span', 'omtp-provider-label', providerLabel(group.id, group.label)),
    );
    item.append(row);
    if (group.unlocked) {
        item.append(el('span', 'omtp-count', String(group.availableCount)));
    }
    item.addEventListener('click', () => {
        if (state.currentTab === 'providers') {
            revealLoginRow(group.id);
            return;
        }
        selectProvider(group.id);
    });
    return item;
}

/**
 * Scroll the sign-in roster to a provider and flash it.
 * @param {string} providerId
 * @param {{retry?: boolean, focusInput?: boolean, smooth?: boolean, duration?: number,
 *          onMissing?: (() => void)|null}} [options]
 */
export function revealLoginRow(providerId, { retry = false, focusInput = false, smooth = true, duration = 1800, onMissing = null } = {}) {
    let attempts = 0;
    const reveal = () => {
        const row = document.querySelector(`.omtp-login-row[data-provider="${cssEscape(providerId)}"]`);
        if (!row) {
            attempts += 1;
            if (retry && attempts <= 10) {
                setTimeout(reveal, 120);
                return;
            }
            if (onMissing) {
                onMissing();
            }
            return;
        }
        row.scrollIntoView(smooth ? { behavior: 'smooth', block: 'center' } : { block: 'center' });
        row.classList.add('omtp-highlight');
        setTimeout(() => row.classList.remove('omtp-highlight'), duration);
        if (focusInput) {
            row.querySelector('input')?.focus();
        }
    };
    reveal();
}

/**
 * Activate the first row of the current list: highlight it, refresh the
 * details pane, scroll it into view and give it keyboard focus.
 * @returns {boolean} true when a row was activated
 */
function selectFirstRow() {
    const entry = state.rowEntries[0];
    if (!entry) {
        return false;
    }
    state.selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
    const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(state.selectedEntryKey)}"]`);
    if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'nearest' });
        row.focus({ preventScroll: true });
    }
    return true;
}

/**
 * Re-activate the first row after a re-render, but only when the previous
 * selection no longer exists in the list.
 * @returns {boolean} true when a row was activated
 */
function selectFirstRowIfStale() {
    const stillThere = state.rowEntries.some((entry) => entryKey(entry) === state.selectedEntryKey);
    if (stillThere) {
        const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(state.selectedEntryKey)}"]`);
        row?.focus({ preventScroll: true });
        return false;
    }
    return selectFirstRow();
}

function selectProvider(provider) {
    state.selectedProvider = provider;
    if (state.currentTab !== 'all') {
        state.currentTab = 'all';
    }
    renderProviderList();
    syncTabs();
    renderList();
    // Land on the first model of the provider that was just opened.
    selectFirstRow();

    // Query this provider's live models in the background; the row list is
    // rebuilt when the probe returns something newer.
    if (!provider) {
        return;
    }
    setLiveRefreshState(document.querySelector('.omtp-provider-refresh-btn'), true);
    catalogApi.fetchLiveModelsForProvider(provider).then((result) => {
        if (result?.models?.length && state.selectedProvider === provider) {
            rebuildEntries();
            renderList();
            selectFirstRowIfStale();
        }
    }).catch((err) => {
        console.debug('[omtp] background live model query failed', err);
    }).finally(() => {
        setLiveRefreshState(document.querySelector('.omtp-provider-refresh-btn'), false);
    });
}
