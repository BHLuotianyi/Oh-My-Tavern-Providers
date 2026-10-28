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
 * Toggle the body class that hides SillyTavern's native API selector block.
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
