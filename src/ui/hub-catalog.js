/**
 * Catalog loading, entry registry and provider grouping for the hub.
 */
import { getRequestHeaders } from '../../../../../../script.js';
import { Fuse } from '../../../../../../lib.js';
import * as catalogApi from '../catalog.js';
import * as engine from '../switch-engine.js';
import { loadPersonality, personalityFor } from '../personality.js';
import { providerDisplayName, supportsProviderNames } from '../provider-names.js';
import { LAB_PROVIDERS, MAINSTREAM_PROVIDERS } from '../constants.js';
import { state } from './hub-state.js';
import { entryKey, refKey, settings } from './hub-utils.js';
import { refreshSelectionUI, renderAll } from './hub-quick.js';

/**
 * Load the catalog through catalog.js, or force a re-fetch when asked.
 * @param {boolean} [force]
 * @returns {Promise<object[]>}
 */
export async function loadCatalogOnce(force = false) {
    if (state.catalogLoading && !force) {
        return state.catalogLoading;
    }
    state.catalogLoading = (async () => {
        try {
            if (force) {
                await catalogApi.loadCatalog({ force: true });
            } else {
                await catalogApi.initCatalog();
            }
            state.catalogLoaded = true;
        } catch (error) {
            console.warn('[omtp] catalog load failed', error);
        }
        await loadProviderAvailability();
        // AA-PersonalityBench snapshot: optional, the hub works without it.
        await loadPersonality().catch(() => null);
        rebuildEntries();
        return state.entries;
    })();
    return state.catalogLoading;
}

/**
 * Load gateway provider availability so keyless gateway rows are visibly
 * unavailable before a switch is attempted.
 */
export async function loadProviderAvailability() {
    try {
        const response = await fetch('/api/plugins/omtp/providers', {
            headers: getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const list = Array.isArray(data?.providers) ? data.providers : [];
        state.providerAvailability = new Map(list.map((provider) => [String(provider.id), provider]));
        catalogApi.setProviderAvailability(state.providerAvailability);
    } catch {
        state.providerAvailability = new Map();
    }
}

/**
 * Rebuild the local entry list from the catalog module and refresh the UI.
 */
export function rebuildEntries() {
    if (!state.initialized || state.isCleaningUp) {
        return;
    }
    let list = [];
    try {
        list = catalogApi.getEntries() ?? [];
    } catch (error) {
        console.warn('[omtp] getEntries failed', error);
    }
    state.entries = Array.isArray(list) ? list.filter(Boolean).map((entry) => {
        const next = {
            ...entry,
            key: entry.key || `${entry.kind}/${entry.provider}/${entry.model}`,
        };
        return catalogApi.withProviderAvailability(next);
    }) : [];
    rebuildFuse();
    if (state.isOpen) {
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
        state.fuse = list.length
            ? new Fuse(list, {
                keys: ['model', 'modelLabel', 'providerLabel', 'provider'],
                threshold: 0.35,
                ignoreLocation: true,
            })
            : null;
    } catch (error) {
        console.warn('[omtp] could not build search index', error);
        state.fuse = null;
    }
}

/**
 * Entries currently allowed to appear in the hub. Gateway (OMP) entries are
 * first-class: every catalog provider is listed, and credentials only decide
 * whether its models are selectable.
 * @returns {object[]}
 */
export function visibleEntries() {
    return state.entries;
}

/** @returns {boolean} Whether provider names should use their Chinese form. */
function showProviderNames() {
    if (!supportsProviderNames(document.documentElement.lang)) {
        return false;
    }
    return settings().ui?.translateProviderNames !== false;
}

/** @param {string} providerId @param {string} label */
export function providerLabel(providerId, label) {
    return providerDisplayName(providerId, label, showProviderNames());
}

/** @returns {boolean} Whether the "hide non-mainstream" filter is on. */
export function mainstreamOnly() {
    return settings().ui?.mainstreamOnly === true;
}

/** @returns {boolean} Whether the "only models with scores" filter is on. */
export function scoredOnly() {
    return settings().ui?.scoredOnly === true;
}

/** @param {string} providerId */
export function isMainstreamProvider(providerId) {
    return MAINSTREAM_PROVIDERS.has(String(providerId || ''));
}

/**
 * Entries after the mainstream filter. A provider the user opened explicitly
 * is always shown, so the filter never makes a chosen provider look empty.
 * @returns {object[]}
 */
export function filteredEntries() {
    if (state.selectedProvider) {
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
export function resolveRef(ref) {
    if (!ref) {
        return null;
    }
    // The local list already carries live provider availability; the catalog
    // module's copy is the raw, optimistic one.
    const key = refKey(ref);
    const local = state.entries.find((entry) => entryKey(entry) === key);
    if (local) {
        return local;
    }
    try {
        const resolved = catalogApi.resolveEntry(ref);
        if (resolved) {
            return catalogApi.withProviderAvailability(resolved);
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
export function getCurrentRef() {
    try {
        const snapshot = engine.captureSelection();
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
export function getSelectedEntry() {
    if (state.selectedEntryKey) {
        const found = state.entries.find((entry) => entryKey(entry) === state.selectedEntryKey);
        if (found) {
            return found;
        }
    }
    return resolveRef(getCurrentRef());
}

/**
 * Create a provider group from a gateway availability record.
 * @param {string} id
 * @param {string} [label]
 * @param {{available?: boolean, keyInvalid?: boolean, keyInvalidReason?: string|null}} [status]
 * @returns {object}
 */
export function providerGroupFromStatus(id, label, status) {
    return {
        id,
        label: label || id,
        count: 0,
        availableCount: 0,
        unlocked: status?.available === true,
        invalid: Boolean(status?.keyInvalid),
        reason: status?.keyInvalidReason || null,
    };
}

/**
 * Split provider groups into usable, rejected-key and credential-less buckets,
 * each sorted by provider id.
 * @param {any[]} groups
 * @returns {{unlocked: any[], invalid: any[], locked: any[]}}
 */
export function partitionProviders(groups) {
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));
    return {
        unlocked: groups.filter((group) => group.unlocked).sort(byId),
        invalid: groups.filter((group) => !group.unlocked && group.invalid).sort(byId),
        locked: groups.filter((group) => !group.unlocked && !group.invalid).sort(byId),
    };
}

/**
 * Group catalog entries into unlocked (has usable credentials), invalid (the
 * stored key was rejected) and locked (needs login/key) providers, each bucket
 * sorted by provider id.
 * @param {object[]} list
 * @returns {{unlocked: object[], invalid: object[], locked: object[], allMap: Map<string, object>}}
 */
export function buildProviderGroups(list) {
    const map = new Map();
    for (const entry of list) {
        if (entry.kind === 'profile') continue;
        const pid = entry.providerId || entry.provider;
        const providerStatus = state.providerAvailability.get(String(pid));
        let group = map.get(pid);
        if (!group) {
            group = {
                ...providerGroupFromStatus(pid, entry.providerLabel, providerStatus),
                unlocked: false,
            };
            map.set(pid, group);
        }
        group.count += 1;
        if (entry.available !== false) {
            group.availableCount += 1;
            group.unlocked = true;
        }
        if (providerStatus?.keyInvalid) {
            group.invalid = true;
            group.reason = providerStatus.keyInvalidReason || null;
        }
    }
    // Usable first, then providers whose stored key the upstream rejected,
    // then everything without credentials.
    return { ...partitionProviders([...map.values()]), allMap: map };
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
export function sidebarSections(unlocked, invalid, locked) {
    const ordered = [...unlocked, ...invalid, ...locked];
    const labs = ordered.filter(isLabGroup);
    const rest = ordered.filter((group) => !isLabGroup(group));
    return [labs, rest].filter((section) => section.length > 0);
}
