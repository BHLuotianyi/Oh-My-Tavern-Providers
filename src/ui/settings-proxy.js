/**
 * OMTP Model Hub — outbound proxy section of the settings panel.
 *
 * The proxy applies to the server plugin's own requests (sign-in, key checks,
 * quota, gateway forwarding), so the choice is stored on the server.
 */
import { tr, trf } from './dom.js';
import { el, isPlainObject, notify } from './helpers.js';
import { apiFetch, applyProxyStatus, byId, errorMessage, refreshProxyStatus } from './settings-api.js';

/**
 * Save the mode and address shown in the panel.
 * @returns {Promise<void>}
 */
async function saveProxySettings() {
    const mode = String(byId('omtp-proxy-mode')?.value || 'system');
    const url = String(byId('omtp-proxy-url')?.value || '').trim();
    if (mode === 'manual' && !url) {
        // Nothing to save until an address is typed; the field is now visible.
        byId('omtp-proxy-url')?.focus();
        return;
    }
    try {
        applyProxyStatus(await apiFetch('/proxy', { method: 'POST', body: { mode, url } }));
        // The last test describes the previous route.
        const output = byId('omtp-proxy-test-result');
        if (output) {
            output.hidden = true;
            output.replaceChildren();
        }
        notify('success', tr('omtp_proxy_saved', 'Proxy settings saved'));
    } catch (error) {
        notify('error', trf('omtp_proxy_save_failed', 'Could not save proxy settings: ${0}', errorMessage(error)));
        await refreshProxyStatus();
    }
}

/**
 * One cell of the result list.
 * @param {string} label
 * @param {{ok: boolean, status?: number, ms: number, error?: string}|null} probe
 * @returns {HTMLElement}
 */
function probeCell(label, probe) {
    if (!probe) {
        return el('span', 'omtp-muted', `${label}: —`);
    }
    const text = probe.ok
        ? trf('omtp_proxy_result_ok', 'HTTP ${0} · ${1} ms', probe.status, probe.ms)
        : String(probe.error || 'failed');
    return el('span', probe.ok ? 'omtp-proxy-ok' : 'omtp-proxy-bad', `${label}: ${probe.ok ? '✓' : '✗'} ${text}`);
}

/**
 * What the result means and what to do about it.
 * @param {Array<{proxy: object|null, direct: object}>} results
 * @returns {string}
 */
function verdict(results) {
    const viaProxy = results.map((entry) => entry.proxy).filter(Boolean);
    if (viaProxy.length) {
        if (viaProxy.every((probe) => probe.ok)) {
            return tr('omtp_proxy_verdict_proxy_ok', 'The proxy works. If sign-in still fails, the error is not a network problem.');
        }
        if (viaProxy.every((probe) => !probe.ok)) {
            return tr('omtp_proxy_verdict_proxy_bad', 'The proxy cannot reach these sites. Check that the proxy app is running, that the port is right, and that its current node works.');
        }
        return tr('omtp_proxy_verdict_mixed', 'Some sites are unreachable through the proxy; check its rules for the hosts marked ✗.');
    }
    if (results.every((entry) => entry.direct.ok)) {
        return tr('omtp_proxy_verdict_direct_ok', 'Direct connections work; no proxy is needed.');
    }
    return tr('omtp_proxy_verdict_direct_bad', 'No proxy is in use and direct connections fail. Turn on the system proxy in your proxy app, or choose Manual and enter its address (for example http://127.0.0.1:7890).');
}

/**
 * Check the sign-in hosts through the current proxy and directly.
 * @returns {Promise<void>}
 */
async function testProxy() {
    const button = byId('omtp-proxy-test');
    const output = byId('omtp-proxy-test-result');
    if (!output) {
        return;
    }
    if (button) {
        button.disabled = true;
    }
    output.hidden = false;
    output.replaceChildren(el('div', 'omtp-muted', tr('omtp_proxy_testing', 'Testing… this takes up to 8 seconds.')));
    try {
        const report = await apiFetch('/proxy/test', { method: 'POST' });
        const results = Array.isArray(report?.results) ? report.results.filter(isPlainObject) : [];
        applyProxyStatus(report);
        const rows = results.map((entry) => {
            const row = el('div', 'omtp-proxy-test-row');
            row.append(
                el('span', 'omtp-proxy-test-host', String(entry.host || '')),
                probeCell(tr('omtp_proxy_col_proxy', 'Proxy'), entry.proxy),
                probeCell(tr('omtp_proxy_col_direct', 'Direct'), entry.direct),
            );
            return row;
        });
        output.replaceChildren(...rows, el('div', 'omtp-proxy-test-verdict', verdict(results)));
    } catch (error) {
        output.replaceChildren(el('div', 'omtp-proxy-bad', trf('omtp_proxy_test_failed', 'Proxy test failed: ${0}', errorMessage(error))));
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

/**
 * Bind the proxy controls inside the settings container.
 * @param {HTMLElement} root
 */
export function bindProxyControls(root) {
    const mode = root.querySelector('#omtp-proxy-mode');
    const url = root.querySelector('#omtp-proxy-url');
    const urlRow = root.querySelector('#omtp-proxy-url-row');
    mode?.addEventListener('change', () => {
        if (urlRow) {
            urlRow.hidden = mode.value !== 'manual';
        }
        saveProxySettings();
    });
    url?.addEventListener('change', () => saveProxySettings());
    root.querySelector('#omtp-proxy-test')?.addEventListener('click', (event) => {
        event.preventDefault();
        testProxy();
    });
}
