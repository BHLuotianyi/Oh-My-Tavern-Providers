/**
 * OMTP Model Hub — per-chat and per-character model bindings.
 *
 * Chat bindings live in `chat_metadata.omtp` and are saved with the chat.
 * Character bindings live in `extension_settings.omtp.characterBindings[avatar]`.
 * A chat binding always wins over a character binding.
 */
import {
    characters,
    chat_metadata,
    getCurrentChatId,
    isGenerating,
} from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { getContext } from '../../../../../st-context.js';
import { eventSource } from '../../../../../events.js';
import { REASONING_LEVELS, ST_EVENTS } from '../constants.js';
import { getEntryKey, getSettings, isValidRef, parseEntryKey, saveSettings } from '../store.js';
import { applyReasoning, captureSelection, switchToEntry } from '../switch-engine.js';
import { getEntries, loadCatalog, resolveEntry } from '../catalog.js';
import { tr } from './dom.js';
import { isPlainObject, notify } from './helpers.js';

const APPLY_DELAY_MS = 150;
const GENERATION_WAIT_MS = 120000;

/** @type {string|null} */
let lastAppliedChatId = null;
/** @type {string|null} */
let lastAppliedRef = null;
let applying = false;
let pending = false;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @type {Promise<unknown>|null} */
let catalogPromise = null;

/**
 * Make sure catalog entries exist before resolving a binding. APP_READY can
 * fire while the first catalog fetch is still in flight; a bounded wait avoids
 * a spurious "unknown model" failure without blocking the chat switch.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function ensureCatalogLoaded(timeoutMs = 5000) {
    if (getEntries().length > 0) {
        return true;
    }
    if (!catalogPromise) {
        catalogPromise = Promise.resolve()
            .then(() => loadCatalog())
            .catch(() => null)
            .finally(() => {
                setTimeout(() => {
                    catalogPromise = null;
                }, 5000);
            });
    }
    await Promise.race([catalogPromise, delay(timeoutMs)]);
    return getEntries().length > 0;
}

/** Normalize an EntryRef, catalog entry or entry key into an EntryRef. */
function normalizeRef(value) {
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
    if (typeof value === 'string') {
        return parseEntryKey(value);
    }
    return null;
}

/** Avatar of the selected character, or null in group chats / no selection. */
function getCurrentAvatar() {
    try {
        const context = getContext?.();
        if (context?.groupId) {
            return null;
        }
        const characterId = context?.characterId;
        if (characterId === undefined || characterId === null) {
            return null;
        }
        const character = context?.characters?.[characterId];
        return character?.avatar ?? null;
    } catch {
        return null;
    }
}

function characterName(avatar) {
    try {
        const list = getContext?.()?.characters ?? characters ?? [];
        const character = list.find((item) => item?.avatar === avatar);
        return character?.name || avatar;
    } catch {
        return avatar;
    }
}

function sanitizeBinding(binding) {
    if (!isPlainObject(binding) || !isValidRef(binding.ref)) {
        return null;
    }
    return binding;
}

/**
 * Binding that applies to the current chat. Chat binding wins; otherwise the
 * selected character's binding (never in group chats).
 * @returns {object|null}
 */
export function getBindingForChat() {
    const chatBinding = sanitizeBinding(chat_metadata?.omtp);
    if (chatBinding) {
        return chatBinding;
    }
    const avatar = getCurrentAvatar();
    if (!avatar) {
        return null;
    }
    return sanitizeBinding(getSettings().characterBindings?.[avatar]);
}

function buildBinding(ref, options = {}) {
    const binding = {
        ref,
        createdAt: Date.now(),
    };
    const level = typeof options.reasoningEffort === 'string' ? options.reasoningEffort.trim().toLowerCase() : '';
    if (level && REASONING_LEVELS.includes(level)) {
        binding.reasoningEffort = level;
    }
    if (isPlainObject(options.extraBody) && Object.keys(options.extraBody).length > 0) {
        binding.extraBody = options.extraBody;
    }
    if (typeof options.label === 'string' && options.label.trim()) {
        binding.label = options.label.trim();
    }
    return binding;
}

async function refreshHubSelection() {
    try {
        const hub = await import('./hub.js');
        hub.refreshSelectionUI?.();
    } catch {
        // The hub may not be initialized yet.
    }
}

/**
 * Bind the current chat to a model.
 * @param {object} refOrEntry EntryRef or catalog entry
 * @param {{reasoningEffort?: string, extraBody?: object, label?: string}} [options]
 * @returns {object} The stored binding
 */
export function bindChat(refOrEntry, options = {}) {
    const ref = normalizeRef(refOrEntry);
    if (!ref) {
        throw new Error('Invalid model reference');
    }
    const chatId = getCurrentChatId?.();
    if (!chatId) {
        throw new Error('Open a chat before binding a model');
    }
    const binding = buildBinding(ref, options);
    chat_metadata.omtp = binding;
    saveMetadataDebounced();
    lastAppliedChatId = chatId;
    lastAppliedRef = getEntryKey(ref);
    renderBindingList();
    refreshHubSelection();
    return binding;
}

/**
 * Bind the selected character to a model.
 * @param {object} refOrEntry EntryRef or catalog entry
 * @param {{reasoningEffort?: string, extraBody?: object, label?: string}} [options]
 * @returns {object} The stored binding
 */
export function bindCharacter(refOrEntry, options = {}) {
    const ref = normalizeRef(refOrEntry);
    if (!ref) {
        throw new Error('Invalid model reference');
    }
    const avatar = getCurrentAvatar();
    if (!avatar) {
        throw new Error('Select a character first (character bindings are unavailable in group chats)');
    }
    const settings = getSettings();
    settings.characterBindings ??= {};
    const binding = buildBinding(ref, options);
    settings.characterBindings[avatar] = binding;
    saveSettings();
    renderBindingList();
    refreshHubSelection();
    return binding;
}

/** Remove the current chat binding. */
export function unbindChat() {
    if (chat_metadata?.omtp) {
        delete chat_metadata.omtp;
        saveMetadataDebounced();
    }
    lastAppliedChatId = null;
    lastAppliedRef = null;
    renderBindingList();
    refreshHubSelection();
}

/** Remove the selected character's binding. */
export function unbindCharacter() {
    const avatar = getCurrentAvatar();
    if (!avatar) {
        return;
    }
    unbindCharacterForAvatar(avatar);
}

function unbindCharacterForAvatar(avatar) {
    const settings = getSettings();
    if (settings.characterBindings?.[avatar]) {
        delete settings.characterBindings[avatar];
        saveSettings();
        renderBindingList();
        refreshHubSelection();
    }
}

/** Current selection key, or null when it cannot be mapped to a catalog entry. */
function currentSelectionKey() {
    try {
        const snapshot = captureSelection();
        if (snapshot?.ref) {
            return getEntryKey(snapshot.ref) || null;
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * Wait (once) for the active generation to finish. Resolves after a timeout so
 * a stuck generation can never block chat changes forever.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitForGenerationEnd(timeoutMs = GENERATION_WAIT_MS) {
    if (!isGenerating()) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        const event = ST_EVENTS.GENERATION_ENDED;
        if (typeof eventSource?.once === 'function') {
            eventSource.once(event, finish);
            // Generation may have ended between the isGenerating() check and
            // listener registration.
            if (!isGenerating()) {
                finish();
            }
        } else {
            const poll = () => {
                if (settled) {
                    return;
                }
                if (!isGenerating()) {
                    finish();
                } else {
                    setTimeout(poll, 500);
                }
            };
            setTimeout(poll, 500);
        }
    });
}

async function applyBindingForCurrentChat() {
    const chatId = getCurrentChatId?.();
    if (!chatId) {
        lastAppliedChatId = null;
        lastAppliedRef = null;
        return;
    }

    const binding = getBindingForChat();
    if (!binding) {
        lastAppliedChatId = chatId;
        lastAppliedRef = null;
        return;
    }

    const key = getEntryKey(binding.ref);
    if (!key) {
        return;
    }
    if (lastAppliedChatId === chatId && lastAppliedRef === key) {
        return;
    }

    await switchToBoundModel(chatId, key);
}

/** Delay, wait out any running generation, then switch once the binding survives the wait. */
async function switchToBoundModel(chatId, key) {
    await delay(APPLY_DELAY_MS);

    if (!getSettings().autoApplyBindings) {
        return;
    }
    if (getCurrentChatId?.() !== chatId) {
        return;
    }

    if (isGenerating()) {
        await waitForGenerationEnd();
        if (!getSettings().autoApplyBindings || getCurrentChatId?.() !== chatId) {
            return;
        }
    }

    // Re-read: the binding or the chat may have changed while waiting.
    const fresh = getBindingForChat();
    if (!fresh || getEntryKey(fresh.ref) !== key) {
        return;
    }

    if (currentSelectionKey() === key) {
        lastAppliedChatId = chatId;
        lastAppliedRef = key;
        return;
    }

    if (!(await ensureCatalogLoaded()) || getCurrentChatId?.() !== chatId) {
        // Catalog not ready yet: leave the guard unset so the next chat event
        // retries once entries are available.
        return;
    }
    const latest = getBindingForChat();
    if (!latest || getEntryKey(latest.ref) !== key) {
        return;
    }

    try {
        await switchToEntry(latest.ref, { reason: 'binding' });
        if (latest.reasoningEffort) {
            const entry = resolveEntry(latest.ref);
            if (entry) {
                applyReasoning(entry, latest.reasoningEffort);
            }
        }
        lastAppliedChatId = chatId;
        lastAppliedRef = key;
    } catch (error) {
        // Remember the attempt so a broken binding never loops.
        lastAppliedChatId = chatId;
        lastAppliedRef = key;
        notify('error', `Bound model unavailable: ${error?.message ?? error}`);
    }
}

/**
 * Apply the current chat/character binding. Called on APP_READY and
 * CHAT_CHANGED; serialized so overlapping calls cannot double-switch.
 */
export async function onChatChanged() {
    if (!getSettings().autoApplyBindings) {
        return;
    }
    if (applying) {
        pending = true;
        return;
    }
    applying = true;
    try {
        await applyBindingForCurrentChat();
    } catch (error) {
        console.warn('[omtp] could not apply model binding', error);
    } finally {
        applying = false;
        if (pending) {
            pending = false;
            setTimeout(() => {
                onChatChanged();
            }, 0);
        }
    }
}

/**
 * Initialize the bindings module. Event wiring is owned by events.js; this
 * only prepares the settings list (when the container exists).
 */
export function initBindings() {
    lastAppliedChatId = null;
    lastAppliedRef = null;
    renderBindingList();
}

/* ------------------------------------------------------------------ */
/* Settings list                                                      */
/* ------------------------------------------------------------------ */

function resolveListContainer(container) {
    if (container?.nodeType === 1) {
        if (container.id === 'omtp-character-bindings') {
            return container;
        }
        return container.querySelector?.('#omtp-character-bindings') ?? null;
    }
    return document.getElementById('omtp-character-bindings');
}

function renderBindingList() {
    renderCharacterBindings(resolveListContainer(null));
}

function renderCharacterBindings(list) {
    if (!list) {
        return;
    }
    list.textContent = '';

    const bindings = getSettings().characterBindings ?? {};
    const rows = Object.entries(bindings)
        .filter(([, binding]) => sanitizeBinding(binding))
        .sort(([a], [b]) => characterName(a).localeCompare(characterName(b)));

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.classList.add('omtp-muted');
        empty.textContent = tr('omtp_no_character_bindings', 'No character bindings');
        list.append(empty);
        return;
    }

    for (const [avatar, binding] of rows) {
        const row = document.createElement('div');
        row.classList.add('omtp-binding-row');

        const label = document.createElement('span');
        label.classList.add('omtp-binding-label');
        const model = binding.label || binding.ref.model;
        label.textContent = `${characterName(avatar)} → ${model} (${binding.ref.provider})`;
        label.title = `${avatar}\n${binding.ref.kind}/${binding.ref.provider}/${binding.ref.model}`;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.classList.add('menu_button');
        remove.textContent = tr('omtp_unbind', 'Unbind');
        remove.addEventListener('click', (event) => {
            event.preventDefault();
            unbindCharacterForAvatar(avatar);
            notify('info', tr('omtp_unbound', 'Binding removed'));
        });

        row.append(label, remove);
        list.append(row);
    }
}

/**
 * Render the character binding list inside the settings container.
 * @param {HTMLElement} [container] Settings container (or the list itself)
 */
export function initBindingUI(container) {
    const list = resolveListContainer(container);
    if (!list) {
        return;
    }
    renderCharacterBindings(list);
}
