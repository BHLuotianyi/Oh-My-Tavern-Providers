/**
 * OMTP Model Hub — DOM injection helpers.
 *
 * Everything here is additive: the extension never removes, reparents or
 * rewrites SillyTavern's own controls (#main_api, #main-API-selector-block,
 * #sys-settings-button, #rm_api_block, #API-status-top). Only the nodes this
 * module created are removed again in cleanupDom().
 */
import { getSettings } from '../store.js';
import { translate } from '../../../../../i18n.js';

const TOP_BAR_ID = 'omtp-hub-button';
const API_TOOLS_ID = 'omtp-api-drawer-tools';
const MODAL_ID = 'omtp-hub-overlay';
const HIDE_NATIVE_CLASS = 'omtp-hide-native-api-selector';

/** @type {Array<{target: EventTarget, type: string, handler: Function}>} */
const boundListeners = [];
/** @type {((event: Event) => void)|null} */
let hotkeyHandler = null;

/**
 * Translate a namespaced key with an English fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function tr(key, fallback) {
    try {
        const translated = translate(fallback, key);
        return translated || fallback;
    } catch {
        return fallback;
    }
}

/**
 * Messages for errors thrown by the switch engine and the selector.
 * Keys are the `code` values from `errors.js`.
 * @type {Record<string, [string, string]>}
 */
const ERROR_TEXT = {
    generating: ['omtp_err_generating', 'Cannot switch while generating'],
    invalid_ref: ['omtp_err_invalid_ref', 'Invalid model reference'],
    invalid_selection: ['omtp_err_invalid_selection', 'Invalid selection'],
    unknown_model: ['omtp_err_unknown_model', 'Unknown model: ${0}'],
    unsupported: ['omtp_err_unsupported', 'Model ${0} is not supported'],
    unavailable: ['omtp_err_unavailable', 'Model ${0} is unavailable'],
    no_native_adapter: ['omtp_err_no_native_adapter', 'No native SillyTavern adapter for ${0}'],
    model_unavailable: ['omtp_err_model_unavailable', 'Model ${0} is not available in ${1}'],
    ui_not_ready: ['omtp_err_ui_not_ready', 'SillyTavern UI is not ready'],
    api_switch: ['omtp_err_api_switch', 'Failed to switch the API to ${0}'],
    source_switch: ['omtp_err_source_switch', 'Failed to select the chat completion source ${0}'],
    textgen_switch: ['omtp_err_textgen_switch', 'Failed to select the text generation type ${0}'],
    novel_model: ['omtp_err_novel_model', 'Failed to select the NovelAI model ${0}'],
    control_missing: ['omtp_err_control_missing', 'Native model control not found: ${0}'],
    model_apply: ['omtp_err_model_apply', 'Failed to apply the model ${0}'],
    connect_failed: ['omtp_err_connect_failed', 'Connection failed for ${0}'],
    gateway_off: ['omtp_err_gateway_off', 'OMTP Gateway unavailable (enable server plugins)'],
    gateway_reason: ['omtp_err_gateway_reason', 'OMTP Gateway unavailable: ${0}'],
    gateway_url: ['omtp_err_gateway_url', 'OMTP Gateway URL is not configured'],
    gateway_token: ['omtp_err_gateway_token', 'OMTP Gateway token is unavailable'],
    gateway_model: ['omtp_err_gateway_model', 'Failed to set the gateway model ${0}'],
    gateway_model_id: ['omtp_err_gateway_model_id', 'Gateway model id is missing'],
    custom_source: ['omtp_err_custom_source', 'Failed to select the custom chat completion source'],
    key_rejected: ['omtp_err_key_rejected', 'Provider ${0} rejected its key (${1})'],
    needs_key: ['omtp_err_needs_key', 'Provider ${0} needs an API key; configure it in OMTP settings'],
    profile_disabled: ['omtp_err_profile_disabled', 'Connection Profiles extension is not enabled in SillyTavern'],
    profile_name: ['omtp_err_profile_name', 'Connection profile name is missing'],
    profile_unknown: ['omtp_err_profile_unknown', 'SillyTavern does not know the connection profile "${0}"'],
    profile_mismatch: ['omtp_err_profile_mismatch', 'SillyTavern applied "${0}" instead of "${1}"'],
    profile_not_switched: ['omtp_err_profile_not_switched', 'SillyTavern did not switch to the connection profile "${0}"'],
    reasoning_level: ['omtp_err_reasoning_level', 'Unknown reasoning level: ${0}'],
    selector_empty: ['omtp_err_selector_empty', 'Enter a model selector'],
    slot_empty: ['omtp_err_slot_empty', 'Quick slot ${0} is empty'],
    slot_unavailable: ['omtp_err_slot_unavailable', 'Quick slot ${0} points to an unavailable model'],
    no_favorites: ['omtp_err_no_favorites', 'No favorites available'],
    no_recents: ['omtp_err_no_recents', 'No recent models available'],
    no_chat: ['omtp_err_no_chat', 'Open a chat before binding a model'],
    no_character: ['omtp_err_no_character', 'Select a character first (character bindings are unavailable in group chats)'],
};

/**
 * Human-readable, translated text for a thrown value.
 * Unknown codes fall back to the error's own message.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
    const code = /** @type {any} */ (error)?.code;
    const entry = typeof code === 'string' ? ERROR_TEXT[code] : undefined;
    if (!entry) {
        return String(/** @type {any} */ (error)?.message || error);
    }
    const params = Array.isArray(/** @type {any} */ (error)?.params)
        ? /** @type {any} */ (error).params.map(String)
        : [];
    return params.length ? trf(entry[0], entry[1], ...params) : tr(entry[0], entry[1]);
}

/**
 * Translate a key and fill `${0}`, `${1}`, … placeholders.
 * @param {string} key
 * @param {string} fallback
 * @param {...unknown} args
 * @returns {string}
 */
export function trf(key, fallback, ...args) {
    let text = tr(key, fallback);
    args.forEach((value, index) => {
        text = text.split('${' + index + '}').join(String(value));
    });
    return text;
}

/**
 * Bind a listener and remember it for cleanup.
 * @param {EventTarget} target
 * @param {string} type
 * @param {Function} handler
 * @param {AddEventListenerOptions|boolean} [options]
 */
function listen(target, type, handler, options) {
    if (!target) {
        return;
    }
    target.addEventListener(type, handler, options);
    boundListeners.push({ target, type, handler });
}

/**
 * Inject the top-bar drawer button before the native system settings drawer.
 * @param {{onOpen?: Function}} [options]
 * @returns {HTMLElement|null}
 */
export function injectTopBarButton({ onOpen } = {}) {
    const holder = document.getElementById('top-settings-holder');
    if (!holder) {
        console.warn('[omtp] #top-settings-holder not found; top bar button not injected');
        return null;
    }

    document.getElementById(TOP_BAR_ID)?.remove();

    const button = document.createElement('div');
    button.id = TOP_BAR_ID;
    button.className = 'drawer';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-haspopup', 'dialog');
    button.title = tr('omtp_topbar_title', 'OMTP Model Hub');

    const toggle = document.createElement('div');
    toggle.className = 'drawer-toggle drawer-header';

    const icon = document.createElement('div');
    icon.id = 'omtp-hub-icon';
    icon.className = 'drawer-icon fa-solid fa-diagram-project closedIcon';
    icon.setAttribute('aria-hidden', 'true');

    toggle.append(icon);
    button.append(toggle);

    const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            onOpen?.();
        } catch (error) {
            console.error('[omtp] failed to open hub', error);
        }
    };

    listen(button, 'click', activate);
    listen(button, 'keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            activate(event);
        }
    });

    const systemButton = document.getElementById('sys-settings-button');
    holder.insertBefore(button, systemButton ?? null);
    return button;
}

/**
 * Update the top-bar button title with the current selection.
 * @param {string} text
 */
export function updateTopBarTitle(text) {
    const button = document.getElementById(TOP_BAR_ID);
    if (!button) {
        return;
    }
    const title = text ? `OMTP Model Hub — ${text}` : 'OMTP Model Hub';
    button.title = title;
    button.setAttribute('aria-label', title);
}

/**
 * Prepend the hub tools to the native API drawer content.
 * @param {{onOpen?: Function, onShowNative?: Function}} [options]
 * @returns {HTMLElement|null}
 */
export function injectApiDrawerTools({ onOpen, onShowNative } = {}) {
    const block = document.getElementById('rm_api_block');
    if (!block) {
        return null;
    }

    document.getElementById(API_TOOLS_ID)?.remove();

    const tools = document.createElement('div');
    tools.id = API_TOOLS_ID;
    tools.className = 'omtp-api-drawer-tools';

    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.id = 'omtp-switch-model-button';
    switchButton.className = 'menu_button menu_button_icon';
    switchButton.textContent = tr('omtp_switch_model', 'Switch model');

    const nativeButton = document.createElement('button');
    nativeButton.type = 'button';
    nativeButton.id = 'omtp-show-native-api';
    nativeButton.className = 'menu_button menu_button_icon';
    nativeButton.textContent = getSettings()?.hideNativeSelector
        ? tr('omtp_show_native_selector', 'Show native API selector')
        : tr('omtp_hide_native_selector', 'Hide native API selector');

    const activate = (handler) => (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            handler?.();
        } catch (error) {
            console.error('[omtp] drawer tool action failed', error);
        }
    };

    listen(switchButton, 'click', activate(onOpen));
    listen(nativeButton, 'click', activate(onShowNative));

    tools.append(switchButton, nativeButton);
    block.prepend(tools);
    return tools;
}

/**
 * Toggle the body class that hides SillyTavern's native API selector and keep
 * the drawer shortcut label in step (the label is otherwise computed once, on
 * injection).
 * @param {object} [settings]
 */
export function applyNativeSelectorVisibility(settings = getSettings()) {
    const hide = Boolean(settings?.hideNativeSelector ?? true);
    document.body.classList.toggle(HIDE_NATIVE_CLASS, hide);
    const apiStatusButton = document.getElementById('API-status-top');
    const apiDrawer = apiStatusButton?.closest?.('.drawer');
    if (apiDrawer) {
        apiDrawer.style.display = hide ? 'none' : '';
    }
    const nativeButton = document.getElementById('omtp-show-native-api');
    if (nativeButton) {
        nativeButton.textContent = hide
            ? tr('omtp_show_native_selector', 'Show native API selector')
            : tr('omtp_hide_native_selector', 'Hide native API selector');
    }
}

/**
 * Register the global hotkey listener (Alt+M by default).
 * @param {(event: KeyboardEvent) => void} handler
 */
export function setGlobalHotkeyHandler(handler) {
    removeGlobalHotkeyHandler();
    hotkeyHandler = handler;
    document.addEventListener('keydown', hotkeyHandler);
}

/**
 * Remove the global hotkey listener.
 */
function removeGlobalHotkeyHandler() {
    if (hotkeyHandler) {
        document.removeEventListener('keydown', hotkeyHandler);
        hotkeyHandler = null;
    }
}

/**
 * Remove every node/listener this module created. Native SillyTavern nodes are
 * never touched.
 */
export function cleanupDom() {
    for (const { target, type, handler } of boundListeners.splice(0)) {
        try {
            target.removeEventListener(type, handler);
        } catch {
            // ignore
        }
    }
    removeGlobalHotkeyHandler();
    document.getElementById(TOP_BAR_ID)?.remove();
    document.getElementById(API_TOOLS_ID)?.remove();
    document.getElementById(MODAL_ID)?.remove();
    document.getElementById('omtp-settings')?.remove();
    document.body.classList.remove(HIDE_NATIVE_CLASS);
    const apiStatusButton = document.getElementById('API-status-top');
    const apiDrawer = apiStatusButton?.closest?.('.drawer');
    if (apiDrawer) apiDrawer.style.display = '';
    document.querySelectorAll('.omtp-highlight').forEach((element) => element.classList.remove('omtp-highlight'));
}
