/**
 * `zai-mint-key` post-exchange hook: exchange the short-lived Z.ai OAuth
 * token for a durable API key via the Z.ai business APIs.
 */
import {
    AfterExchangeError,
    envValue,
    isRecord,
    safeErrorContext,
    trimmedString,
} from './shared.mjs';

const ZAI_DEFAULT_BIZ_BASE = 'https://api.z.ai';
const ZAI_DEFAULT_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';
/** Key name OMP provisions; reusing it adopts an existing sign-in's key. */
const ZAI_KEY_NAME = 'oh-my-pi';

/**
 * Z.ai's `{ code, msg, data, success }` envelope. The OAuth token endpoint
 * signals success with `code: 0`; the biz endpoints (`api.z.ai`) use
 * `code: 200` / `success: true`. Accept both; throw `msg` on failure. Bodies
 * without a status wrapper pass through unchanged.
 * @param {unknown} code
 * @returns {boolean}
 */
function isZaiSuccessCode(code) {
    if (code === null || code === undefined) return true;
    if (typeof code === 'number') return code === 0 || code === 200;
    if (typeof code === 'string') return code === '0' || code === '200';
    return false;
}

/**
 * @param {unknown} body
 * @param {string} operation
 * @returns {unknown}
 */
function unwrapZaiEnvelope(body, operation) {
    if (isRecord(body) && ('code' in body || 'success' in body)) {
        if (body.success === false || !isZaiSuccessCode(body.code)) {
            throw new AfterExchangeError(`Z.ai ${operation} failed: ${body.msg ?? `code ${String(body.code)}`}`);
        }
        return 'data' in body ? body.data : body;
    }
    return body;
}

/**
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {any} context
 * @returns {Promise<unknown>}
 */
async function zaiGetJson(url, headers, context) {
    const response = await context.fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP request failed. status=${response.status}; ${safeErrorContext(url, body)}`);
    }
    return body.length > 0 ? JSON.parse(body) : undefined;
}

/**
 * @param {string} url
 * @param {Record<string, string|number>} payload
 * @param {Record<string,string>} headers
 * @param {any} context
 * @returns {Promise<unknown>}
 */
async function zaiPostJson(url, payload, headers, context) {
    const response = await context.fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP request failed. status=${response.status}; ${safeErrorContext(url, body)}`);
    }
    return body.length > 0 ? JSON.parse(body) : undefined;
}

/**
 * Coerce an api_keys list response (bare array or common wrapper shapes) to an array.
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
function asKeyArray(value) {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
        for (const field of ['list', 'keys', 'apiKeys', 'records']) {
            if (Array.isArray(value[field])) return value[field];
        }
    }
    return [];
}

/**
 * Exchange the short-lived OAuth access token for a durable biz token via
 * ZCode's business-login endpoint. The biz APIs reject the raw OAuth token.
 * @param {string} oauthAccessToken
 * @param {string} businessLoginUrl
 * @param {any} context
 * @returns {Promise<string>}
 */
async function zaiBusinessLogin(oauthAccessToken, businessLoginUrl, context) {
    const data = unwrapZaiEnvelope(
        await zaiPostJson(businessLoginUrl, { token: oauthAccessToken }, {}, context),
        'business login',
    );
    const bizToken = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken);
    if (!bizToken) {
        throw new AfterExchangeError('Z.ai business login returned no access token');
    }
    return bizToken;
}

/**
 * Provision the durable Z.ai API key from a short-lived OAuth access token,
 * mirroring ZCode: business-login → resolve default org/project from
 * `getCustomerInfo` → find/create the OMP-named key → obtain its secret →
 * return `${apiKey}.${secretKey}` (the 49-char durable key).
 * @param {string} oauthAccessToken
 * @param {any} context
 * @returns {Promise<string>}
 */
async function mintZaiKey(oauthAccessToken, context) {
    const env = context.env || {};
    const bizBase = envValue(env, 'ZAI_BIZ_BASE') || ZAI_DEFAULT_BIZ_BASE;
    const businessLoginUrl = envValue(env, 'ZAI_BUSINESS_LOGIN_URL') || ZAI_DEFAULT_BUSINESS_LOGIN_URL;

    const bizToken = await zaiBusinessLogin(oauthAccessToken, businessLoginUrl, context);
    const auth = { Authorization: `Bearer ${bizToken}` };

    const customer = unwrapZaiEnvelope(
        await zaiGetJson(`${bizBase}/api/biz/customer/getCustomerInfo`, auth, context),
        'customer lookup',
    );
    const orgs = Array.isArray(customer?.organizations) ? customer.organizations : [];
    const org = orgs.find((entry) => entry?.isDefault) ?? orgs[0];
    const projects = Array.isArray(org?.projects) ? org.projects : [];
    const project = projects.find((entry) => entry?.isDefault) ?? projects[0];
    const organizationId = trimmedString(org?.organizationId);
    const projectId = trimmedString(project?.projectId);
    if (!organizationId || !projectId) {
        throw new AfterExchangeError('Z.ai key provisioning failed: no organization/project on account');
    }

    const keysUrl = `${bizBase}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
    const existing = asKeyArray(unwrapZaiEnvelope(await zaiGetJson(keysUrl, auth, context), 'api key list'))
        .find((key) => key.name === ZAI_KEY_NAME);
    const keyRecord = existing
        ?? unwrapZaiEnvelope(await zaiPostJson(keysUrl, { name: ZAI_KEY_NAME }, auth, context), 'api key create');

    const apiKey = trimmedString(keyRecord?.apiKey);
    if (!apiKey) {
        throw new AfterExchangeError('Z.ai key provisioning returned no apiKey');
    }

    // Always fetch the secret via the copy endpoint: list entries mask it
    // (`*****abcd`) and the create response's inline secret is not reliable
    // across account states, whereas copy always returns the full secret.
    const copied = unwrapZaiEnvelope(
        await zaiGetJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, auth, context),
        'api key copy',
    );
    const secretKey = trimmedString(copied?.secretKey);
    if (!secretKey) {
        throw new AfterExchangeError('Z.ai key provisioning returned no secretKey');
    }
    return `${apiKey}.${secretKey}`;
}

/**
 * Replace the short-lived OAuth token with the durable key minted by the
 * Z.ai business APIs, dropping `refresh`/`expires` so the gateway uses the
 * durable key directly instead of attempting an OAuth refresh per request.
 * @param {any} credential
 * @param {any} context
 */
export async function zaiMintKey(credential, context) {
    const access = await mintZaiKey(credential.access, context);
    const { refresh: _r, expires: _e, ...rest } = credential;
    return { ...rest, access };
}
