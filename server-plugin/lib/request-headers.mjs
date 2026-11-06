/**
 * Request-identity headers for providers that ask clients to label traffic.
 *
 * The catalog declares the policy (`requestHeaders`); the gateway only knows
 * where the conversation id and the caller's User-Agent come from. Derived
 * session ids are deterministic: the same chat on the same provider always
 * yields the same value, without storing per-chat state.
 */
import crypto from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SESSION_LENGTH = 24;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PREFIX = /^[\x21-\x7e]{0,16}$/;

/**
 * Validate a catalog `requestHeaders` declaration.
 * Throws on malformed input so a bad catalog fails the build instead of
 * surfacing as a broken request at runtime.
 * @param {string} providerId
 * @param {any} input
 * @returns {{sessionHeader?:string, sessionPrefix?:string, sessionForce?:boolean, spoofUserAgent?:string}}
 */
export function normalizeRequestHeaders(providerId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`${providerId}: requestHeaders must be an object`);
    }
    const out = {};
    if (input.sessionHeader !== undefined) {
        if (typeof input.sessionHeader !== 'string' || !HEADER_NAME.test(input.sessionHeader)) {
            throw new Error(`${providerId}: invalid requestHeaders.sessionHeader`);
        }
        out.sessionHeader = input.sessionHeader;
    }
    if (input.sessionPrefix !== undefined) {
        if (typeof input.sessionPrefix !== 'string' || !PREFIX.test(input.sessionPrefix)) {
            throw new Error(`${providerId}: invalid requestHeaders.sessionPrefix`);
        }
        out.sessionPrefix = input.sessionPrefix;
    }
    if (input.sessionForce !== undefined) {
        out.sessionForce = input.sessionForce === true;
    }
    if (input.spoofUserAgent !== undefined) {
        const value = typeof input.spoofUserAgent === 'string' ? input.spoofUserAgent.trim() : '';
        if (!value || value.length > 200 || /[\r\n]/.test(value)) {
            throw new Error(`${providerId}: invalid requestHeaders.spoofUserAgent`);
        }
        out.spoofUserAgent = value;
    }
    if (!out.sessionHeader && !out.spoofUserAgent) {
        throw new Error(`${providerId}: requestHeaders declares nothing to send`);
    }
    return out;
}

/**
 * Read and validate the policy off a catalog provider.
 * @param {any} catalogProvider
 * @returns {ReturnType<typeof normalizeRequestHeaders>|null}
 */
export function requestHeaderPolicy(catalogProvider) {
    const raw = catalogProvider?.requestHeaders;
    if (!raw || typeof raw !== 'object') return null;
    try {
        return normalizeRequestHeaders(String(catalogProvider?.id || ''), raw);
    } catch {
        return null;
    }
}

/** @param {Record<string,string>} headers @param {string} name */
function findHeader(headers, name) {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) return key;
    }
    return null;
}

/**
 * Set a header, dropping any other casing of the same field.
 * @param {Record<string,string>} headers
 * @param {string} name
 * @param {string} value
 */
export function setHeader(headers, name, value) {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) delete headers[key];
    }
    headers[name] = value;
}

/**
 * Set a header unless the caller already supplied it under any casing.
 * @param {Record<string,string>} headers
 * @param {string} name
 * @param {string} value
 */
export function setHeaderIfAbsent(headers, name, value) {
    if (findHeader(headers, name)) return;
    headers[name] = value;
}

/**
 * Deterministic conversation id: HMAC(install id, provider + chat id) rendered
 * in base62. Stable across restarts, distinct per provider and per chat, and
 * not reversible to the chat's file name.
 * @param {string} installId
 * @param {string} providerId
 * @param {string} chatId
 * @param {string} [prefix]
 * @returns {string}
 */
export function deriveSessionId(installId, providerId, chatId, prefix = 'ses_') {
    const digest = crypto
        .createHmac('sha256', String(installId || ''))
        .update(`${providerId}\u0000${chatId}`)
        .digest();
    let n = BigInt(`0x${digest.toString('hex')}`);
    let encoded = '';
    for (let i = 0; i < SESSION_LENGTH; i += 1) {
        encoded = BASE62[Number(n % 62n)] + encoded;
        n /= 62n;
    }
    return `${prefix}${encoded}`;
}

/**
 * Apply the provider's identity policy to outgoing headers.
 *
 * - Session header: derived from the chat id, or the install id when there is
 *   no conversation (health checks, model discovery). `sessionForce` mirrors
 *   omp: the authoritative conversation id wins over a configured value.
 * - User-Agent: the spoof string when enabled, otherwise the caller's own UA
 *   is forwarded untouched (SillyTavern native).
 *
 * @param {Record<string,string>} headers
 * @param {{
 *   policy: ReturnType<typeof normalizeRequestHeaders>|null,
 *   providerId: string,
 *   chatId?: string,
 *   installId?: string,
 *   stUserAgent?: string,
 *   spoof?: boolean,
 * }} options
 * @returns {Record<string,string>}
 */
export function applyRequestHeaders(headers, options) {
    const { policy, providerId, chatId = '', installId = '', stUserAgent = '', spoof = false } = options || {};
    if (!headers || !policy) return headers;
    if (policy.sessionHeader) {
        const sessionId = chatId
            ? deriveSessionId(installId, providerId, chatId, policy.sessionPrefix || 'ses_')
            : installId;
        if (sessionId) {
            if (policy.sessionForce) setHeader(headers, policy.sessionHeader, sessionId);
            else setHeaderIfAbsent(headers, policy.sessionHeader, sessionId);
        }
    }
    if (spoof && policy.spoofUserAgent) {
        setHeader(headers, 'User-Agent', policy.spoofUserAgent);
    } else if (stUserAgent) {
        setHeaderIfAbsent(headers, 'User-Agent', stUserAgent);
    }
    return headers;
}
