/**
 * `muse-code-key` post-exchange hook: exchange a Meta account access token
 * for the durable Muse Code subscription key.
 */
import {
    AfterExchangeError,
    isRecord,
    requestSignal,
    trimmedString,
} from './shared.mjs';

const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';
const MUSE_API_VERSION = '1.0.0';
const MUSE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The stored Muse Code access token is a JSON blob pairing the OAuth token
 * with the minted Model API key; older/plain values are not.
 * @param {string} value
 * @returns {{oauthAccessToken: string, apiKey: string}}
 */
function parseMuseCodeCredential(value) {
    let payload;
    try {
        payload = JSON.parse(value);
    } catch {
        throw new AfterExchangeError('Muse Code credential is invalid; sign in again');
    }
    if (!isRecord(payload)
        || typeof payload.oauthAccessToken !== 'string'
        || typeof payload.apiKey !== 'string'
        || !payload.oauthAccessToken.trim()
        || !payload.apiKey.trim()) {
        throw new AfterExchangeError('Muse Code credential is invalid; sign in again');
    }
    return { oauthAccessToken: payload.oauthAccessToken, apiKey: payload.apiKey };
}

/**
 * Validate the key response the way OMP's schema does: the fields the caller
 * reads must have the documented types when present.
 * @param {unknown} payload
 * @returns {Record<string, any>}
 */
function validateMuseKeyResponse(payload) {
    if (!isRecord(payload)) {
        throw new AfterExchangeError('Invalid Muse Code key response: expected an object');
    }
    const stringFields = ['api_key', 'require_payment_action_url', 'user_email', 'user_id', 'subs_tier_id', 'subs_tier_name'];
    for (const field of stringFields) {
        const value = payload[field];
        if (value !== undefined && value !== null && typeof value !== 'string') {
            throw new AfterExchangeError(`Invalid Muse Code key response: ${field} must be a string`);
        }
    }
    if (payload.action_url !== undefined && payload.action_url !== null && typeof payload.action_url !== 'string') {
        throw new AfterExchangeError('Invalid Muse Code key response: action_url must be a string');
    }
    for (const field of ['require_payment', 'is_subs_active']) {
        const value = payload[field];
        if (value !== undefined && typeof value !== 'boolean') {
            throw new AfterExchangeError(`Invalid Muse Code key response: ${field} must be a boolean`);
        }
    }
    if (payload.subs_usage !== undefined && payload.subs_usage !== null && !isRecord(payload.subs_usage)) {
        throw new AfterExchangeError('Invalid Muse Code key response: subs_usage must be an object');
    }
    return payload;
}

/**
 * Exchange a Meta account access token for the Model API key authorized by a
 * Muse subscription.
 * @param {string} accessToken
 * @param {any} context
 * @param {{onboard?: boolean}} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function requestMuseCodeKey(accessToken, context, { onboard = false } = {}) {
    const signal = requestSignal(context.signal, MUSE_REQUEST_TIMEOUT_MS);
    const response = await context.fetch(MUSE_KEY_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'x-api-version': MUSE_API_VERSION,
        },
        body: JSON.stringify(onboard ? { onboard: true } : {}),
        redirect: 'error',
        signal,
    });
    const text = await response.text();
    if (!response.ok) {
        const excerpt = text.trim() ? ` ${text.slice(0, 500).trim()}` : '';
        throw new AfterExchangeError(`Muse Code key exchange failed: ${response.status}${excerpt}`);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new AfterExchangeError('Muse Code key exchange returned invalid JSON');
    }
    return validateMuseKeyResponse(payload);
}

/**
 * Minted key already carried by a credential, in either shape:
 * - this plugin: `access` is the Model API key and `oauthAccessToken` keeps the
 *   Meta account token beside it;
 * - OMP: `access` is a `{oauthAccessToken, apiKey}` JSON envelope that OMP's
 *   muse provider decodes.
 * @param {any} credential
 * @returns {{apiKey: string, oauthAccessToken: string}|undefined}
 */
function existingMuseApiKey(credential) {
    const oauthAccessToken = trimmedString(credential.oauthAccessToken);
    if (oauthAccessToken) {
        return { apiKey: trimmedString(credential.access) || '', oauthAccessToken };
    }
    try {
        const parsed = parseMuseCodeCredential(credential.access);
        return { apiKey: parsed.apiKey.trim(), oauthAccessToken: parsed.oauthAccessToken };
    } catch {
        return undefined;
    }
}

/**
 * Attach the subscription key. An already-minted key is reused instead of
 * re-minting: the endpoint is aggressively rate-limited (429s) and Meta returns
 * the same `api_key` for the account. Drops `refresh`/`expires` so the gateway
 * uses the durable Model API key directly without attempting an OAuth refresh.
 *
 * Deviation from OMP's shape: OMP stores both values in a JSON envelope in
 * `access` and decodes it in its muse provider. This plugin sends
 * `credential.access` verbatim as the request bearer (`resolveAccessToken`), so
 * the minted key must be `access`; the OAuth token is preserved beside it and
 * an OMP-shaped credential is normalized on the way through.
 * @param {any} credential
 * @param {any} context
 */
export async function attachMuseCodeApiKey(credential, context) {
    const existing = existingMuseApiKey(credential);
    if (existing?.apiKey) {
        if (credential.access === existing.apiKey
            && credential.oauthAccessToken === existing.oauthAccessToken
            && credential.refresh === undefined
            && credential.expires === undefined) {
            return credential;
        }
        const { refresh: _r, expires: _e, ...rest } = credential;
        return { ...rest, access: existing.apiKey, oauthAccessToken: existing.oauthAccessToken };
    }
    const payload = await requestMuseCodeKey(credential.access, context, { onboard: true });
    if (payload.is_subs_active === false) {
        throw new AfterExchangeError('invalid_grant: Muse Code subscription is inactive');
    }
    const apiKey = (payload.api_key || '').trim();
    if (!apiKey) {
        const actionUrl = (payload.action_url || '').trim() || (payload.require_payment_action_url || '').trim();
        if (payload.require_payment === true || actionUrl) {
            throw new AfterExchangeError(
                actionUrl ? `Muse Code subscription is required: ${actionUrl}` : 'Muse Code subscription is required',
            );
        }
        throw new AfterExchangeError('Muse Code key response is missing api_key');
    }
    const email = (payload.user_email || '').trim().toLowerCase();
    const accountId = (payload.user_id || '').trim() || email;
    if (!accountId) {
        throw new AfterExchangeError('Muse Code key response is missing a stable account identity');
    }
    const { refresh: _r, expires: _e, ...rest } = credential;
    return {
        ...rest,
        access: apiKey,
        oauthAccessToken: credential.access,
        accountId,
        email,
    };
}
