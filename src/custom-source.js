/**
 * OMTP Model Hub — SillyTavern custom-source fields & YAML header helpers.
 *
 * Captures and restores ST's `custom` chat completion fields and keeps the
 * `X-OMTP-Chat` attribution header synchronized in `custom_include_headers`.
 */

import { isGatewayMode } from './gateway-status.js';
import { currentChatId } from './usage-session.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { oai_settings } from '../../../../openai.js';
import { yaml } from '../../../../../lib.js';

/** Header carrying the SillyTavern chat id, so usage can be attributed per chat. */
export const CHAT_HEADER = 'X-OMTP-Chat';

/** [snapshot key, oai_settings field, DOM control] */
export const CUSTOM_FIELDS = [
    ['customUrl', 'custom_url', '#custom_api_url_text'],
    ['customModel', 'custom_model', '#custom_model_id'],
    ['customIncludeHeaders', 'custom_include_headers', '#custom_include_headers'],
    ['customIncludeBody', 'custom_include_body', '#custom_include_body'],
    ['customExcludeBody', 'custom_exclude_body', '#custom_exclude_body'],
    ['customPromptPostProcessing', 'custom_prompt_post_processing', '#custom_prompt_post_processing'],
];

export function jq(selector) {
    if (typeof $ !== 'function') {
        return null;
    }
    try {
        const element = $(selector);
        return element.length ? element : null;
    } catch {
        return null;
    }
}

/**
 * Set a control and fire the event ST listens to.
 * Selects whose option is missing are left untouched (their change handler would
 * otherwise clobber the settings field with the current selection).
 */
export function setControlValue(selector, value, eventName = null) {
    if (value == null) {
        return false;
    }
    const element = jq(selector);
    if (!element) {
        return false;
    }
    element.val(value);
    if (element.is('select') && String(element.val()) !== String(value)) {
        return false;
    }
    const event = eventName ?? (element.is('input, textarea') ? 'input' : 'change');
    element.trigger(event);
    return true;
}

/** Custom-source fields as stored in a selection snapshot. */
export function captureCustomFields() {
    const fields = {};
    for (const [key, field] of CUSTOM_FIELDS) {
        fields[key] = oai_settings?.[field] ?? '';
    }
    return fields;
}

export function writeCustomFields(snapshot) {
    if (!snapshot) {
        return;
    }
    for (const [key, field, selector] of CUSTOM_FIELDS) {
        const value = snapshot[key];
        if (typeof value !== 'string') {
            continue;
        }
        oai_settings[field] = value;
        setControlValue(selector, value);
    }
}

/**
 * HTTP header values are Latin-1 only: a chat named in Chinese or with an emoji
 * made SillyTavern throw `Invalid Character in header content ["X-OMTP-Chat"]`
 * before the request was ever sent. Percent-encoding keeps it ASCII; the
 * gateway decodes it again.
 * @param {string} [chatId]
 * @returns {string}
 */
export function encodeChatId(chatId) {
    const text = String(chatId || '');
    if (!text) {
        return '';
    }
    try {
        return encodeURIComponent(text);
    } catch {
        return '';
    }
}

export function mergeYamlHeaders(existing, additions) {
    let parsed = null;
    const text = typeof existing === 'string' ? existing.trim() : '';
    if (text) {
        try {
            const value = yaml.parse(text);
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                parsed = value;
            }
        } catch {
            // Invalid YAML: replace with only the managed headers.
            parsed = null;
        }
    }
    const merged = { ...(parsed ?? {}) };
    for (const [key, value] of Object.entries(additions || {})) {
        if (value === undefined || value === null || value === '') {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }
    return String(yaml.stringify(merged) ?? '').trimEnd();
}

/**
 * Keep the `X-OMTP-Chat` header in sync with the open chat. Called on
 * CHAT_CHANGED while in gateway mode; a no-op for native providers.
 * @param {string} [chatId]
 * @returns {boolean}
 */
export function syncChatHeader(chatId = currentChatId()) {
    if (!isGatewayMode()) {
        return false;
    }
    // Drop the header entirely when no chat is open, so we never send a blank id.
    const text = String(oai_settings.custom_include_headers || '').trim();
    let parsed = {};
    if (text) {
        try {
            const value = yaml.parse(text);
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                parsed = { ...value };
            }
        } catch {
            parsed = {};
        }
    }
    if (chatId) {
        parsed[CHAT_HEADER] = encodeChatId(chatId);
    } else {
        delete parsed[CHAT_HEADER];
    }
    const merged = String(yaml.stringify(parsed) ?? '').trimEnd();
    if (merged === String(oai_settings.custom_include_headers || '').trimEnd()) {
        return false;
    }
    oai_settings.custom_include_headers = merged;
    setControlValue('#custom_include_headers', merged);
    saveSettingsDebounced();
    return true;
}
