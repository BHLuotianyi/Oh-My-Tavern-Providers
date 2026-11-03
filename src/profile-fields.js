/**
 * OMTP Model Hub — Connection Profile field model (pure, no SillyTavern imports).
 *
 * A SillyTavern connection profile is a saved snapshot of connection settings:
 * API, server URL, model, presets, secret and the text-completion templates.
 * SillyTavern records one by running its slash commands with no argument and
 * applies one by running the same commands with the stored values, so the field
 * lists below mirror `CC_COMMANDS` and `TC_COMMANDS` in
 * `public/scripts/extensions/connection-manager/index.js`. Keep them in sync
 * when SillyTavern adds a command to either list.
 */

/** Chat-completion profile fields, in the order SillyTavern applies them. */
export const CC_FIELDS = [
    'api',
    'preset',
    'api-url',
    'model',
    'proxy',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'prompt-post-processing',
    'secret-id',
    'regex-preset',
];

/** Text-completion profile fields, in the order SillyTavern applies them. */
export const TC_FIELDS = [
    'api',
    'preset',
    'api-url',
    'model',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'context',
    'instruct-state',
    'tokenizer',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'secret-id',
    'regex-preset',
];

/** Fields whose empty string is a real value, not "unset". */
export const ALLOW_EMPTY = new Set(['stop-strings', 'start-reply-with']);

/** Fields stored as the strings 'true'/'false'. */
export const STATE_FIELDS = new Set(['sysprompt-state', 'instruct-state']);

/** Fields SillyTavern records but the hub never lets the user type freely. */
export const SELECT_FIELDS = new Set([
    'api',
    'preset',
    'proxy',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'instruct-state',
    'context',
    'tokenizer',
    'reasoning-template',
    'prompt-post-processing',
    'secret-id',
    'regex-preset',
]);

/**
 * i18n key and English fallback for each field label.
 * @type {Record<string, [string, string]>}
 */
export const FIELD_LABELS = {
    'api': ['omtp_field_api', 'API'],
    'preset': ['omtp_field_preset', 'Settings preset'],
    'api-url': ['omtp_field_api_url', 'Server URL'],
    'model': ['omtp_field_model', 'Model'],
    'proxy': ['omtp_field_proxy', 'Proxy preset'],
    'sysprompt': ['omtp_field_sysprompt', 'System prompt'],
    'sysprompt-state': ['omtp_field_sysprompt_state', 'Use system prompt'],
    'instruct': ['omtp_field_instruct', 'Instruct template'],
    'context': ['omtp_field_context', 'Context template'],
    'instruct-state': ['omtp_field_instruct_state', 'Instruct mode'],
    'tokenizer': ['omtp_field_tokenizer', 'Tokenizer'],
    'stop-strings': ['omtp_field_stop_strings', 'Custom stopping strings'],
    'start-reply-with': ['omtp_field_start_reply_with', 'Start reply with'],
    'reasoning-template': ['omtp_field_reasoning_template', 'Reasoning template'],
    'prompt-post-processing': ['omtp_field_post_processing', 'Prompt post-processing'],
    'secret-id': ['omtp_field_secret', 'Secret'],
    'regex-preset': ['omtp_field_regex_preset', 'Regex preset'],
};

/**
 * Fields of a profile mode.
 * @param {'cc'|'tc'|string} mode
 * @returns {string[]}
 */
export function fieldsForMode(mode) {
    return mode === 'tc' ? TC_FIELDS : CC_FIELDS;
}

/**
 * SillyTavern's `main_api` decides which command set a profile uses.
 * @param {string} mainApi
 * @returns {'cc'|'tc'}
 */
export function detectMode(mainApi) {
    return mainApi === 'openai' ? 'cc' : 'tc';
}

/**
 * A profile's mode, falling back to the live API when the profile predates it.
 * @param {{mode?: string}|null|undefined} profile
 * @param {string} [mainApi]
 * @returns {'cc'|'tc'}
 */
export function profileMode(profile, mainApi = '') {
    if (profile?.mode === 'cc' || profile?.mode === 'tc') {
        return profile.mode;
    }
    return detectMode(mainApi);
}

/**
 * Why a profile name is unusable, or null when it is fine.
 * @param {string} name
 * @param {Array<{id?: string, name?: string}>} profiles
 * @param {string|null} [currentId] Profile being renamed (allowed to keep its name).
 * @returns {'empty'|'reserved'|'duplicate'|null}
 */
export function validateProfileName(name, profiles, currentId = null) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value) {
        return 'empty';
    }
    if (value === '<None>') {
        return 'reserved';
    }
    const clash = (Array.isArray(profiles) ? profiles : [])
        .some((profile) => profile && profile.name === value && profile.id !== currentId);
    return clash ? 'duplicate' : null;
}

/**
 * A free name for a duplicate: "X (copy)", then "X (copy 2)"…
 * @param {string} base
 * @param {Array<{name?: string}>} profiles
 * @returns {string}
 */
export function uniqueCopyName(base, profiles) {
    const taken = new Set((Array.isArray(profiles) ? profiles : [])
        .map((profile) => profile?.name)
        .filter((name) => typeof name === 'string'));
    const source = String(base ?? '').trim() || 'Profile';
    const first = `${source} (copy)`;
    if (!taken.has(first)) {
        return first;
    }
    for (let index = 2; index < 1000; index += 1) {
        const candidate = `${source} (copy ${index})`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    return `${source} (copy ${Date.now()})`;
}

/**
 * A free name built from a label: the label itself, then "label 2"…
 * @param {string} base
 * @param {Array<{name?: string}>} profiles
 * @returns {string}
 */
export function uniqueName(base, profiles) {
    const taken = new Set((Array.isArray(profiles) ? profiles : [])
        .map((profile) => profile?.name)
        .filter((name) => typeof name === 'string'));
    const source = String(base ?? '').trim() || 'Profile';
    if (!taken.has(source)) {
        return source;
    }
    for (let index = 2; index < 1000; index += 1) {
        const candidate = `${source} ${index}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    return `${source} ${Date.now()}`;
}

/**
 * Whether a field is recorded into the profile.
 * @param {{exclude?: string[]}|null|undefined} profile
 * @param {string} field
 * @returns {boolean}
 */
export function isExcluded(profile, field) {
    return Array.isArray(profile?.exclude) && profile.exclude.includes(field);
}

/**
 * Include or exclude a field, keeping `exclude` and the stored values aligned.
 * Excluding deletes the stored value; including only clears the exclusion, so
 * the user re-picks a value in the editor.
 * @param {object} profile
 * @param {string} field
 * @param {boolean} excluded
 */
export function setExcluded(profile, field, excluded) {
    if (!profile || !field) {
        return;
    }
    if (!Array.isArray(profile.exclude)) {
        profile.exclude = [];
    }
    const index = profile.exclude.indexOf(field);
    if (excluded) {
        if (index === -1) {
            profile.exclude.push(field);
        }
        delete profile[field];
        return;
    }
    if (index !== -1) {
        profile.exclude.splice(index, 1);
    }
}

/**
 * Store a field value, deleting the key when the value is "unset".
 * @param {object} profile
 * @param {string} field
 * @param {unknown} value
 * @returns {boolean} Whether the profile changed.
 */
export function setFieldValue(profile, field, value) {
    if (!profile || !field) {
        return false;
    }
    const text = value === null || value === undefined ? '' : String(value);
    if (text === '' && !ALLOW_EMPTY.has(field)) {
        if (!(field in profile)) {
            return false;
        }
        delete profile[field];
        return true;
    }
    if (profile[field] === text) {
        return false;
    }
    profile[field] = text;
    return true;
}

/**
 * A blank profile: name, mode and nothing recorded yet.
 * @param {string} id
 * @param {'cc'|'tc'} mode
 * @param {string} name
 * @returns {{id: string, mode: 'cc'|'tc', name: string, exclude: string[]}}
 */
export function blankProfile(id, mode, name) {
    return { id, mode: mode === 'tc' ? 'tc' : 'cc', name, exclude: [] };
}

/**
 * API keys a profile of this mode can use. `CONNECT_API_MAP` maps each key to
 * the SillyTavern `main_api` it selects; chat completion is `openai`.
 * @param {'cc'|'tc'} mode
 * @param {Record<string, {selected?: string}>} apiMap
 * @returns {Array<{value: string, label: string}>}
 */
export function apiChoices(mode, apiMap = {}) {
    const wantChat = mode !== 'tc';
    return Object.entries(apiMap || {})
        .filter(([, config]) => (config?.selected === 'openai') === wantChat)
        .map(([key]) => ({ value: key, label: key }))
        .sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Mode of the API a profile would switch to.
 * @param {string} apiKey
 * @param {Record<string, {selected?: string}>} apiMap
 * @returns {'cc'|'tc'}
 */
export function modeForApi(apiKey, apiMap = {}) {
    return apiMap?.[apiKey]?.selected === 'openai' ? 'cc' : 'tc';
}

/**
 * One-line description of what a profile connects to.
 * @param {{api?: string, model?: string}|null|undefined} profile
 * @returns {string}
 */
export function profileSummary(profile) {
    const parts = [profile?.api, profile?.model].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
}

/**
 * Drop fields that do not belong to `mode` (used when the API switches mode).
 * @param {object} profile
 * @param {'cc'|'tc'} mode
 */
export function pruneToMode(profile, mode) {
    if (!profile) {
        return;
    }
    const keep = new Set(fieldsForMode(mode));
    for (const key of Object.keys(profile)) {
        if (key === 'id' || key === 'name' || key === 'mode' || key === 'exclude') {
            continue;
        }
        if (!keep.has(key)) {
            delete profile[key];
        }
    }
    if (Array.isArray(profile.exclude)) {
        profile.exclude = profile.exclude.filter((field) => keep.has(field));
    }
    profile.mode = mode;
}
