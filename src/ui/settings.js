/**
 * OMTP Model Hub — extension settings panel.
 *
 * Binds the static `settings.html` markup to client settings and to the
 * optional server plugin routes. Every server call degrades gracefully: when
 * the plugin is missing (or `enableServerPlugins` is false) native/translated
 * selection keeps working and the server-only controls are disabled.
 */
import { getRequestHeaders } from '../../../../../../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../../../popup.js';
import {
    API_BASE,
    DEFAULT_GATEWAY_SETTINGS,
    DEFAULT_GATEWAY_URL,
    DEFAULT_SETTINGS,
    GATEWAY_ADAPTERS,
} from '../constants.js';
import { getCatalogInfo, loadCatalog } from '../catalog.js';
import { getSettings, updateSettings } from '../store.js';
import { restoreSelection } from '../switch-engine.js';
import { applyNativeSelectorVisibility, describeError, tr, trf } from './dom.js';
import { el, isPlainObject, notify } from './helpers.js';
import { initBindingUI } from './bindings.js';

const SERVER_CONTROL_IDS = [
    'omtp-gateway-autostart',
    'omtp-gateway-requireauth',
    'omtp-gateway-restart',
    'omtp-catalog-refresh',
    'omtp-import-omp',
];

/** @type {HTMLElement|null} */
let container = null;
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

function byId(id) {
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

function errorMessage(error) {
    return error?.message ?? String(error);
}

/* ------------------------------------------------------------------ */
/* Server API                                                         */
/* ------------------------------------------------------------------ */

async function apiFetch(path, { method = 'GET', body } = {}) {
    const init = {
        method,
        headers: getRequestHeaders(),
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, init);
    } catch (error) {
        markServerUnavailable(error);
        throw new Error(tr('omtp_gateway_unavailable', 'OMTP Gateway unavailable (enable server plugins)'));
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
}

function setServerControlsDisabled(disabled) {
    const reason = disabled
        ? tr('omtp_server_plugin_unavailable', 'OMTP server plugin unavailable (enable server plugins)')
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
        label = tr('omtp_gateway_unavailable', 'OMTP Gateway unavailable (enable server plugins)');
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

async function refreshServerStatus() {
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

async function refreshProviders() {
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

/* ------------------------------------------------------------------ */
/* Popups                                                             */
/* ------------------------------------------------------------------ */

async function confirmAction(title, text) {
    try {
        const result = await Popup.show.confirm(title, text);
        return result === POPUP_RESULT.AFFIRMATIVE;
    } catch (error) {
        console.warn('[omtp] confirmation popup failed', error);
    }
    if (typeof globalThis.confirm === 'function') {
        return Boolean(globalThis.confirm(`${title}\n\n${text}`));
    }
    notify('warning', trf('omtp_confirmation_unavailable', '${0}: confirmation unavailable', title));
    return false;
}

function formRow(labelText, control) {
    const row = el('div', 'omtp-settings-row');
    const label = el('label', null, labelText);
    if (control.id) {
        label.htmlFor = control.id;
    }
    row.append(label, control);
    return row;
}

function parseModels(text) {
    const raw = String(text ?? '').trim();
    if (!raw) {
        return { value: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { error: trf('omtp_invalid_models_json', 'Invalid models JSON: ${0}', error.message) };
    }
    if (!Array.isArray(parsed)) {
        return { error: tr('omtp_models_not_array', 'Models must be a JSON array') };
    }
    const models = [];
    for (const item of parsed) {
        if (typeof item === 'string' && item.trim()) {
            models.push({ id: item.trim(), name: item.trim() });
            continue;
        }
        if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim()) {
            return { error: tr('omtp_model_id_required', 'Each model needs a string "id"') };
        }
        models.push({
            ...item,
            id: item.id.trim(),
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id.trim(),
        });
    }
    return { value: models };
}

/** Build the custom-provider form and its controls. */
function buildCustomProviderForm() {
    const form = el('div');
    form.append(el(
        'div',
        'omtp-muted',
        tr(
            'omtp_custom_provider_hint',
            'Custom providers are merged into the catalog and the gateway model list.',
        ),
    ));

    const idInput = el('input');
    idInput.type = 'text';
    idInput.placeholder = 'my-provider';
    idInput.id = 'omtp-custom-provider-id';

    const labelInput = el('input');
    labelInput.type = 'text';
    labelInput.placeholder = tr('omtp_custom_provider_label_placeholder', 'My Provider');
    labelInput.id = 'omtp-custom-provider-label';

    const adapterSelect = el('select');
    adapterSelect.id = 'omtp-custom-provider-adapter';
    for (const adapter of GATEWAY_ADAPTERS) {
        const option = el('option', null, adapter);
        option.value = adapter;
        adapterSelect.append(option);
    }

    const baseUrlInput = el('input');
    baseUrlInput.type = 'url';
    baseUrlInput.placeholder = 'https://api.example.com/v1';
    baseUrlInput.id = 'omtp-custom-provider-baseurl';

    const modelsArea = el('textarea', 'text_pole monospace');
    modelsArea.rows = 4;
    modelsArea.id = 'omtp-custom-provider-models';
    modelsArea.placeholder = '[{"id":"model-id","name":"Model","contextWindow":32000}]';

    const keyInput = el('input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.id = 'omtp-custom-provider-key';

    const errorLine = el('div', 'omtp-muted');
    errorLine.setAttribute('role', 'alert');

    form.append(
        formRow(tr('omtp_form_id', 'ID'), idInput),
        formRow(tr('omtp_form_label', 'Label'), labelInput),
        formRow(tr('omtp_form_adapter', 'Adapter'), adapterSelect),
        formRow(tr('omtp_form_base_url', 'Base URL'), baseUrlInput),
        formRow(tr('omtp_form_models_json', 'Models JSON'), modelsArea),
        formRow(tr('omtp_form_api_key_optional', 'API key (optional)'), keyInput),
        errorLine,
    );

    return { form, idInput, labelInput, adapterSelect, baseUrlInput, modelsArea, keyInput, errorLine };
}

/** Validate and POST the new provider; returns false to keep the popup open. */
async function submitCustomProvider({ idInput, labelInput, adapterSelect, baseUrlInput, modelsArea, keyInput, errorLine }) {
    const id = idInput.value.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        errorLine.textContent = tr(
            'omtp_provider_id_invalid',
            'Provider id must start with a letter or digit and contain only letters, digits, ".", "_" or "-".',
        );
        return false;
    }
    const models = parseModels(modelsArea.value);
    if (models.error) {
        errorLine.textContent = models.error;
        return false;
    }
    const config = {
        custom: true,
        label: labelInput.value.trim() || id,
        adapter: adapterSelect.value,
        baseUrl: baseUrlInput.value.trim(),
        models: models.value,
    };
    try {
        await apiFetch(`/providers/${encodeURIComponent(id)}/config`, { method: 'POST', body: config });
        const key = keyInput.value.trim();
        if (key) {
            await apiFetch(`/providers/${encodeURIComponent(id)}/key`, { method: 'POST', body: { key } });
        }
    } catch (error) {
        errorLine.textContent = errorMessage(error);
        return false;
    }
    notify('success', trf('omtp_provider_added', 'Provider ${0} added', config.label));
    await refreshProviders();
    return true;
}

export function openCustomProviderEditor() {
    if (serverAvailable === false) {
        notify('warning', tr('omtp_gateway_unavailable', 'OMTP Gateway unavailable (enable server plugins)'));
        return;
    }

    const fields = buildCustomProviderForm();
    const popup = new Popup(fields.form, POPUP_TYPE.CONFIRM, null, {
        okButton: tr('omtp_add_provider', 'Add provider'),
        cancelButton: tr('omtp_cancel', 'Cancel'),
        wide: true,
        allowVerticalScrolling: true,
        onClosing: (current) => (current.result === POPUP_RESULT.AFFIRMATIVE ? submitCustomProvider(fields) : true),
    });

    popup.show().catch((error) => notify('error', errorMessage(error)));
}

function openImportPopup() {
    if (serverAvailable === false) {
        notify('warning', tr('omtp_gateway_unavailable', 'OMTP Gateway unavailable (enable server plugins)'));
        return;
    }

    const form = el('div');
    form.append(el(
        'div',
        'omtp-muted',
        tr(
            'omtp_import_omp_hint',
            'Reads the local oh-my-pi catalog (data only; the omp binary is never executed) and stores it as an overlay. The bundled catalog is never overwritten.',
        ),
    ));

    const pathInput = el('input');
    pathInput.type = 'text';
    pathInput.id = 'omtp-import-path';
    pathInput.placeholder = '~/oh-my-pi';

    const credentialsLabel = el('label', 'checkbox_label');
    const credentialsInput = el('input');
    credentialsInput.type = 'checkbox';
    credentialsInput.id = 'omtp-import-credentials';
    credentialsLabel.append(credentialsInput, el(
        'span',
        null,
        tr(
            'omtp_import_credentials',
            'Import stored credentials from the local OMP agent.db (API keys and OAuth sessions)',
        ),
    ));

    const errorLine = el('div', 'omtp-muted');
    errorLine.setAttribute('role', 'alert');

    form.append(formRow(tr('omtp_omp_path', 'OMP path'), pathInput), credentialsLabel, errorLine);

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, null, {
        okButton: tr('omtp_import', 'Import'),
        cancelButton: tr('omtp_cancel', 'Cancel'),
        wide: true,
        onClosing: async (current) => {
            if (current.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            const catalogPath = pathInput.value.trim();
            try {
                const importCredentials = Boolean(credentialsInput.checked);
                const result = await apiFetch('/import/omp', {
                    method: 'POST',
                    body: {
                        catalogPath: catalogPath || undefined,
                        credentials: importCredentials,
                        confirm: importCredentials ? true : undefined,
                    },
                });
                if (result?.found === false) {
                    notify('info', tr('omtp_import_none', 'No local OMP data found; nothing imported'));
                    return true;
                }
                const credentials = Number(result?.credentials ?? 0);
                notify(
                    'success',
                    credentials
                        ? trf(
                            'omtp_import_done_credentials',
                            'Imported ${0} providers / ${1} models and ${2} credentials',
                            result?.providers ?? 0,
                            result?.models ?? 0,
                            credentials,
                        )
                        : trf(
                            'omtp_import_done',
                            'Imported ${0} providers / ${1} models',
                            result?.providers ?? 0,
                            result?.models ?? 0,
                        ),
                );
                if (result?.credentialError) {
                    notify('warning', trf('omtp_import_credential_note', 'Credential import note: ${0}', result.credentialError));
                }
                // Reload in the background so a slow fetch cannot pin the popup open.
                reloadClientCatalog().catch((error) => {
                    console.warn('[omtp] could not reload after OMP import', error);
                });
            } catch (error) {
                errorLine.textContent = errorMessage(error);
                return false;
            }
            return true;
        },
    });

    popup.show().catch((error) => notify('error', errorMessage(error)));
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

async function reloadClientCatalog() {
    try {
        await loadCatalog({ force: true });
    } catch (error) {
        console.warn('[omtp] could not reload the client catalog', error);
    }
    try {
        const hub = await import('./hub.js');
        await hub.refreshHub?.();
    } catch (error) {
        console.warn('[omtp] could not refresh the hub', error);
    }
    await refreshServerStatus();
}

async function refreshCatalog() {
    const button = byId('omtp-catalog-refresh');
    if (button) {
        button.disabled = true;
    }
    try {
        const url = byId('omtp-catalog-url')?.value.trim() || undefined;
        const result = await apiFetch('/catalog/refresh', {
            method: 'POST',
            body: url ? { url } : {},
        });
        if (result?.ok === false) {
            throw new Error(result.error || tr('omtp_catalog_refresh_failed', 'Catalog refresh failed'));
        }
        notify(
            'success',
            trf(
                'omtp_catalog_refreshed',
                'Catalog refreshed: ${0} providers, ${1} models',
                result?.providers ?? '?',
                result?.models ?? '?',
            ),
        );
        await reloadClientCatalog();
    } catch (error) {
        notify('error', trf('omtp_catalog_refresh_error', 'Catalog refresh failed: ${0}', errorMessage(error)));
    } finally {
        if (button) {
            button.disabled = serverAvailable === false;
        }
    }
}

async function restartGateway() {
    try {
        await apiFetch('/gateway/restart', { method: 'POST' });
        notify('success', tr('omtp_gateway_restart_requested', 'Gateway restart requested'));
    } catch (error) {
        notify('error', trf('omtp_gateway_restart_failed', 'Gateway restart failed: ${0}', errorMessage(error)));
    }
    await refreshServerStatus();
}

async function saveGatewayConfig() {
    try {
        await apiFetch('/config', {
            method: 'POST',
            body: {
                autoStart: Boolean(byId('omtp-gateway-autostart')?.checked),
                requireAuth: Boolean(byId('omtp-gateway-requireauth')?.checked),
            },
        });
        notify('success', tr('omtp_gateway_saved', 'Gateway settings saved'));
    } catch (error) {
        notify('error', trf('omtp_gateway_save_failed', 'Could not save gateway settings: ${0}', errorMessage(error)));
    }
    await refreshServerStatus();
}

async function restoreNativeSelection() {
    const settings = getSettings();
    const snapshot = settings.lastNativeSelection ?? settings.gateway?.savedCustom ?? null;
    if (!snapshot) {
        notify('info', tr('omtp_restore_none', 'No saved native selection to restore'));
        return;
    }
    const confirmed = await confirmAction(
        tr('omtp_restore_native', 'Restore native selection'),
        tr(
            'omtp_restore_confirm',
            'Restore the SillyTavern model selection that was active before OMTP was used?',
        ),
    );
    if (!confirmed) {
        return;
    }
    try {
        await restoreSelection(snapshot, { fast: false });
        notify('success', tr('omtp_restore_done', 'Native selection restored'));
        await refreshSettingsUI();
    } catch (error) {
        notify('error', trf('omtp_restore_failed', 'Could not restore native selection: ${0}', describeError(error)));
    }
}

async function deleteProviderKeys() {
    if (serverAvailable === false) {
        notify('warning', tr('omtp_keys_delete_unavailable', 'Server plugin unavailable; provider keys were not deleted'));
        return;
    }
    const targets = providersCache.filter((provider) => provider.hasKey);
    let removed = 0;
    const failed = [];
    for (const provider of targets) {
        try {
            await apiFetch(`/providers/${encodeURIComponent(provider.id)}/key`, { method: 'DELETE' });
            removed += 1;
        } catch (error) {
            console.warn(`[omtp] could not delete key for ${provider.id}`, error);
            failed.push(String(provider.id));
        }
    }
    if (failed.length) {
        notify(
            'warning',
            trf(
                'omtp_keys_delete_partial',
                '${0} provider key(s) deleted; failed for: ${1}',
                removed,
                failed.join(', '),
            ),
        );
    } else {
        notify(removed > 0 ? 'success' : 'info', trf('omtp_keys_deleted', '${0} provider key(s) deleted', removed));
    }
}

async function clearSettings() {
    const clearKeys = Boolean(byId('omtp-clear-keys')?.checked);
    const confirmed = await confirmAction(
        tr('omtp_clear_settings', 'Clear OMTP settings'),
        clearKeys
            ? tr(
                'omtp_clear_settings_confirm_keys',
                'This removes favorites, recents, quick slots, bindings, extra bodies and UI preferences, and deletes every stored provider key. The native SillyTavern selection is left unchanged.',
            )
            : tr(
                'omtp_clear_settings_confirm',
                'This removes favorites, recents, quick slots, bindings, extra bodies and UI preferences. The native SillyTavern selection is left unchanged.',
            ),
    );
    if (!confirmed) {
        return;
    }

    const live = getSettings();
    for (const key of Object.keys(live)) {
        if (!(key in DEFAULT_SETTINGS)) {
            delete live[key];
        }
    }
    // `updateSettings` merges plain objects one level deep, so these maps would
    // survive the defaults patch; drop them first so the toast is truthful.
    for (const key of ['extraBodies', 'reasoningByEntry', 'characterBindings']) {
        delete live[key];
    }
    updateSettings(structuredClone(DEFAULT_SETTINGS));
    applyNativeSelectorVisibility(getSettings());
    notify('success', tr('omtp_clear_settings_done', 'OMTP settings cleared'));

    if (clearKeys) {
        await deleteProviderKeys();
        const checkbox = byId('omtp-clear-keys');
        if (checkbox) {
            checkbox.checked = false;
        }
    }
    await refreshSettingsUI();
}

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
    if (!/^[a-z0-9]$/.test(key)) {
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

/* ------------------------------------------------------------------ */
/* Binding                                                            */
/* ------------------------------------------------------------------ */

function element(root, id) {
    return root?.querySelector?.(`#${id}`) ?? byId(id);
}

function bindControls(root) {
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
        const value = gatewayUrl.value.trim() || DEFAULT_GATEWAY_URL;
        gatewayUrl.value = value;
        updateSettings({ gatewayUrl: value });
    });

    element(root, 'omtp-gateway-autostart')?.addEventListener('change', () => saveGatewayConfig());
    element(root, 'omtp-gateway-requireauth')?.addEventListener('change', () => saveGatewayConfig());
    element(root, 'omtp-gateway-restart')?.addEventListener('click', (event) => {
        event.preventDefault();
        restartGateway();
    });

    const catalogUrl = element(root, 'omtp-catalog-url');
    catalogUrl?.addEventListener('change', () => {
        updateSettings({ catalogUrl: catalogUrl.value.trim() });
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
