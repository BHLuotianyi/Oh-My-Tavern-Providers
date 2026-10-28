const SENSITIVE_KEY = /^(api[-_]?key|authorization|token|secret|password|access[-_]?token|refresh[-_]?token|id[-_]?token|service[-_]?account[-_]?json|access[-_]?key[-_]?id|secret[-_]?access[-_]?key|session[-_]?token|private[-_]?key|cookie|set-cookie)$/i;

/**
 * Mask a secret for display. Never returns the raw value.
 * @param {unknown} value
 * @returns {string}
 */
export function maskKey(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    const tail = trimmed.slice(-4);
    return `••••${tail}`;
}

/**
 * Alias kept for callers that only need a masked secret.
 */
export const redact = maskKey;

/**
 * Deep-redact sensitive fields in an object for logging or API responses.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[depth]';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));

    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = SENSITIVE_KEY.test(key) ? maskKey(typeof entry === 'string' ? entry : JSON.stringify(entry)) : redactValue(entry, depth + 1);
    }
    return out;
}

/**
 * Redact an HTTP header bag for logging.
 * @param {Record<string, string>|Headers|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function redactHeaders(headers) {
    /** @type {Record<string, string>} */
    const out = {};
    if (!headers) return out;
    const entries = typeof headers.forEach === 'function'
        ? (() => {
            const collected = [];
            headers.forEach((value, key) => collected.push([key, value]));
            return collected;
        })()
        : Object.entries(headers);
    for (const [key, value] of entries) {
        out[key] = SENSITIVE_KEY.test(key) ? maskKey(String(value)) : String(value);
    }
    return out;
}

/**
 * Log an error with sensitive values redacted.
 * @param {string} scope
 * @param {unknown} error
 */
export function logError(scope, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[omtp] ${scope}: ${message}`);
}

/**
 * Log a plain informational message.
 * @param {string} message
 */
export function log(message) {
    console.log(`[omtp] ${message}`);
}
