/**
 * OMTP Model Hub — action handlers for the settings panel.
 */
import { POPUP_RESULT, Popup } from '../../../../../popup.js';
import { DEFAULT_SETTINGS } from '../constants.js';
import { forgetLiveModels, loadCatalog } from '../catalog.js';
import { getSettings, updateSettings } from '../store.js';
import { getGatewayStatus, invalidateGatewayCaches, restoreSelection } from '../switch-engine.js';
import { applyNativeSelectorVisibility, describeError, gatewayUnavailableText, tr, trf } from './dom.js';
import { notify } from './helpers.js';
import {
    apiFetch,
    byId,
    errorMessage,
    getProvidersCache,
    isServerAvailable,
    refreshProviders,
    refreshServerStatus,
    refreshSettingsUI,
    safeHttpUrl,
} from './settings-api.js';

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

export async function reloadClientCatalog() {
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

/**
 * Save the companion address/token and reload everything that comes from the
 * server side: catalog, provider availability, gateway status.
 */
export async function connectCompanion() {
    const url = safeHttpUrl(byId('omtp-companion-url')?.value ?? '');
    if (url === null) {
        notify('error', tr('omtp_invalid_url', 'Enter a valid http(s) URL without a query string.'));
        return;
    }
    const token = String(byId('omtp-companion-token')?.value ?? '').trim();
    updateSettings({ companion: { url, token } });
    const status = byId('omtp-companion-status');
    if (status) status.textContent = tr('omtp_companion_connecting', 'Connecting…');
    await getGatewayStatus({ force: true });
    // Re-probes /status first; the provider list is skipped while the server counts as unavailable.
    await reloadClientCatalog();
    await refreshProviders();
    if (status) {
        status.textContent = !url
            ? ''
            : isServerAvailable() === false
                ? gatewayUnavailableText()
                : tr('omtp_companion_connected', 'Connected');
    }
}

export async function refreshCatalog() {
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
            button.disabled = isServerAvailable() === false;
        }
    }
}

export async function restartGateway() {
    try {
        await apiFetch('/gateway/restart', { method: 'POST' });
        notify('success', tr('omtp_gateway_restart_requested', 'Gateway restart requested'));
    } catch (error) {
        notify('error', trf('omtp_gateway_restart_failed', 'Gateway restart failed: ${0}', errorMessage(error)));
    }
    await refreshServerStatus();
}

export async function saveGatewayConfig() {
    const requireAuth = Boolean(byId('omtp-gateway-requireauth')?.checked);
    if (!requireAuth) {
        const confirmed = await confirmAction(
            tr('omtp_gateway_insecure_title', 'Disable gateway authentication?'),
            tr('omtp_gateway_insecure_body', 'Without a token, any process on this computer can use the local gateway and the API keys stored in OMTP. Only disable this on a machine you fully trust.'),
        );
        if (!confirmed) {
            await refreshServerStatus();
            return;
        }
    }
    try {
        await apiFetch('/config', {
            method: 'POST',
            body: {
                autoStart: Boolean(byId('omtp-gateway-autostart')?.checked),
                requireAuth,
                // The server requires an explicit confirmation before it turns
                // the gateway into an unauthenticated endpoint.
                ...(requireAuth ? {} : { confirmInsecure: true }),
            },
        });
        notify('success', tr('omtp_gateway_saved', 'Gateway settings saved'));
    } catch (error) {
        notify('error', trf('omtp_gateway_save_failed', 'Could not save gateway settings: ${0}', errorMessage(error)));
    }
    await refreshServerStatus();
}

export async function restoreNativeSelection() {
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
    if (isServerAvailable() === false) {
        notify('warning', tr('omtp_keys_delete_unavailable', 'Server plugin unavailable; provider keys were not deleted'));
        return;
    }
    const targets = getProvidersCache().filter((provider) => provider.hasKey);
    let removed = 0;
    const failed = [];
    for (const provider of targets) {
        try {
            await apiFetch(`/providers/${encodeURIComponent(provider.id)}/key`, { method: 'DELETE' });
            removed += 1;
            forgetLiveModels(provider.id);
        } catch (error) {
            console.warn(`[omtp] could not delete key for ${provider.id}`, error);
            failed.push(String(provider.id));
        }
    }
    if (removed > 0) {
        invalidateGatewayCaches();
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

export async function clearSettings() {
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
