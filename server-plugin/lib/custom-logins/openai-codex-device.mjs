/**
 * `openai-codex-device` login hook.
 *
 * OMP implements this flow as provider code
 * (`packages/ai/src/registry/oauth/openai-codex.ts#loginOpenAICodexDevice`)
 * because the device endpoints carry a fixed first-party client id. The
 * protocol itself is a standard RFC 8628-ish device grant, so we port it
 * verbatim: request a user code, poll until the user approves, then exchange
 * the returned authorization code for tokens.
 *
 * The client id is resolved locally (env or `data/omtp/oauth-clients.json`),
 * never shipped in this file.
 */
import { clientEnvNames, policyValue } from '../oauth-clients.mjs';

const CLIENT_ID_ENV = clientEnvNames('openai-codex').clientId[0];

const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const VERIFY_URL = 'https://auth.openai.com/codex/device';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const CLAIM_PATH = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POLLS = 120;
const POLL_FLOOR_MS = 5_000;
const POLL_MARGIN_MS = 3_000;

/** @param {string} token */
function decodeJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Identity claims the catalog exposes for Codex accounts.
 * @param {string} accessToken
 * @param {string|undefined} idToken
 */
function tokenProfile(accessToken, idToken) {
    const payload = decodeJwt(accessToken);
    const idPayload = idToken ? decodeJwt(idToken) : null;
    const auth = payload?.[CLAIM_PATH];
    const idAuth = idPayload?.[CLAIM_PATH];
    const accountId = auth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;
    const email = (payload?.[PROFILE_CLAIM]?.email ?? idPayload?.[PROFILE_CLAIM]?.email)?.trim().toLowerCase();
    const planType = (auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
    return {
        accountId: typeof accountId === 'string' && accountId ? accountId : undefined,
        email: typeof email === 'string' && email ? email : undefined,
        planType: typeof planType === 'string' && planType ? planType : undefined,
    };
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} clientId
 * @param {typeof fetch} doFetch
 * @returns {Promise<any>}
 */
async function exchangeCode(code, verifier, clientId, doFetch) {
    const response = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Token exchange failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Token exchange returned invalid JSON');
    }
    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== 'number') {
        throw new Error('Token exchange response missing access_token/refresh_token/expires_in');
    }
    const { accountId, email, planType } = tokenProfile(data.access_token, data.id_token);
    if (!accountId && !email) {
        throw new Error('Failed to read account identity from the issued token');
    }
    return {
        access: data.access_token,
        refresh: data.refresh_token,
        expires: Date.now() + data.expires_in * 1000,
        ...(accountId ? { accountId, orgId: accountId } : {}),
        ...(email ? { email } : {}),
        ...(planType ? { orgName: planType } : {}),
    };
}

/**
 * Start the device flow.
 *
 * @param {{providerId?: string, login?: any, env?: Record<string,string|undefined>, doFetch?: typeof fetch, signal?: AbortSignal}} deps
 * @returns {Promise<{url: string, userCode: string, instructions: string, waitForCompletion: (deps?: {signal?: AbortSignal}) => Promise<any>}>}
 */
export async function startOpenAICodexDevice({ providerId = 'openai-codex', login, env = process.env, doFetch = fetch, signal } = {}) {
    // The catalog carries this flow's public client id; the env var (fed from
    // `data/omtp/oauth-clients.json` by the login route) is the override.
    const clientId = String(env?.[CLIENT_ID_ENV] || policyValue(login?.clientId, env));
    if (!clientId) {
        throw new Error(
            `OAuth client credentials for ${providerId} are not configured; `
            + `add "clientId" to data/omtp/oauth-clients.json or set ${CLIENT_ID_ENV}.`,
        );
    }
    const init = await doFetch(USERCODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!init.ok) {
        throw new Error(`Device authorization failed: HTTP ${init.status} ${(await init.text()).slice(0, 200)}`);
    }
    const grant = await init.json();
    if (!grant?.device_auth_id || !grant?.user_code) {
        throw new Error('Device authorization response missing device_auth_id/user_code');
    }
    const userCode = String(grant.user_code);
    const intervalMs = (Number(grant.interval) > 0 ? Number(grant.interval) : 5) * 1000 + POLL_MARGIN_MS;

    return {
        url: VERIFY_URL,
        userCode,
        instructions: `Enter code: ${userCode}`,
        async waitForCompletion({ signal: inner } = {}) {
            const cancel = inner || signal;
            for (let poll = 0; poll < MAX_POLLS; poll++) {
                await new Promise((resolve) => setTimeout(resolve, poll === 0 ? Math.min(intervalMs, POLL_FLOOR_MS) : intervalMs));
                if (cancel?.aborted) throw new Error('Login canceled');
                const response = await doFetch(DEVICE_TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_auth_id: grant.device_auth_id, user_code: userCode }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                // 403/404 mean "authorization still pending" for this endpoint.
                if (response.status === 403 || response.status === 404) continue;
                if (!response.ok) {
                    throw new Error(`Device polling failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
                }
                const data = await response.json();
                if (!data?.authorization_code || !data?.code_verifier) {
                    throw new Error('Device polling response missing authorization_code/code_verifier');
                }
                return exchangeCode(String(data.authorization_code), String(data.code_verifier), clientId, doFetch);
            }
            throw new Error('Device authorization timed out');
        },
    };
}

export const HOOKS = { 'openai-codex-device': startOpenAICodexDevice };
