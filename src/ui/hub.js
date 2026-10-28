/**
 * OMTP Model Hub — hub UI, lifecycle and orchestration.
 *
 * The extension entry point (index.js) re-exports init/disable/clean/onDelete
 * from this module. The hub owns:
 *   - settings defaults + the settings panel container,
 *   - the top-bar entry point and the API drawer shortcuts,
 *   - the modal model browser (search, providers, favorites, recents,
 *     quick slots, details, protocol toggle),
 *   - selection display and the per-model actions that delegate to the
 *     switch engine and the feature modules.
 *
 * It never edits SillyTavern core files and never mutates native <select>
 * option lists.
 */
import { eventSource } from '../../../../../events.js';
import { Popup } from '../../../../../popup.js';
import { Fuse, DOMPurify } from '../../../../../../lib.js';
import { chat_metadata, getRequestHeaders, setOnlineStatus } from '../../../../../../script.js';

import * as store from '../store.js';
import * as catalogApi from '../catalog.js';
import * as engine from '../switch-engine.js';
import * as settingsUi from './settings.js';
import * as bindings from './bindings.js';
import * as extraBody from './extra-body.js';
import * as events from '../events.js';
import * as publicApi from '../public-api.js';
import { resolveSelector } from '../selector.js';
import { apiKeyUrlFor } from '../provider-links.js';
import * as loginPanel from './login-panel.js';
import * as usagePanel from './usage-panel.js';
import * as aboutPanel from './about-panel.js';
import * as usageChip from './usage-chip.js';
import { providerDisplayName, supportsProviderNames } from '../provider-names.js';
import {
    AA_PERSONALITY_URL,
    PERSONALITY_INDEXES,
    indexLabel,
    loadPersonality,
    personalityBadge,
    personalityFor,
    personalityRadarSvg,
    personalityTooltip,
    roleplayBadge,
    roleplayScore,
    roleplayTooltip,
} from '../personality.js';
import { normalizeEffortList } from '../reasoning.js';
import { initSlashCommands, teardownSlashCommands } from '../slash-commands.js';
import {
    API_BASE,
    EVENTS,
    ST_EVENTS,
    REASONING_LEVELS,
    LAB_PROVIDERS,
    MAINSTREAM_PROVIDERS,
    QUICK_SLOT_COUNT,
    MAX_FAVORITES,
    MAX_SEARCH_RESULTS,
    SEARCH_DEBOUNCE_MS,
    DEFAULT_HOTKEY,
    OAUTH_PROVIDER_IDS,
} from '../constants.js';
import {
    injectTopBarButton,
    injectApiDrawerTools,
    applyNativeSelectorVisibility,
    updateTopBarTitle,
    setGlobalHotkeyHandler,
    cleanupDom,
    tr,
    trf,
} from './dom.js';

const SOURCE_RANK = { Native: 0, Translated: 1, OMTP: 2, Profile: 3 };

/** @type {Array<object>} */
let entries = [];
/** @type {Map<string, object>} */
let providerGroups = new Map();
/** @type {Fuse<object>|null} */
let fuse = null;
/** @type {boolean} */
let initialized = false;
/** @type {boolean} */
let isCleaningUp = false;
/** @type {boolean} */
let isOpen = false;
/** @type {HTMLElement|null} */
let modal = null;
/** @type {Element|null} */
let previousFocus = null;
/** @type {string} */
let currentTab = 'all';
/** @type {string|null} */
let selectedProvider = null;
/** @type {string|null} */
let selectedEntryKey = null;
/** @type {string} */
let searchQuery = '';
/** @type {ReturnType<typeof setTimeout>|null} */
let searchTimer = null;
/** @type {Array<object>} */
let rowEntries = [];
/** @type {Promise<object[]>|null} */
let catalogLoading = null;
/** @type {boolean} */
let catalogLoaded = false;
/** @type {Map<string, {available:boolean, label:string, unsupportedReason:string|null}>} */
let providerAvailability = new Map();
/** @type {Array<[string, Function]>} */
const hubEventListeners = [];

/* ------------------------------------------------------------------ */
/* Small utilities                                                    */
/* ------------------------------------------------------------------ */

/**
 * Create an element with optional class and text.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function h(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined && text !== null) {
        element.textContent = String(text);
    }
    return element;
}

/**
 * Small Font Awesome capability marker for a model row.
 * @param {string} icon FA icon class suffix
 * @param {string} title Tooltip text
 * @returns {HTMLElement}
 */
function capabilityIcon(icon, title) {
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
function toast(message, type = 'info') {
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

/** @returns {object} */
function settings() {
    try {
        return store.getSettings() || {};
    } catch {
        return {};
    }
}

/** @param {object} patch */
function persist(patch) {
    try {
        store.updateSettings(patch);
    } catch (error) {
        console.warn('[omtp] could not save settings', error);
    }
}

/** @param {object|null|undefined} ref */
function refKey(ref) {
    if (!ref) {
        return '';
    }
    try {
        if (typeof store.getEntryKey === 'function') {
            return store.getEntryKey(ref);
        }
    } catch {
        // fall through
    }
    return `${ref.kind}/${ref.provider}/${ref.model}`;
}

/** @param {object} entry */
function entryKey(entry) {
    if (!entry) {
        return '';
    }
    return entry.key || `${entry.kind}/${entry.provider}/${entry.model}`;
}

/** @param {object} entry */
function refOf(entry) {
    return { kind: entry.kind, provider: entry.provider, model: entry.model };
}

/** @param {object|null} a @param {object|null} b */
function sameRef(a, b) {
    return Boolean(a && b) && a.kind === b.kind && a.provider === b.provider && a.model === b.model;
}

/** @param {object} entry */
function sourceOf(entry) {
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
function sourceLabel(entry) {
    const source = sourceOf(entry);
    const key = `omtp_source_${source.toLowerCase()}`;
    return tr(key, source);
}

/** @param {object} entry */
function isFavoriteEntry(entry) {
    const key = entryKey(entry);
    return (settings().favorites || []).some((ref) => refKey(ref) === key);
}

/** @param {object} entry */
function isRecentEntry(entry) {
    const key = entryKey(entry);
    return (settings().recents || []).some((ref) => refKey(ref) === key);
}

/** @param {object} entry @returns {number} */
function findQuickSlot(entry) {
    const key = entryKey(entry);
    const slots = settings().quickSlots || [];
    return slots.findIndex((ref) => ref && refKey(ref) === key);
}

/** @param {unknown} value */
function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? new Intl.NumberFormat().format(number) : '—';
}

/** @returns {string|null} */
function currentAvatar() {
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
function cssEscape(value) {
    if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
}

/** @param {EventTarget|null} target */
function isEditableTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/* ------------------------------------------------------------------ */
/* Catalog and entry registry                                         */
/* ------------------------------------------------------------------ */

/**
 * Load the catalog through whichever loader catalog.js exposes.
 * @param {boolean} [force]
 * @returns {Promise<object[]>}
 */
async function loadCatalogOnce(force = false) {
    if (catalogLoading && !force) {
        return catalogLoading;
    }
    catalogLoading = (async () => {
        try {
            if (force && typeof catalogApi.loadCatalog === 'function') {
                await catalogApi.loadCatalog({ force: true });
            } else if (typeof catalogApi.initCatalog === 'function') {
                await catalogApi.initCatalog();
            } else if (typeof catalogApi.loadCatalog === 'function') {
                await catalogApi.loadCatalog();
            } else if (typeof catalogApi.loadBundledCatalog === 'function') {
                await catalogApi.loadBundledCatalog();
            } else {
                console.warn('[omtp] catalog module exposes no loader');
            }
            catalogLoaded = true;
        } catch (error) {
            console.warn('[omtp] catalog load failed', error);
        }
        await loadProviderAvailability();
        // AA-PersonalityBench snapshot: optional, the hub works without it.
        await loadPersonality().catch(() => null);
        rebuildEntries();
        return entries;
    })();
    return catalogLoading;
}

/**
 * Load gateway provider availability so keyless gateway rows are visibly
 * unavailable before a switch is attempted.
 */
async function loadProviderAvailability() {
    try {
        const response = await fetch('/api/plugins/omtp/providers', {
            headers: getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const list = Array.isArray(data?.providers) ? data.providers : [];
        providerAvailability = new Map(list.map((provider) => [String(provider.id), provider]));
        catalogApi.setProviderAvailability?.(providerAvailability);
    } catch {
        providerAvailability = new Map();
    }
}

/**
 * Rebuild the local entry list from the catalog module and refresh the UI.
 */
function rebuildEntries() {
    if (!initialized || isCleaningUp) {
        return;
    }
    let list = [];
    try {
        list = catalogApi.getEntries?.() ?? [];
    } catch (error) {
        console.warn('[omtp] getEntries failed', error);
    }
    entries = Array.isArray(list) ? list.filter(Boolean).map((entry) => {
        const next = {
            ...entry,
            key: entry.key || `${entry.kind}/${entry.provider}/${entry.model}`,
        };
        return catalogApi.withProviderAvailability?.(next) ?? next;
    }) : [];
    rebuildFuse();
    if (isOpen) {
        renderAll();
    }
    refreshSelectionUI();
}

/**
 * Rebuild the fuzzy index over currently visible entries.
 */
function rebuildFuse() {
    const list = visibleEntries();
    try {
        fuse = list.length
            ? new Fuse(list, {
                keys: ['model', 'modelLabel', 'providerLabel', 'provider'],
                threshold: 0.35,
                ignoreLocation: true,
            })
            : null;
    } catch (error) {
        console.warn('[omtp] could not build search index', error);
        fuse = null;
    }
}

/**
 * Entries currently allowed to appear in the hub. Gateway (OMP) entries are
 * first-class: every catalog provider is listed, and credentials only decide
 * whether its models are selectable.
 * @returns {object[]}
 */
function visibleEntries() {
    return entries;
}

/** @returns {boolean} Whether provider names should use their Chinese form. */
function showProviderNames() {
    if (!supportsProviderNames(document.documentElement.lang)) {
        return false;
    }
    return settings().ui?.translateProviderNames !== false;
}

/** @param {string} providerId @param {string} label */
function providerLabel(providerId, label) {
    return providerDisplayName(providerId, label, showProviderNames());
}

/** @returns {boolean} Whether the "hide non-mainstream" filter is on. */
function mainstreamOnly() {
    return settings().ui?.mainstreamOnly === true;
}

/** @returns {boolean} Whether the "only models with scores" filter is on. */
function scoredOnly() {
    return settings().ui?.scoredOnly === true;
}

/** @param {string} providerId */
function isMainstreamProvider(providerId) {
    return MAINSTREAM_PROVIDERS.has(String(providerId || ''));
}

/**
 * Entries after the mainstream filter. A provider the user opened explicitly
 * is always shown, so the filter never makes a chosen provider look empty.
 */
function filteredEntries() {
    if (selectedProvider) {
        return visibleEntries();
    }
    let list = visibleEntries();
    if (mainstreamOnly()) {
        list = list.filter((entry) => entry.kind === 'profile' || isMainstreamProvider(entry.providerId || entry.provider));
    }
    if (scoredOnly()) {
        list = list.filter((entry) => entry.kind === 'profile' || Boolean(personalityFor(entry)));
    }
    return list;
}

/**
 * Resolve an EntryRef to a catalog entry.
 * @param {object|null|undefined} ref
 * @returns {object|null}
 */
function resolveRef(ref) {
    if (!ref) {
        return null;
    }
    // The local list already carries live provider availability; the catalog
    // module's copy is the raw, optimistic one.
    const key = refKey(ref);
    const local = entries.find((entry) => entryKey(entry) === key);
    if (local) {
        return local;
    }
    try {
        const resolved = catalogApi.resolveEntry?.(ref);
        if (resolved) {
            return catalogApi.withProviderAvailability?.(resolved) ?? resolved;
        }
    } catch {
        // no catalog match
    }
    return null;
}

/**
 * The selection currently active in SillyTavern.
 * @returns {object|null}
 */
function getCurrentRef() {
    try {
        const snapshot = engine.captureSelection?.();
        if (snapshot?.ref) {
            return snapshot.ref;
        }
    } catch {
        // ignore
    }
    return settings().lastSelection ?? null;
}

/**
 * The entry shown in the details pane: the explicitly selected row, else the
 * current selection.
 * @returns {object|null}
 */
function getSelectedEntry() {
    if (selectedEntryKey) {
        const found = entries.find((entry) => entryKey(entry) === selectedEntryKey);
        if (found) {
            return found;
        }
    }
    return resolveRef(getCurrentRef());
}

/* ------------------------------------------------------------------ */
/* Provider sidebar                                                   */
/* ------------------------------------------------------------------ */

/**
 * Group catalog entries into unlocked (has usable credentials) and locked
 * (needs login/key) providers, sorted by provider id.
 * @param {object[]} list
 * @returns {{unlocked: object[], locked: object[], allMap: Map<string, object>}}
 */
function buildProviderGroups(list) {
    const map = new Map();
    for (const entry of list) {
        if (entry.kind === 'profile') continue;
        const pid = entry.providerId || entry.provider;
        let group = map.get(pid);
        if (!group) {
            group = {
                id: pid,
                label: entry.providerLabel || pid,
                count: 0,
                availableCount: 0,
                unlocked: false,
                invalid: false,
                reason: null,
            };
            map.set(pid, group);
        }
        group.count += 1;
        if (entry.available !== false) {
            group.availableCount += 1;
            group.unlocked = true;
        }
        const providerStatus = providerAvailability.get(String(pid));
        if (providerStatus?.keyInvalid) {
            group.invalid = true;
            group.reason = providerStatus.keyInvalidReason || null;
        }
    }
    const all = [...map.values()];
    const byId = (a, b) => a.id.localeCompare(b.id);
    // Usable first, then providers whose stored key the upstream rejected,
    // then everything without credentials.
    const unlocked = all.filter((g) => g.unlocked).sort(byId);
    const invalid = all.filter((g) => !g.unlocked && g.invalid).sort(byId);
    const locked = all.filter((g) => !g.unlocked && !g.invalid).sort(byId);
    return { unlocked, invalid, locked, allMap: map };
}

/** @param {any} group */
function isLabGroup(group) {
    return LAB_PROVIDERS.has(String(group.id || ''));
}

/**
 * Labs first, then the rest; each section keeps the green → red → hollow order.
 * @param {any[]} unlocked
 * @param {any[]} invalid
 * @param {any[]} locked
 * @returns {any[][]} Non-empty sections in render order.
 */
function sidebarSections(unlocked, invalid, locked) {
    const ordered = [...unlocked, ...invalid, ...locked];
    const labs = ordered.filter(isLabGroup);
    const rest = ordered.filter((group) => !isLabGroup(group));
    return [labs, rest].filter((section) => section.length > 0);
}

/**
 * Sidebar for the sign-in tab: every provider we know about, bucketed and
 * filtered by the same query that filters the login roster.
 * @param {HTMLElement} listElement
 */
function renderLoginProviderList(listElement) {
    const query = searchQuery.trim().toLowerCase();
    /** @type {Map<string, any>} */
    const map = new Map();
    const add = (id, label, status) => {
        map.set(id, {
            id,
            label: label || id,
            count: 0,
            availableCount: 0,
            unlocked: status?.available === true,
            invalid: Boolean(status?.keyInvalid),
            reason: status?.keyInvalidReason || null,
        });
    };
    for (const entry of visibleEntries()) {
        if (entry.kind === 'profile') continue;
        const pid = entry.providerId || entry.provider;
        if (map.has(pid)) continue;
        add(pid, entry.providerLabel || pid, providerAvailability.get(String(pid)));
    }
    for (const [id, status] of providerAvailability) {
        if (!map.has(id)) {
            add(id, status.label, status);
        }
    }
    const matches = (group) => (!query
        || `${group.label} ${group.id}`.toLowerCase().includes(query))
        && (!mainstreamOnly() || group.id === selectedProvider || isMainstreamProvider(group.id));
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));
    const all = [...map.values()].filter(matches);
    const unlocked = all.filter((g) => g.unlocked).sort(byId);
    const invalid = all.filter((g) => !g.unlocked && g.invalid).sort(byId);
    const locked = all.filter((g) => !g.unlocked && !g.invalid).sort(byId);
    providerGroups = new Map(all.map((g) => [g.id, g]));

    const availableTotal = [...map.values()].filter((g) => g.unlocked).length;
    const allItem = h('button', 'omtp-provider-item' + (selectedProvider === null ? ' omtp-active' : ''));
    allItem.type = 'button';
    allItem.dataset.provider = '';
    allItem.append(
        h('span', 'omtp-provider-label', tr('omtp_all_models', 'All models')),
        h('span', 'omtp-count', String(availableTotal)),
    );
    allItem.addEventListener('click', () => selectProvider(null));
    listElement.replaceChildren(allItem);

    if (!all.length) {
        listElement.append(h('div', 'omtp-empty-state', trf('omtp_login_no_results', 'No provider matches “${0}”.', searchQuery.trim())));
        return;
    }
    for (const [index, section] of sidebarSections(unlocked, invalid, locked).entries()) {
        if (index > 0) {
            listElement.append(h('div', 'omtp-provider-separator'));
        }
        for (const group of section) {
            listElement.append(renderProviderSidebarItem(group));
        }
    }
}

/**
 * Render the provider sidebar.
 */
function renderProviderList() {
    const listElement = document.getElementById('omtp-provider-list');
    if (!listElement) {
        return;
    }
    // The sign-in tab indexes providers, not models, and so does its search:
    // the column shows exactly the providers the login roster is showing.
    if (currentTab === 'providers') {
        renderLoginProviderList(listElement);
        return;
    }
    // While searching, the sidebar only lists providers that own a match.
    const query = searchQuery.trim().toLowerCase();
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
    const groups = buildProviderGroups(list);
    const { allMap } = groups;
    let { unlocked, invalid, locked } = groups;
    // Providers whose model list is empty (local runtimes, OAuth-only plans)
    // still belong in the column: the live probe fills them on first click.
    if (!query && !scoredOnly()) {
        for (const [id, status] of providerAvailability) {
            if (allMap.has(id)) {
                continue;
            }
            const group = {
                id,
                label: status.label || id,
                count: 0,
                availableCount: 0,
                unlocked: status.available === true,
                invalid: Boolean(status.keyInvalid),
                reason: status.keyInvalidReason || null,
            };
            allMap.set(id, group);
            if (group.unlocked) {
                unlocked.push(group);
            } else if (group.invalid) {
                invalid.push(group);
            } else {
                locked.push(group);
            }
        }
        const byId = (a, b) => String(a.id).localeCompare(String(b.id));
        unlocked.sort(byId);
        invalid.sort(byId);
        locked.sort(byId);
    }
    if (mainstreamOnly()) {
        const keep = (group) => group.id === selectedProvider || isMainstreamProvider(group.id);
        unlocked = unlocked.filter(keep);
        invalid = invalid.filter(keep);
        locked = locked.filter(keep);
    }
    providerGroups = allMap;
    if (selectedProvider && !allMap.has(selectedProvider)) {
        // While searching the sidebar only lists providers with a match; keep
        // the selection unless the provider is gone from the catalog entirely.
        const stillKnown = visibleEntries().some((entry) => String(entry.providerId || entry.provider) === String(selectedProvider));
        if (!stillKnown) {
            selectedProvider = null;
        }
    }
    listElement.replaceChildren();

    const availableTotal = list.filter((e) => e.available !== false && e.kind !== 'profile').length;
    const allItem = h('button', 'omtp-provider-item' + (selectedProvider === null ? ' omtp-active' : ''));
    allItem.type = 'button';
    allItem.dataset.provider = '';
    const allLabel = h('span', 'omtp-provider-label', tr('omtp_all_models', 'All models'));
    const allCount = h('span', 'omtp-count', String(availableTotal));
    allItem.append(allLabel, allCount);
    allItem.addEventListener('click', () => selectProvider(null));
    listElement.append(allItem);

    // Labs first, then aggregators/clouds/local runtimes; inside each section
    // usable → rejected key (red) → no credentials, alphabetical.
    for (const [index, section] of sidebarSections(unlocked, invalid, locked).entries()) {
        if (index > 0) {
            listElement.append(h('div', 'omtp-provider-separator'));
        }
        for (const group of section) {
            listElement.append(renderProviderSidebarItem(group));
        }
    }
}

/**
 * One provider row in the sidebar.
 * @param {any} group
 * @returns {HTMLElement}
 */
function renderProviderSidebarItem(group) {
    const active = selectedProvider === group.id ? ' omtp-active' : '';
    const item = h('button', 'omtp-provider-item' + (group.unlocked ? '' : ' omtp-provider-locked') + active);
    item.type = 'button';
    item.dataset.provider = group.id;
    item.title = group.unlocked
        ? `${group.label} — ${group.availableCount} models`
        : group.invalid
            ? trf('omtp_provider_invalid_title', '${0} — key rejected: ${1}', group.label, group.reason || 'auth error')
            : trf('omtp_provider_locked_title', '${0} (no credentials / not signed in)', group.label);
    const row = h('span', 'omtp-provider-item-row');
    const dotClass = group.unlocked ? 'omtp-dot-online' : group.invalid ? 'omtp-dot-invalid' : 'omtp-dot-offline';
    const dot = h('span', 'omtp-sidebar-dot ' + dotClass);
    const label = h('span', 'omtp-provider-label', providerLabel(group.id, group.label));
    row.append(dot, label);
    item.append(row);
    if (group.unlocked) {
        item.append(h('span', 'omtp-count', String(group.availableCount)));
    }
    item.addEventListener('click', () => {
        if (currentTab === 'providers') {
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
 */
function revealLoginRow(providerId) {
    const row = document.querySelector(`.omtp-login-row[data-provider="${cssEscape(providerId)}"]`);
    if (!row) {
        return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('omtp-highlight');
    setTimeout(() => row.classList.remove('omtp-highlight'), 1800);
}
/**
 * Activate the first row of the current list: highlight it, refresh the
 * details pane, scroll it into view and give it keyboard focus.
 * @returns {boolean} true when a row was activated
 */
function selectFirstRow() {
    const entry = rowEntries[0];
    if (!entry) {
        return false;
    }
    selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
    const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(selectedEntryKey)}"]`);
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
    const stillThere = rowEntries.some((entry) => entryKey(entry) === selectedEntryKey);
    if (stillThere) {
        const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(selectedEntryKey)}"]`);
        row?.focus({ preventScroll: true });
        return false;
    }
    return selectFirstRow();
}

function selectProvider(provider) {
    selectedProvider = provider;
    if (currentTab !== 'all') {
        currentTab = 'all';
    }
    renderProviderList();
    syncTabs();
    renderList();
    // Land on the first model of the provider that was just opened.
    selectFirstRow();

    // Dynamically query live models for this provider from API (Requirement 1 & 3)
    if (provider) {
        const refreshBtn = document.querySelector('.omtp-provider-refresh-btn');
        if (refreshBtn) refreshBtn.textContent = '⏳ ' + tr('omtp_syncing', 'Syncing…');
        catalogApi.fetchLiveModelsForProvider?.(provider).then((result) => {
            if (result?.models?.length && selectedProvider === provider) {
                rebuildEntries();
                renderList();
                selectFirstRowIfStale();
            }
        }).catch((err) => {
            console.debug('[omtp] background live model query failed', err);
        }).finally(() => {
            const btn = document.querySelector('.omtp-provider-refresh-btn');
            if (btn) btn.textContent = '🔄 ' + tr('omtp_refresh_live_models', 'Refresh live models');
        });
    }
}

/* ------------------------------------------------------------------ */
/* Search and model list                                              */
/* ------------------------------------------------------------------ */

/**
 * Entries that belong to the active tab.
 * @returns {object[]}
 */
function entriesForTab() {
    const list = filteredEntries();
    switch (currentTab) {
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

    if (fuse) {
        try {
            for (const result of fuse.search(raw)) {
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
    container.append(h('div', 'omtp-section-title', text));
}

/**
 * Append an empty-state row.
 * @param {HTMLElement} container
 * @param {string} text
 */
function appendEmptyState(container, text) {
    container.append(h('div', 'omtp-empty-state', text));
}

/**
 * Render the model list for the current tab/search/provider.
 */
function renderList() {
    const listElement = document.getElementById('omtp-model-list');
    if (!listElement) {
        return;
    }
    const manager = document.getElementById('omtp-provider-manager');
    const body = document.getElementById('omtp-hub-body');
    document.querySelector('#omtp-tabs .omtp-tab-filters')?.classList.toggle('omtp-hidden', currentTab === 'about');
    document.getElementById('omtp-hub-footer')?.classList.toggle('omtp-hidden', currentTab === 'about');
    if (currentTab === 'usage' || currentTab === 'about') {
        rowEntries = [];
        listElement.replaceChildren();
        listElement.hidden = true;
        body?.classList.add('omtp-manager-open');
        body?.classList.toggle('omtp-about-open', currentTab === 'about');
        // The model filters and the usable-model count mean nothing on a static page.
        document.querySelector('#omtp-tabs .omtp-tab-filters')?.classList.toggle('omtp-hidden', currentTab === 'about');
        document.getElementById('omtp-hub-footer')?.classList.toggle('omtp-hidden', currentTab === 'about');
        if (manager) {
            loginPanel.disposeLoginPanel?.();
            manager.hidden = false;
            if (currentTab === 'usage') {
                aboutPanel.disposeAboutPanel?.();
                Promise.resolve(usagePanel.mountUsagePanel?.(manager))
                    .catch((error) => console.warn('[omtp] usage panel failed', error));
            } else {
                usagePanel.disposeUsagePanel?.();
                Promise.resolve(aboutPanel.mountAboutPanel?.(manager))
                    .catch((error) => console.warn('[omtp] about panel failed', error));
            }
        }
        return;
    }
    usagePanel.disposeUsagePanel?.();
    aboutPanel.disposeAboutPanel?.();
    if (currentTab === 'providers') {
        rowEntries = [];
        listElement.replaceChildren();
        listElement.hidden = true;
        body?.classList.add('omtp-manager-open');
        if (manager) {
            manager.hidden = false;
            Promise.resolve(loginPanel.mountLoginPanel?.(manager, {
                onChanged: () => refreshHub().catch(() => {}),
            }))
                // Entering the tab must honour whatever is already in the search box.
                .then(() => loginPanel.setLoginFilter?.(searchQuery))
                .catch((error) => console.warn('[omtp] login panel failed', error));
        }
        return;
    }
    if (manager && !manager.hidden) {
        loginPanel.disposeLoginPanel?.();
        manager.hidden = true;
    }
    listElement.hidden = false;
    body?.classList.remove('omtp-manager-open');
    body?.classList.remove('omtp-about-open');
    document.querySelector('#omtp-tabs .omtp-tab-filters')?.classList.remove('omtp-hidden');
    document.getElementById('omtp-hub-footer')?.classList.remove('omtp-hidden');
    listElement.replaceChildren();
    rowEntries = [];
    const renderedKeys = new Set();
    const query = searchQuery.trim();

    const appendRow = (entry) => {
        const key = entryKey(entry);
        if (renderedKeys.has(key)) {
            return;
        }
        renderedKeys.add(key);
        rowEntries.push(entry);
        listElement.append(renderRow(entry, rowEntries.length - 1));
    };

    if (query) {
        // With a provider selected the query filters inside it, so typing first
        // and then clicking a provider keeps the search meaningful.
        const scope = selectedProvider
            ? filteredEntries().filter((entry) => entry.kind !== 'profile'
                && (entry.providerId === selectedProvider || entry.provider === selectedProvider))
            : entriesForTab();
        const results = searchEntries(query, scope);
        if (!results.length) {
            const elsewhere = selectedProvider ? searchEntries(query, entriesForTab()).length : 0;
            appendEmptyState(listElement, elsewhere
                ? trf('omtp_no_results_in_provider', 'No match in this provider. ${0} matches elsewhere.', elsewhere)
                : tr('omtp_no_results', 'No models match your search.'));
        } else {
            // Group hits by provider so every section has its own refresh
            // button; section order follows the ranking (best match first).
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
        appendProtocolHint(listElement);
        return;
    }

    if (currentTab === 'profiles') {
        const profiles = filteredEntries().filter((entry) => entry.kind === 'profile');
        if (!profiles.length) {
            appendEmptyState(listElement, tr('omtp_no_results', 'No models match your search.'));
        } else {
            profiles.forEach(appendRow);
        }
        appendProtocolHint(listElement);
        return;
    }

    if (currentTab === 'favorites') {
        const favorites = filteredEntries().filter((entry) => isFavoriteEntry(entry));
        if (!favorites.length) {
            appendEmptyState(listElement, tr('omtp_no_results', 'No models match your search.'));
        } else {
            favorites.forEach(appendRow);
        }
        appendProtocolHint(listElement);
        return;
    }

    if (currentTab === 'recent') {
        const recents = filteredEntries().filter((entry) => isRecentEntry(entry));
        if (!recents.length) {
            appendEmptyState(listElement, tr('omtp_no_results', 'No models match your search.'));
        } else {
            recents.forEach(appendRow);
        }
        appendProtocolHint(listElement);
        return;
    }

    // The dashboard (no provider selected) shows pinned entries; a provider view
    // shows only that provider's models. Pinned entries for providers that are
    // not signed in are hidden — the "All models" view lists what can be used.
    const usable = (entry) => entry.available !== false;
    if (!selectedProvider) {
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
    if (selectedProvider) {
        const group = providerGroups.get(selectedProvider);
        const models = filteredEntries().filter((entry) => entry.kind !== 'profile' && (entry.providerId === selectedProvider || entry.provider === selectedProvider));
        if (models.length) {
            listElement.append(renderProviderHeader(selectedProvider, models.length));
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
    if (!rowEntries.length) {
        appendEmptyState(listElement, tr('omtp_select_provider_hint', 'Pick a provider on the left or search for a model.'));
    }
    appendProtocolHint(listElement);
}

/**
 * Add the "turn on OMTP providers" hint at the end of the list.
 * @param {HTMLElement} container
 */
function appendProtocolHint(container) {
    // All providers and models are now automatically routed; no hint row needed.
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
    const selected = selectedEntryKey === key;
    row.setAttribute('aria-selected', String(selected));
    if (selected) {
        row.classList.add('omtp-active');
    }
    const currentRef = getCurrentRef();
    if (currentRef && sameRef(currentRef, refOf(entry))) {
        row.classList.add('omtp-current');
        row.title = tr('omtp_model_in_use_hint', 'Currently in use');
    }
    if (highlightKey === key) {
        row.classList.add('omtp-row-flash');
    }
    if (entry.available === false) {
        row.classList.add('omtp-unavailable', 'omtp-disabled');
    }

    const main = h('div', 'omtp-row-main');
    const name = h('div', 'omtp-row-name', entry.modelLabel || entry.model);
    const metaParts = [entry.providerLabel || entry.provider, entry.model];
    if (entry.contextWindow) {
        metaParts.push(formatNumber(entry.contextWindow));
    }
    const meta = h('div', 'omtp-row-meta', metaParts.join(' · '));
    if (entry.isLive) {
        const liveBadge = h('span', 'omtp-live-badge', tr('omtp_live_badge', 'live'));
        liveBadge.title = tr('omtp_live_badge_hint', 'Confirmed live via the provider API');
        meta.append(' · ', liveBadge);
    }
    if (entry.available === false) {
        const keyBadge = h('span', 'omtp-missing-key-badge', tr('omtp_missing_key', 'no key'));
        meta.append(' · ', keyBadge);
    }
    const personality = personalityFor(entry);
    if (personality) {
        const pb = h('span', 'omtp-row-pb', personalityBadge(personality.record));
        pb.title = personalityTooltip(personality.record);
        const rp = h('span', 'omtp-row-pb omtp-row-rp', roleplayBadge(personality.record));
        rp.title = roleplayTooltip(personality.record);
        name.append(' ', pb, ' ', rp);
    }
    main.append(name, meta);
    const badge = h('span', `omtp-badge omtp-badge-${sourceOf(entry).toLowerCase()}`, sourceLabel(entry));

    const capabilities = h('span', 'omtp-capabilities');
    if (entry.supportsTools) {
        capabilities.append(capabilityIcon('fa-screwdriver-wrench', 'Tools'));
    }
    if (entry.reasoning) {
        capabilities.append(capabilityIcon('fa-brain', 'Reasoning'));
    }
    if (Array.isArray(entry.input) && entry.input.includes('image')) {
        capabilities.append(capabilityIcon('fa-image', 'Image input'));
    }

    const status = h('span', `omtp-status-dot ${entry.available === false ? 'omtp-bad' : 'omtp-ok'}`);
    status.title = entry.available === false
        ? (entry.unsupportedReason || tr('omtp_status_unavailable', 'Unavailable'))
        : tr('omtp_status_available', 'Available');

    const slotIndex = findQuickSlot(entry);
    const slotBadge = slotIndex >= 0 ? h('span', 'omtp-slot-badge', String(slotIndex + 1)) : null;
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
    selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
}

/**
 * Update row highlight classes without rebuilding the list (keeps scroll).
 */
function highlightSelectedRow() {
    document.querySelectorAll('#omtp-model-list .omtp-model-row').forEach((row) => {
        const active = row.dataset.key === selectedEntryKey;
        row.classList.toggle('omtp-active', active);
        row.setAttribute('aria-selected', String(active));
    });
}

/* ------------------------------------------------------------------ */
/* Details pane                                                       */
/* ------------------------------------------------------------------ */

/**
 * Append a definition-list row.
 * @param {HTMLElement} list
 * @param {string} label
 * @param {string} value
 */
function addMeta(list, label, value) {
    list.append(h('dt', null, label), h('dd', null, value));
}

/**
 * Create a details action button.
 * @param {string} id
 * @param {string} label
 * @param {Function} handler
 * @param {string} [extraClass]
 * @returns {HTMLButtonElement}
 */
function actionButton(id, label, handler, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = extraClass;
    button.textContent = label;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        try {
            const result = handler();
            if (result?.catch) {
                result.catch((error) => toast(error?.message || String(error), 'error'));
            }
        } catch (error) {
            toast(error?.message || String(error), 'error');
        }
    });
    return button;
}

/**
 * Section header for a provider: label, match count and a live-refresh button.
 * @param {string} providerId
 * @param {number} count Models shown under the header.
 * @returns {HTMLElement}
 */
function renderProviderHeader(providerId, count) {
    const group = providerGroups.get(providerId);
    const headerRow = h('div', 'omtp-section-header-row');
    const titleElem = h('div', 'omtp-section-title', `${providerLabel(providerId, group?.label)} · ${count}`);
    const refreshBtn = h('button', 'omtp-provider-refresh-btn', '🔄 ' + tr('omtp_refresh_live_models', 'Refresh live models'));
    refreshBtn.title = tr('omtp_refresh_live_models_hint', 'Fetch the current model list from this provider API');
    refreshBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        refreshBtn.textContent = '⏳ ' + tr('omtp_syncing', 'Syncing…');
        refreshBtn.disabled = true;
        try {
            const result = await catalogApi.fetchLiveModelsForProvider(providerId, true);
            if (result?.models?.length) {
                toast(trf('omtp_live_models_found', 'Fetched ${0} models from the API', result.models.length), 'success');
            } else if (result?.needsCredentials) {
                toast(tr('omtp_refresh_needs_key', 'This provider has no credentials yet; add a key first.'), 'warning');
            } else if (result?.error) {
                toast(trf('omtp_refresh_failed', 'Refresh failed: ${0}', result.error), 'error');
            } else {
                toast(tr('omtp_live_models_none', 'The provider returned no models.'), 'info');
            }
            rebuildEntries();
            renderList();
        } catch (error) {
            toast(trf('omtp_live_models_failed', 'Could not fetch models: ${0}', error.message || error), 'error');
        } finally {
            refreshBtn.textContent = '🔄 ' + tr('omtp_refresh_live_models', 'Refresh live models');
            refreshBtn.disabled = false;
        }
    });
    headerRow.append(titleElem, refreshBtn);
    return headerRow;
}

/**
 * Radar chart + index list for a model with AA-PersonalityBench data.
 * @param {any} record
 * @returns {HTMLElement}
 */
function personalitySection(record) {
    const wrap = h('div', 'omtp-pb');
    const head = h('div', 'omtp-pb-head');
    const title = h('span', 'omtp-pb-title', tr('omtp_pb_title', 'AA-PersonalityBench'));
    const link = h('a', 'omtp-pb-link', '↗');
    link.href = AA_PERSONALITY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = tr('omtp_pb_open', 'Open the AA-PersonalityBench page');
    head.append(title, link);
    wrap.append(head);

    const scores = h('div', 'omtp-pb-scores');
    const aa = h('span', 'omtp-pb-score', trf('omtp_pb_mean', 'Mean index ${0}', Math.round(record.mean)));
    const rp = h('span', 'omtp-pb-score omtp-pb-rp', roleplayBadge(record));
    rp.title = roleplayTooltip(record);
    scores.append(aa, rp);
    wrap.append(scores);

    const radar = h('div', 'omtp-pb-chart');
    radar.innerHTML = personalityRadarSvg(record);
    wrap.append(radar);

    const list = h('div', 'omtp-pb-list');
    for (const index of PERSONALITY_INDEXES) {
        const value = Math.round(Number(record.scores[index] ?? 0));
        if (!Number.isFinite(value)) {
            continue;
        }
        const row = h('div', 'omtp-pb-row');
        const bar = h('span', 'omtp-pb-bar');
        const fill = h('span', 'omtp-pb-fill');
        fill.style.width = `${Math.max(2, Math.min(100, value))}%`;
        bar.append(fill);
        row.append(
            h('span', 'omtp-pb-label', indexLabel(index)),
            bar,
            h('span', 'omtp-pb-value', String(value)),
        );
        list.append(row);
    }
    wrap.append(list);

    const note = h('div', 'omtp-pb-note');
    note.textContent = record.published
        ? tr('omtp_pb_attribution', 'Data: Artificial Analysis')
        : `${tr('omtp_pb_attribution', 'Data: Artificial Analysis')} · ${tr('omtp_pb_derived', 'Indexes derived from AA trait z-scores')}`;
    wrap.append(note);
    return wrap;
}

/**
 * Render the details pane for the selected/current entry.
 */
function renderDetails() {
    const details = document.getElementById('omtp-details');
    if (!details) {
        return;
    }
    details.replaceChildren();
    details.scrollTop = 0;
    const entry = getSelectedEntry();
    if (!entry) {
        details.append(h('div', 'omtp-empty-state', tr('omtp_details_empty', 'Select a model to see its details.')));
        return;
    }

    const ref = refOf(entry);
    const key = entryKey(entry);
    details.append(h('h3', null, entry.modelLabel || entry.model));
    details.append(h('div', 'omtp-details-id', entry.model));
    details.append(h('span', `omtp-badge omtp-badge-${sourceOf(entry).toLowerCase()}`, sourceLabel(entry)));

    if (entry.unsupportedReason) {
        const reason = h('div', 'omtp-unsupported', trf('omtp_unsupported', 'Not selectable: ${0}', entry.unsupportedReason));
        details.append(reason);
    }

    const meta = document.createElement('dl');
    meta.className = 'omtp-details-meta';
    addMeta(meta, tr('omtp_meta_provider', 'Provider'), providerLabel(entry.providerId || entry.provider, entry.providerLabel || entry.provider));
    addMeta(meta, tr('omtp_meta_source', 'Source'), sourceLabel(entry));
    addMeta(meta, tr('omtp_meta_context', 'Context'), entry.contextWindow ? formatNumber(entry.contextWindow) : '—');
    addMeta(meta, tr('omtp_meta_max_tokens', 'Max tokens'), entry.maxTokens ? formatNumber(entry.maxTokens) : '—');
    if (Array.isArray(entry.input) && entry.input.length) {
        addMeta(meta, tr('omtp_meta_input', 'Input'), entry.input.join(', '));
    }
    addMeta(meta, tr('omtp_meta_tools', 'Tools (reference only)'), entry.supportsTools ? tr('omtp_yes', 'Yes') : tr('omtp_no', 'No'));
    const reasoningLabel = entry.reasoning
        ? (Array.isArray(entry.efforts) && entry.efforts.length
            ? normalizeEffortList(entry.efforts).filter((level) => level !== 'auto').join(', ') || tr('omtp_yes', 'Yes')
            : tr('omtp_yes', 'Yes'))
        : tr('omtp_no', 'No');
    addMeta(meta, tr('omtp_meta_reasoning', 'Reasoning'), reasoningLabel);
    addMeta(meta, tr('omtp_meta_status', 'Status'), entry.available === false ? tr('omtp_status_unavailable', 'Unavailable') : tr('omtp_status_available', 'Available'));
    details.append(meta);

    const personality = personalityFor(entry);
    if (personality) {
        details.append(personalitySection(personality.record));
    }

    // Reasoning effort
    const reasoningRow = h('div', 'omtp-details-reason');
    const reasoningLabelElement = h('label', null, tr('omtp_reasoning', 'Reasoning effort'));
    reasoningLabelElement.htmlFor = 'omtp-reasoning';
    const reasoningSelect = document.createElement('select');
    reasoningSelect.id = 'omtp-reasoning';
    for (const level of REASONING_LEVELS) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level === 'auto' ? tr('omtp_reasoning_auto', 'auto') : level;
        reasoningSelect.append(option);
    }
    const supportsReasoning = Boolean(entry.reasoning) || (Array.isArray(entry.efforts) && entry.efforts.length > 0);
    reasoningSelect.disabled = !supportsReasoning;
    if (!supportsReasoning) {
        reasoningSelect.title = 'This model does not expose reasoning effort';
    }
    reasoningSelect.value = settings().reasoningByEntry?.[key] || 'auto';
    reasoningSelect.addEventListener('change', () => setReasoning(entry, reasoningSelect.value));
    reasoningRow.append(reasoningLabelElement, reasoningSelect);
    details.append(reasoningRow);

    // Actions
    const actions = h('div', 'omtp-details-actions');

    const useButton = actionButton('omtp-use-model', tr('omtp_use_model', 'Use model'), () => useEntry(entry), 'omtp-wide');
    useButton.disabled = entry.available === false;
    actions.append(useButton);

    if (entry.available === false) {
        const warnBox = h('div', 'omtp-unavail-warning-box');
        const state = providerAvailability.get(String(entry.providerId || entry.provider));
        warnBox.textContent = state?.keyInvalid
            ? trf('omtp_provider_key_rejected', '⚠️ The stored key was rejected (${0}). Replace it below.', state.keyInvalidReason || 'auth error')
            : tr('omtp_provider_needs_key', '⚠️ This provider has no API key or login. Add credentials below to use it.');
        details.append(warnBox);
    }

    const favorite = isFavoriteEntry(entry);
    actions.append(actionButton(
        'omtp-fav-toggle',
        favorite ? tr('omtp_unfavorite', 'Unfavorite') : tr('omtp_favorite', 'Favorite'),
        () => toggleFavorite(entry),
        favorite ? 'omtp-on' : '',
    ));

    actions.append(actionButton(
        'omtp-quick-assign',
        tr('omtp_quick_save', 'Save to quick bar'),
        () => armQuickSlot(entry),
        pendingQuickEntry && entryKey(pendingQuickEntry) === entryKey(entry) ? 'omtp-on' : '',
    ));

    const chatBinding = getChatBinding();
    const chatBound = chatBinding?.ref ? sameRef(chatBinding.ref, ref) : false;
    actions.append(actionButton(
        'omtp-bind-chat',
        chatBound ? tr('omtp_unbind_chat', 'Unbind chat') : tr('omtp_bind_chat', 'Bind chat'),
        () => toggleChatBinding(entry),
        chatBound ? 'omtp-on' : '',
    ));

    const characterBinding = getCharacterBinding();
    const characterBound = characterBinding?.ref ? sameRef(characterBinding.ref, ref) : false;
    actions.append(actionButton(
        'omtp-bind-character',
        characterBound ? tr('omtp_unbind_character', 'Unbind character') : tr('omtp_bind_character', 'Bind character'),
        () => toggleCharacterBinding(entry),
        characterBound ? 'omtp-on' : '',
    ));

    actions.append(actionButton('omtp-edit-extra-body', tr('omtp_edit_extra_body', 'Edit extra body'), () => {
        if (typeof extraBody.openExtraBodyEditor !== 'function') {
            throw new Error('Extra body editor is unavailable');
        }
        return extraBody.openExtraBodyEditor(entry);
    }));

    actions.append(actionButton('omtp-provider-settings', tr('omtp_provider_settings', 'Provider settings'), () => openProviderSettings(entry)));

    actions.append(actionButton('omtp-copy-selector', tr('omtp_copy_selector', 'Copy selector'), () => copySelector(entry)));

    details.append(actions);
    renderInHubProviderCard(entry, details);
}

function renderInHubProviderCard(entry, details) {
    const providerId = entry.providerId || entry.provider;
    if (!providerId || entry.kind === 'profile') return;

    const kinds = Array.isArray(entry.authKinds) && entry.authKinds.length
        ? entry.authKinds
        : (entry.authKind ? [entry.authKind] : []);
    if (kinds.includes('none') || kinds.length === 0) {
        return;
    }

    // Credential management lives in the Login tab (omp's `/login`), not in the
    // model details: one place decides how a provider signs in.
    const state = providerAvailability.get(String(providerId));
    const card = h('div', 'omtp-in-hub-provider-card');
    const title = h('div', 'omtp-card-title');
    title.append(h('span', null, `🔑 ${entry.providerLabel || providerId}`));
    const status = h('span', 'omtp-card-status');
    status.textContent = state?.keyInvalid
        ? tr('omtp_credentials_invalid', '🔴 Key rejected')
        : entry.available !== false
            ? tr('omtp_credentials_ready', '🟢 Ready')
            : tr('omtp_credentials_missing', '⚪ Not authorized');
    title.append(status);
    card.append(title);

    const action = h('button', 'menu_button', tr('omtp_open_login', 'Open sign-in'));
    action.type = 'button';
    action.addEventListener('click', () => {
        currentTab = 'providers';
        syncTabs();
        renderProviderList();
        renderList();
        setTimeout(() => {
            const row = document.querySelector(`.omtp-login-row[data-provider="${cssEscape(providerId)}"]`);
            row?.scrollIntoView({ block: 'center' });
            row?.classList.add('omtp-highlight');
            setTimeout(() => row?.classList.remove('omtp-highlight'), 1800);
        }, 200);
    });
    card.append(action);
    details.append(card);
}

/**
 * Persist and apply a reasoning level for an entry.
 * @param {object} entry
 * @param {string} level
 */
function setReasoning(entry, level) {
    const key = entryKey(entry);
    if (typeof engine.applyReasoning === 'function') {
        try {
            engine.applyReasoning(entry, level);
            return;
        } catch (error) {
            console.warn('[omtp] could not apply reasoning effort', error);
        }
    }
    const map = { ...(settings().reasoningByEntry || {}) };
    if (!level) {
        delete map[key];
    } else {
        map[key] = level;
    }
    persist({ reasoningByEntry: map });
}

/* ------------------------------------------------------------------ */
/* Favorites, recents, quick slots                                    */
/* ------------------------------------------------------------------ */

/**
 * Toggle an entry in the favorites list.
 * @param {object} entry
 */
function toggleFavorite(entry) {
    const key = entryKey(entry);
    const ref = refOf(entry);
    const favorites = settings().favorites || [];
    const exists = favorites.some((item) => refKey(item) === key);
    const next = exists
        ? favorites.filter((item) => refKey(item) !== key)
        : [ref, ...favorites].slice(0, MAX_FAVORITES);
    persist({ favorites: next });
    if (isOpen) {
        renderList();
        renderDetails();
    }
}

/**
 * Assign/clear a quick slot for an entry.
 * @param {object} entry
 */
/** @type {object|null} Model waiting to be dropped into a quick slot. */
let pendingQuickEntry = null;

/**
 * Inline status line under the quick bar (replaces the old toast, which
 * covered the list).
 */
function renderQuickHint() {
    const hint = document.getElementById('omtp-quick-hint');
    if (!hint) {
        return;
    }
    if (!pendingQuickEntry) {
        hint.textContent = '';
        hint.hidden = true;
        return;
    }
    hint.hidden = false;
    hint.textContent = trf(
        'omtp_quick_arm_hint',
        'Click a quick slot to place ${0} — right-click clears one.',
        `${pendingQuickEntry.providerLabel || pendingQuickEntry.provider} / ${pendingQuickEntry.model}`,
    );
}
/** Entry key to flash after a jump; re-applied on every render until it expires. */
let highlightKey = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let highlightTimer = null;

/**
 * Keep one row flashed for a moment, even when the switch re-renders the list.
 * @param {string} key
 * @param {number} [ms]
 */
function flashEntryRow(key, ms = 1500) {
    highlightKey = key;
    if (highlightTimer) {
        clearTimeout(highlightTimer);
    }
    highlightTimer = setTimeout(() => {
        highlightKey = null;
        highlightTimer = null;
        document.querySelectorAll('#omtp-model-list .omtp-row-flash').forEach((node) => node.classList.remove('omtp-row-flash'));
    }, ms);
}

/**
 * Arm a model for the next quick-slot click: the bar stays in "place me"
 * mode until a slot is clicked (or the same button is pressed again).
 * @param {object} entry
 */
function armQuickSlot(entry) {
    if (pendingQuickEntry && entryKey(pendingQuickEntry) === entryKey(entry)) {
        pendingQuickEntry = null;
        renderQuickBar();
        renderDetails();
        return;
    }
    pendingQuickEntry = entry;
    renderQuickBar();
    renderDetails();
}



/**
 * Assign an entry to a specific quick slot.
 * @param {number} index 0-based
 * @param {object} entry
 */
function assignQuickSlot(index, entry) {
    if (index < 0 || index >= QUICK_SLOT_COUNT) {
        return;
    }
    const slots = [...(settings().quickSlots || [])];
    while (slots.length < QUICK_SLOT_COUNT) {
        slots.push(null);
    }
    const ref = refOf(entry);
    const key = entryKey(entry);
    for (let i = 0; i < slots.length; i++) {
        if (slots[i] && refKey(slots[i]) === key && i !== index) {
            slots[i] = null;
        }
    }
    slots[index] = ref;
    persist({ quickSlots: slots });
    toast(trf('omtp_quick_assigned', 'Assigned to quick slot ${0}', index + 1), 'success');
    if (isOpen) {
        renderQuickBar();
        renderList();
        renderDetails();
    }
}

/**
 * Clear a quick slot.
 * @param {number} index 0-based
 */
function clearQuickSlot(index) {
    if (index < 0 || index >= QUICK_SLOT_COUNT) {
        return;
    }
    const slots = [...(settings().quickSlots || [])];
    while (slots.length < QUICK_SLOT_COUNT) {
        slots.push(null);
    }
    slots[index] = null;
    persist({ quickSlots: slots });
    toast(trf('omtp_quick_cleared', 'Quick slot ${0} cleared', index + 1), 'info');
    if (isOpen) {
        renderQuickBar();
        renderList();
        renderDetails();
    }
}

/**
 * Switch to the model stored in a quick slot.
 * @param {number} index 0-based
 */
async function useQuickSlot(index) {
    const ref = (settings().quickSlots || [])[index];
    if (!ref) {
        toast(trf('omtp_quick_empty', 'Quick slot ${0} is empty', index + 1), 'info');
        return;
    }
    const entry = resolveRef(ref);
    if (!entry) {
        toast(trf('omtp_binding_unavailable', 'Bound model unavailable: ${0}', `${ref.provider}/${ref.model}`), 'warning');
        return;
    }
    const ok = await useEntry(entry);
    if (ok) {
        focusEntry(entry);
    }
}

/**
 * Move both panes onto an entry: select its provider in the left column and
 * scroll the right-hand list to its row.
 * @param {object} entry
 */
function focusEntry(entry) {
    const pid = String(entry.providerId || entry.provider || '');
    const changedProvider = pid && selectedProvider !== pid;
    if (changedProvider) {
        selectedProvider = pid;
    }
    selectedEntryKey = entryKey(entry);
    if (changedProvider) {
        renderProviderList();
        renderList();
    }
    renderDetails();
    flashEntryRow(selectedEntryKey);
    scrollToEntryRow(selectedEntryKey);
    // The switch lands its own re-render on the next tick.
    setTimeout(() => scrollToEntryRow(selectedEntryKey), 90);
}

/**
 * Scroll the list to an entry row and focus it.
 * @param {string} key
 */
function scrollToEntryRow(key) {
    const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(key)}"]`);
    if (!row) {
        return;
    }
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
}

/**
 * Assign the selected (or current) model to a quick slot via keyboard.
 * @param {number} index 0-based
 */
function assignQuickSlotFromSelection(index) {
    const entry = getSelectedEntry();
    if (!entry) {
        toast(tr('omtp_select_model_first', 'Select a model first'), 'warning');
        return;
    }
    assignQuickSlot(index, entry);
}

/* ------------------------------------------------------------------ */
/* Bindings                                                           */
/* ------------------------------------------------------------------ */

/** @returns {object|null} Chat-only binding (ignores character fallback). */
function getChatBinding() {
    try {
        const binding = chat_metadata?.omtp;
        return binding && typeof binding === 'object' && binding.ref ? binding : null;
    } catch {
        return null;
    }
}

/** @returns {object|null} Binding that applies to the current chat. */
function getEffectiveBinding() {
    try {
        return typeof bindings.getBindingForChat === 'function' ? bindings.getBindingForChat() : null;
    } catch {
        return null;
    }
}

/** @returns {object|null} */
function getCharacterBinding() {
    const avatar = currentAvatar();
    if (!avatar) {
        return null;
    }
    return settings().characterBindings?.[avatar] ?? null;
}

/**
 * Toggle the chat binding for an entry.
 * @param {object} entry
 */
async function toggleChatBinding(entry) {
    const ref = refOf(entry);
    const current = getChatBinding();
    if (current?.ref && sameRef(current.ref, ref)) {
        if (typeof bindings.unbindChat === 'function') {
            await bindings.unbindChat();
        }
        toast(tr('omtp_unbound', 'Binding removed'), 'info');
    } else {
        if (typeof bindings.bindChat !== 'function') {
            throw new Error('Bindings module is unavailable');
        }
        await bindings.bindChat(ref, { reasoningEffort: currentReasoning(entry) });
        toast(trf('omtp_bound_chat', 'Chat bound to ${0}', entry.modelLabel || entry.model), 'success');
    }
    if (isOpen) {
        renderDetails();
    }
}

/**
 * Toggle the character binding for an entry.
 * @param {object} entry
 */
async function toggleCharacterBinding(entry) {
    const ref = refOf(entry);
    const current = getCharacterBinding();
    if (current?.ref && sameRef(current.ref, ref)) {
        if (typeof bindings.unbindCharacter === 'function') {
            await bindings.unbindCharacter();
        }
        toast(tr('omtp_unbound', 'Binding removed'), 'info');
    } else {
        if (typeof bindings.bindCharacter !== 'function') {
            throw new Error('Bindings module is unavailable');
        }
        await bindings.bindCharacter(ref, { reasoningEffort: currentReasoning(entry) });
        toast(trf('omtp_bound_character', 'Character bound to ${0}', entry.modelLabel || entry.model), 'success');
    }
    if (isOpen) {
        renderDetails();
    }
}

/**
 * Reasoning level currently chosen for an entry.
 * @param {object} entry
 * @returns {string}
 */
function currentReasoning(entry) {
    return settings().reasoningByEntry?.[entryKey(entry)] || 'auto';
}

/* ------------------------------------------------------------------ */
/* Switching and provider actions                                     */
/* ------------------------------------------------------------------ */

/**
 * Switch SillyTavern to an entry.
 * @param {object|null} entry
 * @param {{throwOnError?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
async function useEntry(entry, { throwOnError = false } = {}) {
    if (!entry) {
        const error = new Error('Unknown model');
        if (throwOnError) {
            throw error;
        }
        toast(error.message, 'error');
        return false;
    }
    if (entry.available === false) {
        const message = entry.unsupportedReason
            ? trf('omtp_unsupported', 'Not selectable: ${0}', entry.unsupportedReason)
            : tr('omtp_status_unavailable', 'Unavailable');
        if (throwOnError) {
            throw new Error(message);
        }
        toast(message, 'warning');
        return false;
    }
    try {
        await engine.switchToEntry(refOf(entry), { reason: 'hub' });
        selectedEntryKey = entryKey(entry);
        refreshSelectionUI();
        toast(trf('omtp_model_in_use', 'Now using ${0}', `${entry.modelLabel || entry.model} · ${entry.providerLabel || entry.provider}`), 'success');
        if (isOpen) {
            renderList();
            renderDetails();
            renderQuickBar();
        }
        return true;
    } catch (error) {
        const message = error?.message || String(error);
        if (throwOnError) {
            throw error;
        }
        toast(trf('omtp_switch_failed', 'Could not switch model: ${0}', message), 'error');
        return false;
    }
}

/**
 * Open the relevant provider settings for an entry.
 * @param {object} entry
 */
function openProviderSettings(entry) {
    if (entry.kind === 'profile') {
        closeHub();
        toast(tr('omtp_profile_settings', 'Manage this profile in the Connection Profiles extension'), 'info');
        return;
    }
    if (entry.kind === 'st' && entry.nativeAdapter) {
        closeHub();
        const blockSelector = entry.nativeAdapter.settingsBlock;
        const block = blockSelector ? document.querySelector(blockSelector) : null;
        const drawer = document.getElementById('rm_api_block');
        const systemButton = document.getElementById('sys-settings-button');
        if (drawer?.classList.contains('closedDrawer') && systemButton) {
            systemButton.querySelector('.drawer-toggle')?.click();
        }
        if (block) {
            setTimeout(() => {
                block.scrollIntoView({ behavior: 'smooth', block: 'center' });
                block.classList.add('omtp-highlight');
                setTimeout(() => block.classList.remove('omtp-highlight'), 2000);
            }, 150);
        } else {
            toast(tr('omtp_configure_native', 'Configure in SillyTavern'), 'info');
        }
        return;
    }
    focusProviderSettings(entry.provider);
}

/**
 * Focus the OMTP settings provider section for a gateway provider.
 * @param {string} provider
 */
function focusProviderSettings(provider) {
    if (!isOpen) {
        openHub();
    }
    currentTab = 'providers';
    syncTabs();
    renderProviderList();
    renderList();

    let attempts = 0;
    const reveal = () => {
        const row = document.querySelector(`.omtp-login-row[data-provider="${cssEscape(provider)}"]`);
        if (!row) {
            if (attempts++ < 10) {
                setTimeout(reveal, 120);
            } else {
                toast(tr('omtp_configure_native', 'Configure in SillyTavern'), 'info');
            }
            return;
        }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('omtp-highlight');
        setTimeout(() => row.classList.remove('omtp-highlight'), 2000);
        row.querySelector('input')?.focus();
    };
    setTimeout(reveal, 150);
}

/**
 * Copy the selector for an entry to the clipboard.
 * @param {object} entry
 */
async function copySelector(entry) {
    const text = entry.kind === 'omp' ? `${entry.provider}/${entry.model}` : entry.model;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            toast(tr('omtp_copied', 'Selector copied'), 'success');
            return;
        }
        throw new Error('Clipboard unavailable');
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.append(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
            toast(tr('omtp_copied', 'Selector copied'), 'success');
        } catch {
            toast(tr('omtp_copy_failed', 'Could not copy selector'), 'error');
        }
    }
}

/* ------------------------------------------------------------------ */
/* Quick bar, footer, tabs                                            */
/* ------------------------------------------------------------------ */

/**
 * Render the nine quick-switch buttons.
 */
function renderQuickBar() {
    const bar = document.getElementById('omtp-quick-bar');
    if (!bar) {
        return;
    }
    bar.replaceChildren();
    renderQuickHint();
    bar.classList.toggle('omtp-arming', Boolean(pendingQuickEntry));
    const slots = settings().quickSlots || [];
    for (let index = 0; index < QUICK_SLOT_COUNT; index++) {
        const ref = slots[index] || null;
        const entry = ref ? resolveRef(ref) : null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'omtp-quick-slot' + (entry ? '' : ' omtp-empty')
            + (pendingQuickEntry ? ' omtp-quick-drop' : '');
        button.dataset.slot = String(index + 1);
        button.textContent = entry ? (entry.modelLabel || entry.model) : '+';
        button.title = entry
            ? `${entry.providerLabel || entry.provider} / ${entry.model} — ${index + 1}`
            : ref
                ? `Unavailable quick slot ${index + 1}`
                : `Empty quick slot ${index + 1}`;
        button.addEventListener('click', () => {
            // Armed from the model card: this click places the model
            // (overwriting whatever the slot held).
            if (pendingQuickEntry) {
                const target = pendingQuickEntry;
                pendingQuickEntry = null;
                assignQuickSlot(index, target);
                renderDetails();
                return;
            }
            if (!entry) {
                return;
            }
            useQuickSlot(index);
        });
        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            if (ref) {
                clearQuickSlot(index);
            }
        });
        bar.append(button);
    }
}

/**
 * Render the footer: how many providers are unlocked and how many models are
 * usable right now.
 */
function renderFooter() {
    const footer = document.getElementById('omtp-hub-footer');
    if (!footer) {
        return;
    }
    footer.replaceChildren();

    // Count every listed provider, not just the ones that own catalog entries:
    // local runtimes and OAuth plans appear before their first live probe.
    const groups = [...providerGroups.values()];
    const unlockedProviders = groups.filter((group) => group.unlocked).length;
    const unlocked = visibleEntries().filter((entry) => entry.kind !== 'profile' && entry.available !== false);
    // Singular/plural are separate strings so English reads naturally at 1.
    const providerText = unlockedProviders === 1
        ? tr('omtp_footer_provider_one', '1 usable provider')
        : trf('omtp_footer_provider_other', '${0} usable providers', unlockedProviders);
    const modelText = unlocked.length === 1
        ? tr('omtp_footer_model_one', '1 usable model')
        : trf('omtp_footer_model_other', '${0} usable models', unlocked.length);
    const counts = h('span', 'omtp-footer-counts', `${providerText} · ${modelText}`);

    footer.append(counts);
}

/**
 * Mark the active tab.
 */
function syncTabs() {
    document.querySelectorAll('#omtp-tabs .omtp-tab').forEach((tab) => {
        const active = tab.dataset.tab === currentTab;
        tab.classList.toggle('omtp-active', active);
        tab.setAttribute('aria-selected', String(active));
    });
}

/**
 * Re-render everything inside the modal.
 */
function renderAll() {
    if (!modal) {
        return;
    }
    renderProviderList();
    syncTabs();
    renderList();
    renderDetails();
    renderQuickBar();
    renderFooter();
}

/* ------------------------------------------------------------------ */
/* Modal lifecycle                                                    */
/* ------------------------------------------------------------------ */

let gatewayPollTimer = null;

async function updateGatewayPill() {
    const dot = document.getElementById('omtp-gateway-dot');
    const label = document.getElementById('omtp-gateway-label');
    const pill = document.getElementById('omtp-gateway-pill');
    if (!dot || !label || !pill) return;

    try {
        const res = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
            const data = await res.json();
            if (data.gateway?.running || data.gateway?.listening) {
                dot.className = 'omtp-status-dot omtp-dot-online';
                label.textContent = trf('omtp_gateway_online', 'Gateway online (${0})', data.gateway.port);
                pill.title = trf('omtp_gateway_online_hint', 'Local gateway is running (http://127.0.0.1:${0}/v1)', data.gateway.port);
                return;
            }
        }
    } catch {}
    try {
        const healthRes = await fetch('http://127.0.0.1:4100/health', { signal: AbortSignal.timeout(1500) });
        if (healthRes.ok) {
            dot.className = 'omtp-status-dot omtp-dot-online';
            label.textContent = trf('omtp_gateway_online', 'Gateway online (${0})', 4100);
            pill.title = trf('omtp_gateway_online_hint', 'Local gateway is running (http://127.0.0.1:${0}/v1)', 4100);
            return;
        }
    } catch {}

    dot.className = 'omtp-status-dot omtp-dot-offline';
    label.textContent = tr('omtp_gateway_offline', 'Gateway offline');
    pill.title = tr('omtp_gateway_offline_hint', 'Gateway not reachable — click to start it');
}

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

/**
 * Build the modal shell once and return it.
 * @returns {HTMLElement}
 */
function ensureModal() {
    if (modal) {
        return modal;
    }

    const overlay = document.createElement('div');
    overlay.id = 'omtp-hub-overlay';
    overlay.className = 'omtp-hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'omtp-hub-title');

    const hub = document.createElement('div');
    hub.id = 'omtp-hub';

    const header = h('div');
    header.id = 'omtp-hub-header';
    const title = h('h2', null, tr('omtp_hub_title', 'OMTP Model Hub'));
    title.id = 'omtp-hub-title';
    const search = document.createElement('input');
    search.id = 'omtp-search';
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.placeholder = tr('omtp_search_placeholder', 'Search models, providers or provider/model');
    search.setAttribute('aria-label', search.placeholder);
    const close = document.createElement('button');
    close.id = 'omtp-hub-close';
    close.type = 'button';
    close.className = 'menu_button';
    close.textContent = '×';
    close.title = tr('omtp_close', 'Close');
    close.setAttribute('aria-label', close.title);
    const gwPill = h('div', 'omtp-gateway-pill');
    gwPill.id = 'omtp-gateway-pill';
    const gwDot = h('span', 'omtp-status-dot');
    gwDot.id = 'omtp-gateway-dot';
    const gwLabel = h('span', 'omtp-status-label', tr('omtp_gateway_checking', 'Gateway checking…'));
    gwLabel.id = 'omtp-gateway-label';
    gwPill.append(gwDot, gwLabel);
    gwPill.addEventListener('click', onGatewayPillClick);

    header.append(title, gwPill, search, close);

    const quickBar = h('div');
    quickBar.id = 'omtp-quick-bar';
    // Lives beside the bar, not inside it: renderQuickBar() replaces children.
    const quickHint = h('div', 'omtp-quick-hint');
    quickHint.id = 'omtp-quick-hint';
    quickHint.hidden = true;

    const tabs = h('div');
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
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'omtp-tab';
        button.dataset.tab = tab;
        button.setAttribute('role', 'tab');
        button.textContent = tr(key, fallback);
        tabs.append(button);
    }

    // Filters live in one right-aligned group. Order is fixed as
    // [translated names (non-English only)] [scored only] [non-mainstream] so
    // the two always-present boxes keep the same neighbours — and therefore the
    // same screen positions — in every language.
    const filters = h('div', 'omtp-tab-filters');

    // Chinese provider names: only offered where a translated form exists.
    if (supportsProviderNames(document.documentElement.lang)) {
        const namesLabel = h('label', 'omtp-mainstream-toggle');
        const namesBox = document.createElement('input');
        namesBox.type = 'checkbox';
        namesBox.id = 'omtp-provider-names';
        namesBox.checked = settings().ui?.translateProviderNames !== false;
        namesBox.addEventListener('change', () => {
            persist({ ui: { ...(settings().ui || {}), translateProviderNames: namesBox.checked } });
            renderProviderList();
            renderList();
            renderDetails();
            loginPanel.refresh?.();
        });
        namesLabel.append(namesBox, h('span', null, tr('omtp_filter_provider_names', '显示供应商翻译名')));
        namesLabel.title = tr('omtp_filter_provider_names_hint', 'Translated names only where an official Chinese name exists; regions are always translated');
        filters.append(namesLabel);
    }

    const scoredLabel = h('label', 'omtp-mainstream-toggle');
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
    scoredLabel.append(scoredBox, h('span', null, tr('omtp_filter_scored', '仅显示有评分的模型')));
    scoredLabel.title = tr('omtp_filter_scored_hint', 'Only models that have AA-PersonalityBench data');
    filters.append(scoredLabel);

    const mainstreamLabel = h('label', 'omtp-mainstream-toggle');
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
    mainstreamLabel.append(mainstreamBox, h('span', null, tr('omtp_filter_mainstream', '显示非主流供应商')));
    mainstreamLabel.title = tr('omtp_filter_mainstream_hint', 'Uncheck to keep only first-party labs, major platforms and local runtimes');
    filters.append(mainstreamLabel);

    tabs.append(filters);

    const body = h('div');
    body.id = 'omtp-hub-body';
    const providerList = h('aside');
    providerList.id = 'omtp-provider-list';
    providerList.setAttribute('aria-label', 'Providers');
    const pane = h('section', 'omtp-model-pane');
    const modelList = h('div');
    modelList.id = 'omtp-model-list';
    modelList.setAttribute('role', 'listbox');
    modelList.setAttribute('aria-label', 'Models');
    const manager = h('div', 'omtp-provider-manager');
    manager.id = 'omtp-provider-manager';
    manager.hidden = true;
    pane.append(modelList, manager);
    const details = h('aside');
    details.id = 'omtp-details';
    body.append(providerList, pane, details);

    const footer = h('footer');
    footer.id = 'omtp-hub-footer';

    hub.append(header, quickBar, quickHint, tabs, body, footer);
    overlay.append(hub);
    document.body.append(overlay);

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
        currentTab = button.dataset.tab || 'all';
        syncTabs();
        renderProviderList();
        renderList();
    });

    modal = overlay;
    return overlay;
}

/**
 * Remove the modal from the DOM.
 */
function destroyModal() {
    modal?.remove();
    modal = null;
}

/**
 * Handle search input with a 120 ms debounce.
 */
function onSearchInput() {
    clearTimeout(searchTimer);
    const input = document.getElementById('omtp-search');
    searchTimer = setTimeout(() => {
        searchTimer = null;
        searchQuery = input?.value ?? '';
        selectedEntryKey = null;
        if (currentTab === 'providers') {
            // The sign-in tab filters its roster; the provider column mirrors
            // the same query over the provider index.
            loginPanel.setLoginFilter?.(searchQuery);
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
    if (isCleaningUp || !initialized) {
        return;
    }
    if (isOpen) {
        if (requestedTab) {
            showTab(requestedTab);
        }
        return;
    }
    if (requestedTab) {
        currentTab = requestedTab;
    }
    ensureModal();
    previousFocus = document.activeElement;
    modal.classList.remove('omtp-hidden');
    isOpen = true;
    if (!catalogLoaded) {
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
    if (!gatewayPollTimer) {
        gatewayPollTimer = setInterval(updateGatewayPill, 10000);
    }
    const search = document.getElementById('omtp-search');
    if (search) {
        search.value = searchQuery;
        setTimeout(() => search.focus(), 0);
    }
}

/**
 * Switch the open hub to a tab (no-op when closed).
 * @param {string} tab
 */
/**
 * SillyTavern reports "no connection" until an API call succeeds, which made a
 * page reload look disconnected even though the gateway was fine. Probe it once
 * on startup and tell SillyTavern the truth.
 */
async function syncGatewayOnlineStatus() {
    if (isCleaningUp) {
        return;
    }
    let gatewayMode = false;
    try {
        gatewayMode = Boolean(engine.isGatewayMode?.());
    } catch {
        gatewayMode = false;
    }
    if (!gatewayMode) {
        return;
    }
    try {
        const status = await engine.getGatewayStatus?.({ force: true });
        if (status?.running) {
            setOnlineStatus(tr('omtp_status_connected', 'Connected'));
        }
    } catch {
        // Leave SillyTavern's own indicator alone when the probe fails.
    }
}

export function showTab(tab) {
    if (!isOpen || !tab) {
        return;
    }
    currentTab = tab;
    syncTabs();
    renderProviderList();
    renderList();
}

/**
 * Close the hub modal.
 */
export function closeHub() {
    if (!modal) {
        return;
    }
    modal.classList.add('omtp-hidden');
    isOpen = false;
    if (gatewayPollTimer) {
        clearInterval(gatewayPollTimer);
        gatewayPollTimer = null;
    }
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        try {
            previousFocus.focus();
        } catch {
            // ignore
        }
    }
    previousFocus = null;
}

/**
 * Toggle the hub modal.
 */
export function toggleHub() {
    if (isOpen) {
        closeHub();
    } else {
        openHub();
    }
}

/* ------------------------------------------------------------------ */
/* Keyboard handling                                                  */
/* ------------------------------------------------------------------ */

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
function handleGlobalKeydown(event) {
    if (isCleaningUp || Popup.util?.isPopupOpen?.()) {
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
        if (!rowEntries.length) {
            return;
        }
        event.preventDefault();
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (event.key === 'Enter') {
        if (!rowEntries.length) {
            return;
        }
        event.preventDefault();
        const entry = rowEntries.find((item) => entryKey(item) === selectedEntryKey) || rowEntries[0];
        useEntry(entry);
        return;
    }
    if (String(event.key).toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target)) {
        const entry = rowEntries.find((item) => entryKey(item) === selectedEntryKey) || getSelectedEntry();
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
    if (!rowEntries.length) {
        return;
    }
    const currentIndex = rowEntries.findIndex((entry) => entryKey(entry) === selectedEntryKey);
    let next = currentIndex < 0 ? 0 : currentIndex + delta;
    next = Math.max(0, Math.min(rowEntries.length - 1, next));
    const entry = rowEntries[next];
    selectedEntryKey = entryKey(entry);
    highlightSelectedRow();
    renderDetails();
    const row = document.querySelector(`#omtp-model-list .omtp-model-row[data-key="${cssEscape(selectedEntryKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
}

/**
 * Keep Tab focus inside the dialog.
 * @param {KeyboardEvent} event
 */
function trapFocus(event) {
    if (!modal) {
        return;
    }
    const focusable = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.disabled && (element.offsetParent !== null || element === document.activeElement));
    if (!focusable.length) {
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}

/* ------------------------------------------------------------------ */
/* Selection display                                                  */
/* ------------------------------------------------------------------ */

/**
 * Refresh the top-bar title (and details if open) from the current selection.
 */
export function refreshSelectionUI() {
    if (isCleaningUp) {
        return;
    }
    const ref = getCurrentRef();
    const entry = resolveRef(ref);
    let label = '';
    if (entry) {
        label = `${entry.modelLabel || entry.model} (${entry.providerLabel || entry.provider})`;
        if (entry.kind === 'omp') {
            label = `${label} · OMTP`;
        } else if (entry.kind === 'profile') {
            label = `${label} · Profile`;
        }
    } else if (ref) {
        label = `${ref.provider}/${ref.model}`;
    }
    const binding = getEffectiveBinding();
    if (binding?.ref) {
        label = `${label} ⛓`.trim();
    }
    updateTopBarTitle(label);
    if (isOpen) {
        renderDetails();
    }
}

/**
 * Rebuild entries and refresh the hub. Called by events.js after catalog
 * refreshes and by the public API.
 * @param {{reload?: boolean}} [options]
 */
export async function refreshHub(options = {}) {
    if (!initialized || isCleaningUp) {
        return;
    }
    await loadProviderAvailability();
    if (options.reload) {
        await loadCatalogOnce(true);
    } else {
        try {
            catalogApi.invalidateNativeCache?.();
        } catch (error) {
            console.warn('[omtp] could not invalidate native availability cache', error);
        }
        rebuildEntries();
    }
    refreshSelectionUI();
}

/**
 * The current selection as an EntryRef (null when unknown).
 * @returns {object|null}
 */
export function getCurrentSelection() {
    return getCurrentRef();
}

/**
 * Public-API switch entry point. Accepts an EntryRef or a selector string.
 * @param {object|string} selectorOrRef
 * @returns {Promise<boolean>}
 */
export async function switchTo(selectorOrRef) {
    const ref = selectorOrRef;
    if (typeof selectorOrRef === 'string') {
        const current = settings();
        const result = resolveSelector(selectorOrRef, entries, {
            quickSlots: current.quickSlots,
            favorites: current.favorites,
            recents: current.recents,
        });
        if (result?.error) {
            throw new Error(result.error);
        }
        if (!result?.entry) {
            throw new Error(`Unknown model: ${selectorOrRef}`);
        }
        if (result.level) {
            try {
                engine.applyReasoning(result.entry, result.level);
            } catch (error) {
                console.warn('[omtp] could not apply reasoning effort', error);
            }
        }
        return useEntry(result.entry, { throwOnError: true });
    }
    if (!ref || typeof ref !== 'object') {
        throw new Error('Invalid selection');
    }
    const entry = resolveRef(ref);
    if (!entry) {
        throw new Error(`Unknown model: ${ref.provider}/${ref.model}`);
    }
    return useEntry(entry, { throwOnError: true });
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to SillyTavern/public events owned by this module.
 */
function registerHubEvents() {
    if (!eventSource?.on) {
        return;
    }
    const add = (name, handler) => {
        try {
            eventSource.on(name, handler);
            hubEventListeners.push([name, handler]);
        } catch (error) {
            console.warn(`[omtp] could not subscribe to ${name}`, error);
        }
    };
    add(EVENTS.SELECTION_CHANGED, onSelectionChanged);
    add(EVENTS.CATALOG_CHANGED, onCatalogChanged);
    add(ST_EVENTS.CHAT_CHANGED, onChatContextChanged);
    add(ST_EVENTS.GENERATION_ENDED, () => usageChip.scheduleUsageChipRefresh());
    add(ST_EVENTS.APP_READY, onAppReady);
}

/**
 * Remove module-owned event subscriptions.
 */
function cleanupHubEvents() {
    for (const [name, handler] of hubEventListeners.splice(0)) {
        try {
            if (typeof eventSource.removeListener === 'function') {
                eventSource.removeListener(name, handler);
            } else if (typeof eventSource.off === 'function') {
                eventSource.off(name, handler);
            }
        } catch {
            // ignore
        }
    }
}

function onSelectionChanged() {
    if (isCleaningUp) {
        return;
    }
    refreshSelectionUI();
    if (isOpen) {
        renderDetails();
    }
}

function onCatalogChanged() {
    if (isCleaningUp) {
        return;
    }
    rebuildEntries();
}

function onChatContextChanged(chatId) {
    if (isCleaningUp) {
        return;
    }
    selectedEntryKey = null;
    try {
        // Keep the gateway header in step so usage is attributed to this chat.
        engine.syncChatHeader?.(chatId);
    } catch {
        // Header sync is best-effort.
    }
    usagePanel.resetUsageSession?.(chatId);
    usageChip.refreshUsageChip?.({ force: true, chatId }).catch(() => {});
    refreshSelectionUI();
    if (isOpen) {
        renderList();
        renderDetails();
    }
}

function onAppReady() {
    syncGatewayOnlineStatus().catch(() => {});
    try {
        engine.syncChatHeader?.();
    } catch {
        // best-effort
    }
    if (isCleaningUp) {
        return;
    }
    if (!catalogLoaded) {
        loadCatalogOnce();
    }
    refreshSelectionUI();
}

/* ------------------------------------------------------------------ */
/* Settings panel                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch settings.html, sanitize it and append it to the extensions settings
 * column. Returns the #omtp-settings container.
 * @returns {Promise<HTMLElement|null>}
 */
async function injectSettingsHtml() {
    const existing = document.getElementById('omtp-settings');
    if (existing) {
        return existing;
    }
    const holder = document.getElementById('extensions_settings2');
    if (!holder) {
        console.warn('[omtp] #extensions_settings2 not found; settings panel not injected');
        return null;
    }
    const response = await fetch(new URL('../../settings.html', import.meta.url));
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    if (isCleaningUp || !initialized) {
        return null;
    }
    const sanitized = DOMPurify.sanitize(html);
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    const container = template.content.querySelector('#omtp-settings');
    if (!container) {
        throw new Error('settings.html does not contain #omtp-settings');
    }
    holder.append(container);
    return container;
}

/**
 * Initialize the settings and bindings panels once the container exists.
 */
async function initSettingsPanel() {
    try {
        const container = await injectSettingsHtml();
        if (!container) {
            return;
        }
        try {
            const result = settingsUi.initSettingsUI?.(container);
            if (result?.catch) {
                result.catch((error) => console.warn('[omtp] settings UI init failed', error));
            }
        } catch (error) {
            console.warn('[omtp] settings UI init failed', error);
        }
        try {
            const result = bindings.initBindingUI?.(container);
            if (result?.catch) {
                result.catch((error) => console.warn('[omtp] bindings UI init failed', error));
            }
        } catch (error) {
            console.warn('[omtp] bindings UI init failed', error);
        }
    } catch (error) {
        console.warn('[omtp] could not inject settings panel', error);
    }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/**
 * Toggle the native API selector from the API drawer shortcut.
 */
function onShowNativeSelector() {
    try {
        const next = !settings().hideNativeSelector;
        persist({ hideNativeSelector: next });
        applyNativeSelectorVisibility({ ...settings(), hideNativeSelector: next });
        injectApiDrawerTools({ onOpen: openHub, onShowNative: onShowNativeSelector });
        settingsUi.refreshSettingsUI?.();
    } catch (error) {
        console.warn('[omtp] could not toggle native selector', error);
    }
}

/**
 * Extension activation hook. Must finish quickly: heavy work is scheduled.
 */
/**
 * Point the welcome prompt's "API Connections" button at the hub.
 *
 * SillyTavern renders `welcomePrompt.html` for every new welcome message, so we
 * patch each instance as it appears and remember the original markup to restore
 * it on cleanup.
 * @type {{button: HTMLElement, html: string}[]}
 */
const patchedWelcomeButtons = [];
/** @type {MutationObserver|null} */
let welcomeObserver = null;

function wireWelcomeApiButton() {
    const patch = () => {
        const button = document.querySelector(
            '.custom-flex-container > button.drawer-opener[data-target="sys-settings-button"]:not([data-omtp-welcome])',
        );
        if (!button) {
            return;
        }
        button.dataset.omtpWelcome = '1';
        patchedWelcomeButtons.push({ button, html: button.innerHTML, target: button.dataset.target, className: button.className });
        button.classList.remove('drawer-opener');
        delete button.dataset.target;
        button.title = tr('omtp_open_hub_hint', 'Open the OMTP model hub');
        const icon = button.querySelector('i');
        if (icon) {
            icon.className = 'fa-solid fa-layer-group';
        }
        const label = button.querySelector('span');
        if (label) {
            label.textContent = tr('omtp_open_hub', 'OMTP Model Hub');
            label.removeAttribute('data-i18n');
        }
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openHub();
        });
    };

    patch();
    if (welcomeObserver || typeof MutationObserver !== 'function') {
        return;
    }
    welcomeObserver = new MutationObserver(patch);
    welcomeObserver.observe(document.getElementById('chat') || document.body, { childList: true, subtree: true });
}

/** Restore the welcome prompt buttons we rewrote. */
function unwireWelcomeApiButton() {
    welcomeObserver?.disconnect();
    welcomeObserver = null;
    for (const { button, html, target, className } of patchedWelcomeButtons.splice(0)) {
        if (!button.isConnected) {
            continue;
        }
        button.innerHTML = html;
        button.className = className;
        if (target) {
            button.dataset.target = target;
        }
        delete button.dataset.omtpWelcome;
        button.removeAttribute('title');
    }
}

export async function init() {
    if (initialized) {
        return;
    }
    initialized = true;
    isCleaningUp = false;
    try {
        store.loadSettings();
    } catch (error) {
        console.warn('[omtp] could not load settings', error);
    }

    try {
        injectTopBarButton({ onOpen: openHub });
        usageChip.mountUsageChip({ onOpen: openHub });
        wireWelcomeApiButton();
        injectApiDrawerTools({ onOpen: openHub, onShowNative: onShowNativeSelector });
        applyNativeSelectorVisibility(settings());
        setGlobalHotkeyHandler(handleGlobalKeydown);
    } catch (error) {
        console.warn('[omtp] DOM injection failed', error);
    }

    registerHubEvents();

    try {
        const result = bindings.initBindings?.();
        if (result?.catch) {
            result.catch((error) => console.warn('[omtp] bindings init failed', error));
        }
    } catch (error) {
        console.warn('[omtp] bindings init failed', error);
    }

    try {
        const result = extraBody.initExtraBody?.();
        if (result?.catch) {
            result.catch((error) => console.warn('[omtp] extra body init failed', error));
        }
    } catch (error) {
        console.warn('[omtp] extra body init failed', error);
    }

    try {
        const result = events.initEvents?.();
        if (result?.catch) {
            result.catch((error) => console.warn('[omtp] events init failed', error));
        }
    } catch (error) {
        console.warn('[omtp] events init failed', error);
    }

    try {
        const result = publicApi.initPublicApi?.({
            version: '0.1.0',
            open: openHub,
            close: closeHub,
            toggle: toggleHub,
            refreshHub,
            refreshSelectionUI,
            getCurrentSelection,
            switchTo,
        });
        if (result?.catch) {
            result.catch((error) => console.warn('[omtp] public API init failed', error));
        }
    } catch (error) {
        console.warn('[omtp] public API init failed', error);
    }

    try {
        initSlashCommands({ open: openHub });
    } catch (error) {
        console.warn('[omtp] slash command registration failed', error);
    }

    // Do not await: activation must stay under the extension hook budget.
    initSettingsPanel().catch((error) => console.warn('[omtp] settings panel init failed', error));
    loadProviderAvailability().catch(() => {});
    loadCatalogOnce().catch((error) => console.warn('[omtp] catalog init failed', error));
    refreshSelectionUI();
}

/**
 * Shared teardown for disable/clean/delete.
 */
async function teardown() {
    if (isCleaningUp) {
        return;
    }
    isCleaningUp = true;
    try {
        let gatewayMode = false;
        try {
            gatewayMode = Boolean(engine.isGatewayMode?.());
        } catch {
            gatewayMode = false;
        }
        if (gatewayMode) {
            const current = settings();
            const snapshot = current.lastNativeSelection || current.gateway?.savedCustom || null;
            if (snapshot) {
                try {
                    await engine.restoreSelection?.(snapshot, { fast: true });
                } catch (error) {
                    console.warn('[omtp] could not restore native selection', error);
                }
            }
        }
        if (settings().gateway?.savedCustom) {
            try {
                await engine.restoreSelection?.(settings().gateway.savedCustom, { fast: true });
            } catch (error) {
                console.warn('[omtp] could not restore custom source state', error);
            }
            const current = settings();
            persist({ gateway: { ...(current.gateway || {}), savedCustom: null } });
        }
    } finally {
        if (searchTimer) {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        try {
            events.cleanupEvents?.();
        } catch (error) {
            console.warn('[omtp] events cleanup failed', error);
        }
        try {
            teardownSlashCommands();
        } catch (error) {
            console.warn('[omtp] slash command cleanup failed', error);
        }
        try {
            publicApi.cleanupPublicApi?.();
        } catch (error) {
            console.warn('[omtp] public API cleanup failed', error);
        }
        cleanupHubEvents();
        closeHub();
        destroyModal();
        try {
            usageChip.disposeUsageChip();
            unwireWelcomeApiButton();
        } catch (error) {
            console.warn('[omtp] welcome button restore failed', error);
        }
        cleanupDom();
        rowEntries = [];
        selectedEntryKey = null;
        selectedProvider = null;
        searchQuery = '';
        catalogLoading = null;
        catalogLoaded = false;
        initialized = false;
        isCleaningUp = false;
    }
}

/** Extension disable hook. */
export async function disable() {
    await teardown();
}

/** Extension clean hook (settings reset / cleanup). */
export async function clean() {
    await teardown();
}

/** Extension delete hook. */
export async function onDelete() {
    await teardown();
}
