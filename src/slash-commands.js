/**
 * Slash commands, mirroring omp's model/switch/effort trio.
 *
 *   /omtp                     open the hub
 *   /omtp stats               start (or reuse) the local stats dashboard
 *   /model [selector]         no arg: open the hub; with arg: set the model (persisted)
 *   /switch [selector]        no arg: quick picker; with arg: session-only switch
 *   /effort [level]           no arg: cycle the level; with arg: set it
 *
 * "Session-only" follows omp's `setModelTemporary`: the model is applied now
 * but the saved default selection is left untouched.
 *
 * Commands are registered once at activation and removed on teardown so a
 * reloaded extension never leaves stale handlers behind.
 */
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { oai_settings } from '../../../../openai.js';
import { getRequestHeaders } from '../../../../../script.js';
import { API_BASE, REASONING_LEVELS } from './constants.js';
import { EFFORT_ALIASES, normalizeEffortList } from './reasoning.js';
import { getEntries, resolveEntry, withProviderAvailability } from './catalog.js';
import { switchToSelector } from './public-api.js';
import { rankEntries } from './selector.js';
import { currentChatId } from './usage-session.js';
import { getSettings } from './store.js';
import { applyGlobalReasoning, applyReasoning, captureSelection } from './switch-engine.js';
import { openQuickPicker } from './ui/quick-picker.js';
import { describeError, tr, trf } from './ui/dom.js';

/** Names this module owns; used for idempotent teardown. */
const OWNED = ['omtp', 'model', 'switch', 'effort', 'usage'];

let registered = false;
/** @type {Function|null} */
let openHubFn = null;
/**
 * Commands replaced at registration time (SillyTavern ships its own `/model`),
 * keyed by owned name, so teardown can restore them.
 * @type {Map<string, {command: object|null, helpString: string|undefined}>}
 */
let previousCommands = new Map();

function openHub(options = {}) {
    const opener = openHubFn || globalThis.OMTP?.open;
    if (typeof opener !== 'function') {
        throw new Error('OMTP hub is not initialized');
    }
    opener(options);
}

/**
 * Start (or reuse) the plugin's local dashboard server — the `omp stats`
 * equivalent — and show it in a new tab. The server binds to loopback and exits
 * after a half hour without requests, so there is nothing to clean up here.
 * @returns {Promise<string>} the dashboard URL
 */
async function openStatsDashboard() {
    const chat = currentChatId();
    const lang = document.documentElement.lang || navigator.language || '';
    const params = new URLSearchParams();
    if (chat) params.set('chat', chat);
    if (lang) params.set('lang', lang);
    const query = params.toString() ? `?${params}` : '';
    const response = await fetch(`${API_BASE}/stats/server${query}`, { headers: getRequestHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.url) {
        throw new Error(tr('omtp_stats_server_failed', 'Could not start the stats dashboard.'));
    }
    const tab = window.open(data.url, '_blank');
    if (tab) {
        tab.opener = null;
    } else {
        // Popup blocked: the URL is still the answer, so surface it.
        const message = trf('omtp_stats_server_url', 'Stats dashboard: ${0}', data.url);
        if (globalThis.toastr?.info) globalThis.toastr.info(message);
        else console.info('[omtp]', message);
    }
    return data.url;
}

function entryKey(entry) {
    return entry?.key || `${entry?.kind}/${entry?.provider}/${entry?.model}`;
}

function label(entry) {
    return `${entry.provider}/${entry.model}`;
}

/** Entries that can be selected right now, server availability applied. */
function usableEntries() {
    return getEntries()
        .map(withProviderAvailability)
        .filter((entry) => entry.kind !== 'profile' && entry.available !== false);
}

/**
 * The entry SillyTavern is on right now, or null.
 * @returns {object|null}
 */
function currentEntry() {
    let ref = null;
    try {
        ref = captureSelection()?.ref ?? null;
    } catch {
        ref = null;
    }
    if (!ref) {
        ref = getSettings().lastSelection ?? null;
    }
    if (!ref) {
        return null;
    }
    const entry = resolveEntry(ref);
    return entry ? withProviderAvailability(entry) : null;
}

/**
 * Resolve a level argument the way omp does: exact match first, then a unique
 * prefix of at least two characters.
 * @param {string} raw
 * @param {string[]} choices
 * @returns {string|null}
 */
function resolveLevel(raw, choices) {
    const needle = String(raw || '').trim().toLowerCase();
    if (!needle) {
        return null;
    }
    const direct = EFFORT_ALIASES.get(needle) ?? needle;
    if (choices.includes(direct)) {
        return direct;
    }
    if (needle.length < 2) {
        return null;
    }
    const matches = choices.filter((choice) => choice.startsWith(needle));
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Levels the current model exposes, in cycle order.
 * @param {object} entry
 * @returns {string[]}
 */
function availableLevels(entry) {
    return normalizeEffortList(entry?.efforts);
}

/**
 * The level SillyTavern's own control currently holds, if it is set.
 * `/effort` writes that same control, so the dropdown is the source of truth
 * once the user touches it.
 * @returns {string}
 */
function liveLevel() {
    const value = String(oai_settings?.reasoning_effort ?? '').toLowerCase();
    return REASONING_LEVELS.includes(value) ? value : '';
}

/**
 * Current reasoning level for an entry: the live control first, then the
 * per-model memory, then `auto`.
 * @param {object|null} entry
 * @returns {string}
 */
function currentLevel(entry) {
    const live = liveLevel();
    if (live) {
        return live;
    }
    const stored = entry ? getSettings().reasoningByEntry?.[entryKey(entry)] : '';
    const value = String(stored || '').toLowerCase();
    return REASONING_LEVELS.includes(value) ? value : 'auto';
}

/**
 * Error for an `/effort` argument that names no available level.
 * @param {string} requested
 * @param {string[]} levels
 * @returns {Error}
 */
function unknownEffortError(requested, levels) {
    return new Error(trf(
        'omtp_unknown_effort',
        'Unknown thinking level: ${0}. Available: ${1}',
        requested.toLowerCase(),
        levels.join(', '),
    ));
}

/**
 * Set a level with no model selected (no connection yet): ST's own reasoning
 * control still applies, exactly like the built-in settings dropdown.
 * @param {string|null} requested
 * @returns {string}
 */
function setGlobalLevel(requested) {
    const active = currentLevel(null);
    let level = active;
    if (requested) {
        const resolved = resolveLevel(requested, REASONING_LEVELS);
        if (!resolved) {
            throw unknownEffortError(requested, REASONING_LEVELS);
        }
        level = resolved;
    } else {
        const index = REASONING_LEVELS.indexOf(active);
        level = REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length];
    }
    const { applied } = applyGlobalReasoning(level);
    return applied
        ? trf('omtp_effort_set', 'Thinking set to ${0}.', level)
        : trf('omtp_effort_idle', 'Thinking level ${0} saved. It applies once an OpenAI-compatible connection is active.', level);
}

/**
 * Apply and report a reasoning level.
 * @param {object} entry
 * @param {string} level
 * @returns {string}
 */
function setLevel(entry, level) {
    applyReasoning(entry, level);
    return trf('omtp_effort_set', 'Thinking set to ${0}.', level);
}

/**
 * Shared handler for `/model` and `/switch`.
 * @param {string} rawSelector
 * @param {boolean} persist
 * @returns {Promise<string>}
 */
async function applySelector(rawSelector, persist) {
    const selector = String(rawSelector || '').trim();
    if (!selector) {
        throw new Error(tr('omtp_selector_required', 'Enter a model selector'));
    }
    let ref;
    try {
        ref = await switchToSelector(selector, { persist });
    } catch (error) {
        // The engine throws coded errors; show the user's language.
        throw new Error(describeError(error));
    }
    const entry = resolveEntry(ref);
    const name = entry ? label(entry) : `${ref.provider}/${ref.model}`;
    const message = persist
        ? trf('omtp_model_set', 'Model set to ${0}.', name)
        : trf('omtp_switch_session', 'Session-only model: ${0}.', name);
    // A fuzzy selector can resolve to one of several candidates; say so.
    return ref.warning ? `${message}\n${ref.warning}` : message;
}

/**
 * Remember what each owned name currently holds, so teardown can put foreign
 * commands (notably SillyTavern's built-in `/model`) back.
 */
function snapshotOwnedCommands() {
    const commands = SlashCommandParser.commands;
    const helpStrings = SlashCommandParser.helpStrings;
    previousCommands = new Map();
    for (const name of OWNED) {
        previousCommands.set(name, {
            command: commands?.[name] ?? null,
            helpString: helpStrings?.[name],
        });
    }
}

/**
 * Register `/omtp`, `/model`, `/switch`, `/effort`. Safe to call repeatedly.
 * @param {{open?: Function}} [hooks] hub entry point bound to `/omtp`
 */
export function initSlashCommands(hooks = {}) {
    if (typeof hooks.open === 'function') {
        openHubFn = hooks.open;
    }
    if (registered) {
        return;
    }
    registered = true;

    try {
        snapshotOwnedCommands();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'omtp',
            callback: async (_named, subcommand) => {
                const sub = String(subcommand ?? '').trim().toLowerCase();
                if (sub === 'stats') {
                    return openStatsDashboard();
                }
                if (sub && sub !== 'hub') {
                    throw new Error(trf('omtp_unknown_subcommand', 'Unknown subcommand: ${0}. Try `stats`.', sub));
                }
                openHub();
                return '';
            },
            unnamedArgumentList: [
                new SlashCommandArgument(
                    'Optional subcommand: `stats` starts the local statistics dashboard; without it the hub opens.',
                    [ARGUMENT_TYPE.STRING],
                    false,
                ),
            ],
            helpString: 'Open the OMTP model hub, or with `stats` the local token/cost dashboard.',
            returns: ARGUMENT_TYPE.STRING,
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'model',
            callback: async (_named, selector) => {
                const raw = String(selector ?? '').trim();
                if (!raw) {
                    openHub();
                    return '';
                }
                return applySelector(raw, true);
            },
            // SillyTavern ships its own `/model`; this keeps scripts that pass
            // `--quiet` working even though the switch never toasts here.
            namedArgumentList: [
                new SlashCommandNamedArgument(
                    'quiet',
                    'Accepted for compatibility; this command never toasts.',
                    [ARGUMENT_TYPE.BOOLEAN],
                    false,
                    false,
                    'false',
                ),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument(
                    'Optional model selector: `provider/model`, a fuzzy id, `@1`-`@9`, `@fav`, or `model:level`. Without it the hub opens.',
                    [ARGUMENT_TYPE.STRING],
                    false,
                ),
            ],
            helpString: 'Set the model for this session and remember it as the default. Without an argument, opens the hub.',
            returns: ARGUMENT_TYPE.STRING,
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'switch',
            callback: async (_named, selector) => {
                const raw = String(selector ?? '').trim();
                if (raw) {
                    return applySelector(raw, false);
                }
                const current = currentEntry();
                openQuickPicker({
                    items: usableEntries(),
                    currentKey: current ? entryKey(current) : '',
                    title: tr('omtp_picker_title', 'Switch model'),
                    hint: tr('omtp_picker_hint', 'session-only'),
                    rank: (query, list) => rankEntries(list, query, {
                        favorites: getSettings().favorites,
                        recents: getSettings().recents,
                        limit: list.length,
                    }),
                    onPick: (entry) => {
                        switchToSelector(`${entry.provider}/${entry.model}`, { persist: false })
                            .catch((error) => console.warn('[omtp] switch failed', error));
                    },
                });
                return '';
            },
            unnamedArgumentList: [
                new SlashCommandArgument(
                    'Optional model selector. Without it a compact picker opens.',
                    [ARGUMENT_TYPE.STRING],
                    false,
                ),
            ],
            helpString: 'Switch the model for this session only, leaving the saved default alone. Without an argument, opens the quick picker.',
            returns: ARGUMENT_TYPE.STRING,
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'usage',
            callback: () => {
                openHub({ tab: 'usage' });
                return '';
            },
            helpString: 'Open the model hub on the provider usage page.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'effort',
            callback: (_named, rawLevel) => {
                const entry = currentEntry();
                // Without a usable, reasoning-capable model (no key, not signed
                // in, nothing selected) fall back to SillyTavern's own reasoning
                // control, exactly like the built-in settings menu.
                if (!entry || !entry.reasoning || entry.available === false) {
                    return setGlobalLevel(String(rawLevel ?? '').trim() || null);
                }
                const levels = availableLevels(entry);
                const requested = String(rawLevel ?? '').trim();
                if (!requested) {
                    const active = currentLevel(entry);
                    const index = levels.indexOf(active);
                    const next = levels[(index + 1) % levels.length] ?? levels[0];
                    return setLevel(entry, next);
                }
                const resolved = resolveLevel(requested, levels);
                if (!resolved) {
                    throw unknownEffortError(requested, levels);
                }
                return setLevel(entry, resolved);
            },
            unnamedArgumentList: [
                new SlashCommandArgument(
                    'Optional level (`auto`, `min`, `low`, `medium`, `high`, `max`, or a unique prefix). Without it the level cycles.',
                    [ARGUMENT_TYPE.STRING],
                    false,
                ),
            ],
            helpString: 'Show, set or cycle the reasoning effort of the current model; without a model it sets SillyTavern\'s own reasoning control.',
            returns: ARGUMENT_TYPE.STRING,
        }));
    } catch (error) {
        registered = false;
        console.warn('[omtp] could not register slash commands', error);
        throw error;
    }
}

/**
 * Remove the commands this module registered. Leaves foreign commands alone.
 */
export function teardownSlashCommands() {
    if (!registered) {
        return;
    }
    registered = false;
    openHubFn = null;
    const commands = SlashCommandParser.commands;
    const helpStrings = SlashCommandParser.helpStrings;
    for (const name of OWNED) {
        const command = commands?.[name];
        if (command) {
            for (const key of [command.name, ...(command.aliases || [])]) {
                if (commands[key] === command) {
                    delete commands[key];
                }
            }
        }
        const previous = previousCommands.get(name);
        if (previous?.command) {
            commands[name] = previous.command;
        }
        if (helpStrings) {
            if (previous?.helpString !== undefined) {
                helpStrings[name] = previous.helpString;
            } else {
                delete helpStrings[name];
            }
        }
    }
    previousCommands = new Map();
}
