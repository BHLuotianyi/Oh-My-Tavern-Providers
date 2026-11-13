/**
 * Where the OMTP server side lives for this host.
 *
 * - SillyTavern: the server plugin, same origin, `/api/plugins/omtp`.
 * - TauriTavern: no Node server plugins; the same server code runs as the
 *   standalone companion (`server-plugin/standalone.mjs`) at an address the
 *   user enters in the settings, authorised by its token.
 *
 * Every management call goes through `apiBase()` + `apiHeaders()` / `requestHeaders()`.
 */
import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders as stRequestHeaders } from '../../../../../script.js';
import { API_BASE, withClientHeader } from './constants.js';

/** Header carrying the companion token (see server-plugin/standalone.mjs). */
export const COMPANION_TOKEN_HEADER = 'x-omtp-token';

/**
 * TauriTavern replaces SillyTavern's Node server with a Rust backend, so the
 * server plugin cannot run inside it.
 * @returns {boolean}
 */
export function isTauriTavern() {
    const host = globalThis.__TAURITAVERN__;
    return typeof host === 'object' && host !== null;
}

/**
 * Companion address and token, or null when this host uses the server plugin
 * or no companion has been configured.
 * @returns {{url: string, token: string}|null}
 */
export function companion() {
    if (!isTauriTavern()) return null;
    const settings = extension_settings?.omtp?.companion;
    const url = typeof settings?.url === 'string' ? settings.url.trim().replace(/\/+$/, '') : '';
    if (!url) return null;
    return { url, token: typeof settings?.token === 'string' ? settings.token.trim() : '' };
}

/**
 * Whether management routes exist at all: always under SillyTavern (the
 * plugin may still be missing; callers handle the 404), only with a
 * configured companion under TauriTavern.
 * @returns {boolean}
 */
export function hasServerBackend() {
    return !isTauriTavern() || companion() !== null;
}

/** Base URL of the management routes. */
export function apiBase() {
    const target = companion();
    return target ? `${target.url}/api/plugins/omtp` : API_BASE;
}

/**
 * Headers for a management call: the OMTP client marker, plus the companion
 * token when the companion serves the routes.
 * @param {Record<string, any>|Headers} [headers]
 * @returns {Record<string, any>}
 */
export function apiHeaders(headers = {}) {
    const result = withClientHeader(headers);
    const target = companion();
    if (target?.token) result[COMPANION_TOKEN_HEADER] = target.token;
    return result;
}

/**
 * Request headers for an OMTP management call: SillyTavern's CSRF/auth
 * headers wrapped with the OMTP client marker and companion token.
 * @param {Parameters<typeof stRequestHeaders>[0]} [options]
 * @returns {Record<string, any>}
 */
export function requestHeaders(options) {
    return apiHeaders(stRequestHeaders(options));
}

/**
 * The companion reports its gateway and dashboard on 127.0.0.1. When it runs
 * on another device, swap in the host the client reaches it at.
 * @param {string} url
 * @returns {string}
 */
export function reachableUrl(url) {
    const target = companion();
    if (!target || !url) return url;
    try {
        const parsed = new URL(url);
        const companionHost = new URL(target.url).hostname;
        if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.hostname !== companionHost) {
            parsed.hostname = companionHost;
            return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
        }
    } catch {
        // Not a URL; leave it to the caller.
    }
    return url;
}
