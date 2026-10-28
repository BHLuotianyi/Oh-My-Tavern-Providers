/**
 * Details pane rendering for the hub.
 */
import * as catalogApi from '../catalog.js';
import * as engine from '../switch-engine.js';
import { MAX_FAVORITES, REASONING_LEVELS } from '../constants.js';
import {
    AA_PERSONALITY_URL,
    PERSONALITY_INDEXES,
    indexLabel,
    personalityFor,
    personalityRadarSvg,
    roleplayBadge,
    roleplayTooltip,
} from '../personality.js';
import { normalizeEffortList } from '../reasoning.js';
import * as extraBody from './extra-body.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { state } from './hub-state.js';
import {
    entryKey,
    formatNumber,
    isFavoriteEntry,
    persist,
    refKey,
    refOf,
    sameRef,
    setLiveRefreshState,
    settings,
    sourceLabel,
    sourceOf,
    toast,
} from './hub-utils.js';
import { getSelectedEntry, providerLabel, rebuildEntries } from './hub-catalog.js';
import { renderList } from './hub-list.js';
import { revealLoginRow, renderProviderList } from './hub-sidebar.js';
import { armQuickSlot, syncTabs } from './hub-quick.js';
import {
    copySelector,
    getCharacterBinding,
    getChatBinding,
    openProviderSettings,
    toggleCharacterBinding,
    toggleChatBinding,
    useEntry,
} from './hub-actions.js';

/**
 * Append a definition-list row.
 * @param {HTMLElement} list
 * @param {string} label
 * @param {string} value
 */
function addMeta(list, label, value) {
    list.append(el('dt', null, label), el('dd', null, value));
}

/**
 * Create a details action button.
 * @param {string} id
 * @param {string} label
 * @param {Function} handler
 * @param {string} [extraClass]
 * @returns {HTMLButtonElement}
 */
function actionButton(id, label, handler, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = extraClass;
    button.textContent = label;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        try {
            const result = handler();
            if (result?.catch) {
                result.catch((error) => toast(error?.message || String(error), 'error'));
            }
        } catch (error) {
            toast(error?.message || String(error), 'error');
        }
    });
    return button;
}

/**
 * Report the outcome of a live-model refresh.
 * @param {{models?: object[], needsCredentials?: boolean, error?: string}|null} result
 */
function announceLiveModelResult(result) {
    if (result?.models?.length) {
        toast(trf('omtp_live_models_found', 'Fetched ${0} models from the API', result.models.length), 'success');
    } else if (result?.needsCredentials) {
        toast(tr('omtp_refresh_needs_key', 'This provider has no credentials yet; add a key first.'), 'warning');
    } else if (result?.error) {
        toast(trf('omtp_refresh_failed', 'Refresh failed: ${0}', result.error), 'error');
    } else {
        toast(tr('omtp_live_models_none', 'The provider returned no models.'), 'info');
    }
}

/**
 * Section header for a provider: label, match count and a live-refresh button.
 * @param {string} providerId
 * @param {number} count Models shown under the header.
 * @returns {HTMLElement}
 */
export function renderProviderHeader(providerId, count) {
    const group = state.providerGroups.get(providerId);
    const headerRow = el('div', 'omtp-section-header-row');
    const titleElem = el('div', 'omtp-section-title', `${providerLabel(providerId, group?.label)} · ${count}`);
    const refreshBtn = el('button', 'omtp-provider-refresh-btn', '🔄 ' + tr('omtp_refresh_live_models', 'Refresh live models'));
    refreshBtn.title = tr('omtp_refresh_live_models_hint', 'Fetch the current model list from this provider API');
    refreshBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        setLiveRefreshState(refreshBtn, true);
        refreshBtn.disabled = true;
        try {
            const result = await catalogApi.fetchLiveModelsForProvider(providerId, true);
            announceLiveModelResult(result);
            rebuildEntries();
            renderList();
        } catch (error) {
            toast(trf('omtp_live_models_failed', 'Could not fetch models: ${0}', error.message || error), 'error');
        } finally {
            setLiveRefreshState(refreshBtn, false);
            refreshBtn.disabled = false;
        }
    });
    headerRow.append(titleElem, refreshBtn);
    return headerRow;
}

/**
 * Radar chart + index list for a model with AA-PersonalityBench data.
 * @param {any} record
 * @returns {HTMLElement}
 */
function personalitySection(record) {
    const wrap = el('div', 'omtp-pb');
    const head = el('div', 'omtp-pb-head');
    const title = el('span', 'omtp-pb-title', tr('omtp_pb_title', 'AA-PersonalityBench'));
    const link = el('a', 'omtp-pb-link', '↗');
    link.href = AA_PERSONALITY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = tr('omtp_pb_open', 'Open the AA-PersonalityBench page');
    head.append(title, link);
    wrap.append(head);

    const scores = el('div', 'omtp-pb-scores');
    const aa = el('span', 'omtp-pb-score', trf('omtp_pb_mean', 'Mean index ${0}', Math.round(record.mean)));
    const rp = el('span', 'omtp-pb-score omtp-pb-rp', roleplayBadge(record));
    rp.title = roleplayTooltip(record);
    scores.append(aa, rp);
    wrap.append(scores);

    const radar = el('div', 'omtp-pb-chart');
    radar.innerHTML = personalityRadarSvg(record);
    wrap.append(radar);

    const list = el('div', 'omtp-pb-list');
    for (const index of PERSONALITY_INDEXES) {
        const value = Math.round(Number(record.scores[index] ?? 0));
        if (!Number.isFinite(value)) {
            continue;
        }
        const row = el('div', 'omtp-pb-row');
        const bar = el('span', 'omtp-pb-bar');
        const fill = el('span', 'omtp-pb-fill');
        fill.style.width = `${Math.max(2, Math.min(100, value))}%`;
        bar.append(fill);
        row.append(
            el('span', 'omtp-pb-label', indexLabel(index)),
            bar,
            el('span', 'omtp-pb-value', String(value)),
        );
        list.append(row);
    }
    wrap.append(list);

    const note = el('div', 'omtp-pb-note');
    note.textContent = record.published
        ? tr('omtp_pb_attribution', 'Data: Artificial Analysis')
        : `${tr('omtp_pb_attribution', 'Data: Artificial Analysis')} · ${tr('omtp_pb_derived', 'Indexes derived from AA trait z-scores')}`;
    wrap.append(note);
    return wrap;
}

/** @param {any} entry */
function reasoningMetaText(entry) {
    if (!entry.reasoning) {
        return tr('omtp_no', 'No');
    }
    if (Array.isArray(entry.efforts) && entry.efforts.length) {
        return normalizeEffortList(entry.efforts).filter((level) => level !== 'auto').join(', ') || tr('omtp_yes', 'Yes');
    }
    return tr('omtp_yes', 'Yes');
}

/**
 * Definition list for a selected entry.
 * @param {object} entry
 * @returns {HTMLElement}
 */
function renderDetailsMeta(entry) {
    const meta = document.createElement('dl');
    meta.className = 'omtp-details-meta';
    addMeta(meta, tr('omtp_meta_provider', 'Provider'), providerLabel(entry.providerId || entry.provider, entry.providerLabel || entry.provider));
    addMeta(meta, tr('omtp_meta_source', 'Source'), sourceLabel(entry));
    addMeta(meta, tr('omtp_meta_context', 'Context'), entry.contextWindow ? formatNumber(entry.contextWindow) : '—');
    addMeta(meta, tr('omtp_meta_max_tokens', 'Max tokens'), entry.maxTokens ? formatNumber(entry.maxTokens) : '—');
    if (Array.isArray(entry.input) && entry.input.length) {
        addMeta(meta, tr('omtp_meta_input', 'Input'), entry.input.join(', '));
    }
    addMeta(meta, tr('omtp_meta_tools', 'Tools (reference only)'), entry.supportsTools ? tr('omtp_yes', 'Yes') : tr('omtp_no', 'No'));
    addMeta(meta, tr('omtp_meta_reasoning', 'Reasoning'), reasoningMetaText(entry));
    addMeta(meta, tr('omtp_meta_status', 'Status'), entry.available === false ? tr('omtp_status_unavailable', 'Unavailable') : tr('omtp_status_available', 'Available'));
    return meta;
}

/**
 * Reasoning-effort selector for an entry.
 * @param {object} entry
 * @param {string} key
 * @returns {HTMLElement}
 */
function renderReasoningControl(entry, key) {
    const reasoningRow = el('div', 'omtp-details-reason');
    const reasoningLabelElement = el('label', null, tr('omtp_reasoning', 'Reasoning effort'));
    reasoningLabelElement.htmlFor = 'omtp-reasoning';
    const reasoningSelect = document.createElement('select');
    reasoningSelect.id = 'omtp-reasoning';
    for (const level of REASONING_LEVELS) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level === 'auto' ? tr('omtp_reasoning_auto', 'auto') : level;
        reasoningSelect.append(option);
    }
    const supportsReasoning = Boolean(entry.reasoning) || (Array.isArray(entry.efforts) && entry.efforts.length > 0);
    reasoningSelect.disabled = !supportsReasoning;
    if (!supportsReasoning) {
        reasoningSelect.title = 'This model does not expose reasoning effort';
    }
    reasoningSelect.value = settings().reasoningByEntry?.[key] || 'auto';
    reasoningSelect.addEventListener('change', () => setReasoning(entry, reasoningSelect.value));
    reasoningRow.append(reasoningLabelElement, reasoningSelect);
    return reasoningRow;
}

/**
 * Warning that explains why an unavailable model cannot be used.
 * @param {object} entry
 * @returns {HTMLElement}
 */
function renderUnavailableWarning(entry) {
    const status = state.providerAvailability.get(String(entry.providerId || entry.provider));
    const warnBox = el('div', 'omtp-unavail-warning-box');
    warnBox.textContent = status?.keyInvalid
        ? trf('omtp_provider_key_rejected', '⚠️ The stored key was rejected (${0}). Replace it below.', status.keyInvalidReason || 'auth error')
        : tr('omtp_provider_needs_key', '⚠️ This provider has no API key or login. Add credentials below to use it.');
    return warnBox;
}

/**
 * Action bar for a selected entry.
 * @param {object} entry
 * @param {object} ref
 * @param {HTMLElement} details
 * @returns {HTMLElement}
 */
function renderDetailsActions(entry, ref, details) {
    const actions = el('div', 'omtp-details-actions');

    const useButton = actionButton('omtp-use-model', tr('omtp_use_model', 'Use model'), () => useEntry(entry), 'omtp-wide');
    useButton.disabled = entry.available === false;
    actions.append(useButton);

    if (entry.available === false) {
        details.append(renderUnavailableWarning(entry));
    }

    const favorite = isFavoriteEntry(entry);
    actions.append(actionButton(
        'omtp-fav-toggle',
        favorite ? tr('omtp_unfavorite', 'Unfavorite') : tr('omtp_favorite', 'Favorite'),
        () => toggleFavorite(entry),
        favorite ? 'omtp-on' : '',
    ));

    actions.append(actionButton(
        'omtp-quick-assign',
        tr('omtp_quick_save', 'Save to quick bar'),
        () => armQuickSlot(entry),
        state.pendingQuickEntry && entryKey(state.pendingQuickEntry) === entryKey(entry) ? 'omtp-on' : '',
    ));

    const chatBinding = getChatBinding();
    const chatBound = chatBinding?.ref ? sameRef(chatBinding.ref, ref) : false;
    actions.append(actionButton(
        'omtp-bind-chat',
        chatBound ? tr('omtp_unbind_chat', 'Unbind chat') : tr('omtp_bind_chat', 'Bind chat'),
        () => toggleChatBinding(entry),
        chatBound ? 'omtp-on' : '',
    ));

    const characterBinding = getCharacterBinding();
    const characterBound = characterBinding?.ref ? sameRef(characterBinding.ref, ref) : false;
    actions.append(actionButton(
        'omtp-bind-character',
        characterBound ? tr('omtp_unbind_character', 'Unbind character') : tr('omtp_bind_character', 'Bind character'),
        () => toggleCharacterBinding(entry),
        characterBound ? 'omtp-on' : '',
    ));

    actions.append(actionButton('omtp-edit-extra-body', tr('omtp_edit_extra_body', 'Edit extra body'), () => extraBody.openExtraBodyEditor(entry)));

    actions.append(actionButton('omtp-provider-settings', tr('omtp_provider_settings', 'Provider settings'), () => openProviderSettings(entry)));

    actions.append(actionButton('omtp-copy-selector', tr('omtp_copy_selector', 'Copy selector'), () => copySelector(entry)));

    return actions;
}

/** @param {{keyInvalid?: boolean}} [status] @param {object} entry */
function credentialStatusText(status, entry) {
    if (status?.keyInvalid) {
        return tr('omtp_credentials_invalid', '🔴 Key rejected');
    }
    if (entry.available !== false) {
        return tr('omtp_credentials_ready', '🟢 Ready');
    }
    return tr('omtp_credentials_missing', '⚪ Not authorized');
}

/**
 * Render the details pane for the selected/current entry.
 */
export function renderDetails() {
    const details = document.getElementById('omtp-details');
    if (!details) {
        return;
    }
    details.replaceChildren();
    details.scrollTop = 0;
    const entry = getSelectedEntry();
    if (!entry) {
        details.append(el('div', 'omtp-empty-state', tr('omtp_details_empty', 'Select a model to see its details.')));
        return;
    }

    const ref = refOf(entry);
    const key = entryKey(entry);
    details.append(el('h3', null, entry.modelLabel || entry.model));
    details.append(el('div', 'omtp-details-id', entry.model));
    details.append(el('span', `omtp-badge omtp-badge-${sourceOf(entry).toLowerCase()}`, sourceLabel(entry)));

    if (entry.unsupportedReason) {
        const reason = el('div', 'omtp-unsupported', trf('omtp_unsupported', 'Not selectable: ${0}', entry.unsupportedReason));
        details.append(reason);
    }

    details.append(renderDetailsMeta(entry));

    const personality = personalityFor(entry);
    if (personality) {
        details.append(personalitySection(personality.record));
    }

    details.append(renderReasoningControl(entry, key));
    details.append(renderDetailsActions(entry, ref, details));
    renderInHubProviderCard(entry, details);
}

/**
 * Credential status card for gateway providers, linking to the sign-in tab.
 * @param {object} entry
 * @param {HTMLElement} details
 */
function renderInHubProviderCard(entry, details) {
    const providerId = entry.providerId || entry.provider;
    if (!providerId || entry.kind === 'profile') return;

    const kinds = Array.isArray(entry.authKinds) && entry.authKinds.length
        ? entry.authKinds
        : (entry.authKind ? [entry.authKind] : []);
    if (kinds.includes('none') || kinds.length === 0) {
        return;
    }

    // Credential management lives in the Login tab (omp's `/login`), not in the
    // model details: one place decides how a provider signs in.
    const status = state.providerAvailability.get(String(providerId));
    const card = el('div', 'omtp-in-hub-provider-card');
    const title = el('div', 'omtp-card-title');
    title.append(el('span', null, `🔑 ${entry.providerLabel || providerId}`));
    const statusElement = el('span', 'omtp-card-status', credentialStatusText(status, entry));
    title.append(statusElement);
    card.append(title);

    const action = el('button', 'menu_button', tr('omtp_open_login', 'Open sign-in'));
    action.type = 'button';
    action.addEventListener('click', () => {
        state.currentTab = 'providers';
        syncTabs();
        renderProviderList();
        renderList();
        setTimeout(() => revealLoginRow(providerId, { smooth: false }), 200);
    });
    card.append(action);
    details.append(card);
}

/**
 * Persist and apply a reasoning level for an entry.
 * @param {object} entry
 * @param {string} level
 */
function setReasoning(entry, level) {
    const key = entryKey(entry);
    try {
        engine.applyReasoning(entry, level);
        return;
    } catch (error) {
        console.warn('[omtp] could not apply reasoning effort', error);
    }
    const map = { ...(settings().reasoningByEntry || {}) };
    if (!level) {
        delete map[key];
    } else {
        map[key] = level;
    }
    persist({ reasoningByEntry: map });
}

/**
 * Toggle an entry in the favorites list.
 * @param {object} entry
 */
export function toggleFavorite(entry) {
    const key = entryKey(entry);
    const ref = refOf(entry);
    const favorites = settings().favorites || [];
    const exists = favorites.some((item) => refKey(item) === key);
    const next = exists
        ? favorites.filter((item) => refKey(item) !== key)
        : [ref, ...favorites].slice(0, MAX_FAVORITES);
    persist({ favorites: next });
    if (state.isOpen) {
        renderList();
        renderDetails();
    }
}
