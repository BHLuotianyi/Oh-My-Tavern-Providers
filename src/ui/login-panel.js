/**
 * Login panel — mirrors omp's `/login` menu.
 *
 * One row per provider: name, sign-in state, and exactly one primary action
 * (sign in / paste a key / sign out). OAuth rows drive the server's generic
 * login engine; providers whose policy needs provider-specific code point at
 * the OMP import instead.
 */
import { apiBase, isTauriTavern, requestHeaders } from '../backend.js';
import { apiKeyUrlFor } from '../provider-links.js';
import { providerDisplayName, supportsProviderNames } from '../provider-names.js';
import { forgetLiveModels } from '../catalog.js';
import { getSettings } from '../store.js';
import { invalidateGatewayCaches } from '../switch-engine.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';
import { openCustomProviderEditor } from './settings-forms.js';

/**
 * Authorize URLs come from the server (and ultimately from a catalog policy).
 * Never let a non-http(s) URL reach `location.href` or an anchor href.
 * @param {unknown} value
 * @returns {string}
 */
function safeAuthorizeUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
        return '';
    }
}

/** Providers with a login flow come first, like omp's `/login` roster. */
const KIND_RANK = new Map([
    ['oauth-code', 0],
    ['device-code', 1],
    ['custom', 2],
    ['api-key', 3],
]);

/** @typedef {{timer: number|null, stall?: number}} PollEntry */

/** @type {Map<string, PollEntry>} */
const activeSessions = new Map();

/** How long a bound callback may stay silent before the panel explains why. */
const CALLBACK_STALL_MS = 20_000;

/**
 * Last failed row action per provider. Kept outside the DOM so a hub refresh
 * that re-renders the roster cannot swallow the error.
 * @type {Map<string, string>}
 */
const actionErrors = new Map();

let host = null;
/** @type {(() => void)|null} */
let onChanged = null;
/** Last fetched provider roster, so filtering never re-queries the server. */
let roster = [];
/** Current search text from the hub's search box. */
let filterText = '';

async function api(path, init = {}) {
    const headers = { ...requestHeaders(), ...(init.headers || {}) };
    if (init.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${apiBase()}${path}`, { ...init, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
    }
    return data;
}

/**
 * Which credential this row reflects: a masked API key or the account email.
 * @param {object} provider
 * @returns {string}
 */
function fingerprint(provider) {
    const value = String(provider.last4 || '');
    if (!value) return '';
    // OAuth credentials report their account email; keys report the last 4.
    return value.includes('@') ? ` · ${value}` : ` · ****${value}`;
}

function statusText(provider) {
    // `keyInvalid` only ever applies to a stored key; an empty slot can never be
    // "rejected", it is simply not signed in.
    if (provider.keyInvalid && provider.hasKey) {
        return trf('omtp_login_status_invalid', 'Key rejected — ${0}', provider.keyInvalidReason || 'auth error') + fingerprint(provider);
    }
    if (provider.hasKey) {
        // Say where the key comes from: a key inherited from SillyTavern's own
        // secrets is not stored here and signs out through this panel.
        const label = provider.keySource === 'st'
            ? 'omtp_login_status_signed_in_tavern'
            : 'omtp_login_status_signed_in';
        const fallback = provider.keySource === 'st'
            ? 'Signed in via SillyTavern${0}'
            : 'Signed in${0}';
        return trf(label, fallback, fingerprint(provider));
    }
    if (provider.authKind === 'none') {
        return tr('omtp_login_status_keyless', 'No sign-in needed');
    }
    return tr('omtp_login_status_signed_out', 'Not signed in');
}

function rank(provider) {
    const kind = provider.loginKind || (provider.authKind === 'none' ? 'none' : 'api-key');
    return KIND_RANK.has(kind) ? KIND_RANK.get(kind) : 4;
}

/**
 * @param {object} provider
 * @param {string} query Lower-cased needle.
 * @returns {boolean}
 */
function matchesQuery(provider, query) {
    const haystack = [provider.label, provider.id, provider.authKind].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
}

/**
 * Render the login rows.
 * @param {object[]} providers
 */
function renderRows(providers) {
    if (!host) {
        return;
    }
    roster = providers;
    host.replaceChildren();
    const list = el('div', 'omtp-login-list');
    const query = filterText.trim().toLowerCase();
    const sorted = [...providers]
        .filter((provider) => !query || matchesQuery(provider, query))
        .sort((a, b) => rank(a) - rank(b)
            || String(a.label || a.id).localeCompare(String(b.label || b.id)));

    if (!sorted.length) {
        list.append(el('div', 'omtp-login-empty', trf('omtp_login_no_results', 'No provider matches “${0}”.', filterText.trim())));
    }
    for (const provider of sorted) {
        list.append(renderRow(provider));
    }
    const footer = el('div', 'omtp-login-footer');
    const add = el('button', 'menu_button', tr('omtp_add_provider', 'Add custom provider'));
    add.type = 'button';
    add.addEventListener('click', () => {
        openCustomProviderEditor();
        setTimeout(() => refresh(), 1200);
    });
    footer.append(add);
    host.append(list, footer);
}

/** Show a failed action on its row (and keep it across a re-render). */
function showActionError(row, providerId, message) {
    actionErrors.set(providerId, message);
    let hint = row.querySelector('.omtp-login-action-error');
    if (!hint) {
        hint = el('div', 'omtp-login-hint omtp-login-error omtp-login-action-error');
        row.append(hint);
    }
    hint.textContent = message;
}

/** Clear a row's failed-action hint before a new attempt. */
function clearActionError(row, providerId) {
    actionErrors.delete(providerId);
    row?.querySelector?.('.omtp-login-action-error')?.remove();
}

function renderRow(provider) {
    const id = String(provider.id);
    const row = el('div', 'omtp-login-row');
    row.dataset.provider = id;

    const head = el('div', 'omtp-login-head');
    const translateNames = supportsProviderNames(document.documentElement.lang)
        && getSettings().ui?.translateProviderNames !== false;
    const name = el('div', 'omtp-login-name', providerDisplayName(id, provider.label || id, translateNames));
    // Green means "usable right now": keyed providers with a live key and
    // keyless local runtimes alike.
    const stateClass = provider.keyInvalid && provider.hasKey
        ? ' omtp-login-state-error'
        : provider.hasKey || provider.available ? ' omtp-login-state-ok' : '';
    const state = el('div', 'omtp-login-state' + stateClass);
    state.textContent = statusText(provider);
    head.append(name, state);
    row.append(head);

    const actions = el('div', 'omtp-login-actions');
    const kind = provider.loginKind || '';
    const signedIn = Boolean(provider.hasKey);

    // `custom` providers run here too when the server ships their hook.
    if (kind === 'oauth-code' || kind === 'device-code' || kind === 'custom') {
        const loginBtn = el('button', 'menu_button', tr('omtp_login_sign_in', 'Sign in'));
        loginBtn.type = 'button';
        loginBtn.addEventListener('click', () => startLogin(provider, row, actions));
        actions.append(loginBtn);
        if (provider.loginNeedsHook) {
            loginBtn.disabled = true;
            loginBtn.title = tr('omtp_login_needs_omp', 'This flow needs provider-specific code; sign in with omp and import');
        }
    }

    if (kind === 'custom' && provider.loginNeedsHook) {
        actions.append(el('span', 'omtp-login-hint', tr('omtp_login_needs_omp', 'This flow needs provider-specific code; sign in with omp and import')));
    }

    // Providers with a login flow get a Sign in button only; key entry stays
    // for plain api-key providers and custom hooks we cannot drive.
    const hasLoginFlow = kind === 'oauth-code' || kind === 'device-code' || (kind === 'custom' && !provider.loginNeedsHook);
    if (provider.authKind !== 'none' && !hasLoginFlow) {
        actions.append(renderKeyEntry(provider, row));
    }

    const consoleUrl = apiKeyUrlFor(id);
    if (consoleUrl && provider.authKind !== 'none') {
        const link = el('a', 'menu_button omtp-get-key', tr('omtp_get_api_key', 'Get API key'));
        link.href = consoleUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
    }

    if (signedIn) {
        const out = el('button', 'menu_button', tr('omtp_logout', 'Sign out'));
        out.type = 'button';
        out.addEventListener('click', async () => {
            clearActionError(row, id);
            out.disabled = true;
            try {
                await api(`/providers/${encodeURIComponent(id)}/logout`, { method: 'POST' });
                forgetLiveModels(id);
                invalidateGatewayCaches();
                onChanged?.();
                await refresh();
            } catch (error) {
                showActionError(row, id, trf('omtp_login_logout_failed', 'Could not sign out: ${0}', error.message || error));
                onChanged?.();
            } finally {
                out.disabled = false;
            }
        });
        actions.append(out);
    }

    row.append(actions);
    if (provider.supportsUserAgentSpoof) {
        row.append(renderConfigToggle(provider, row, 'userAgentSpoof',
            tr('omtp_login_ua_spoof', 'Disguise User-Agent as the opencode client'),
            (message) => trf('omtp_login_ua_spoof_failed', 'Could not save the User-Agent setting: ${0}', message)));
    }
    if (provider.supportsSingleMaxTokens) {
        row.append(renderConfigToggle(provider, row, 'singleMaxTokens',
            tr('omtp_login_single_max_tokens', 'Send only max_tokens (drop max_completion_tokens when both are set)'),
            (message) => trf('omtp_login_single_max_tokens_failed', 'Could not save the token limit setting: ${0}', message)));
    }
    const notice = PROVIDER_NOTICES[id];
    if (notice) {
        row.append(el('div', 'omtp-login-hint omtp-login-warning', tr(notice[0], notice[1])));
    }
    if (actionErrors.has(id)) {
        row.append(el('div', 'omtp-login-hint omtp-login-error omtp-login-action-error', actionErrors.get(id)));
    }
    return row;
}

/** Placeholder value shown for a stored key; never sent back to the server. */
const KEY_MASK = '••••••••••••';

/**
 * Warnings shown under a provider row: `[i18n key, English fallback]`.
 * Volcengine's plan terms say the plan key outside AI coding / agent tools may
 * get the subscription suspended or the account banned.
 */
const PROVIDER_NOTICES = Object.freeze({
    'volcengine-coding-plan': ['omtp_login_ark_plan_warning', 'Volcengine only allows this plan in AI coding / agent tools; using it elsewhere (such as SillyTavern) may get the subscription suspended or the account banned.'],
    'volcengine-agent-plan': ['omtp_login_ark_plan_warning', 'Volcengine only allows this plan in AI coding / agent tools; using it elsewhere (such as SillyTavern) may get the subscription suspended or the account banned.'],
});

/**
 * Per-provider boolean switch stored in the provider config. Defaults to on;
 * the server treats an absent value as on.
 * @param {object} provider
 * @param {HTMLElement} row
 * @param {'userAgentSpoof'|'singleMaxTokens'} key
 * @param {string} label
 * @param {(message: string) => string} failureText
 * @returns {HTMLElement}
 */
function renderConfigToggle(provider, row, key, label, failureText) {
    const id = String(provider.id);
    const wrap = el('label', 'checkbox_label omtp-login-spoof');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = provider[key] !== false;
    input.addEventListener('change', async () => {
        input.disabled = true;
        try {
            await api(`/providers/${encodeURIComponent(id)}/config`, {
                method: 'POST',
                body: JSON.stringify({ [key]: input.checked }),
            });
            onChanged?.();
            await refresh();
        } catch (error) {
            input.checked = !input.checked;
            showActionError(row, id, failureText(error.message || error));
            onChanged?.();
        } finally {
            input.disabled = false;
        }
    });
    wrap.append(input, el('span', null, label));
    return wrap;
}

function renderKeyEntry(provider, row) {
    const id = String(provider.id);
    const wrap = el('div', 'omtp-login-key');
    const field = el('div', 'omtp-key-field');
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.placeholder = tr('omtp_provider_key', 'API key');
    input.setAttribute('aria-label', tr('omtp_provider_key', 'API key'));
    const stored = Boolean(provider.hasKey);
    if (stored) {
        input.value = KEY_MASK;
        input.classList.add('omtp-key-stored');
        input.title = tr('omtp_login_key_stored', 'A key is stored — type a new one to replace it');
    }
    input.addEventListener('input', () => {
        // Any edit invalidates the mask, including deleting it down to empty.
        input.classList.toggle('omtp-key-stored', input.value === KEY_MASK);
    });
    const eye = el('button', 'omtp-key-eye', '👁️');
    eye.type = 'button';
    eye.title = tr('omtp_toggle_key_visibility', 'Show/hide key');
    eye.addEventListener('click', () => {
        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        eye.classList.toggle('omtp-key-eye-on', !visible);
    });
    field.append(input, eye);

    const hint = el('div', 'omtp-login-hint');
    const save = el('button', 'menu_button', tr('omtp_save_key', 'Save key'));
    save.type = 'button';
    save.addEventListener('click', async () => {
        const key = input.value.trim();
        if (stored && input.value === KEY_MASK) {
            hint.textContent = tr('omtp_login_key_unchanged', 'That is the stored key — type a new one to replace it.');
            input.focus();
            input.select();
            return;
        }
        if (!key) {
            hint.textContent = tr('omtp_login_empty_key', 'Enter a key first — use Sign out to clear the stored one.');
            input.focus();
            return;
        }
        hint.textContent = '';
        clearActionError(row, id);
        save.disabled = true;
        try {
            await api(`/providers/${encodeURIComponent(id)}/key`, {
                method: 'POST',
                body: JSON.stringify({ key }),
            });
            input.value = '';
            forgetLiveModels(id);
            invalidateGatewayCaches();
            onChanged?.();
            await refresh();
        } catch (error) {
            showActionError(row, id, trf('omtp_login_save_failed', 'Could not save the key: ${0}', error.message || error));
            onChanged?.();
        } finally {
            save.disabled = false;
        }
    });
    wrap.append(field, save, hint);
    return wrap;
}

function setRowButtonsDisabled(actions, disabled) {
    actions.querySelectorAll('button').forEach((button) => {
        button.disabled = disabled;
    });
}

/**
 * Open the placeholder tab synchronously: a popup created after `await` is
 * blocked. The authorize URL only exists once the server answers, so the
 * placeholder tab is navigated instead of opening a fresh one.
 * TauriTavern hands `window.open` to the system browser and has no popup
 * blocker, so there the URL is opened once known (see openAuthorizeUrl).
 */
function openLoginPopup() {
    if (isTauriTavern()) {
        return null;
    }
    try {
        const popup = window.open('about:blank', '_blank');
        if (popup) {
            popup.opener = null;
        }
        return popup;
    } catch {
        return null;
    }
}

/**
 * @param {Window|null} popup placeholder from openLoginPopup()
 * @param {string} authorizeUrl
 */
function openAuthorizeUrl(popup, authorizeUrl) {
    if (!authorizeUrl) return;
    try {
        if (popup) popup.location.href = authorizeUrl;
        else if (isTauriTavern()) window.open(authorizeUrl, '_blank');
    } catch {
        // The browser can still refuse; the link in the flow stays visible.
    }
}

async function startLogin(provider, row, actions) {
    const id = String(provider.id);
    clearActionError(row, id);
    setRowButtonsDisabled(actions, true);
    const popup = openLoginPopup();
    const panel = el('div', 'omtp-login-flow');
    row.append(panel);
    panel.textContent = tr('omtp_login_starting', 'Starting…');
    try {
        const started = await api(`/providers/${encodeURIComponent(id)}/login`, {
            method: 'POST',
            body: JSON.stringify({ locale: navigator.language || '' }),
        });
        const authorizeUrl = safeAuthorizeUrl(started.url);
        openAuthorizeUrl(popup, authorizeUrl);
        renderLoginFlow(id, started, panel, popup, actions);
        pollSession(id, started, panel, popup, actions);
    } catch (error) {
        // The server refused to build the flow (e.g. no OAuth client id): the
        // placeholder tab is still blank, so close it and let the row retry.
        try {
            popup?.close();
        } catch {
            // the browser may refuse to close a cross-origin tab
        }
        const message = String(error.message || error);
        const hint = /OAuth client id/i.test(message)
            ? tr('omtp_login_needs_client_id', 'Set the OAuth client id in data/omtp/oauth-clients.json or the OMTP_*_CLIENT_ID environment variable.')
            : '';
        panel.replaceChildren(el('div', 'omtp-login-error', hint ? `${message} — ${hint}` : message));
        setRowButtonsDisabled(actions, false);
    }
}

/** Fill the flow panel: instruction, authorize link, device code, paste box and Cancel. */
function renderLoginFlow(id, started, panel, popup, actions) {
    panel.replaceChildren();
    panel.append(el('div', 'omtp-login-instruction', started.instructions || tr('omtp_login_browser_hint', 'Complete the login in your browser.')));
    const authorizeUrl = safeAuthorizeUrl(started.url);
    if (authorizeUrl) {
        if (!popup) {
            panel.append(el('div', 'omtp-login-hint', tr('omtp_login_popup_blocked', 'The browser blocked the sign-in tab — open it below.')));
        }
        const link = el('a', 'omtp-login-url', authorizeUrl);
        link.href = authorizeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        panel.append(link);
    }
    if (started.userCode) {
        panel.append(el('div', 'omtp-login-usercode', started.userCode));
    }
    if (started.kind === 'oauth-code') {
        panel.append(buildPasteBox(id, started.id, panel, popup));
    }

    const cancel = el('button', 'menu_button', tr('omtp_login_cancel', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => cancelLogin(id, started.id, panel, popup, actions));
    panel.append(cancel);
}

function buildPasteBox(id, sessionId, panel, popup) {
    const paste = el('div', 'omtp-login-paste');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = tr('omtp_login_paste_placeholder', 'Paste the redirect URL or authorization code');
    const submit = el('button', 'menu_button', tr('omtp_login_paste_submit', 'Submit'));
    submit.type = 'button';
    submit.addEventListener('click', async () => {
        submit.disabled = true;
        try {
            const result = await api(`/providers/${encodeURIComponent(id)}/login/${encodeURIComponent(sessionId)}/code`, {
                method: 'POST',
                body: JSON.stringify({ code: input.value }),
            });
            if (result.status === 'done') {
                finishLogin(id, panel, result, popup);
            } else {
                panel.append(el('div', 'omtp-login-error', result.error || 'Login failed'));
            }
        } catch (error) {
            panel.append(el('div', 'omtp-login-error', String(error.message || error)));
        } finally {
            submit.disabled = false;
        }
    });
    paste.append(input, submit);
    return paste;
}

async function cancelLogin(id, sessionId, panel, popup, actions) {
    stopPolling(id);
    try {
        popup?.close();
    } catch {
        // the browser may refuse to close a cross-origin tab
    }
    await api(`/providers/${encodeURIComponent(id)}/login/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
    panel.remove();
    setRowButtonsDisabled(actions, false);
}

function stopPolling(providerId) {
    const entry = activeSessions.get(providerId);
    if (entry?.timer) {
        clearInterval(entry.timer);
    }
    if (entry?.stall) {
        clearTimeout(entry.stall);
    }
    activeSessions.delete(providerId);
}

/**
 * Poll a pending session. When a loopback listener was bound (`manual: false`),
 * also explain a callback that never arrives: a browser proxy that does not
 * bypass `localhost`, a container or a remote browser leaves the flow pending
 * with no visible reason, and the paste box is the only way out.
 * @param {string} providerId
 * @param {{id: string, manual?: boolean}} started flow returned by the server
 * @param {HTMLElement} panel
 * @param {Window|null} [popup]
 * @param {HTMLElement|null} [actions] row action container holding the buttons
 */
function pollSession(providerId, started, panel, popup = null, actions = null) {
    const sessionId = started.id;
    stopPolling(providerId);
    const timer = setInterval(async () => {
        try {
            const status = await api(`/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(sessionId)}`);
            if (status.status === 'done') {
                finishLogin(providerId, panel, status, popup);
            } else if (status.status === 'error') {
                stopPolling(providerId);
                panel.append(el('div', 'omtp-login-error', status.error || 'Login failed'));
                if (actions) {
                    setRowButtonsDisabled(actions, false);
                }
            }
        } catch {
            stopPolling(providerId);
        }
    }, 2000);
    /** @type {PollEntry} */
    const entry = { timer };
    // The server sets `manual` when the code arrives by paste; only a bound
    // listener can stall silently.
    if (started.manual === false) {
        entry.stall = setTimeout(() => {
            if (!panel.isConnected || panel.querySelector('.omtp-login-stalled')) {
                return;
            }
            panel.append(el(
                'div',
                'omtp-login-hint omtp-login-stalled',
                tr(
                    'omtp_login_callback_stalled',
                    'No callback has arrived. If a browser proxy, firewall or container is blocking http://localhost, copy the address bar of the sign-in tab and paste it into the box below.',
                ),
            ));
        }, CALLBACK_STALL_MS);
    }
    activeSessions.set(providerId, entry);
}

function finishLogin(providerId, panel, status, popup = null) {
    stopPolling(providerId);
    forgetLiveModels(providerId);
    invalidateGatewayCaches();
    panel.replaceChildren(el('div', 'omtp-login-success', trf('omtp_login_success', 'Signed in${0}', status.account ? ` · ${status.account}` : '')));
    onChanged?.();
    setTimeout(() => refresh(), 400);
    if (popup && !popup.closed) {
        // Let the callback page paint its confirmation first.
        setTimeout(() => {
            try {
                popup.close();
            } catch {
                // cross-origin tabs may refuse to close
            }
        }, 900);
    }
}

/**
 * Fetch provider status and re-render.
 * @returns {Promise<void>}
 */
export async function refresh() {
    if (!host) {
        return;
    }
    try {
        const data = await api('/providers');
        renderRows(Array.isArray(data.providers) ? data.providers : []);
    } catch (error) {
        host.replaceChildren(el('div', 'omtp-muted', String(error.message || error)));
    }
}

/**
 * Mount the login panel.
 * @param {HTMLElement} container
 * @param {{onChanged?: (error?: unknown) => void}} [options]
 */
export async function mountLoginPanel(container, options = {}) {
    onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
    // Re-mounting on every keystroke would refetch and reset the scroll
    // position; re-render from the cached roster instead.
    if (host === container && container.isConnected && roster.length) {
        renderRows(roster);
        return;
    }
    host = container;
    host.replaceChildren(el('div', 'omtp-muted', tr('omtp_login_loading', 'Loading sign-in state…')));
    await refresh();
}

/**
 * Apply the hub's search box to the sign-in roster.
 * @param {string} query
 */
export function setLoginFilter(query) {
    filterText = String(query || '');
    if (!host || !roster.length) {
        return;
    }
    renderRows(roster);
}

/** Stop polling when the tab closes. */
export function disposeLoginPanel() {
    for (const id of [...activeSessions.keys()]) {
        stopPolling(id);
    }
    actionErrors.clear();
    host = null;
    onChanged = null;
}
