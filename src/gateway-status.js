/**
 * OMTP Model Hub — gateway status, token resolution and mode detection.
 *
 * Tracks the server plugin's gateway status and auth token (with short-lived
 * caches invalidated on secret/login changes) and identifies whether
 * SillyTavern's `custom` chat completion source is currently pointed at it.
 */

import { getSettings } from './store.js';
import { invalidateProviderAvailability } from './catalog.js';
import { apiBase, reachableUrl, requestHeaders } from './backend.js';
import { main_api } from '../../../../../script.js';
import { oai_settings } from '../../../../openai.js';

export const STATUS_TIMEOUT_MS = 8000;
const GATEWAY_STATUS_TTL_MS = 5000;
const GATEWAY_TOKEN_TTL_MS = 60000;

/** Gateway URL last reported by the server plugin; used for synchronous mode checks. */
let activeGatewayUrl = null;
let gatewayStatusCache = { at: 0, value: null };
let gatewayTokenCache = { at: 0, url: null, token: null };

export function normalizeUrl(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

export function gatewaySettings(settings) {
    if (!settings.gateway || typeof settings.gateway !== 'object') {
        settings.gateway = { savedCustom: null };
    }
    return settings.gateway;
}

/**
 * Invalidate cached gateway status, gateway token, and provider availability.
 * Call after secret or login credential changes.
 */
export function invalidateGatewayCaches() {
    gatewayStatusCache = { at: 0, value: null };
    gatewayTokenCache = { at: 0, url: null, token: null };
    invalidateProviderAvailability();
}

async function fetchGatewayStatus() {
    const response = await fetch(`${apiBase()}/status`, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`status request failed (${response.status})`);
    }
    const data = await response.json();
    const gateway = data?.gateway ?? {};
    // A LAN companion reports its gateway on 127.0.0.1; ST must reach its host.
    const url = normalizeUrl(reachableUrl(gateway.url));
    if (url) {
        activeGatewayUrl = url;
    }
    return {
        running: !!gateway.running,
        url: url || null,
        port: gateway.port ?? null,
        requireAuth: !!gateway.requireAuth,
        lastError: gateway.lastError ?? null,
        serverPlugin: data?.serverPlugin === true,
    };
}

/**
 * Current gateway status. Never throws: without the server plugin it degrades to
 * `running:false` with the manually configured URL.
 * @param {{force?: boolean}} [options]
 */
export async function getGatewayStatus({ force = false } = {}) {
    if (!force && gatewayStatusCache.value && Date.now() - gatewayStatusCache.at < GATEWAY_STATUS_TTL_MS) {
        return gatewayStatusCache.value;
    }
    let value;
    try {
        value = await fetchGatewayStatus();
    } catch (error) {
        value = {
            running: false,
            url: normalizeUrl(getSettings().gatewayUrl) || null,
            port: null,
            requireAuth: false,
            lastError: error?.message ?? 'status unavailable',
            serverPlugin: false,
        };
    }
    gatewayStatusCache = { at: Date.now(), value };
    return value;
}

/**
 * Resolve the bearer token required by the gateway, using the cached server
 * token or falling back to `settings.gatewayToken`.
 * @param {{requireAuth?: boolean, url?: string|null}} status
 * @returns {Promise<string|null>}
 */
export async function resolveGatewayToken(status) {
    if (!status.requireAuth) {
        return null;
    }
    const settings = getSettings();
    const url = status.url || normalizeUrl(settings.gatewayUrl);
    if (gatewayTokenCache.token && gatewayTokenCache.url === url && Date.now() - gatewayTokenCache.at < GATEWAY_TOKEN_TTL_MS) {
        return gatewayTokenCache.token;
    }
    try {
        const response = await fetch(`${apiBase()}/gateway/token`, {
            headers: requestHeaders(),
            signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (response.ok) {
            const data = await response.json();
            const token = typeof data?.token === 'string' ? data.token.trim() : '';
            if (token) {
                gatewayTokenCache = { at: Date.now(), url, token };
                return token;
            }
        }
    } catch (error) {
        console.debug('[omtp] gateway token request failed', error);
    }
    const manual = String(settings.gatewayToken ?? '').trim();
    return manual || null;
}

/** Whether SillyTavern's active connection currently points at the OMTP Gateway. */
export function isGatewayMode() {
    if (main_api !== 'openai') {
        return false;
    }
    if (oai_settings?.chat_completion_source !== 'custom') {
        return false;
    }
    const current = normalizeUrl(oai_settings?.custom_url);
    if (!current) {
        return false;
    }
    const settings = getSettings();
    // `activeUrl` is the URL actually written to `custom_url`; without it a reload
    // on a fallback port (the server plugin may bind 4100-4110) reported native.
    const candidates = [...new Set([
        activeGatewayUrl,
        settings?.gatewayUrl,
        settings?.gateway?.activeUrl,
    ].map(normalizeUrl).filter(Boolean))];
    return candidates.some((url) => current === url || current.startsWith(`${url}/`));
}
