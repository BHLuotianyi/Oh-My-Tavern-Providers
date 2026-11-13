/**
 * Shared helpers for post-exchange credential hooks.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Failure raised by a ported hook; distinguished from transport errors. */
export class AfterExchangeError extends Error {}

/**
 * Upstream error bodies can echo tokens, and request URLs often carry a
 * `?key=`/`?code=`. Errors here surface in logs and in the login API response,
 * so keep the diagnostic useful without leaking either.
 * @param {unknown} url
 * @param {unknown} body
 * @returns {string}
 */
export function safeErrorContext(url, body) {
    let safeUrl = '[url hidden]';
    try {
        const parsed = new URL(String(url || ''));
        parsed.search = '';
        parsed.hash = '';
        safeUrl = parsed.toString();
    } catch {
        // Keep the placeholder for a malformed URL.
    }
    const text = String(body ?? '');
    const excerpt = text.length > 300 ? `${text.slice(0, 300)}…[truncated]` : text;
    return `url=${safeUrl}; body=${excerpt}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Non-empty string as-is, everything else `undefined`.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Trimmed non-empty string, everything else `undefined`.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function trimmedString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read a dotted path out of a JSON body.
 * @param {unknown} source
 * @param {string} path
 */
export function readPath(source, path) {
    let current = source;
    for (const part of path.split('.')) {
        if (!isRecord(current)) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Drop keys whose value is `undefined` so stored credentials stay compact.
 * @template {Record<string, any>} T
 * @param {T} value
 * @returns {T}
 */
export function compact(value) {
    const out = /** @type {Record<string, any>} */ ({});
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) out[key] = entry;
    }
    return /** @type {T} */ (out);
}

/**
 * Read an env override from the session environment.
 * @param {Record<string,string|undefined>} env
 * @param {string} name
 * @returns {string|undefined}
 */
export function envValue(env, name) {
    const value = env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Request signal: the caller's cancellation composed with a per-request
 * timeout, so a stalled enrichment endpoint aborts instead of hanging login.
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 */
export function requestSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * `fetch` wrapper for the provisioning phase: mirrors OMP's `oauthFetch`
 * cancellation/timeout error messages.
 * @param {any} context
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function oauthFetch(context, url, init, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
        return await context.fetch(url, { ...init, signal });
    } catch (error) {
        if (context.signal?.aborted) {
            throw new AfterExchangeError(`OAuth login cancelled: ${String(context.signal.reason)}`);
        }
        if (timeout.aborted) {
            throw new AfterExchangeError(`Timed out after ${timeoutMs}ms waiting for ${url}`);
        }
        throw error;
    }
}

/**
 * Decode a JWT payload without verifying it; `null` for malformed tokens.
 * @param {string} token
 * @returns {Record<string, any>|null}
 */
export function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return isRecord(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

/**
 * Recover the `VALIDATION_REQUIRED` help URL Google embeds in a 403 body.
 * @param {string} errorBody
 * @returns {string|undefined}
 */
export function extractGoogleValidationUrl(errorBody) {
    if (!String(errorBody).includes('VALIDATION_REQUIRED')) return undefined;
    const start = String(errorBody).indexOf('{');
    if (start === -1) return undefined;
    try {
        const parsed = JSON.parse(String(errorBody).slice(start));
        const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
        const detail = details.find((entry) => entry?.reason === 'VALIDATION_REQUIRED'
            && typeof entry?.metadata?.validation_url === 'string');
        return detail?.metadata?.validation_url;
    } catch {
        return undefined;
    }
}

/**
 * @param {string} validationUrl
 * @param {string} nextAction
 * @param {string|undefined} email
 * @returns {string}
 */
export function formatGoogleValidationRequiredMessage(validationUrl, nextAction, email) {
    const account = email ? ` for ${email}` : '';
    return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}

/**
 * Sleep that settles early when the login is cancelled.
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new AfterExchangeError('Login cancelled'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new AfterExchangeError('Login cancelled'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}
