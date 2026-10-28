/**
 * OMTP Model Hub — lifecycle facade.
 *
 * The extension entry point (index.js) re-exports init/disable/clean/onDelete
 * from this module. The UI itself lives in the sibling hub-*.js modules; this
 * file owns the extension hooks, the settings-panel injection, the SillyTavern
 * event wiring and the public re-exports used by events.js and public-api.js.
 *
 * It never edits SillyTavern core files and never mutates native <select>
 * option lists.
 */
import { eventSource } from '../../../../../events.js';
import { DOMPurify } from '../../../../../../lib.js';

import * as store from '../store.js';
import * as engine from '../switch-engine.js';
import * as settingsUi from './settings.js';
import * as bindings from './bindings.js';
import * as extraBody from './extra-body.js';
import * as events from '../events.js';
import * as publicApi from '../public-api.js';
import * as usagePanel from './usage-panel.js';
import * as usageChip from './usage-chip.js';
import { initSlashCommands, teardownSlashCommands } from '../slash-commands.js';
import { EVENTS, ST_EVENTS } from '../constants.js';
import {
    applyNativeSelectorVisibility,
    cleanupDom,
    injectApiDrawerTools,
    injectTopBarButton,
    setGlobalHotkeyHandler,
    tr,
} from './dom.js';
import { state } from './hub-state.js';
import { persist, settings } from './hub-utils.js';
import { getCurrentRef, loadCatalogOnce, loadProviderAvailability, rebuildEntries } from './hub-catalog.js';
import { renderList } from './hub-list.js';
import { renderDetails } from './hub-details.js';
import { refreshHub, refreshSelectionUI } from './hub-quick.js';
import {
    closeHub,
    destroyModal,
    handleGlobalKeydown,
    openHub,
    syncGatewayOnlineStatus,
    toggleHub,
} from './hub-modal.js';

export { openHub, closeHub, toggleHub };
export { showTab } from './hub-modal.js';
export { refreshHub, refreshSelectionUI };

/** @type {Array<[string, Function]>} */
const hubEventListeners = [];

/**
 * Run an init hook, logging (but never throwing) sync and async failures.
 * @param {Function} start
 * @param {string} label
 */
function invokeInit(start, label) {
    try {
        const result = start();
        if (result?.catch) {
            result.catch((error) => console.warn(`[omtp] ${label} failed`, error));
        }
    } catch (error) {
        console.warn(`[omtp] ${label} failed`, error);
    }
}

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
    if (state.isCleaningUp) {
        return;
    }
    // refreshSelectionUI already repaints the details pane when the hub is open.
    refreshSelectionUI();
}

function onCatalogChanged() {
    if (state.isCleaningUp) {
        return;
    }
    rebuildEntries();
}

function onChatContextChanged(chatId) {
    if (state.isCleaningUp) {
        return;
    }
    state.selectedEntryKey = null;
    try {
        // Keep the gateway header in step so usage is attributed to this chat.
        engine.syncChatHeader(chatId);
    } catch {
        // Header sync is best-effort.
    }
    usagePanel.resetUsageSession(chatId);
    usageChip.refreshUsageChip({ force: true, chatId }).catch(() => {});
    refreshSelectionUI();
    if (state.isOpen) {
        renderList();
        renderDetails();
    }
}

function onAppReady() {
    syncGatewayOnlineStatus().catch(() => {});
    try {
        engine.syncChatHeader();
    } catch {
        // best-effort
    }
    if (state.isCleaningUp) {
        return;
    }
    if (!state.catalogLoaded) {
        loadCatalogOnce();
    }
    refreshSelectionUI();
}

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
    if (state.isCleaningUp || !state.initialized) {
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
        invokeInit(() => settingsUi.initSettingsUI(container), 'settings UI init');
        invokeInit(() => bindings.initBindingUI(container), 'bindings UI init');
    } catch (error) {
        console.warn('[omtp] could not inject settings panel', error);
    }
}

/**
 * Toggle the native API selector from the API drawer shortcut.
 */
function onShowNativeSelector() {
    try {
        const next = !settings().hideNativeSelector;
        persist({ hideNativeSelector: next });
        applyNativeSelectorVisibility({ ...settings(), hideNativeSelector: next });
        injectApiDrawerTools({ onOpen: openHub, onShowNative: onShowNativeSelector });
        settingsUi.refreshSettingsUI();
    } catch (error) {
        console.warn('[omtp] could not toggle native selector', error);
    }
}

/**
 * Point the welcome prompt's "API Connections" button at the hub.
 *
 * SillyTavern renders `welcomePrompt.html` for every new welcome message, so we
 * patch each instance as it appears and remember the original markup to restore
 * it on cleanup.
 * @type {{button: HTMLElement, html: string, target: string|undefined, className: string}[]}
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

/**
 * The current selection as an EntryRef (null when unknown).
 * @returns {object|null}
 */
export function getCurrentSelection() {
    return getCurrentRef();
}

/**
 * Extension activation hook. Must finish quickly: heavy work is scheduled.
 */
export async function init() {
    if (state.initialized) {
        return;
    }
    state.initialized = true;
    state.isCleaningUp = false;
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

    invokeInit(() => bindings.initBindings(), 'bindings init');
    invokeInit(() => extraBody.initExtraBody(), 'extra body init');
    invokeInit(() => events.initEvents(), 'events init');
    invokeInit(() => publicApi.initPublicApi({
        version: '0.1.0',
        open: openHub,
        close: closeHub,
        toggle: toggleHub,
        getCurrentSelection,
    }), 'public API init');

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
 * Put the native/custom selection back before the extension goes away.
 */
async function restorePreviousSelection() {
    let gatewayMode = false;
    try {
        gatewayMode = Boolean(engine.isGatewayMode());
    } catch {
        gatewayMode = false;
    }
    if (gatewayMode) {
        const current = settings();
        const snapshot = current.lastNativeSelection || current.gateway?.savedCustom || null;
        if (snapshot) {
            try {
                await engine.restoreSelection(snapshot, { fast: true });
            } catch (error) {
                console.warn('[omtp] could not restore native selection', error);
            }
        }
    }
    if (settings().gateway?.savedCustom) {
        try {
            await engine.restoreSelection(settings().gateway.savedCustom, { fast: true });
        } catch (error) {
            console.warn('[omtp] could not restore custom source state', error);
        }
        const current = settings();
        persist({ gateway: { ...(current.gateway || {}), savedCustom: null } });
    }
}

/**
 * Remove every surface the extension added and unsubscribe its events.
 */
function cleanupHubSurfaces() {
    if (state.searchTimer) {
        clearTimeout(state.searchTimer);
        state.searchTimer = null;
    }
    try {
        events.cleanupEvents();
    } catch (error) {
        console.warn('[omtp] events cleanup failed', error);
    }
    try {
        teardownSlashCommands();
    } catch (error) {
        console.warn('[omtp] slash command cleanup failed', error);
    }
    try {
        publicApi.cleanupPublicApi();
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
}

/** Forget all hub state so a later init() starts clean. */
function resetHubState() {
    state.rowEntries = [];
    state.selectedEntryKey = null;
    state.selectedProvider = null;
    state.searchQuery = '';
    state.catalogLoading = null;
    state.catalogLoaded = false;
    state.initialized = false;
    state.isCleaningUp = false;
}

/**
 * Shared teardown for disable/clean/delete.
 */
async function teardown() {
    if (state.isCleaningUp) {
        return;
    }
    state.isCleaningUp = true;
    try {
        await restorePreviousSelection();
    } finally {
        cleanupHubSurfaces();
        resetHubState();
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
