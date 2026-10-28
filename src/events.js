/**
 * OMTP Model Hub — SillyTavern event wiring.
 *
 * Listeners are registered after APP_READY (the event emitter replays
 * APP_READY when it already fired, so late initialization still starts).
 * Availability-related events are debounced into a single rebuild.
 *
 * Callbacks are optional; the defaults drive the hub so that `initEvents()`
 * works when called with no arguments.
 */
import { eventSource, event_types } from '../../../../events.js';
import { EVENTS, ST_EVENTS } from './constants.js';
import { invalidateNativeCache } from './catalog.js';
import { refreshHub, refreshSelectionUI } from './ui/hub.js';
import { onChatChanged } from './ui/bindings.js';

const REBUILD_DEBOUNCE_MS = 200;

/** @type {Array<[string, Function]>} */
let listeners = [];
let initialized = false;
let started = false;
let refreshTimer = null;
/** @type {Record<string, Function|null>} */
let callbacks = {};

/**
 * Resolve a SillyTavern event name, preferring the runtime event_types map and
 * falling back to the constants snapshot when the event module is unavailable.
 * @param {string} key
 * @returns {string|null}
 */
function eventName(key) {
    return event_types?.[key] ?? ST_EVENTS?.[key] ?? null;
}

function warn(message, error) {
    console.warn(`[omtp] ${message}`, error);
}

function invoke(name, ...args) {
    const fn = callbacks[name];
    if (typeof fn !== 'function') {
        return;
    }
    try {
        const result = fn(...args);
        if (result?.catch) {
            result.catch((error) => warn(`${name} failed`, error));
        }
    } catch (error) {
        warn(`${name} failed`, error);
    }
}

function subscribe(name, handler) {
    if (!name || typeof handler !== 'function' || !eventSource?.on) {
        return;
    }
    try {
        eventSource.on(name, handler);
        listeners.push([name, handler]);
    } catch (error) {
        warn(`could not subscribe to ${name}`, error);
    }
}

function runRefresh() {
    invoke('refreshChip');
    invoke('refreshHub');
}

function scheduleRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        runRefresh();
    }, REBUILD_DEBOUNCE_MS);
}

function cancelRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

/**
 * Register the listeners that follow APP_READY.
 */
function start() {
    if (started) {
        return;
    }
    started = true;

    subscribe(eventName('CHAT_CHANGED'), () => invoke('onChatChanged'));

    const onAvailabilityChanged = () => {
        try {
            invalidateNativeCache();
        } catch (error) {
            warn('could not invalidate the native support cache', error);
        }
        scheduleRefresh();
    };

    for (const key of [
        'MAIN_API_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'CHATCOMPLETION_MODEL_CHANGED',
        'ONLINE_STATUS_CHANGED',
        'SECRET_WRITTEN',
        'SECRET_DELETED',
        'SECRET_ROTATED',
        'SECRET_EDITED',
    ]) {
        subscribe(eventName(key), onAvailabilityChanged);
    }

    for (const key of [
        'CONNECTION_PROFILE_LOADED',
        'CONNECTION_PROFILE_CREATED',
        'CONNECTION_PROFILE_UPDATED',
        'CONNECTION_PROFILE_DELETED',
    ]) {
        subscribe(eventName(key), scheduleRefresh);
    }

    subscribe(eventName('GENERATION_STARTED'), () => invoke('onGenerationStarted'));
    subscribe(eventName('GENERATION_ENDED'), () => invoke('onGenerationEnded'));

    // The hub rebuilds its own DOM on this event; external subscribers can
    // still react through the optional callback.
    subscribe(EVENTS.CATALOG_CHANGED, () => invoke('onCatalogChanged'));
}

function onAppReady() {
    start();
    invoke('onChatChanged');
}

/**
 * Install the event listeners. Safe to call multiple times; cleanupEvents()
 * must be called before re-initializing after a disable.
 * @param {{refreshChip?: Function, refreshHub?: Function, onChatChanged?: Function,
 *          onGenerationStarted?: Function, onGenerationEnded?: Function}} [options]
 */
export function initEvents(options = {}) {
    if (initialized) {
        return;
    }
    initialized = true;

    callbacks = {
        refreshChip: refreshSelectionUI,
        refreshHub: () => refreshHub(),
        onChatChanged,
        onGenerationStarted: null,
        onGenerationEnded: null,
        onCatalogChanged: null,
        ...(options && typeof options === 'object' ? options : {}),
    };

    if (!eventSource?.on) {
        return;
    }

    // `on(APP_READY)` replays immediately when the app is already ready.
    subscribe(eventName('APP_READY'), onAppReady);
}

/**
 * Remove every listener registered by initEvents() and cancel pending work.
 */
export function cleanupEvents() {
    cancelRefresh();
    for (const [name, handler] of listeners.splice(0)) {
        try {
            eventSource.removeListener?.(name, handler);
            eventSource.off?.(name, handler);
        } catch {
            // ignore
        }
    }
    try {
        globalThis.__omtpExtraBodyCleanup?.();
    } catch (error) {
        warn('extra body cleanup failed', error);
    }
    callbacks = {};
    initialized = false;
    started = false;
}
