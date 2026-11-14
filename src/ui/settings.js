/**
 * OMTP Model Hub — extension settings panel.
 *
 * Binds the static `settings.html` markup to client settings and to the
 * optional server plugin routes. Every server call degrades gracefully: when
 * the plugin is missing (or `enableServerPlugins` is false) native/translated
 * selection keeps working and the server-only controls are disabled.
 */
import { DEFAULT_GATEWAY_URL } from '../constants.js';
import { getSettings, updateSettings } from '../store.js';
import { UPDATE_CHANNELS } from '../update-check.js';
import { applyNativeSelectorVisibility, tr } from './dom.js';
import { el, isPlainObject, notify } from './helpers.js';
import {
    clearSettings,
    connectCompanion,
    refreshCatalog,
    restartGateway,
    restoreNativeSelection,
    saveGatewayConfig,
} from './settings-actions.js';
import { byId, refreshSettingsUI, safeHttpUrl } from './settings-api.js';
import { openImportPopup } from './settings-forms.js';
import { bindProxyControls } from './settings-proxy.js';
import { refreshUpdatePill } from './update-pill.js';

export { refreshSettingsUI };

/** @type {HTMLElement|null} */
let container = null;

function normalizeHotkey(value) {
    const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!raw) {
        return null;
    }
    const parts = raw.split('+').filter(Boolean);
    if (parts.length < 2) {
        return null;
    }
    const key = parts.pop();
    // Alt+1..9 belong to the quick slots; letting the hub hotkey claim a
    // digit makes those slots permanently unreachable.
    if (!/^[a-z0]$/.test(key)) {
        return null;
    }
    const modifiers = [];
    for (const part of parts) {
        const modifier = part === 'control' ? 'ctrl' : part === 'cmd' ? 'meta' : part;
        if (!['alt', 'ctrl', 'shift', 'meta'].includes(modifier) || modifiers.includes(modifier)) {
            return null;
        }
        modifiers.push(modifier);
    }
    return [...modifiers, key].join('+');
}

function element(root, id) {
    return root?.querySelector?.(`#${id}`) ?? byId(id);
}

const UPDATE_CHANNEL_LABELS = {
    nightly: ['omtp_update_channel_nightly', 'Nightly'],
    git: ['omtp_update_channel_git', 'Git (main)'],
};

function fillUpdateChannels(select) {
    if (select.dataset.omtpFilled === '1') {
        return;
    }
    select.dataset.omtpFilled = '1';
    for (const id of UPDATE_CHANNELS) {
        const [key, fallback] = UPDATE_CHANNEL_LABELS[id] || [null, id];
        const option = el('option', null, key ? tr(key, fallback) : id);
        option.value = id;
        select.append(option);
    }
}

function bindControls(root) {
    const updateChannelSelect = element(root, 'omtp-update-channel');
    if (updateChannelSelect) {
        fillUpdateChannels(updateChannelSelect);
        updateChannelSelect.addEventListener('change', () => {
            updateSettings({ updateChannel: updateChannelSelect.value });
            refreshUpdatePill({ force: true }).catch((error) => {
                console.warn('[omtp] update check failed after a channel change', error);
            });
        });
    }

    const hideNative = element(root, 'omtp-hide-native');
    hideNative?.addEventListener('change', () => {
        const hide = Boolean(hideNative.checked);
        updateSettings({ hideNativeSelector: hide });
        applyNativeSelectorVisibility({ ...getSettings(), hideNativeSelector: hide });
    });

    const hotkey = element(root, 'omtp-hotkey');
    hotkey?.addEventListener('change', () => {
        const normalized = normalizeHotkey(hotkey.value);
        if (!normalized) {
            notify('warning', tr('omtp_hotkey_invalid', 'Hotkey must be a key with at least one modifier, for example alt+m'));
            hotkey.value = getSettings().ui?.hotkey ?? 'alt+m';
            return;
        }
        hotkey.value = normalized;
        updateSettings({ ui: { hotkey: normalized } });
    });

    const autoApply = element(root, 'omtp-auto-apply');
    autoApply?.addEventListener('change', () => {
        updateSettings({ autoApplyBindings: Boolean(autoApply.checked) });
    });

    const gatewayUrl = element(root, 'omtp-gateway-url');
    gatewayUrl?.addEventListener('change', () => {
        const value = safeHttpUrl(gatewayUrl.value);
        if (value === null) {
            notify('error', tr('omtp_invalid_url', 'Enter a valid http(s) URL without a query string.'));
            gatewayUrl.value = getSettings().gatewayUrl || DEFAULT_GATEWAY_URL;
            return;
        }
        const next = value || DEFAULT_GATEWAY_URL;
        gatewayUrl.value = next;
        updateSettings({ gatewayUrl: next });
    });

    element(root, 'omtp-gateway-autostart')?.addEventListener('change', () => saveGatewayConfig());
    element(root, 'omtp-gateway-requireauth')?.addEventListener('change', () => saveGatewayConfig());
    element(root, 'omtp-gateway-restart')?.addEventListener('click', (event) => {
        event.preventDefault();
        restartGateway();
    });

    bindProxyControls(root);

    const catalogUrl = element(root, 'omtp-catalog-url');
    catalogUrl?.addEventListener('change', () => {
        const value = safeHttpUrl(catalogUrl.value);
        if (value === null) {
            notify('error', tr('omtp_invalid_url', 'Enter a valid http(s) URL without a query string.'));
            catalogUrl.value = getSettings().catalogUrl || '';
            return;
        }
        updateSettings({ catalogUrl: value });
    });

    element(root, 'omtp-catalog-refresh')?.addEventListener('click', (event) => {
        event.preventDefault();
        refreshCatalog();
    });
    element(root, 'omtp-import-omp')?.addEventListener('click', (event) => {
        event.preventDefault();
        openImportPopup();
    });

    element(root, 'omtp-restore-native')?.addEventListener('click', (event) => {
        event.preventDefault();
        restoreNativeSelection();
    });
    element(root, 'omtp-clear-settings')?.addEventListener('click', (event) => {
        event.preventDefault();
        clearSettings();
    });
    element(root, 'omtp-companion-connect')?.addEventListener('click', (event) => {
        event.preventDefault();
        connectCompanion();
    });
}

/**
 * Initialize the settings panel.
 * @param {HTMLElement|{container?: HTMLElement}} [arg]
 * @returns {HTMLElement|null} The settings container
 */
export function initSettingsUI(arg) {
    const options = arg?.nodeType === 1
        ? { container: arg }
        : (isPlainObject(arg) ? arg : {});

    container = options.container
        ?? document.getElementById('omtp-settings')
        ?? document.querySelector('#extensions_settings2 #omtp-settings');

    if (!container) {
        console.warn('[omtp] settings container not found; settings UI not initialized');
        return null;
    }

    if (!container.dataset.omtpBound) {
        container.dataset.omtpBound = '1';
        // The drawer header is static markup; localize it here because
        // SillyTavern only translates [data-i18n] nodes present at load time.
        const title = container.querySelector('.inline-drawer-header b');
        if (title) {
            title.textContent = tr('omtp_settings_title', 'OMTP Model Hub');
        }
        bindControls(container);
    }

    refreshSettingsUI();
    return container;
}
