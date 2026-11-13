/**
 * Connection Profile store and SillyTavern Connection Manager bridge.
 *
 * SillyTavern's Connection Manager owns the profiles: it stores them in
 * `extension_settings.connectionManager.profiles`, records a profile by running
 * its slash commands against the live settings and applies one by running the
 * same commands with the stored values. The hub never re-implements that
 * record/apply logic — it drives SillyTavern's own select element (which applies
 * and emits `CONNECTION_PROFILE_LOADED`) and its `/profile-*` commands, and only
 * edits the stored objects directly for the parts SillyTavern has no command
 * for: renaming, field values, duplication and deletion.
 */
import { extension_settings } from '../../../../../extensions.js';
import { CONNECT_API_MAP, main_api, saveSettingsDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { PROFILE_PROVIDER_ID } from '../constants.js';
import {
    blankProfile,
    detectMode,
    modeForApi,
    profileMode,
    pruneToMode,
    setExcluded,
    setFieldValue,
    uniqueCopyName,
    uniqueName,
    validateProfileName,
} from '../profile-fields.js';
import { tr } from './dom.js';

const NONE = '<None>';
const SELECT_ID = 'connection_profiles';

/** @returns {any|null} */
function cmSettings() {
    const settings = extension_settings?.connectionManager;
    return settings && Array.isArray(settings.profiles) ? settings : null;
}

/** @returns {object[]} */
export function profiles() {
    return cmSettings()?.profiles ?? [];
}

/** @returns {boolean} */
export function isConnectionManagerEnabled() {
    try {
        const disabled = Array.isArray(extension_settings?.disabledExtensions)
            ? extension_settings.disabledExtensions
            : [];
        return !disabled.includes('third-party/connection-manager') && Boolean(cmSettings());
    } catch {
        return false;
    }
}

/** @returns {string|null} */
export function activeProfileId() {
    const id = cmSettings()?.selectedProfile;
    return typeof id === 'string' && id ? id : null;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isProfileActive(id) {
    return Boolean(id) && activeProfileId() === id;
}

/**
 * @param {string} id
 * @returns {object|null}
 */
export function findProfile(id) {
    if (!id) {
        return null;
    }
    return profiles().find((profile) => profile?.id === id) ?? null;
}

/**
 * Hub entry key for a profile.
 * @param {string} id
 * @returns {string}
 */
export function profileKey(id) {
    return `profile/${PROFILE_PROVIDER_ID}/${id}`;
}

/** @returns {HTMLSelectElement|null} */
function stSelect() {
    const element = document.getElementById(SELECT_ID);
    return element instanceof HTMLSelectElement ? element : null;
}

function persist() {
    try {
        saveSettingsDebounced();
    } catch {
        // SillyTavern not ready; the in-memory change still applies.
    }
}

async function emit(name, ...args) {
    try {
        await eventSource?.emit?.(name, ...args);
    } catch {
        // Other extensions failing to react must not block the hub.
    }
}

function uuid() {
    try {
        if (typeof crypto?.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // fall through to the random suffix
    }
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertManageable() {
    if (!isConnectionManagerEnabled()) {
        throw new Error(tr('omtp_profiles_disabled', 'Enable the Connection Profiles extension in SillyTavern first.'));
    }
}

/**
 * @param {string} name Slash command name.
 * @returns {{callback: Function}}
 */
function commandFor(name) {
    const command = SlashCommandParser?.commands?.[name];
    if (!command || typeof command.callback !== 'function') {
        throw new Error(tr('omtp_profiles_disabled', 'Enable the Connection Profiles extension in SillyTavern first.'));
    }
    return command;
}

/**
 * Resolve when SillyTavern finishes applying a profile. The manager emits the
 * event itself; the timeout only guards against a disabled extension.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function onceLoaded(timeoutMs = 20000) {
    return new Promise((resolve) => {
        let timer = null;
        const done = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            resolve();
        };
        try {
            eventSource.once(event_types.CONNECTION_PROFILE_LOADED, done);
        } catch {
            resolve();
            return;
        }
        timer = setTimeout(done, timeoutMs);
    });
}

/**
 * Rebuild SillyTavern's own profile dropdown (and its button state) after the
 * hub changed the profile list, so both UIs stay in sync without a reload.
 */
export function syncStSelect() {
    const select = stSelect();
    if (!select) {
        return;
    }
    const current = activeProfileId();
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = NONE;
    none.selected = !current;
    select.append(none);
    const sorted = [...profiles()].sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));
    for (const profile of sorted) {
        if (!profile?.id) {
            continue;
        }
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        option.selected = profile.id === current;
        select.append(option);
    }
    for (const id of ['update_connection_profile', 'reload_connection_profile', 'delete_connection_profile']) {
        document.getElementById(id)?.classList.toggle('disabled', !current);
    }
}

/**
 * Apply a profile through SillyTavern's select, which runs the profile's slash
 * commands and emits the loaded event.
 * @param {string} id
 */
export async function applyProfile(id) {
    const profile = findProfile(id);
    if (!profile) {
        throw new Error(tr('omtp_profile_missing', 'That connection profile no longer exists.'));
    }
    const select = stSelect();
    if (!select) {
        assertManageable();
        throw new Error(tr('omtp_profiles_disabled', 'Enable the Connection Profiles extension in SillyTavern first.'));
    }
    if (!Array.from(select.options).some((option) => option.value === id)) {
        syncStSelect();
    }
    const loaded = onceLoaded();
    select.value = id;
    select.dispatchEvent(new Event('change'));
    await loaded;
    return profile;
}

/**
 * Stop using a profile: SillyTavern treats "None" as a selection change.
 */
export async function clearActiveProfile() {
    const select = stSelect();
    if (!select) {
        return;
    }
    const loaded = onceLoaded();
    select.selectedIndex = 0;
    select.dispatchEvent(new Event('change'));
    await loaded;
}

/**
 * The API key of the live connection, used to name a new profile.
 * @returns {Promise<string>}
 */
async function currentApiLabel() {
    try {
        const command = SlashCommandParser?.commands?.['api'];
        const result = await command?.callback?.({ quiet: 'true' }, '');
        return String(result ?? '').trim();
    } catch {
        return '';
    }
}

/**
 * Record the current connection as a new profile (SillyTavern's
 * `/profile-create` does the snapshotting).
 * @returns {Promise<object>}
 */
export async function createFromCurrent() {
    assertManageable();
    const command = commandFor('profile-create');
    const api = await currentApiLabel();
    const name = uniqueName(api || tr('omtp_profile_default_name', 'Profile'), profiles());
    const before = new Set(profiles().map((profile) => profile.id));
    await command.callback({}, name);
    const created = profiles().find((profile) => !before.has(profile.id));
    if (!created) {
        throw new Error(tr('omtp_profile_create_failed', 'Could not create the profile.'));
    }
    return created;
}

/**
 * Create a profile with no settings recorded; the details pane fills it in.
 * @returns {Promise<object>}
 */
export async function createBlank() {
    assertManageable();
    const settings = cmSettings();
    const profile = blankProfile(
        uuid(),
        detectMode(main_api),
        uniqueName(tr('omtp_profile_blank_name', 'New profile'), profiles()),
    );
    settings.profiles.push(profile);
    persist();
    syncStSelect();
    await emit(event_types.CONNECTION_PROFILE_CREATED, profile);
    return profile;
}

/**
 * Re-record the active profile from the live connection (`/profile-update`).
 * @returns {Promise<object>}
 */
export async function updateActive() {
    assertManageable();
    const id = activeProfileId();
    if (!id) {
        throw new Error(tr('omtp_profile_update_needs_active', 'Use the profile first, then update it from the live connection.'));
    }
    const command = commandFor('profile-update');
    await command.callback({}, '');
    const profile = findProfile(id);
    if (!profile) {
        throw new Error(tr('omtp_profile_missing', 'That connection profile no longer exists.'));
    }
    return profile;
}

/**
 * @param {string} id
 * @param {string} name
 * @returns {object}
 */
export function renameProfile(id, name) {
    const profile = findProfile(id);
    if (!profile) {
        throw new Error(tr('omtp_profile_missing', 'That connection profile no longer exists.'));
    }
    const reason = validateProfileName(name, profiles(), id);
    if (reason === 'empty') {
        throw new Error(tr('omtp_profile_name_empty', 'The profile name cannot be empty.'));
    }
    if (reason === 'reserved') {
        throw new Error(tr('omtp_profile_name_reserved', '"<None>" is reserved by SillyTavern.'));
    }
    if (reason === 'duplicate') {
        throw new Error(tr('omtp_profile_name_duplicate', 'A profile with that name already exists.'));
    }
    const next = String(name).trim();
    if (profile.name === next) {
        return profile;
    }
    const old = structuredClone(profile);
    profile.name = next;
    persist();
    syncStSelect();
    emit(event_types.CONNECTION_PROFILE_UPDATED, old, profile);
    return profile;
}

/**
 * Store a field value. Changing the API may switch the profile between chat and
 * text completion, which drops the fields of the other mode.
 * @param {object} profile
 * @param {string} field
 * @param {string} value
 * @returns {boolean} Whether the mode changed (the details pane must re-render).
 */
export function setProfileField(profile, field, value) {
    if (!profile || !field) {
        return false;
    }
    const oldMode = profileMode(profile, main_api);
    const changed = setFieldValue(profile, field, value);
    let modeChanged = false;
    if (field === 'api' && value) {
        const nextMode = modeForApi(String(value), CONNECT_API_MAP);
        if (nextMode !== oldMode) {
            pruneToMode(profile, nextMode);
            modeChanged = true;
        }
    }
    if (changed || modeChanged) {
        persist();
    }
    return modeChanged;
}

/**
 * @param {object} profile
 * @param {string} field
 * @param {boolean} included
 */
export function setProfileIncluded(profile, field, included) {
    if (!profile || !field) {
        return;
    }
    setExcluded(profile, field, !included);
    persist();
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function duplicateProfile(id) {
    const source = findProfile(id);
    if (!source) {
        throw new Error(tr('omtp_profile_missing', 'That connection profile no longer exists.'));
    }
    const settings = cmSettings();
    const copy = structuredClone(source);
    copy.id = uuid();
    copy.name = uniqueCopyName(source.name, profiles());
    settings.profiles.push(copy);
    persist();
    syncStSelect();
    await emit(event_types.CONNECTION_PROFILE_CREATED, copy);
    return copy;
}

/**
 * Delete a profile. SillyTavern has no command for this; its own delete button
 * does the same mutation, so the events keep every listener in sync.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteProfile(id) {
    const settings = cmSettings();
    if (!settings) {
        return false;
    }
    const index = settings.profiles.findIndex((profile) => profile?.id === id);
    if (index === -1) {
        return false;
    }
    const [removed] = settings.profiles.splice(index, 1);
    const wasActive = settings.selectedProfile === id;
    if (wasActive) {
        settings.selectedProfile = null;
    }
    persist();
    syncStSelect();
    await emit(event_types.CONNECTION_PROFILE_DELETED, removed);
    if (wasActive) {
        await emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
    }
    return true;
}
