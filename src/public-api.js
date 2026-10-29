/**
 * OMTP Model Hub — public API for other extensions.
 *
 * `globalThis.OMTP` exposes selection control, runtime adapter/provider
 * registration and event subscription. The global is only removed again when
 * it still points at the API installed by this module.
 */
import { eventSource } from '../../../../events.js';
import { EVENTS, EXTENSION_VERSION } from './constants.js';
import { getActiveCatalog, getEntries, invalidateNativeCache, mergeCatalog, resolveEntry, setActiveCatalog, withProviderAvailability } from './catalog.js';
import { isValidRef, getSettings, parseEntryKey } from './store.js';
import { captureSelection, switchToEntry } from './switch-engine.js';
import { resolveSelector } from './selector.js';
import { registerNativeAdapter } from './adapters/native.js';
import { closeHub, getCurrentSelection as hubGetCurrentSelection, openHub, toggleHub } from './ui/hub.js';

/** @type {object|null} */
let installed = null;
/** @type {object|undefined} */
let previousGlobal;
/** @type {Array<[string, Function]>} */
let apiListeners = [];

function emit(name, payload) {
    if (!eventSource?.emit) {
        return;
    }
    try {
        const result = eventSource.emit(name, payload);
        if (result?.catch) {
            result.catch((error) => console.warn(`[omtp] could not emit ${name}`, error));
        }
    } catch (error) {
        console.warn(`[omtp] could not emit ${name}`, error);
    }
}

function normalizeRefArg(value) {
    if (!value) {
        return null;
    }
    if (isValidRef(value)) {
        return { kind: value.kind, provider: value.provider, model: value.model };
    }
    if (isValidRef(value.ref)) {
        return { kind: value.ref.kind, provider: value.ref.provider, model: value.ref.model };
    }
    if (typeof value.key === 'string') {
        return parseEntryKey(value.key);
    }
    return null;
}

/**
 * Switch to an entry by selector string (`provider/model`, `@1`, `@fav`, ...)
 * or EntryRef. Throws when the model is unknown or unavailable.
 * @param {string|object} selectorOrRef
 * @returns {Promise<object>} The resolved EntryRef
 */
async function switchTo(selectorOrRef, { persist = true } = {}) {
    const settings = getSettings();
    let ref = null;
    let level;
    let resolvedEntry = null;
    if (typeof selectorOrRef === 'string') {
        const input = selectorOrRef.trim();
        if (!input) {
            throw new Error('Enter a model selector');
        }
        const keyRef = parseEntryKey(input);
        if (keyRef) {
            ref = keyRef;
        } else {
            const result = resolveSelector(input, getEntries().map(withProviderAvailability), {
                favorites: settings.favorites,
                recents: settings.recents,
                quickSlots: settings.quickSlots,
            });
            if (result?.error) {
                throw new Error(result.error);
            }
            if (!result?.entry) {
                throw new Error(`Unknown model: ${selectorOrRef}`);
            }
            if (result.warning) {
                console.debug('[omtp]', result.warning);
            }
            resolvedEntry = result.entry;
            ref = {
                kind: result.entry.kind,
                provider: result.entry.provider,
                model: result.entry.model,
            };
            level = result.level;
        }
    } else {
        ref = normalizeRefArg(selectorOrRef);
    }

    if (!isValidRef(ref)) {
        throw new Error('Invalid selection');
    }
    if (!resolvedEntry) {
        const rawEntry = resolveEntry(ref);
        if (!rawEntry) {
            throw new Error(`Unknown model: ${ref.provider}/${ref.model}`);
        }
        resolvedEntry = withProviderAvailability(rawEntry);
    }
    if (resolvedEntry.available === false) {
        throw new Error(resolvedEntry.unsupportedReason || `Model ${resolvedEntry.model} is unavailable`);
    }

    await switchToEntry(ref, { reason: 'public-api', level, persist });
    return ref;
}

/**
 * Public selector entry point used by the slash commands.
 * @param {string|object} selectorOrRef
 * @returns {Promise<object>} The resolved EntryRef
 */
export async function switchToSelector(selectorOrRef, options = {}) {
    return switchTo(selectorOrRef, options);
}

/**
 * Register a native adapter at runtime. Entries rebuild on the next catalog
 * change event.
 * @param {object} adapter
 * @returns {object} The frozen registered adapter
 */
function registerProviderAdapter(adapter) {
    const registered = registerNativeAdapter(adapter);
    invalidateNativeCache();
    emit(EVENTS.CATALOG_CHANGED, { source: 'adapter', key: registered.key });
    return registered;
}

/**
 * Merge a provider (or provider map / catalog overlay) into the active catalog.
 * @param {object} provider
 * @returns {object} The active catalog
 */
function registerCatalogProvider(provider) {
    if (!provider || typeof provider !== 'object') {
        throw new TypeError('registerCatalogProvider requires a provider object');
    }
    const merged = mergeCatalog(getActiveCatalog(), provider);
    setActiveCatalog(merged);
    emit(EVENTS.CATALOG_CHANGED, { source: 'runtime' });
    return getActiveCatalog();
}

function on(event, handler) {
    if (typeof handler !== 'function') {
        throw new TypeError('OMTP.on requires an event name and handler');
    }
    if (!eventSource?.on) {
        return;
    }
    eventSource.on(event, handler);
    apiListeners.push([event, handler]);
}

function off(event, handler) {
    if (typeof handler !== 'function' || !eventSource) {
        return;
    }
    try {
        eventSource.removeListener?.(event, handler);
        eventSource.off?.(event, handler);
    } catch {
        // ignore
    }
    const index = apiListeners.findIndex(([name, listener]) => name === event && listener === handler);
    if (index >= 0) {
        apiListeners.splice(index, 1);
    }
}

/**
 * Install `globalThis.OMTP`. The optional argument lets the hub supply its own
 * UI entry points; `switchTo` always uses the selector + switch-engine path.
 * @param {{version?: string, open?: Function, close?: Function, toggle?: Function,
 *          getCurrentSelection?: Function}} [api]
 * @returns {object} The installed API
 */
export function initPublicApi(api = {}) {
    if (installed && globalThis.OMTP === installed) {
        return installed;
    }
    if (globalThis.OMTP !== undefined && globalThis.OMTP !== installed) {
        previousGlobal = globalThis.OMTP;
    } else {
        previousGlobal = undefined;
    }

    const impl = {
        version: typeof api?.version === 'string' ? api.version : EXTENSION_VERSION,
        open: typeof api?.open === 'function' ? api.open : openHub,
        close: typeof api?.close === 'function' ? api.close : closeHub,
        toggle: typeof api?.toggle === 'function' ? api.toggle : toggleHub,
        getCurrentSelection: typeof api?.getCurrentSelection === 'function'
            ? api.getCurrentSelection
            : (hubGetCurrentSelection ?? captureSelection),
        switchTo,
        registerProviderAdapter,
        registerCatalogProvider,
        on,
        off,
        events: EVENTS,
        /** Reserved for later role integrations; not consumed by the hub. */
        roles: {},
    };

    installed = impl;
    globalThis.OMTP = impl;
    return impl;
}

/** Remove the global when it is still ours. */
export function cleanupPublicApi() {
    for (const [name, handler] of apiListeners.splice(0)) {
        try {
            eventSource?.removeListener?.(name, handler);
            eventSource?.off?.(name, handler);
        } catch {
            // ignore
        }
    }
    if (installed && globalThis.OMTP === installed) {
        if (previousGlobal !== undefined) {
            globalThis.OMTP = previousGlobal;
        } else {
            delete globalThis.OMTP;
        }
    }
    installed = null;
    previousGlobal = undefined;
}
