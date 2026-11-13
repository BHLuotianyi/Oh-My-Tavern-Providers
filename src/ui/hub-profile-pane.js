/**
 * Connection Profile details pane and toolbar rendering for the hub.
 */
import { CONNECT_API_MAP, main_api } from '../../../../../../script.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import {
    ALLOW_EMPTY,
    FIELD_LABELS,
    SELECT_FIELDS,
    STATE_FIELDS,
    apiChoices,
    fieldsForMode,
    isExcluded,
    profileMode,
    profileSummary,
    validateProfileName,
} from '../profile-fields.js';
import { describeError, tr } from './dom.js';
import { el, notify } from './helpers.js';
import { rebuildEntries } from './hub-catalog.js';
import {
    applyProfile,
    clearActiveProfile,
    createBlank,
    createFromCurrent,
    deleteProfile,
    duplicateProfile,
    findProfile,
    isConnectionManagerEnabled,
    isProfileActive,
    profileKey,
    profiles,
    renameProfile,
    setProfileField,
    setProfileIncluded,
    updateActive,
} from './hub-profile-store.js';
import { state } from './hub-state.js';

/**
 * Move the hub selection to a profile and re-render.
 * @param {string} id
 */
function focusProfile(id) {
    state.selectedEntryKey = profileKey(id);
    rebuildEntries();
}

/**
 * Run a profile action, reporting failures as toasts.
 * @param {Function} action
 * @param {string} [success]
 */
function run(action, success = '') {
    Promise.resolve()
        .then(action)
        .then((result) => {
            if (success && result !== false) {
                notify('success', success);
            }
        })
        .catch((error) => notify('error', describeError(error)));
}

/**
 * Options for a field, taken from the slash command that records it: the static
 * enum list first, then the provider (presets and secrets are dynamic).
 * @param {string} field
 * @returns {Promise<Array<{value: string, label: string}>>}
 */
async function fieldOptions(field) {
    const command = SlashCommandParser?.commands?.[field];
    const argument = command?.unnamedArgumentList?.[0] ?? command?.namedArgumentList?.[0] ?? null;
    let list = Array.isArray(argument?.enumList) ? argument.enumList : [];
    if (!list.length && typeof argument?.enumProvider === 'function') {
        list = await Promise.resolve(argument.enumProvider());
    }
    return (Array.isArray(list) ? list : [])
        .map((item) => ({
            value: String(item?.value ?? ''),
            label: String(item?.description ?? item?.value ?? ''),
        }))
        .filter((option) => option.value !== '');
}

/**
 * Localised mode name.
 * @param {'cc'|'tc'} mode
 * @returns {string}
 */
function modeLabelText(mode) {
    return mode === 'cc'
        ? tr('omtp_profile_mode_cc', 'Chat completion')
        : tr('omtp_profile_mode_tc', 'Text completion');
}

/** @returns {HTMLButtonElement} */
function profileButton(label, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `omtp-profile-action${extraClass ? ` ${extraClass}` : ''}`;
    button.textContent = label;
    return button;
}

/**
 * @param {object} profile
 * @returns {HTMLElement}
 */
function buildApiSelect(profile) {
    // Every API is offered: picking one from the other mode converts the
    // profile (its fields are pruned to the new command set).
    const chatChoices = apiChoices('cc', CONNECT_API_MAP);
    const textChoices = apiChoices('tc', CONNECT_API_MAP);
    const select = document.createElement('select');
    select.className = 'omtp-profile-select';
    select.append(new Option(tr('omtp_profile_unset', 'Not recorded'), ''));
    const addGroup = (label, choices) => {
        if (!choices.length) {
            return;
        }
        const group = document.createElement('optgroup');
        group.label = label;
        for (const choice of choices) {
            group.append(new Option(choice.label, choice.value));
        }
        select.append(group);
    };
    addGroup(tr('omtp_profile_mode_cc', 'Chat completion'), chatChoices);
    addGroup(tr('omtp_profile_mode_tc', 'Text completion'), textChoices);
    const current = String(profile.api ?? '');
    const known = [...chatChoices, ...textChoices].some((choice) => choice.value === current);
    if (current && !known) {
        select.append(new Option(current, current));
    }
    select.value = current;
    select.addEventListener('change', () => {
        if (setProfileField(profile, 'api', select.value)) {
            rebuildEntries();
            return;
        }
        // Same mode: only the summary line changes, so keep the pane (and the
        // field editors below it) untouched.
        const summary = document.querySelector('#omtp-details .omtp-profile-sub');
        if (summary) {
            summary.textContent = `${modeLabelText(profileMode(profile, main_api))} · ${profileSummary(profile)}`;
        }
    });
    return select;
}

/**
 * @param {object} profile
 * @param {string} field
 * @returns {HTMLElement}
 */
function buildStateSelect(profile, field) {
    const select = document.createElement('select');
    select.className = 'omtp-profile-select';
    select.append(
        new Option(tr('omtp_profile_unset', 'Not recorded'), ''),
        new Option(tr('omtp_profile_on', 'On'), 'true'),
        new Option(tr('omtp_profile_off', 'Off'), 'false'),
    );
    select.value = String(profile[field] ?? '');
    select.addEventListener('change', () => setProfileField(profile, field, select.value));
    return select;
}

/**
 * @param {Array<{value: string, label: string}>} options
 * @param {object} profile
 * @param {string} field
 * @returns {HTMLSelectElement}
 */
function buildSelect(options, profile, field) {
    const select = document.createElement('select');
    select.className = 'omtp-profile-select';
    select.append(new Option(tr('omtp_profile_unset', 'Not recorded'), ''));
    const current = String(profile[field] ?? '');
    const seen = new Set();
    for (const option of options) {
        if (seen.has(option.value)) {
            continue;
        }
        seen.add(option.value);
        const text = option.label && option.label !== option.value
            ? `${option.value} — ${option.label}`
            : option.value;
        select.append(new Option(text, option.value));
    }
    if (current && !seen.has(current)) {
        select.append(new Option(current, current));
    }
    select.value = current;
    select.addEventListener('change', () => setProfileField(profile, field, select.value));
    return select;
}

/**
 * Text input first (usable immediately), upgraded to a select when the command
 * offers choices.
 * @param {object} profile
 * @param {string} field
 * @returns {HTMLElement}
 */
function buildFieldControl(profile, field) {
    if (field === 'api') {
        return buildApiSelect(profile);
    }
    if (STATE_FIELDS.has(field)) {
        return buildStateSelect(profile, field);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'omtp-profile-input';
    input.value = String(profile[field] ?? '');
    input.placeholder = ALLOW_EMPTY.has(field)
        ? tr('omtp_profile_empty_allowed', 'Empty clears it')
        : tr('omtp_profile_unset', 'Not recorded');
    input.addEventListener('change', () => setProfileField(profile, field, input.value));
    if (SELECT_FIELDS.has(field)) {
        fieldOptions(field)
            .then((options) => {
                if (!options.length || !input.isConnected) {
                    return;
                }
                const select = buildSelect(options, profile, field);
                select.disabled = input.disabled;
                input.replaceWith(select);
            })
            .catch(() => {
                // Keep the text input when the provider fails.
            });
    }
    return input;
}

/**
 * One field row: include checkbox, label, value control.
 * @param {object} profile
 * @param {string} field
 * @returns {HTMLElement}
 */
function buildFieldRow(profile, field) {
    const [key, fallback] = FIELD_LABELS[field] ?? [field, field];
    const row = el('div', 'omtp-profile-field');
    row.dataset.field = field;
    const excluded = isExcluded(profile, field);
    if (excluded) {
        row.classList.add('omtp-excluded');
    }
    const include = document.createElement('input');
    include.type = 'checkbox';
    include.className = 'omtp-profile-include';
    include.checked = !excluded;
    include.title = tr('omtp_profile_include_hint', 'Uncheck to keep this setting out of the profile');
    const control = buildFieldControl(profile, field);
    control.disabled = excluded;
    include.addEventListener('change', () => {
        const included = include.checked;
        setProfileIncluded(profile, field, included);
        row.classList.toggle('omtp-excluded', !included);
        control.disabled = !included;
        if (!included) {
            control.value = '';
        }
    });
    row.append(include, el('span', 'omtp-profile-field-label', tr(key, fallback)), control);
    return row;
}

/**
 * @param {object} profile
 * @returns {HTMLElement}
 */
function buildNameRow(profile) {
    const row = el('label', 'omtp-profile-name-row');
    row.append(el('span', 'omtp-profile-field-label', tr('omtp_profile_name', 'Name')));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'omtp-profile-input';
    input.value = String(profile.name ?? '');
    input.addEventListener('change', () => {
        const reason = validateProfileName(input.value, profiles(), profile.id);
        if (reason) {
            const message = reason === 'empty'
                ? tr('omtp_profile_name_empty', 'The profile name cannot be empty.')
                : reason === 'reserved'
                    ? tr('omtp_profile_name_reserved', '"<None>" is reserved by SillyTavern.')
                    : tr('omtp_profile_name_duplicate', 'A profile with that name already exists.');
            notify('warning', message);
            input.value = String(profile.name ?? '');
            return;
        }
        if (input.value.trim() === profile.name) {
            return;
        }
        try {
            renameProfile(profile.id, input.value);
            notify('success', tr('omtp_profile_renamed', 'Connection profile renamed.'));
        } catch (error) {
            notify('error', describeError(error));
            input.value = String(profile.name ?? '');
        }
    });
    row.append(input);
    return row;
}

/**
 * @param {object} profile
 * @param {boolean} active
 * @returns {HTMLElement}
 */
function buildActions(profile, active) {
    const row = el('div', 'omtp-profile-actions');

    const use = profileButton(
        active ? tr('omtp_profile_reapply', 'Re-apply') : tr('omtp_profile_use', 'Use'),
        'omtp-primary',
    );
    use.title = tr('omtp_profile_use_hint', 'Apply this profile: its API, URL, model, preset and templates become the live connection');
    use.addEventListener('click', () => run(
        () => applyProfile(profile.id),
        tr('omtp_profile_applied', 'Connection profile applied'),
    ));
    row.append(use);

    if (active) {
        const none = profileButton(tr('omtp_profile_stop', 'Stop using'));
        none.title = tr('omtp_profile_stop_hint', 'Switch SillyTavern back to "None"; the current connection settings stay as they are');
        none.addEventListener('click', () => run(
            () => clearActiveProfile(),
            tr('omtp_profile_cleared', 'No profile in use'),
        ));
        row.append(none);
    }

    const update = profileButton(tr('omtp_profile_update', 'Update from current'));
    update.title = active
        ? tr('omtp_profile_update_hint_active', 'Record the live connection settings into this profile')
        : tr('omtp_profile_update_hint', 'Use this profile first, then update it from the live connection');
    update.disabled = !active;
    update.addEventListener('click', () => run(
        async () => {
            await updateActive();
            rebuildEntries();
        },
        tr('omtp_profile_updated', 'Profile updated from the current connection'),
    ));
    row.append(update);

    const duplicate = profileButton(tr('omtp_profile_duplicate', 'Duplicate'));
    duplicate.title = tr('omtp_profile_duplicate_hint', 'Copy this profile, including its recorded settings');
    duplicate.addEventListener('click', () => run(async () => {
        const copy = await duplicateProfile(profile.id);
        focusProfile(copy.id);
    }));
    row.append(duplicate);

    row.append(buildDeleteButton(profile));
    return row;
}

/**
 * Two-step delete: no modal on top of the hub, and no accidental removal.
 * @param {object} profile
 * @returns {HTMLButtonElement}
 */
function buildDeleteButton(profile) {
    const button = profileButton(tr('omtp_profile_delete', 'Delete'), 'omtp-danger');
    button.title = tr('omtp_profile_delete_hint', 'Remove this profile; the live connection is not changed');
    let armed = false;
    let timer = null;
    const reset = () => {
        armed = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        button.textContent = tr('omtp_profile_delete', 'Delete');
        button.classList.remove('omtp-danger-armed');
    };
    button.addEventListener('click', (event) => {
        event.preventDefault();
        if (!armed) {
            armed = true;
            button.textContent = tr('omtp_profile_delete_confirm', 'Delete? Click again');
            button.classList.add('omtp-danger-armed');
            timer = setTimeout(reset, 4000);
            return;
        }
        reset();
        run(async () => {
            if (state.selectedEntryKey === profileKey(profile.id)) {
                state.selectedEntryKey = null;
            }
            await deleteProfile(profile.id);
            rebuildEntries();
        }, tr('omtp_profile_deleted', 'Connection profile deleted'));
    });
    return button;
}

/**
 * Details pane for a profile entry.
 * @param {object} entry
 * @param {HTMLElement} details
 */
export function renderProfileDetails(entry, details) {
    const profile = findProfile(entry?.model) ?? (entry?.profile ?? null);
    if (!profile || !profiles().includes(profile)) {
        details.append(el('div', 'omtp-empty-state', tr('omtp_profile_missing', 'That connection profile no longer exists.')));
        return;
    }
    const mode = profileMode(profile, main_api);
    const active = isProfileActive(profile.id);

    const head = el('div', 'omtp-profile-head');
    head.append(el('h3', null, profile.name || profile.id));
    head.append(el('span', 'omtp-badge omtp-badge-profile', tr('omtp_profile_badge', 'Profile')));
    if (active) {
        head.append(el('span', 'omtp-profile-active', tr('omtp_profile_active', 'In use')));
    }
    details.append(head);

    details.append(el('div', 'omtp-profile-sub', `${modeLabelText(mode)} · ${profileSummary(profile)}`));
    details.append(buildActions(profile, active));
    details.append(buildNameRow(profile));

    const fields = el('div', 'omtp-profile-fields');
    fields.append(el('div', 'omtp-profile-fields-title', tr('omtp_profile_fields_title', 'Recorded settings')));
    for (const field of fieldsForMode(mode)) {
        fields.append(buildFieldRow(profile, field));
    }
    details.append(fields);
    details.append(el('div', 'omtp-profile-hint', tr(
        'omtp_profile_hint',
        'A profile stores connection settings only — chats, characters and prompts are untouched.',
    )));
}

/**
 * Create buttons shown above the profile lists.
 * @param {HTMLElement} listElement
 */
export function appendProfilesToolbar(listElement) {
    const bar = el('div', 'omtp-profiles-toolbar');
    if (!isConnectionManagerEnabled()) {
        bar.append(el('div', 'omtp-profiles-toolbar-hint', tr(
            'omtp_profiles_disabled',
            'Enable the Connection Profiles extension in SillyTavern first.',
        )));
        listElement.append(bar);
        return;
    }
    const create = el('button', 'omtp-profile-new', `＋ ${tr('omtp_profile_create_current', 'From current connection')}`);
    create.type = 'button';
    create.title = tr('omtp_profile_create_current_hint', 'Record the API, URL, model, preset and secret currently in use');
    create.addEventListener('click', () => run(async () => {
        const profile = await createFromCurrent();
        focusProfile(profile.id);
    }, tr('omtp_profile_created', 'Connection profile created')));

    const blank = el('button', 'omtp-profile-new omtp-profile-new-blank', `＋ ${tr('omtp_profile_create_blank', 'Empty profile')}`);
    blank.type = 'button';
    blank.title = tr('omtp_profile_create_blank_hint', 'Create a profile with no settings and fill the fields in the details pane');
    blank.addEventListener('click', () => run(async () => {
        const profile = await createBlank();
        focusProfile(profile.id);
    }, tr('omtp_profile_created', 'Connection profile created')));

    bar.append(create, blank);
    listElement.append(bar);
}
