/**
 * Quick bar, footer, tab sync and the hub-wide refresh entry points.
 */
import { QUICK_SLOT_COUNT } from '../constants.js';
import * as catalogApi from '../catalog.js';
import { tr, trf, updateTopBarTitle } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import {
    cssEscape,
    entryKey,
    persist,
    refKey,
    refOf,
    settings,
    toast,
} from './hub-utils.js';
import {
    getCurrentRef,
    getSelectedEntry,
    loadCatalogOnce,
    loadProviderAvailability,
    rebuildEntries,
    resolveRef,
    visibleEntries,
} from './hub-catalog.js';
import { renderDetails } from './hub-details.js';
import { renderList } from './hub-list.js';
import { renderProviderList } from './hub-sidebar.js';
import { getEffectiveBinding, useEntry } from './hub-actions.js';

/**
 * Inline status line under the quick bar (replaces the old toast, which
 * covered the list).
 */
function renderQuickHint() {
    const hint = document.getElementById('omtp-quick-hint');
    if (!hint) {
        return;
    }
    if (!state.pendingQuickEntry) {
        hint.textContent = '';
        hint.hidden = true;
        return;
    }
    hint.hidden = false;
    hint.textContent = trf(
        'omtp_quick_arm_hint',
        'Click a quick slot to place ${0} — right-click clears one.',
        `${state.pendingQuickEntry.providerLabel || state.pendingQuickEntry.provider} / ${state.pendingQuickEntry.model}`,
    );
}

/**
 * Keep one row flashed for a moment, even when the switch re-renders the list.
 * @param {string} key
 * @param {number} [ms]
 */
function flashEntryRow(key, ms = 1500) {
    state.highlightKey = key;
    clearTimeout(state.highlightTimer);
    state.highlightTimer = setTimeout(() => {
        state.highlightKey = null;
        state.highlightTimer = null;
        document.querySelectorAll('#omtp-model-list .omtp-row-flash').forEach((node) => node.classList.remove('omtp-row-flash'));
    }, ms);
}

/**
 * Arm a model for the next quick-slot click: the bar stays in "place me"
 * mode until a slot is clicked (or the same button is pressed again).
 * @param {object} entry
 */
export function armQuickSlot(entry) {
    if (state.pendingQuickEntry && entryKey(state.pendingQuickEntry) === entryKey(entry)) {
        state.pendingQuickEntry = null;
        renderQuickBar();
        renderDetails();
        return;
    }
    state.pendingQuickEntry = entry;
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
    if (state.isOpen) {
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
    if (state.isOpen) {
        renderQuickBar();
        renderList();
        renderDetails();
    }
}

/**
 * Switch to the model stored in a quick slot.
 * @param {number} index 0-based
 */
export async function useQuickSlot(index) {
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
    const changedProvider = pid && state.selectedProvider !== pid;
    if (changedProvider) {
        state.selectedProvider = pid;
    }
    state.selectedEntryKey = entryKey(entry);
    if (changedProvider) {
        renderProviderList();
        renderList();
    }
    renderDetails();
    flashEntryRow(state.selectedEntryKey);
    scrollToEntryRow(state.selectedEntryKey);
    // The switch lands its own re-render on the next tick.
    setTimeout(() => scrollToEntryRow(state.selectedEntryKey), 90);
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
export function assignQuickSlotFromSelection(index) {
    const entry = getSelectedEntry();
    if (!entry) {
        toast(tr('omtp_select_model_first', 'Select a model first'), 'warning');
        return;
    }
    assignQuickSlot(index, entry);
}

/** @param {object|null} entry @param {object|null} ref @param {number} index */
function quickSlotTitle(entry, ref, index) {
    const position = index + 1;
    if (entry) {
        return `${entry.providerLabel || entry.provider} / ${entry.model} — ${position}`;
    }
    if (ref) {
        return `Unavailable quick slot ${position}`;
    }
    return `Empty quick slot ${position}`;
}

/**
 * Render the nine quick-switch buttons.
 */
export function renderQuickBar() {
    const bar = document.getElementById('omtp-quick-bar');
    if (!bar) {
        return;
    }
    bar.replaceChildren();
    renderQuickHint();
    bar.classList.toggle('omtp-arming', Boolean(state.pendingQuickEntry));
    const slots = settings().quickSlots || [];
    for (let index = 0; index < QUICK_SLOT_COUNT; index++) {
        const ref = slots[index] || null;
        const entry = ref ? resolveRef(ref) : null;
        const button = el('button', 'omtp-quick-slot' + (entry ? '' : ' omtp-empty')
            + (state.pendingQuickEntry ? ' omtp-quick-drop' : ''));
        button.type = 'button';
        button.dataset.slot = String(index + 1);
        button.textContent = entry ? (entry.modelLabel || entry.model) : '+';
        button.title = quickSlotTitle(entry, ref, index);
        button.addEventListener('click', () => {
            // Armed from the model card: this click places the model
            // (overwriting whatever the slot held).
            if (state.pendingQuickEntry) {
                const target = state.pendingQuickEntry;
                state.pendingQuickEntry = null;
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
export function renderFooter() {
    const footer = document.getElementById('omtp-hub-footer');
    if (!footer) {
        return;
    }
    footer.replaceChildren();

    // Count every listed provider, not just the ones that own catalog entries:
    // local runtimes and OAuth plans appear before their first live probe.
    const groups = [...state.providerGroups.values()];
    const unlockedProviders = groups.filter((group) => group.unlocked).length;
    const unlocked = visibleEntries().filter((entry) => entry.kind !== 'profile' && entry.available !== false);
    // Singular/plural are separate strings so English reads naturally at 1.
    const providerText = unlockedProviders === 1
        ? tr('omtp_footer_provider_one', '1 usable provider')
        : trf('omtp_footer_provider_other', '${0} usable providers', unlockedProviders);
    const modelText = unlocked.length === 1
        ? tr('omtp_footer_model_one', '1 usable model')
        : trf('omtp_footer_model_other', '${0} usable models', unlocked.length);
    footer.append(el('span', 'omtp-footer-counts', `${providerText} · ${modelText}`));
}

/**
 * Mark the active tab.
 */
export function syncTabs() {
    document.querySelectorAll('#omtp-tabs .omtp-tab').forEach((tab) => {
        const active = tab.dataset.tab === state.currentTab;
        tab.classList.toggle('omtp-active', active);
        tab.setAttribute('aria-selected', String(active));
    });
}

/**
 * Re-render everything inside the modal.
 */
export function renderAll() {
    if (!state.modal) {
        return;
    }
    renderProviderList();
    syncTabs();
    renderList();
    renderDetails();
    renderQuickBar();
    renderFooter();
}

/**
 * Refresh the top-bar title (and details if open) from the current selection.
 */
export function refreshSelectionUI() {
    if (state.isCleaningUp) {
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
    if (state.isOpen) {
        renderDetails();
    }
}

/**
 * Rebuild entries and refresh the hub. Called by events.js after catalog
 * refreshes and by the public API.
 * @param {{reload?: boolean}} [options]
 */
export async function refreshHub(options = {}) {
    if (!state.initialized || state.isCleaningUp) {
        return;
    }
    await loadProviderAvailability();
    if (options.reload) {
        await loadCatalogOnce(true);
    } else {
        try {
            catalogApi.invalidateNativeCache();
        } catch (error) {
            console.warn('[omtp] could not invalidate native availability cache', error);
        }
        rebuildEntries();
    }
    refreshSelectionUI();
}
