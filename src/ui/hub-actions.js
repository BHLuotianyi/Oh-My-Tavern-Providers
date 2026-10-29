/**
 * Bindings and per-model actions for the hub.
 */
import { chat_metadata } from '../../../../../../script.js';
import * as engine from '../switch-engine.js';
import * as bindings from './bindings.js';
import { describeError, tr, trf } from './dom.js';
import { state } from './hub-state.js';
import { notify } from './helpers.js';
import { currentAvatar, entryKey, refOf, sameRef, settings } from './hub-utils.js';
import { renderList } from './hub-list.js';
import { renderDetails } from './hub-details.js';
import { renderProviderList, revealLoginRow } from './hub-sidebar.js';
import { refreshSelectionUI, renderQuickBar, syncTabs } from './hub-quick.js';
import { closeHub, openHub } from './hub-modal.js';

/** @returns {object|null} Chat-only binding (ignores character fallback). */
export function getChatBinding() {
    try {
        const binding = chat_metadata?.omtp;
        return binding && typeof binding === 'object' && binding.ref ? binding : null;
    } catch {
        return null;
    }
}

/** @returns {object|null} Binding that applies to the current chat. */
export function getEffectiveBinding() {
    try {
        return bindings.getBindingForChat();
    } catch {
        return null;
    }
}

/** @returns {object|null} */
export function getCharacterBinding() {
    const avatar = currentAvatar();
    if (!avatar) {
        return null;
    }
    return settings().characterBindings?.[avatar] ?? null;
}

/**
 * Toggle the chat binding for an entry.
 * @param {object} entry
 */
export async function toggleChatBinding(entry) {
    const ref = refOf(entry);
    const current = getChatBinding();
    if (current?.ref && sameRef(current.ref, ref)) {
        await bindings.unbindChat();
        notify('info', tr('omtp_unbound', 'Binding removed'));
    } else {
        await bindings.bindChat(ref, { reasoningEffort: currentReasoning(entry) });
        notify('success', trf('omtp_bound_chat', 'Chat bound to ${0}', entry.modelLabel || entry.model));
    }
    if (state.isOpen) {
        renderDetails();
    }
}

/**
 * Toggle the character binding for an entry.
 * @param {object} entry
 */
export async function toggleCharacterBinding(entry) {
    const ref = refOf(entry);
    const current = getCharacterBinding();
    if (current?.ref && sameRef(current.ref, ref)) {
        await bindings.unbindCharacter();
        notify('info', tr('omtp_unbound', 'Binding removed'));
    } else {
        await bindings.bindCharacter(ref, { reasoningEffort: currentReasoning(entry) });
        notify('success', trf('omtp_bound_character', 'Character bound to ${0}', entry.modelLabel || entry.model));
    }
    if (state.isOpen) {
        renderDetails();
    }
}

/**
 * Reasoning level currently chosen for an entry.
 * @param {object} entry
 * @returns {string}
 */
function currentReasoning(entry) {
    return settings().reasoningByEntry?.[entryKey(entry)] || 'auto';
}

/**
 * Switch SillyTavern to an entry.
 * @param {object|null} entry
 * @param {{throwOnError?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function useEntry(entry, { throwOnError = false } = {}) {
    if (!entry) {
        const error = new Error('Unknown model');
        if (throwOnError) {
            throw error;
        }
        notify('error', error.message);
        return false;
    }
    if (entry.available === false) {
        const message = entry.unsupportedReason
            ? trf('omtp_unsupported', 'Not selectable: ${0}', entry.unsupportedReason)
            : tr('omtp_status_unavailable', 'Unavailable');
        if (throwOnError) {
            throw new Error(message);
        }
        notify('warning', message);
        return false;
    }
    try {
        await engine.switchToEntry(refOf(entry), { reason: 'hub' });
        state.selectedEntryKey = entryKey(entry);
        refreshSelectionUI();
        notify('success', trf('omtp_model_in_use', 'Now using ${0}', `${entry.modelLabel || entry.model} · ${entry.providerLabel || entry.provider}`));
        if (state.isOpen) {
            renderList();
            renderDetails();
            renderQuickBar();
        }
        return true;
    } catch (error) {
        if (throwOnError) {
            throw error;
        }
        notify('error', trf('omtp_switch_failed', 'Could not switch model: ${0}', describeError(error)));
        return false;
    }
}

/**
 * Reveal SillyTavern's Connection Profiles panel.
 *
 * Profile entries are read-only in the hub: renaming, updating or deleting one
 * happens in SillyTavern. The old code only toasted "manage it over there" and
 * closed the hub, which left the user with no way to actually change anything.
 */
function revealConnectionManager(profileId = '') {
    const select = document.getElementById('connection_profiles');
    if (!select) {
        notify('warning', tr('omtp_profiles_disabled', 'Enable the Connection Profiles extension in SillyTavern to edit profiles'));
        return;
    }
    const drawer = document.getElementById('rm_api_block');
    const systemButton = document.getElementById('sys-settings-button');
    if (drawer?.classList.contains('closedDrawer') && systemButton) {
        systemButton.querySelector('.drawer-toggle')?.click();
    }
    const block = select.closest('.inline-drawer') || select;
    setTimeout(() => {
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        block.classList.add('omtp-highlight');
        setTimeout(() => block.classList.remove('omtp-highlight'), 2000);
        // Point at the profile the user asked about. Selecting it would apply
        // the connection, so the hub only moves the focus, never the value.
        const option = Array.from(select.options).find((item) => item.value === String(profileId));
        if (option) {
            option.scrollIntoView({ block: 'nearest' });
        }
    }, 150);
}

/**
 * Open the relevant provider settings for an entry.
 * @param {object} entry
 */
export function openProviderSettings(entry) {
    if (entry.kind === 'profile') {
        closeHub();
        revealConnectionManager(entry.model);
        return;
    }
    if (entry.kind === 'st' && entry.nativeAdapter) {
        closeHub();
        const blockSelector = entry.nativeAdapter.settingsBlock;
        const block = blockSelector ? document.querySelector(blockSelector) : null;
        const drawer = document.getElementById('rm_api_block');
        const systemButton = document.getElementById('sys-settings-button');
        if (drawer?.classList.contains('closedDrawer') && systemButton) {
            systemButton.querySelector('.drawer-toggle')?.click();
        }
        if (block) {
            setTimeout(() => {
                block.scrollIntoView({ behavior: 'smooth', block: 'center' });
                block.classList.add('omtp-highlight');
                setTimeout(() => block.classList.remove('omtp-highlight'), 2000);
            }, 150);
        } else {
            notify('info', tr('omtp_configure_native', 'Configure in SillyTavern'));
        }
        return;
    }
    focusProviderSettings(entry.provider);
}

/**
 * Focus the sign-in row for a gateway provider.
 * @param {string} provider
 */
function focusProviderSettings(provider) {
    if (!state.isOpen) {
        openHub();
    }
    state.currentTab = 'providers';
    syncTabs();
    renderProviderList();
    renderList();

    setTimeout(() => revealLoginRow(provider, {
        retry: true,
        focusInput: true,
        duration: 2000,
        onMissing: () => notify('info', tr('omtp_configure_native', 'Configure in SillyTavern')),
    }), 150);
}

/**
 * Copy the selector for an entry to the clipboard.
 * @param {object} entry
 */
export async function copySelector(entry) {
    const text = entry.kind === 'omp' ? `${entry.provider}/${entry.model}` : entry.model;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            notify('success', tr('omtp_copied', 'Selector copied'));
            return;
        }
        throw new Error('Clipboard unavailable');
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.append(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
            notify('success', tr('omtp_copied', 'Selector copied'));
        } catch {
            notify('error', tr('omtp_copy_failed', 'Could not copy selector'));
        }
    }
}
