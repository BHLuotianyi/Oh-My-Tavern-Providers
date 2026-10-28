/**
 * Persistent client settings for the OMTP Model Hub.
 *
 * Settings live in `extension_settings.omtp` and are saved through
 * SillyTavern's debounced settings saver.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import {
    DEFAULT_SETTINGS,
    ENTRY_KINDS,
    MAX_FAVORITES,
    MAX_RECENTS,
    QUICK_SLOT_COUNT,
    SETTINGS_NAMESPACE,
} from './constants.js';

export { DEFAULT_SETTINGS };

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function settingsRoot() {
    if (!isPlainObject(extension_settings)) {
        throw new Error('[omtp] SillyTavern extension_settings is unavailable');
    }
    return extension_settings;
}

/** True when `ref` looks like a valid EntryRef. */
export function isValidRef(ref) {
    if (!isPlainObject(ref)) {
        return false;
    }
    if (!ENTRY_KINDS.includes(ref.kind)) {
        return false;
    }
    if (typeof ref.provider !== 'string' || ref.provider.length === 0 || ref.provider.includes('/')) {
        return false;
    }
    return typeof ref.model === 'string' && ref.model.length > 0;
}

/**
 * Stable entry key: `kind/provider/model`. Providers never contain `/`;
 * models may, so only the first two separators are structural.
 */
export function getEntryKey(ref) {
    if (typeof ref === 'string') {
        return parseEntryKey(ref) ? ref : '';
    }
    if (!isValidRef(ref)) {
        return '';
    }
    return `${ref.kind}/${ref.provider}/${ref.model}`;
}

/** Parse an entry key back into an EntryRef. Returns null for invalid keys. */
export function parseEntryKey(key) {
    if (typeof key !== 'string') {
        return null;
    }
    const first = key.indexOf('/');
    if (first <= 0) {
        return null;
    }
    const second = key.indexOf('/', first + 1);
    if (second < 0) {
        return null;
    }
    const kind = key.slice(0, first);
    const provider = key.slice(first + 1, second);
    const model = key.slice(second + 1);
    if (!ENTRY_KINDS.includes(kind) || provider.length === 0 || model.length === 0) {
        return null;
    }
    return { kind, provider, model };
}

function uniqueRefs(value, limit) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const ref of value) {
        if (!isValidRef(ref)) {
            continue;
        }
        const key = getEntryKey(ref);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({ kind: ref.kind, provider: ref.provider, model: ref.model });
        if (result.length >= limit) {
            break;
        }
    }
    return result;
}

function normalizeQuickSlots(value) {
    const slots = Array.from({ length: QUICK_SLOT_COUNT }, () => null);
    if (!Array.isArray(value)) {
        return slots;
    }
    for (let index = 0; index < QUICK_SLOT_COUNT && index < value.length; index += 1) {
        const ref = value[index];
        slots[index] = isValidRef(ref)
            ? { kind: ref.kind, provider: ref.provider, model: ref.model }
            : null;
    }
    return slots;
}

function normalizeSettings(settings) {
    settings.version = DEFAULT_SETTINGS.version;

    settings.hideNativeSelector = typeof settings.hideNativeSelector === 'boolean'
        ? settings.hideNativeSelector
        : DEFAULT_SETTINGS.hideNativeSelector;
    settings.autoApplyBindings = typeof settings.autoApplyBindings === 'boolean'
        ? settings.autoApplyBindings
        : DEFAULT_SETTINGS.autoApplyBindings;

    settings.gatewayUrl = typeof settings.gatewayUrl === 'string'
        ? settings.gatewayUrl
        : DEFAULT_SETTINGS.gatewayUrl;
    settings.gatewayToken = typeof settings.gatewayToken === 'string'
        ? settings.gatewayToken
        : DEFAULT_SETTINGS.gatewayToken;
    settings.catalogUrl = typeof settings.catalogUrl === 'string'
        ? settings.catalogUrl
        : DEFAULT_SETTINGS.catalogUrl;

    settings.favorites = uniqueRefs(settings.favorites, MAX_FAVORITES);
    settings.recents = uniqueRefs(settings.recents, MAX_RECENTS);
    settings.quickSlots = normalizeQuickSlots(settings.quickSlots);
    settings.lastSelection = isValidRef(settings.lastSelection)
        ? {
            kind: settings.lastSelection.kind,
            provider: settings.lastSelection.provider,
            model: settings.lastSelection.model,
        }
        : null;
    settings.lastNativeSelection = isPlainObject(settings.lastNativeSelection)
        ? settings.lastNativeSelection
        : null;

    settings.extraBodies = isPlainObject(settings.extraBodies) ? settings.extraBodies : {};
    settings.reasoningByEntry = isPlainObject(settings.reasoningByEntry) ? settings.reasoningByEntry : {};
    settings.characterBindings = isPlainObject(settings.characterBindings) ? settings.characterBindings : {};

    if (!isPlainObject(settings.ui)) {
        settings.ui = clone(DEFAULT_SETTINGS.ui);
    } else if (typeof settings.ui.hotkey !== 'string' || settings.ui.hotkey.length === 0) {
        settings.ui.hotkey = DEFAULT_SETTINGS.ui.hotkey;
    }

    if (!isPlainObject(settings.gateway)) {
        settings.gateway = clone(DEFAULT_SETTINGS.gateway);
    } else if (settings.gateway.savedCustom !== null && !isPlainObject(settings.gateway.savedCustom)) {
        settings.gateway.savedCustom = null;
    }

    return settings;
}

/**
 * Ensure `extension_settings.omtp` exists, fill missing fields with defaults
 * and normalize collections (recents <= 20, nine quick slots, favorites <= 100).
 */
export function loadSettings() {
    const root = settingsRoot();
    let settings = root[SETTINGS_NAMESPACE];

    if (!isPlainObject(settings)) {
        settings = clone(DEFAULT_SETTINGS);
        root[SETTINGS_NAMESPACE] = settings;
        return normalizeSettings(settings);
    }

    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = clone(defaultValue);
        }
    }

    return normalizeSettings(settings);
}

/** Persist settings via SillyTavern's debounced saver. */
export function saveSettings() {
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
}

/** Live settings object (created and normalized on first access). */
export function getSettings() {
    return loadSettings();
}

/**
 * Apply a shallow patch (plain objects are merged one level deep) and save.
 * Returns the live settings object.
 */
export function updateSettings(patch) {
    const settings = loadSettings();
    if (!isPlainObject(patch)) {
        return settings;
    }

    for (const [key, value] of Object.entries(patch)) {
        if (isPlainObject(value) && isPlainObject(settings[key])) {
            Object.assign(settings[key], value);
        } else {
            settings[key] = value;
        }
    }

    normalizeSettings(settings);
    saveSettings();
    return settings;
}
