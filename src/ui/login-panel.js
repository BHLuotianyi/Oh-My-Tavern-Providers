/**
 * Login panel — mirrors omp's `/login` menu.
 *
 * One row per provider: name, sign-in state, and exactly one primary action
 * (sign in / paste a key / sign out). OAuth rows drive the server's generic
 * login engine; providers whose policy needs provider-specific code point at
 * the OMP import instead.
 */
import { getRequestHeaders } from '../../../../../../script.js';
import { API_BASE } from '../constants.js';
import { apiKeyUrlFor } from '../provider-links.js';
import { providerDisplayName, supportsProviderNames } from '../provider-names.js';
import { getSettings } from '../store.js';
import { tr, trf } from './dom.js';
import { openCustomProviderEditor } from './settings.js';

/** Providers with a login flow come first, like omp's `/login` roster. */
const KIND_RANK = new Map([
    ['oauth-code', 0],
    ['device-code', 1],
    ['custom', 2],
    ['api-key', 3],
]);

/** @type {Map<string, {timer: number|null}>} */
const activeSessions = new Map();

let host = null;
/** @type {(() => void)|null} */
let onChanged = null;
/** Last fetched provider roster, so filtering never re-queries the server. */
let roster = [];
/** Current search text from the hub's search box. */
let filterText = '';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function api(path, init = {}) {
    const headers = { ...getRequestHeaders(), ...(init.headers || {}) };
    if (init.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
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
        return trf('omtp_login_status_signed_in', 'Signed in${0}', fingerprint(provider));
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
        actions.append(renderKeyEntry(provider));
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
            out.disabled = true;
            try {
                await api(`/providers/${encodeURIComponent(id)}/logout`, { method: 'POST' });
                onChanged?.();
                await refresh();
            } catch (error) {
                onChanged?.(error);
            } finally {
                out.disabled = false;
            }
        });
        actions.append(out);
    }

    row.append(actions);
    return row;
}

/** Placeholder value shown for a stored key; never sent back to the server. */
const KEY_MASK = '••••••••••••';

function renderKeyEntry(provider) {
    const wrap = el('div', 'omtp-login-key');
    const field = el('div', 'omtp-key-field');
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.placeholder = tr('omtp_provider_key', 'API key');
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
        save.disabled = true;
        try {
            await api(`/providers/${encodeURIComponent(provider.id)}/key`, {
                method: 'POST',
                body: JSON.stringify({ key }),
            });
            input.value = '';
            onChanged?.();
            await refresh();
        } catch (error) {
            onChanged?.(error);
        } finally {
            save.disabled = false;
        }
    });
    wrap.append(field, save, hint);
    return wrap;
}

async function startLogin(provider, row, actions) {
    const id = String(provider.id);
    actions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    // Open the tab synchronously: a popup created after `await` is blocked.
    // The authorize URL only exists once the server answers, so we navigate
    // the placeholder tab instead of opening a fresh one.
    let popup = null;
    try {
        popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
    } catch {
        popup = null;
    }
    const panel = el('div', 'omtp-login-flow');
    row.append(panel);
    panel.textContent = tr('omtp_login_starting', 'Starting…');
    try {
        const started = await api(`/providers/${encodeURIComponent(id)}/login`, {
            method: 'POST',
            body: JSON.stringify({ locale: navigator.language || '' }),
        });
        if (popup && started.url) {
            try {
                popup.location.href = started.url;
            } catch {
                // The browser can still refuse; the link below stays visible.
            }
        }
        panel.replaceChildren();
        panel.append(el('div', 'omtp-login-instruction', started.instructions || tr('omtp_login_browser_hint', 'Complete the login in your browser.')));
        if (started.url) {
            if (!popup) {
                panel.append(el('div', 'omtp-login-hint', tr('omtp_login_popup_blocked', 'The browser blocked the sign-in tab — open it below.')));
            }
            const link = el('a', 'omtp-login-url', started.url);
            link.href = started.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            panel.append(link);
        }
        if (started.userCode) {
            panel.append(el('div', 'omtp-login-usercode', started.userCode));
        }
        if (started.kind === 'oauth-code') {
            const paste = el('div', 'omtp-login-paste');
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = tr('omtp_login_paste_placeholder', 'Paste the redirect URL or authorization code');
            const submit = el('button', 'menu_button', tr('omtp_login_paste_submit', 'Submit'));
            submit.type = 'button';
            submit.addEventListener('click', async () => {
                submit.disabled = true;
                try {
                    const result = await api(`/providers/${encodeURIComponent(id)}/login/${encodeURIComponent(started.id)}/code`, {
                        method: 'POST',
                        body: JSON.stringify({ code: input.value }),
                    });
                    if (result.status === 'done') {
                        finishLogin(id, row, panel, result, popup);
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
            panel.append(paste);
        }

        const cancel = el('button', 'menu_button', tr('omtp_login_cancel', 'Cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', async () => {
            stopPolling(id);
            try {
                popup?.close();
            } catch {
                // the browser may refuse to close a cross-origin tab
            }
            await api(`/providers/${encodeURIComponent(id)}/login/${encodeURIComponent(started.id)}`, { method: 'DELETE' }).catch(() => {});
            panel.remove();
            actions.querySelectorAll('button').forEach((button) => { button.disabled = false; });
        });
        panel.append(cancel);

        pollSession(id, started.id, row, panel, popup);
    } catch (error) {
        panel.replaceChildren(el('div', 'omtp-login-error', String(error.message || error)));
    }
}

function stopPolling(providerId) {
    const entry = activeSessions.get(providerId);
    if (entry?.timer) {
        clearInterval(entry.timer);
    }
    activeSessions.delete(providerId);
}

function pollSession(providerId, sessionId, row, panel, popup = null) {
    stopPolling(providerId);
    const timer = setInterval(async () => {
        try {
            const status = await api(`/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(sessionId)}`);
            if (status.status === 'done') {
                finishLogin(providerId, row, panel, status, popup);
            } else if (status.status === 'error') {
                stopPolling(providerId);
                panel.append(el('div', 'omtp-login-error', status.error || 'Login failed'));
            }
        } catch {
            stopPolling(providerId);
        }
    }, 2000);
    activeSessions.set(providerId, { timer });
}

function finishLogin(providerId, row, panel, status, popup = null) {
    stopPolling(providerId);
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
    host = null;
    onChanged = null;
}
