/**
 * OMTP Model Hub — SillyTavern event wiring.
 *
 * Listeners are registered after APP_READY (the event emitter replays
 * APP_READY when it already fired, so late initialization still starts).
 * Availability-related events are debounced into a single rebuild.
 */
import { eventSource, event_types } from '../../../../events.js';
import { ST_EVENTS } from './constants.js';
import { invalidateNativeCache, invalidateProfileCache } from './catalog.js';
import { invalidateGatewayCaches } from './switch-engine.js';
import { refreshHub, refreshSelectionUI } from './ui/hub.js';
import { onChatChanged } from './ui/bindings.js';

const REBUILD_DEBOUNCE_MS = 200;

/** @type {Array<[string, Function]>} */
let listeners = [];
let initialized = false;
let started = false;
let refreshTimer = null;
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

function runSafe(name, fn, ...args) {
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
    runSafe('refreshSelectionUI', refreshSelectionUI);
    runSafe('refreshHub', refreshHub);
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

    subscribe(eventName('CHAT_CHANGED'), () => runSafe('onChatChanged', onChatChanged));

    const onAvailabilityChanged = () => {
        try {
            invalidateNativeCache();
            invalidateGatewayCaches();
        } catch (error) {
            warn('could not invalidate availability caches', error);
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

    const onProfilesChanged = () => {
        try {
            invalidateProfileCache();
        } catch (error) {
            warn('could not invalidate profile cache', error);
        }
        scheduleRefresh();
    };

    for (const key of [
        'CONNECTION_PROFILE_LOADED',
        'CONNECTION_PROFILE_CREATED',
        'CONNECTION_PROFILE_UPDATED',
        'CONNECTION_PROFILE_DELETED',
    ]) {
        subscribe(eventName(key), onProfilesChanged);
    }
}

function onAppReady() {
    start();
    runSafe('onChatChanged', onChatChanged);
}

/**
 * Install the event listeners. Safe to call multiple times; cleanupEvents()
 * must be called before re-initializing after a disable.
 */
export function initEvents() {
    if (initialized) {
        return;
    }
    initialized = true;

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
    initialized = false;
    started = false;
}
