/**
 * Post-exchange credential hooks.
 *
 * OMP lets an `oauth-code` / `device-code` rule name an `afterExchange` hook
 * (see `packages/ai/src/registry/hooks/{oauth-code,device-code}.ts`) that
 * enriches or replaces the engine-mapped credential after the token exchange:
 * identity recovery, project provisioning, durable key minting. The hooks are
 * provider code rather than policy data, so this module ports the eight hooks
 * the bundled catalog references:
 *
 *   anthropic-identity          account/org identity from Claude Code bootstrap
 *   openai-codex-profile        ChatGPT account identity from token JWT claims
 *   google-gemini-cli-project   Cloud Code Assist project discovery/onboarding
 *   google-antigravity-project  Antigravity project discovery/onboarding
 *   zai-mint-key                durable Z.ai API key from the OAuth token
 *   muse-code-key               Meta Muse subscription key attached to the token
 *   factory-droid-region        Factory organization + residency/inference scope
 *   gitlab-duo-clear-cache      cache invalidation (no local cache here)
 *
 * Hooks only enrich a credential that is already exchangeable, so an unknown
 * or unimplemented hook name must never fail the sign-in: it is logged once and
 * the credential is returned untouched. A *known* hook failing does fail the
 * login, exactly like OMP, because a credential the provider cannot use (e.g.
 * Z.ai's short-lived OAuth token instead of the minted key) is worse than a
 * visible error.
 *
 * Reference implementations:
 * `packages/ai/src/registry/oauth/{anthropic,openai-codex,google-gemini-cli,google-antigravity,zai,gitlab-duo,factory-droid,muse-code}.ts`.
 */
import { log } from './redact.mjs';

/** Failure raised by a ported hook; distinguished from transport errors. */
class AfterExchangeError extends Error {}

/** Bootstrap endpoint Claude Code reports the signed-in account/org on. */
const ANTHROPIC_BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
const ANTHROPIC_BOOTSTRAP_MODEL = 'claude-opus-4-8';
/** Pinned Claude Code CLI version used in the bootstrap User-Agent. */
const DEFAULT_CLAUDE_CODE_VERSION = '2.1.280';

/** Cloud Code Assist host for Gemini CLI accounts. */
const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_CLI_VERSION = '0.46.0';
const GEMINI_POLL_INTERVAL_MS = 5_000;
const GEMINI_POLL_MAX_ATTEMPTS = 24;
const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';

/** Cloud Code Assist host for Antigravity accounts (daily channel). */
const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_FREE_TIER = 'free-tier';
const ANTIGRAVITY_ONBOARD_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_ONBOARD_POLL_MS = 1_000;
const ANTIGRAVITY_DEFAULT_VERSION = '2.19.1';

const ZAI_DEFAULT_BIZ_BASE = 'https://api.z.ai';
const ZAI_DEFAULT_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';
/** Key name OMP provisions; reusing it adopts an existing sign-in's key. */
const ZAI_KEY_NAME = 'oh-my-pi';

const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';
const MUSE_API_VERSION = '1.0.0';
const MUSE_REQUEST_TIMEOUT_MS = 20_000;

const FACTORY_WHOAMI_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Hook names already reported as unimplemented, so the log stays one-per-hook. */
const reportedUnknownHooks = new Set();

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Non-empty string as-is, everything else `undefined`.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Trimmed non-empty string, everything else `undefined`.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function trimmedString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read a dotted path out of a JSON body.
 * @param {unknown} source
 * @param {string} path
 */
function readPath(source, path) {
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
function compact(value) {
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
function envValue(env, name) {
    const value = env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Request signal: the caller's cancellation composed with a per-request
 * timeout, so a stalled enrichment endpoint aborts instead of hanging login.
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 */
function requestSignal(signal, timeoutMs) {
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
async function oauthFetch(context, url, init, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
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
function decodeJwtPayload(token) {
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
function extractGoogleValidationUrl(errorBody) {
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
function formatGoogleValidationRequiredMessage(validationUrl, nextAction, email) {
    const account = email ? ` for ${email}` : '';
    return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}

/* ------------------------------------------------------------------ */
/* anthropic-identity                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {string} token
 * @param {any} context
 * @returns {Promise<{accountId?:string, email?:string, orgId?:string, orgName?:string}>}
 */
async function fetchAnthropicBootstrapIdentity(token, context) {
    const url = `${ANTHROPIC_BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(ANTHROPIC_BOOTSTRAP_MODEL)}`;
    const version = envValue(context.env, 'PI_AI_CLAUDE_CODE_VERSION') || DEFAULT_CLAUDE_CODE_VERSION;
    const response = await context.fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json, text/plain, */*',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': `claude-code/${version}`,
            'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${body}`);
    }
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Anthropic bootstrap returned invalid JSON. url=${url}; body=${body}`);
    }
    const account = isRecord(data?.oauth_account) ? data.oauth_account : {};
    return {
        accountId: nonEmpty(account.account_uuid),
        email: nonEmpty(account.account_email),
        orgId: nonEmpty(account.organization_uuid),
        orgName: nonEmpty(account.organization_name),
    };
}

/**
 * Fill account (and, at login only, organization) identity from the bootstrap
 * endpoint when the token response left it unset. Failures leave the credential
 * untouched: identity is cosmetic for a working token.
 * @param {any} credential
 * @param {any} context
 */
async function anthropicIdentity(credential, context) {
    const includeOrg = context.phase !== 'refresh';
    const orgSatisfied = !includeOrg || credential.orgId !== undefined;
    if (credential.accountId && credential.email && orgSatisfied) return credential;
    try {
        const bootstrap = await fetchAnthropicBootstrapIdentity(credential.access, context);
        return compact({
            ...credential,
            accountId: credential.accountId ?? bootstrap.accountId,
            email: credential.email ?? bootstrap.email,
            ...(includeOrg ? {
                orgId: credential.orgId ?? bootstrap.orgId,
                orgName: credential.orgName ?? bootstrap.orgName,
            } : {}),
        });
    } catch {
        return credential;
    }
}

/* ------------------------------------------------------------------ */
/* openai-codex-profile                                               */
/* ------------------------------------------------------------------ */

const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';
const CODEX_PROFILE_CLAIM = 'https://api.openai.com/profile';

/**
 * Identity slice decoded from the Codex token claims. The ChatGPT workspace
 * (`chatgpt_account_id`) is the subscription pool the token draws limits from;
 * `chatgpt_plan_type` may only be present on the `id_token`.
 * @param {string} accessToken
 * @param {string|undefined} idToken
 */
function codexTokenProfile(accessToken, idToken) {
    const payload = decodeJwtPayload(accessToken);
    const idPayload = idToken ? decodeJwtPayload(idToken) : null;
    const auth = isRecord(payload?.[CODEX_AUTH_CLAIM]) ? payload[CODEX_AUTH_CLAIM] : undefined;
    const idAuth = isRecord(idPayload?.[CODEX_AUTH_CLAIM]) ? idPayload[CODEX_AUTH_CLAIM] : undefined;
    const accountId = auth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;
    const email = readPath(payload?.[CODEX_PROFILE_CLAIM], 'email') ?? readPath(idPayload?.[CODEX_PROFILE_CLAIM], 'email');
    const planType = auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type;
    return {
        accountId: nonEmpty(accountId),
        email: trimmedString(typeof email === 'string' ? email.toLowerCase() : email),
        planType: trimmedString(typeof planType === 'string' ? planType.toLowerCase() : planType),
    };
}

/**
 * Enrich declaratively exchanged Codex credentials from access/id-token JWT
 * claims. A login whose token carries no identity at all is an error: the
 * account id is what later requests are keyed on.
 * @param {any} credential
 * @param {any} context
 */
async function openaiCodexProfile(credential, context) {
    const idToken = isRecord(context.raw) && typeof context.raw.id_token === 'string' ? context.raw.id_token : undefined;
    const profile = codexTokenProfile(credential.access, idToken);
    const login = context.phase !== 'refresh';
    if (login && !profile.accountId && !profile.email) {
        throw new AfterExchangeError('Failed to extract account identity from token');
    }
    const stored = context.stored || {};
    const resolvedAccountId = profile.accountId ?? stored.accountId;
    return compact({
        ...credential,
        accountId: resolvedAccountId,
        email: profile.email ?? stored.email,
        ...(login && resolvedAccountId ? { orgId: resolvedAccountId } : {}),
        ...(login && profile.planType ? { orgName: profile.planType } : {}),
        ...(!login && stored.orgId ? { orgId: stored.orgId } : {}),
        ...(!login && stored.orgName ? { orgName: stored.orgName } : {}),
    });
}

/* ------------------------------------------------------------------ */
/* google-gemini-cli-project                                          */
/* ------------------------------------------------------------------ */

/**
 * Gemini CLI identifies itself to unlock higher rate limits; the platform and
 * arch are host facts, the version/format mirror the official client.
 * @param {Record<string,string|undefined>} env
 * @returns {string}
 */
function geminiCliUserAgent(env) {
    const version = envValue(env, 'PI_AI_GEMINI_CLI_VERSION') || GEMINI_CLI_VERSION;
    const platform = process.platform === 'win32' ? 'win32' : process.platform;
    const arch = process.arch === 'x64' ? 'x64' : process.arch;
    return `GeminiCLI/${version}/${GEMINI_DEFAULT_MODEL} (${platform}; ${arch}; terminal)`;
}

/**
 * Antigravity's control plane is gated on the client version; os/arch/cl are
 * pinned to the reference client the constants were captured from.
 * @param {Record<string,string|undefined>} env
 * @returns {string}
 */
function antigravityUserAgent(env) {
    const version = envValue(env, 'PI_AI_ANTIGRAVITY_VERSION') || ANTIGRAVITY_DEFAULT_VERSION;
    const cl = envValue(env, 'PI_AI_ANTIGRAVITY_CL') || '963137146';
    const os = envValue(env, 'PI_AI_ANTIGRAVITY_OS') || 'darwin';
    const arch = envValue(env, 'PI_AI_ANTIGRAVITY_ARCH') || 'arm64';
    return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/**
 * The default tier is the first `isDefault` entry, else legacy.
 * @param {any} allowedTiers
 */
function getDefaultTier(allowedTiers) {
    if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) return { id: TIER_LEGACY };
    return allowedTiers.find((tier) => tier?.isDefault) || { id: TIER_LEGACY };
}

/**
 * VPC-SC-restricted Workspace tenants answer `loadCodeAssist` with a
 * `SECURITY_POLICY_VIOLATED` error but are otherwise standard-tier accounts.
 * @param {unknown} payload
 * @returns {boolean}
 */
function isVpcScAffectedUser(payload) {
    if (!isRecord(payload) || !('error' in payload)) return false;
    const details = payload.error?.details;
    if (!Array.isArray(details)) return false;
    return details.some((detail) => detail?.reason === 'SECURITY_POLICY_VIOLATED');
}

/**
 * Poll a Cloud Code Assist long-running operation. The attempt cap turns a
 * stuck operation into a bounded login error instead of an endless loop.
 * @param {string} operationName
 * @param {Record<string,string>} headers
 * @param {any} context
 */
async function pollGeminiOperation(operationName, headers, context) {
    for (let attempt = 0; attempt < GEMINI_POLL_MAX_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            context.onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${GEMINI_POLL_MAX_ATTEMPTS})...`);
            if (context.signal?.aborted) throw new AfterExchangeError('OAuth login cancelled');
            await new Promise((resolve) => {
                setTimeout(resolve, GEMINI_POLL_INTERVAL_MS);
            });
        }
        if (context.signal?.aborted) throw new AfterExchangeError('OAuth login cancelled');
        const response = await oauthFetch(context, `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, { method: 'GET', headers });
        if (!response.ok) {
            throw new AfterExchangeError(`Failed to poll operation: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        if (data?.done) return data;
    }
    throw new AfterExchangeError(`Project provisioning did not complete after ${GEMINI_POLL_MAX_ATTEMPTS} attempts`);
}

/**
 * Resolve (or provision) the Cloud Code Assist project a Gemini CLI account is
 * billed against. Mirrors `discoverProject` in the reference.
 * @param {string} accessToken
 * @param {any} context
 * @returns {Promise<string>}
 */
async function discoverGeminiProject(accessToken, context) {
    const env = context.env || {};
    const envProjectId = envValue(env, 'GOOGLE_CLOUD_PROJECT') || envValue(env, 'GOOGLE_CLOUD_PROJECT_ID');
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': geminiCliUserAgent(env),
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
    };
    const projectRequired = 'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. '
        + 'See https://goo.gle/gemini-cli-auth-docs#workspace-gca';

    context.onProgress?.('Checking for existing Cloud Code Assist project...');
    const loadResponse = await oauthFetch(context, `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            cloudaicompanionProject: envProjectId,
            metadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
                duetProject: envProjectId,
            },
        }),
    });
    let data;
    if (!loadResponse.ok) {
        let errorPayload;
        try {
            errorPayload = await loadResponse.clone().json();
        } catch {
            errorPayload = undefined;
        }
        if (isVpcScAffectedUser(errorPayload)) {
            data = { currentTier: { id: TIER_STANDARD } };
        } else {
            const errorText = await loadResponse.text();
            throw new AfterExchangeError(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
        }
    } else {
        data = await loadResponse.json();
    }

    if (data?.currentTier) {
        if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
        if (envProjectId) return envProjectId;
        throw new AfterExchangeError(projectRequired);
    }

    const tier = getDefaultTier(data?.allowedTiers);
    const tierId = tier?.id ?? TIER_FREE;
    if (tierId !== TIER_FREE && !envProjectId) {
        throw new AfterExchangeError(projectRequired);
    }

    context.onProgress?.('Provisioning Cloud Code Assist project (this may take a moment)...');
    const onboardBody = {
        tierId,
        metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
        },
    };
    if (tierId !== TIER_FREE && envProjectId) {
        onboardBody.cloudaicompanionProject = envProjectId;
        onboardBody.metadata.duetProject = envProjectId;
    }
    const onboardResponse = await oauthFetch(context, `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
        method: 'POST',
        headers,
        body: JSON.stringify(onboardBody),
    });
    if (!onboardResponse.ok) {
        const errorText = await onboardResponse.text();
        throw new AfterExchangeError(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
    }
    let operation = await onboardResponse.json();
    if (!operation?.done && operation?.name) {
        operation = await pollGeminiOperation(operation.name, headers, context);
    }
    const projectId = operation?.response?.cloudaicompanionProject?.id;
    if (projectId) return projectId;
    if (envProjectId) return envProjectId;
    throw new AfterExchangeError(
        'Could not discover or provision a Google Cloud project. '
        + 'Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. '
        + 'See https://goo.gle/gemini-cli-auth-docs#workspace-gca',
    );
}

/**
 * Resolve the project after login and preserve it across refresh responses.
 * @param {any} credential
 * @param {any} context
 * @param {(accessToken: string, context: any) => Promise<string>} discover provider-specific discovery
 */
async function googleProjectHook(credential, context, discover) {
    if (context.phase === 'refresh') {
        return context.stored?.projectId ? { ...credential, projectId: context.stored.projectId } : credential;
    }
    const raw = context.raw;
    if (!isRecord(raw) || typeof raw.refresh_token !== 'string' || raw.refresh_token === '') {
        throw new AfterExchangeError('No refresh token received. Please try again.');
    }
    let projectId;
    try {
        projectId = await discover(credential.access, context);
    } catch (error) {
        if (error instanceof AfterExchangeError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const validationUrl = extractGoogleValidationUrl(message);
        if (!validationUrl) throw error;
        throw new AfterExchangeError(
            formatGoogleValidationRequiredMessage(validationUrl, 'sign in again', credential.email),
        );
    }
    return { ...credential, projectId };
}

/* ------------------------------------------------------------------ */
/* google-antigravity-project                                         */
/* ------------------------------------------------------------------ */

/**
 * POST a Cloud Code Assist request and return its JSON body. Any non-200 is a
 * provisioning failure; the label keeps the error actionable.
 * @param {string} label
 * @param {string} url
 * @param {'GET'|'POST'} method
 * @param {Record<string,string>} headers
 * @param {string|undefined} body
 * @param {any} context
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
async function requestAntigravity(label, url, method, headers, body, context, timeoutMs) {
    if (context.signal?.aborted) throw new AfterExchangeError('OAuth login cancelled');
    const init = body === undefined ? { method, headers } : { method, headers, body };
    const response = await oauthFetch(context, url, init, timeoutMs);
    if (response.status !== 200) {
        const errorText = await response.text();
        throw new AfterExchangeError(`${label} failed: ${response.status} ${response.statusText}: ${errorText}`);
    }
    return response.json();
}

/**
 * @param {Record<string,string>} headers
 * @param {Record<string, unknown>} body
 * @param {any} context
 */
async function postAntigravityLoadCodeAssist(headers, body, context) {
    const payload = await requestAntigravity(
        'loadCodeAssist',
        `${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
        'POST',
        headers,
        JSON.stringify(body),
        context,
    );
    if (!isRecord(payload)) {
        throw new AfterExchangeError('failed to unmarshal LoadCodeAssistResponse: expected an object');
    }
    return payload;
}

/**
 * @param {Record<string,string>} headers
 * @param {any} context
 */
async function loadAntigravityCodeAssist(headers, context) {
    const metadata = { ideType: 'ANTIGRAVITY' };
    let payload = await postAntigravityLoadCodeAssist(headers, { metadata }, context);
    const projectId = nonEmpty(payload.cloudaicompanionProject);
    // A project without a paid tier means the account has not been onboarded
    // yet; re-query with it so the response carries the tier information.
    if ((payload.paidTier === undefined || payload.paidTier === null) && projectId) {
        payload = await postAntigravityLoadCodeAssist(headers, {
            cloudaicompanionProject: projectId,
            metadata,
        }, context);
    }
    return payload;
}

/**
 * A response that allows `free-tier` onboarding; an explicit ineligibility is
 * reported with the provider's reason and (when present) help URL.
 * @param {Record<string, any>} payload
 */
function assertAntigravityFreeTierEligible(payload) {
    const allowed = Array.isArray(payload.allowedTiers)
        ? payload.allowedTiers.some((tier) => tier?.id === ANTIGRAVITY_FREE_TIER)
        : false;
    if (allowed) return;
    const ineligible = Array.isArray(payload.ineligibleTiers)
        ? payload.ineligibleTiers.find((tier) => tier?.tierId === ANTIGRAVITY_FREE_TIER)
        : undefined;
    if (!ineligible?.reasonMessage) return;
    const validation = nonEmpty(ineligible.validationUrl) ? `\n${ineligible.validationUrl}` : '';
    throw new AfterExchangeError(`${ineligible.reasonMessage}${validation}`);
}

/**
 * @param {any} operation
 * @returns {string}
 */
function describeOperationError(operation) {
    if (operation?.message) {
        return typeof operation.code === 'number' ? `${operation.code}: ${operation.message}` : operation.message;
    }
    return JSON.stringify(operation) ?? String(operation);
}

/**
 * @param {number} deadline
 * @returns {number}
 */
function remainingOnboardTime(deadline) {
    const remaining = deadline - Date.now();
    if (remaining > 0) return remaining;
    throw new AfterExchangeError(`onboardUser timed out after ${ANTIGRAVITY_ONBOARD_TIMEOUT_MS}ms`);
}

/**
 * Sleep that settles early when the login is cancelled.
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 */
function sleep(ms, signal) {
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

/**
 * Onboard the account onto the Antigravity free tier, polling the long-running
 * operation until it settles or the 30s budget is spent.
 * @param {Record<string,string>} headers
 * @param {any} context
 */
async function onboardAntigravity(headers, context) {
    const deadline = Date.now() + ANTIGRAVITY_ONBOARD_TIMEOUT_MS;
    const parseOperation = (payload) => {
        if (!isRecord(payload)) {
            throw new AfterExchangeError('failed to unmarshal OnboardUser operation: expected an object');
        }
        return payload;
    };
    let operation = parseOperation(await requestAntigravity(
        'onboardUser',
        `${ANTIGRAVITY_ENDPOINT}/v1internal:onboardUser`,
        'POST',
        headers,
        JSON.stringify({ tierId: ANTIGRAVITY_FREE_TIER, metadata: { ideType: 'ANTIGRAVITY' } }),
        context,
        remainingOnboardTime(deadline),
    ));

    while (true) {
        if (operation.done === true) {
            if (operation.error !== undefined && operation.error !== null) {
                throw new AfterExchangeError(`OnboardUser operation failed: ${describeOperationError(operation.error)}`);
            }
            if (operation.response === undefined || operation.response === null) {
                throw new AfterExchangeError('failed to unmarshal OnboardUserResponse');
            }
            return;
        }

        await sleep(Math.min(ANTIGRAVITY_ONBOARD_POLL_MS, remainingOnboardTime(deadline)), context.signal);
        if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
        const operationName = nonEmpty(operation.name);
        if (!operationName) {
            throw new AfterExchangeError('onboardUser returned an operation without a name');
        }
        operation = parseOperation(await requestAntigravity(
            'onboardUser operation',
            `${ANTIGRAVITY_ENDPOINT}/v1internal/${operationName}`,
            'GET',
            headers,
            undefined,
            context,
            remainingOnboardTime(deadline),
        ));
    }
}

/**
 * Resolve (or provision) the Antigravity Cloud Code Assist project.
 * @param {string} accessToken
 * @param {any} context
 * @returns {Promise<string>}
 */
async function discoverAntigravityProject(accessToken, context) {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': antigravityUserAgent(context.env || {}),
    };
    context.onProgress?.('Checking Cloud Code Assist account status...');
    try {
        const initial = await loadAntigravityCodeAssist(headers, context);
        assertAntigravityFreeTierEligible(initial);
        if (initial.currentTier === undefined || initial.currentTier === null) {
            context.onProgress?.('Provisioning the Antigravity free tier...');
            await onboardAntigravity(headers, context);
        }
        context.onProgress?.('Refreshing Cloud Code Assist project...');
        const refreshed = await loadAntigravityCodeAssist(headers, context);
        const projectId = nonEmpty(refreshed.cloudaicompanionProject);
        if (projectId) return projectId;
        throw new AfterExchangeError('loadCodeAssist did not return a cloudaicompanionProject');
    } catch (error) {
        if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
        if (error instanceof AfterExchangeError) throw error;
        throw new AfterExchangeError(
            `Could not discover an Antigravity project. ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/* ------------------------------------------------------------------ */
/* zai-mint-key                                                       */
/* ------------------------------------------------------------------ */

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
        throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${body}`);
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
        throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${body}`);
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
 * Z.ai business APIs.
 * @param {any} credential
 * @param {any} context
 */
async function zaiMintKey(credential, context) {
    return { ...credential, access: await mintZaiKey(credential.access, context) };
}

/* ------------------------------------------------------------------ */
/* muse-code-key                                                      */
/* ------------------------------------------------------------------ */

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
 * the same `api_key` for the account.
 *
 * Deviation from OMP's shape: OMP stores both values in a JSON envelope in
 * `access` and decodes it in its muse provider. This plugin sends
 * `credential.access` verbatim as the request bearer (`resolveAccessToken`), so
 * the minted key must be `access`; the OAuth token is preserved beside it and
 * an OMP-shaped credential is normalized on the way through.
 * @param {any} credential
 * @param {any} context
 */
async function attachMuseCodeApiKey(credential, context) {
    const existing = existingMuseApiKey(credential);
    if (existing?.apiKey) {
        if (credential.access === existing.apiKey && credential.oauthAccessToken === existing.oauthAccessToken) {
            return credential;
        }
        return { ...credential, access: existing.apiKey, oauthAccessToken: existing.oauthAccessToken };
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
    return {
        ...credential,
        access: apiKey,
        oauthAccessToken: credential.access,
        accountId,
        email,
    };
}

/* ------------------------------------------------------------------ */
/* factory-droid-region                                               */
/* ------------------------------------------------------------------ */

/** Factory API host per residency region; EU accounts are served from the EU region. */
function factoryDroidApiBaseUrl(region) {
    return region === 'eu' ? 'https://api.eu.factory.ai' : 'https://api.factory.ai';
}

/** Explicit inference scope wins, else EU residency infers EU, else global. */
function resolveFactoryDroidInferenceRegion(scope) {
    if (scope?.inferenceRegion) return scope.inferenceRegion;
    return scope?.region === 'eu' ? 'eu' : 'global';
}

/**
 * Resolve the canonical Factory identity: residency chooses the API host,
 * inference scope chooses eligible routes. Unlike most hooks this one can fail
 * the login — Factory rejects credentials without an organization.
 * @param {any} credential
 * @param {any} context
 */
async function attachFactoryDroidRegion(credential, context) {
    if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
    if (!isRecord(context.raw) || typeof context.raw.refresh_token !== 'string' || !credential.refresh) {
        throw new AfterExchangeError('Factory token response missing refresh token');
    }
    const login = context.phase !== 'refresh';
    const stored = context.stored || {};
    const selectedOrg = typeof context.raw.organization_id === 'string'
        ? context.raw.organization_id
        : stored.activeOrganizationId;
    // The token's Factory org claim belongs to the new bearer: a different
    // claim is an org change even when the WorkOS selection is unchanged.
    const factoryOrgChanged = Boolean(credential.orgId && stored.orgId && credential.orgId !== stored.orgId);
    const sameOrg = !factoryOrgChanged
        && (!selectedOrg || !stored.activeOrganizationId || selectedOrg === stored.activeOrganizationId);
    const identity = compact({
        ...credential,
        activeOrganizationId: selectedOrg,
        orgId: credential.orgId ?? (sameOrg ? stored.orgId : undefined),
        region: sameOrg ? stored.region : undefined,
        inferenceRegion: sameOrg ? stored.inferenceRegion : undefined,
    });
    const signal = requestSignal(context.signal, FACTORY_WHOAMI_TIMEOUT_MS);
    try {
        const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
            headers: {
                Authorization: `Bearer ${credential.access}`,
                Accept: 'application/json',
                ...(identity.orgId ? { 'X-Factory-Org-Id': identity.orgId } : {}),
            },
            signal,
        });
        if (!response.ok && login) {
            throw new AfterExchangeError(`Factory identity check failed (${response.status}): ${await response.text()}`);
        }
        if (response.ok) {
            const body = await response.json();
            if (isRecord(body)) {
                const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : identity.orgId;
                if (login && !orgId) {
                    throw new AfterExchangeError('Factory login did not resolve an organization');
                }
                // A different organization must not inherit the stored scope.
                const carried = !orgId || !identity.orgId || orgId === identity.orgId ? identity : undefined;
                const region = body.region === 'eu' || body.region === 'global' ? body.region : carried?.region;
                const inferenceRegion = body.inferenceRegion === 'global'
                    || body.inferenceRegion === 'eu'
                    || body.inferenceRegion === 'us'
                    ? body.inferenceRegion
                    : resolveFactoryDroidInferenceRegion({ region, inferenceRegion: carried?.inferenceRegion });
                return compact({ ...identity, orgId, region, inferenceRegion });
            }
        }
    } catch (error) {
        if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
        if (login) throw error;
        // Refresh keeps the stored identity rather than failing the refresh.
    }
    if (context.signal?.aborted) throw new AfterExchangeError('Login cancelled');
    if (login && !identity.orgId) {
        throw new AfterExchangeError('Factory login did not resolve an organization');
    }
    return identity;
}

/* ------------------------------------------------------------------ */
/* gitlab-duo-clear-cache                                             */
/* ------------------------------------------------------------------ */

/**
 * OMP clears its in-process GitLab Duo direct-access cache after token
 * rotation. This plugin caches no direct-access credentials — every request
 * resolves the key store, so there is nothing to invalidate.
 * @param {any} credential
 */
async function gitlabDuoClearCache(credential) {
    return credential;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

/** @type {Map<string, (credential: any, context: any) => Promise<any>>} */
const HOOKS = new Map([
    ['anthropic-identity', anthropicIdentity],
    ['openai-codex-profile', openaiCodexProfile],
    ['google-gemini-cli-project', (credential, context) => googleProjectHook(credential, context, discoverGeminiProject)],
    ['google-antigravity-project', (credential, context) => googleProjectHook(credential, context, discoverAntigravityProject)],
    ['zai-mint-key', zaiMintKey],
    ['muse-code-key', attachMuseCodeApiKey],
    ['factory-droid-region', attachFactoryDroidRegion],
    ['gitlab-duo-clear-cache', gitlabDuoClearCache],
]);

/**
 * Run the `afterExchange` hook a login policy declares.
 *
 * Unknown or unimplemented hooks never fail the login: they only enrich the
 * already-exchanged credential, so the credential is returned unchanged after a
 * one-time log line.
 *
 * @param {string|undefined} hookName policy `login.afterExchange`
 * @param {object} credential engine-mapped credential
 * @param {{
 *     provider?: string,
 *     phase?: 'login'|'refresh',
 *     raw?: unknown,
 *     fetch?: typeof fetch,
 *     env?: Record<string,string|undefined>,
 *     signal?: AbortSignal,
 *     stored?: object,
 *     onProgress?: (message: string) => void,
 * }} [context] request/session context (`raw` is the token response body)
 * @returns {Promise<object>} the enriched (or untouched) credential
 */
export async function applyAfterExchange(hookName, credential, context = {}) {
    const name = String(hookName || '').trim();
    if (!name) return credential;
    const hook = HOOKS.get(name);
    if (!hook) {
        if (!reportedUnknownHooks.has(name)) {
            reportedUnknownHooks.add(name);
            log(`after-exchange hook "${name}" is not implemented; keeping the exchanged credential unchanged`);
        }
        return credential;
    }
    return hook(credential, {
        provider: String(context.provider || ''),
        phase: context.phase === 'refresh' ? 'refresh' : 'login',
        raw: context.raw,
        fetch: context.fetch || fetch,
        env: context.env || process.env,
        signal: context.signal,
        stored: context.stored,
        onProgress: typeof context.onProgress === 'function' ? context.onProgress : undefined,
    });
}
