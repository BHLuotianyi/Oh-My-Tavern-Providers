/**
 * Cloud Code Assist project discovery/onboarding hooks:
 * `google-gemini-cli-project` and `google-antigravity-project`.
 */
import { antigravityUserAgent, geminiCliUserAgent } from '../client-versions.mjs';
import {
    AfterExchangeError,
    envValue,
    extractGoogleValidationUrl,
    formatGoogleValidationRequiredMessage,
    isRecord,
    nonEmpty,
    oauthFetch,
    sleep,
} from './shared.mjs';

/** Cloud Code Assist host for Gemini CLI accounts. */
const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
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
export async function discoverGeminiProject(accessToken, context) {
    const env = context.env || {};
    const envProjectId = envValue(env, 'GOOGLE_CLOUD_PROJECT') || envValue(env, 'GOOGLE_CLOUD_PROJECT_ID');
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': geminiCliUserAgent(GEMINI_DEFAULT_MODEL, env),
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
export async function discoverAntigravityProject(accessToken, context) {
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

/**
 * Resolve the project after login and preserve it across refresh responses.
 * @param {any} credential
 * @param {any} context
 * @param {(accessToken: string, context: any) => Promise<string>} discover provider-specific discovery
 */
export async function googleProjectHook(credential, context, discover) {
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
