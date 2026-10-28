/**
 * OMTP Model Hub — manual extra-body JSON.
 *
 * Each entry (`kind/provider/model`) may carry a plain-object body that is
 * merged into the outgoing generation payload. OMTP-owned keys (model,
 * messages, stream, ...) can never be overridden; attempts are stripped and
 * reported to the user.
 */
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../../../popup.js';
import { eventSource } from '../../../../../events.js';
import { PROTECTED_EXTRA_BODY_KEYS, ST_EVENTS } from '../constants.js';
import { getEntryKey, getSettings, saveSettings } from '../store.js';
import { captureSelection } from '../switch-engine.js';
import { tr } from './dom.js';

const CLEANUP_KEY = '__omtpExtraBodyCleanup';

/** @type {Array<[string, Function]>} */
let hooks = [];
let initialized = false;

function notify(kind, message) {
    const fn = globalThis.toastr?.[kind];
    if (typeof fn === 'function') {
        fn(message);
    } else if (kind === 'error') {
        console.error('[omtp]', message);
    } else {
        console.log('[omtp]', message);
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function eventName(key) {
    return ST_EVENTS?.[key] ?? key;
}

/**
 * Current entry key, derived from SillyTavern's live selection state.
 * Returns null when the selection cannot be mapped to a catalog entry.
 * @returns {string|null}
 */
function currentEntryKey() {
    try {
        const snapshot = captureSelection();
        if (snapshot && typeof snapshot === 'object' && snapshot.ref) {
            const key = getEntryKey(snapshot.ref);
            return key || null;
        }
    } catch (error) {
        console.debug('[omtp] could not capture selection for extra body', error);
    }
    return null;
}

/**
 * Merge one level deep: plain objects are combined, arrays and scalars replace.
 * @param {object} target
 * @param {object} body
 */
function mergeExtraBody(target, body) {
    for (const [key, value] of Object.entries(body)) {
        if (PROTECTED_EXTRA_BODY_KEYS.includes(key)) {
            continue;
        }
        if (isPlainObject(value) && isPlainObject(target[key])) {
            target[key] = { ...target[key], ...cloneValue(value) };
        } else {
            target[key] = cloneValue(value);
        }
    }
}

/**
 * Apply the stored extra body for the current entry to a generation payload.
 * No-op when the entry has no configured body or the payload is not an object.
 * @param {object} payload
 */
function applyExtraBody(payload) {
    if (!isPlainObject(payload)) {
        return;
    }
    const key = currentEntryKey();
    if (!key) {
        return;
    }
    const body = getSettings().extraBodies?.[key];
    if (!isPlainObject(body) || Object.keys(body).length === 0) {
        return;
    }
    try {
        mergeExtraBody(payload, body);
        console.debug('[omtp] applied extra body', key);
    } catch (error) {
        console.warn('[omtp] could not apply extra body', error);
    }
}

function onChatCompletionSettingsReady(generateData) {
    applyExtraBody(generateData);
}

function onTextCompletionSettingsReady(params) {
    applyExtraBody(params);
}

function onGenerateAfterData(generateData) {
    applyExtraBody(generateData);
}

/**
 * Register the generation hooks once. Safe to call repeatedly.
 */
export function initExtraBody() {
    if (initialized) {
        return;
    }
    initialized = true;
    if (!eventSource) {
        return;
    }
    const subscribe = typeof eventSource.makeLast === 'function'
        ? eventSource.makeLast.bind(eventSource)
        : eventSource.on.bind(eventSource);

    const entries = [
        [eventName('CHAT_COMPLETION_SETTINGS_READY'), onChatCompletionSettingsReady],
        [eventName('TEXT_COMPLETION_SETTINGS_READY'), onTextCompletionSettingsReady],
        [eventName('GENERATE_AFTER_DATA'), onGenerateAfterData],
    ];
    for (const [name, handler] of entries) {
        if (!name) {
            continue;
        }
        try {
            subscribe(name, handler);
            hooks.push([name, handler]);
        } catch (error) {
            console.warn(`[omtp] could not subscribe to ${name}`, error);
        }
    }

    globalThis[CLEANUP_KEY] = () => {
        for (const [name, handler] of hooks.splice(0)) {
            try {
                eventSource.removeListener?.(name, handler);
                eventSource.off?.(name, handler);
            } catch {
                // ignore
            }
        }
        initialized = false;
        if (globalThis[CLEANUP_KEY]) {
            delete globalThis[CLEANUP_KEY];
        }
    };
}

/**
 * Validate a JSON body. Returns either `{ value }` or `{ error }`.
 * @param {string} text
 * @returns {{value?: object, removed?: string[], error?: string}}
 */
function parseExtraBody(text) {
    let parsed;
    try {
        parsed = JSON.parse(text?.trim() ? text : '{}');
    } catch (error) {
        return { error: `Invalid JSON: ${error.message}` };
    }
    if (!isPlainObject(parsed)) {
        return { error: 'Extra body must be a JSON object' };
    }
    const removed = [];
    for (const key of PROTECTED_EXTRA_BODY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            delete parsed[key];
            removed.push(key);
        }
    }
    return { value: parsed, removed };
}

/**
 * Resolve the entry key for an entry object, EntryRef or entry key string.
 * @param {object|string} entry
 * @returns {string|null}
 */
function resolveKey(entry) {
    if (!entry) {
        return null;
    }
    if (typeof entry === 'string') {
        return entry.includes('/') ? entry : null;
    }
    if (typeof entry.key === 'string' && entry.key.includes('/')) {
        return entry.key;
    }
    if (entry.ref) {
        return getEntryKey(entry.ref) || null;
    }
    if (entry.kind && entry.provider && entry.model) {
        return getEntryKey(entry) || null;
    }
    return null;
}

function entryLabel(entry, key) {
    if (entry && typeof entry === 'object') {
        return entry.modelLabel || entry.model || key;
    }
    return key;
}

/**
 * Open the extra-body editor popup for an entry.
 * @param {object|string} entry Catalog entry, EntryRef or entry key
 * @returns {Promise<void>}
 */
export async function openExtraBodyEditor(entry) {
    initExtraBody();
    const lastSelection = getSettings().lastSelection;
    const key = resolveKey(entry) || (lastSelection ? getEntryKey(lastSelection) : null);
    if (!key) {
        notify('error', 'Extra body editor needs a valid model entry');
        return;
    }

    const settings = getSettings();
    const existing = settings.extraBodies?.[key];
    const label = entryLabel(entry, key);

    const wrapper = document.createElement('div');
    wrapper.classList.add('omtp-extra-body-editor');

    const hint = document.createElement('div');
    hint.classList.add('omtp-muted');
    hint.textContent = tr(
        'omtp_extra_body_hint',
        'Plain JSON object merged into the request body. Model, messages, stream and API routing keys are managed by OMTP.',
    );
    wrapper.append(hint);

    const textarea = document.createElement('textarea');
    textarea.id = 'omtp-extra-body-json';
    textarea.classList.add('text_pole', 'monospace');
    textarea.rows = 12;
    textarea.style.width = '100%';
    textarea.spellcheck = false;
    textarea.value = isPlainObject(existing) ? JSON.stringify(existing, null, 2) : '';
    textarea.placeholder = '{\n  "top_k": 42\n}';
    wrapper.append(textarea);

    const errorLine = document.createElement('div');
    errorLine.classList.add('omtp-muted');
    errorLine.setAttribute('role', 'alert');
    wrapper.append(errorLine);

    const popup = new Popup(wrapper, POPUP_TYPE.CONFIRM, null, {
        okButton: tr('omtp_save', 'Save'),
        cancelButton: tr('omtp_cancel', 'Cancel'),
        customButtons: [{ text: tr('omtp_delete', 'Delete'), result: POPUP_RESULT.CUSTOM1 }],
        wide: true,
        allowVerticalScrolling: true,
        onClosing: (current) => {
            if (current.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            const raw = textarea.value.trim();
            const live = getSettings();
            live.extraBodies ??= {};

            if (!raw) {
                delete live.extraBodies[key];
                saveSettings();
                notify('success', `Extra body removed for ${label}`);
                return true;
            }

            const parsed = parseExtraBody(raw);
            if (parsed.error) {
                errorLine.textContent = parsed.error;
                return false;
            }
            if (parsed.removed?.length) {
                errorLine.textContent = `Removed OMTP-managed keys: ${parsed.removed.join(', ')}`;
                notify('warning', `Key "${parsed.removed[0]}" is managed by OMTP and cannot be overridden`);
            }
            if (Object.keys(parsed.value ?? {}).length === 0) {
                delete live.extraBodies[key];
            } else {
                live.extraBodies[key] = parsed.value;
            }
            saveSettings();
            notify('success', `Extra body saved for ${label}`);
            return true;
        },
    });

    if (existing && isPlainObject(existing)) {
        popup.defaultResult = POPUP_RESULT.AFFIRMATIVE;
    }

    try {
        const result = await popup.show();
        if (result === POPUP_RESULT.CUSTOM1) {
            const live = getSettings();
            if (live.extraBodies?.[key]) {
                delete live.extraBodies[key];
                saveSettings();
                notify('success', `Extra body removed for ${label}`);
            }
        }
    } catch (error) {
        console.warn('[omtp] extra body editor failed', error);
        notify('error', `Could not open extra body editor: ${error?.message ?? error}`);
    }
}
