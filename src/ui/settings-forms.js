/**
 * OMTP Model Hub — custom-provider and OMP-import popup forms.
 */
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../../../popup.js';
import { GATEWAY_ADAPTERS } from '../constants.js';
import { forgetLiveModels } from '../catalog.js';
import { invalidateGatewayCaches } from '../switch-engine.js';
import { gatewayUnavailableText, tr, trf } from './dom.js';
import { el, isPlainObject, notify } from './helpers.js';
import { reloadClientCatalog } from './settings-actions.js';
import {
    apiFetch,
    errorMessage,
    isServerAvailable,
    refreshProviders,
    safeHttpUrl,
} from './settings-api.js';

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
    const baseUrl = safeHttpUrl(baseUrlInput.value);
    if (!baseUrl) {
        errorLine.textContent = tr('omtp_invalid_url', 'Enter a valid http(s) URL without a query string.');
        return false;
    }
    const config = {
        custom: true,
        label: labelInput.value.trim() || id,
        adapter: adapterSelect.value,
        baseUrl,
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
    } finally {
        // The config may already have changed even when the key save failed.
        forgetLiveModels(id);
        invalidateGatewayCaches();
    }
    notify('success', trf('omtp_provider_added', 'Provider ${0} added', config.label));
    await refreshProviders();
    return true;
}

export function openCustomProviderEditor() {
    if (isServerAvailable() === false) {
        notify('warning', gatewayUnavailableText());
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

export function openImportPopup() {
    if (isServerAvailable() === false) {
        notify('warning', gatewayUnavailableText());
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
                invalidateGatewayCaches();
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
