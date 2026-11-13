/**
 * Guard for the OMTP management routes (`/api/plugins/omtp/*`).
 *
 * The gateway itself (`127.0.0.1:4100/v1`) has its own Bearer check. These
 * routes are mounted inside SillyTavern, so they inherit the host's auth, but
 * that is not enough: a malicious page can still reach a loopback server with
 * a cross-site request. Requiring a custom header means a browser has to send
 * a CORS preflight first, which SillyTavern does not allow. A same-origin
 * request from the OMTP UI carries the header and passes.
 *
 * Set `OMTP_STRICT_HOST=1` (plus optional `OMTP_ALLOWED_HOSTS=host1,host2`)
 * to also pin the Host header, which closes DNS-rebinding for browser clients.
 * It is opt-in because reverse-proxy deployments use a public Host name.
 */

import { isLoopbackHostHeader } from './net-hosts.mjs';

/** Header every OMTP client request must carry. */
export const CLIENT_HEADER = 'x-omtp-client';
/** Value of {@link CLIENT_HEADER}. */
export const CLIENT_HEADER_VALUE = 'omtp-web';
/**
 * @param {any} req Express-like request
 * @param {string} name lower-case header name
 * @returns {string}
 */
function header(req, name) {
    const fromMap = req?.headers?.[name];
    const raw = fromMap ?? (typeof req?.get === 'function' ? req.get(name) : '');
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Validate that a management request comes from the OMTP UI (or an explicitly
 * authorised local client), not from a foreign web page.
 *
 * @param {any} req Express-like request
 * @param {{strictHost?: boolean, allowedHosts?: string[], env?: Record<string, string|undefined>}} [options]
 * @returns {{ok: boolean, reason: string}}
 */
export function checkTrustedClient(req, options = {}) {
    const env = options.env ?? process.env;
    if (header(req, CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
        return { ok: false, reason: 'missing_client_header' };
    }

    const origin = header(req, 'origin');
    if (origin) {
        let originHost;
        try {
            originHost = new URL(origin).host.toLowerCase();
        } catch {
            return { ok: false, reason: 'invalid_origin' };
        }
        const host = header(req, 'host').toLowerCase();
        if (host && originHost !== host) {
            return { ok: false, reason: 'origin_mismatch' };
        }
    }

    // `same-site` is allowed for front-end proxies that serve the UI from a
    // sibling subdomain; `cross-site` is never a legitimate management call.
    const site = header(req, 'sec-fetch-site').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
        return { ok: false, reason: 'cross_site_request' };
    }

    const strictHost = options.strictHost ?? env.OMTP_STRICT_HOST === '1';
    if (strictHost) {
        const rawHost = header(req, 'host');
        if (!rawHost) {
            return { ok: false, reason: 'host_not_allowed' };
        }
        if (!isLoopbackHostHeader(rawHost)) {
            const allowed = new Set();
            for (const entry of (env.OMTP_ALLOWED_HOSTS || '').split(',')) {
                const name = entry.trim().toLowerCase();
                if (name) allowed.add(name);
            }
            for (const name of options.allowedHosts || []) {
                if (name) allowed.add(String(name).trim().toLowerCase());
            }
            let hostname = '';
            try {
                if (!/[\s/@?#\\]/.test(rawHost)) {
                    hostname = new URL(`http://${rawHost}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
                }
            } catch {
                hostname = '';
            }
            if (!hostname || !allowed.has(hostname)) {
                return { ok: false, reason: 'host_not_allowed' };
            }
        }
    }

    return { ok: true, reason: '' };
}
