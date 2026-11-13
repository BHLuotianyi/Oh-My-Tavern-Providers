/**
 * OMTP Model Hub — server API helpers and status/provider refresh for settings.
 */
import {
    DEFAULT_GATEWAY_SETTINGS,
    DEFAULT_GATEWAY_URL,
    EXTENSION_VERSION,
} from '../constants.js';
import { apiBase, isTauriTavern, requestHeaders } from '../backend.js';
import { getCatalogInfo } from '../catalog.js';
import { getSettings } from '../store.js';
import { resolveUpdateChannel } from '../update-check.js';
import { initBindingUI } from './bindings.js';
import { gatewayUnavailableText, tr, trf } from './dom.js';
import { isPlainObject } from './helpers.js';

const SERVER_CONTROL_IDS = [
    'omtp-gateway-autostart',
    'omtp-gateway-requireauth',
    'omtp-gateway-restart',
    'omtp-catalog-refresh',
    'omtp-import-omp',
];

/** @type {object|null} */
let serverStatus = null;
/** @type {boolean|null} */
let serverAvailable = null;
/** @type {Array<object>} */
let providersCache = [];
/** @type {Promise<void>|null} */
let refreshing = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

export function byId(id) {
    return document.getElementById(id);
}

function setText(id, text) {
    const element = byId(id);
    if (element) {
        element.textContent = text;
    }
}

function setInputValue(id, value) {
    const element = byId(id);
    if (element && document.activeElement !== element) {
        element.value = value;
    }
}

function setSelectValue(id, value) {
    const element = byId(id);
    if (element && typeof value === 'string') {
        element.value = value;
    }
}

function setChecked(id, value) {
    const element = byId(id);
    if (element) {
        element.checked = Boolean(value);
    }
}

function setDisabled(id, disabled, reason) {
    const element = byId(id);
    if (!element) {
        return;
    }
    element.disabled = Boolean(disabled);
    if (reason) {
        element.title = reason;
    } else {
        element.removeAttribute('title');
    }
}

function formatDate(value) {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function errorMessage(error) {
    return error?.message ?? String(error);
}

/**
 * Only plain http(s) URLs are usable as gateway / catalog / provider bases.
 * Returns '' for an empty value and null for anything unsafe.
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeHttpUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if ((url.protocol === 'http:' || url.protocol === 'https:')
            && !url.username && !url.password && !url.search && !url.hash) {
            return url.toString().replace(/\/+$/, '');
        }
    } catch {
        // Not a URL at all.
    }
    return null;
}

export function isServerAvailable() {
    return serverAvailable;
}

export function getProvidersCache() {
    return providersCache;
}

/* ------------------------------------------------------------------ */
/* Server API                                                         */
/* ------------------------------------------------------------------ */

export async function apiFetch(path, { method = 'GET', body } = {}) {
    const init = {
        method,
        headers: requestHeaders(),
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${apiBase()}${path}`, init);
    } catch (error) {
        markServerUnavailable(error);
        throw new Error(gatewayUnavailableText());
    }

    if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
            const payload = await response.json();
            detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? detail;
        } catch {
            // keep the status text
        }
        const error = new Error(String(detail));
        error.status = response.status;
        throw error;
    }

    if (response.status === 204) {
        return null;
    }
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function markServerUnavailable(error) {
    if (serverAvailable !== false) {
        console.warn('[omtp] server plugin unavailable; using degraded settings UI', error);
    }
    serverAvailable = false;
}

function markServerAvailable() {
    serverAvailable = true;
}

/* ------------------------------------------------------------------ */
/* Local settings                                                     */
/* ------------------------------------------------------------------ */

function applyLocalSettings() {
    const settings = getSettings();
    setChecked('omtp-hide-native', settings.hideNativeSelector);
    setInputValue('omtp-hotkey', settings.ui?.hotkey ?? 'alt+m');
    setChecked('omtp-auto-apply', settings.autoApplyBindings);
    setInputValue('omtp-gateway-url', settings.gatewayUrl || DEFAULT_GATEWAY_URL);
    setInputValue('omtp-catalog-url', settings.catalogUrl || '');
    setSelectValue('omtp-update-channel', resolveUpdateChannel(EXTENSION_VERSION, settings.updateChannel));
    const companionSection = byId('omtp-companion-section');
    if (companionSection) {
        companionSection.hidden = !isTauriTavern();
        setInputValue('omtp-companion-url', settings.companion.url);
        setInputValue('omtp-companion-token', settings.companion.token);
    }
}

function setServerControlsDisabled(disabled) {
    const reason = disabled
        ? (isTauriTavern() ? gatewayUnavailableText() : tr('omtp_server_plugin_unavailable', 'OMTP server plugin unavailable (enable server plugins)'))
        : '';
    for (const id of SERVER_CONTROL_IDS) {
        setDisabled(id, disabled, reason);
    }
}

/* ------------------------------------------------------------------ */
/* Status rendering                                                   */
/* ------------------------------------------------------------------ */

function updateGatewayStatus(gateway) {
    const statusElement = byId('omtp-gateway-status');
    let label;
    let dotClass;
    if (serverAvailable === false) {
        label = gatewayUnavailableText();
        dotClass = 'omtp-bad';
    } else if (gateway?.running) {
        const url = gateway.url || `http://127.0.0.1:${gateway.port ?? 4100}/v1`;
        label = trf('omtp_about_gateway_running', 'Running at ${0}', url);
        dotClass = 'omtp-ok';
    } else {
        label = gateway?.lastError
            ? trf('omtp_gateway_stopped_error', 'Stopped: ${0}', gateway.lastError)
            : tr('omtp_gateway_stopped', 'Stopped');
        dotClass = 'omtp-warn';
    }

    if (!statusElement) {
        return;
    }
    const dot = statusElement.querySelector('.omtp-status-dot');
    const text = statusElement.querySelector('.omtp-gateway-status-text');
    if (dot) {
        dot.className = `omtp-status-dot ${dotClass}`;
    }
    if (text) {
        text.textContent = label;
    } else {
        statusElement.textContent = label;
    }

    const manualToken = Boolean(getSettings().gatewayToken);
    let tokenText;
    if (serverAvailable === false) {
        tokenText = tr('omtp_gateway_token_unknown', 'Token status unknown');
    } else if (gateway?.requireAuth) {
        tokenText = manualToken
            ? tr('omtp_gateway_token_both', 'Server token + manual token configured')
            : tr('omtp_gateway_token_server', 'Server-managed token required');
    } else {
        tokenText = tr('omtp_gateway_auth_disabled', 'Auth disabled');
    }
    setText('omtp-gateway-token-status', tokenText);
}

function updateCatalogInfo(catalog) {
    const element = byId('omtp-catalog-info');
    if (!element) {
        return;
    }
    const parts = [];
    if (serverAvailable !== false && catalog) {
        if (catalog.version) {
            parts.push(`v${catalog.version}`);
        }
        if (catalog.generatedAt) {
            parts.push(formatDate(catalog.generatedAt));
        }
        const providers = catalog.providers ?? catalog.stats?.providers;
        const models = catalog.models ?? catalog.stats?.models;
        if (providers !== undefined) {
            parts.push(trf('omtp_catalog_providers', '${0} providers', providers));
        }
        if (models !== undefined) {
            parts.push(trf('omtp_catalog_models', '${0} models', models));
        }
        if (catalog.source) {
            parts.push(String(catalog.source));
        }
    } else {
        const info = getCatalogInfo();
        const source = info?.source && info.source !== 'none' ? info.source : 'bundled';
        parts.push(trf('omtp_catalog_source', '${0} catalog', source));
        if (info?.generatedAt) {
            parts.push(formatDate(info.generatedAt));
        }
        if (info?.stats) {
            parts.push(trf('omtp_catalog_providers', '${0} providers', info.stats.providers ?? 0));
            parts.push(trf('omtp_catalog_models', '${0} models', info.stats.models ?? 0));
        }
        if (serverAvailable === false) {
            parts.push(tr('omtp_catalog_server_unavailable', 'server plugin unavailable'));
        }
    }
    element.textContent = parts.filter(Boolean).join(' · ');
}

function applyGatewayConfig(config) {
    const source = config ?? DEFAULT_GATEWAY_SETTINGS;
    setChecked('omtp-gateway-autostart', source.autoStart ?? DEFAULT_GATEWAY_SETTINGS.autoStart);
    setChecked('omtp-gateway-requireauth', source.requireAuth ?? DEFAULT_GATEWAY_SETTINGS.requireAuth);
}

/* ------------------------------------------------------------------ */
/* Refresh                                                            */
/* ------------------------------------------------------------------ */

export async function refreshServerStatus() {
    try {
        const status = await apiFetch('/status');
        if (!isPlainObject(status)) {
            throw new Error('Unexpected /status response');
        }
        markServerAvailable();
        serverStatus = status;
        updateGatewayStatus(serverStatus?.gateway);
        updateCatalogInfo(serverStatus?.catalog);

        let config = null;
        try {
            config = await apiFetch('/config');
        } catch {
            config = null;
        }
        applyGatewayConfig(config);
        setServerControlsDisabled(false);
    } catch (error) {
        markServerUnavailable(error);
        serverStatus = null;
        updateGatewayStatus(null);
        updateCatalogInfo(null);
        applyGatewayConfig(null);
        setServerControlsDisabled(true);
    }
}

function normalizeProviderList(data) {
    if (!data) {
        return [];
    }
    if (Array.isArray(data)) {
        return data.filter(isPlainObject);
    }
    if (Array.isArray(data.providers)) {
        return data.providers.filter(isPlainObject);
    }
    if (isPlainObject(data.providers)) {
        return Object.entries(data.providers).map(([id, provider]) => ({ id, ...provider }));
    }
    if (isPlainObject(data)) {
        return Object.entries(data)
            .filter(([, value]) => isPlainObject(value))
            .map(([id, provider]) => ({ id, ...provider }));
    }
    return [];
}

export async function refreshProviders() {
    if (serverAvailable === false && !serverStatus) {
        providersCache = [];
        return;
    }
    try {
        const data = await apiFetch('/providers');
        markServerAvailable();
        providersCache = normalizeProviderList(data);
    } catch (error) {
        markServerUnavailable(error);
        providersCache = [];
    }
}

/**
 * Refresh every value in the settings panel. Never throws.
 * @returns {Promise<void>}
 */
export function refreshSettingsUI() {
    if (!document.getElementById('omtp-settings')) {
        return Promise.resolve();
    }
    applyLocalSettings();
    if (refreshing) {
        return refreshing;
    }
    refreshing = (async () => {
        await Promise.allSettled([refreshServerStatus(), refreshProviders()]);
        try {
            initBindingUI(document.getElementById('omtp-settings'));
        } catch (error) {
            console.warn('[omtp] could not refresh binding list', error);
        }
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
}
