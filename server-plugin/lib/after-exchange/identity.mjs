/**
 * Identity & cache post-exchange hooks: `anthropic-identity`,
 * `openai-codex-profile`, and `gitlab-duo-clear-cache`.
 */
import { claudeCodeVersion } from '../client-versions.mjs';
import {
    AfterExchangeError,
    compact,
    decodeJwtPayload,
    isRecord,
    nonEmpty,
    readPath,
    safeErrorContext,
    trimmedString,
} from './shared.mjs';

/** Bootstrap endpoint Claude Code reports the signed-in account/org on. */
const ANTHROPIC_BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
const ANTHROPIC_BOOTSTRAP_MODEL = 'claude-opus-4-8';

/**
 * @param {string} token
 * @param {any} context
 * @returns {Promise<{accountId?:string, email?:string, orgId?:string, orgName?:string}>}
 */
async function fetchAnthropicBootstrapIdentity(token, context) {
    const url = `${ANTHROPIC_BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(ANTHROPIC_BOOTSTRAP_MODEL)}`;
    const version = claudeCodeVersion(context.env || {});
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
        throw new Error(`HTTP request failed. status=${response.status}; ${safeErrorContext(url, body)}`);
    }
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Anthropic bootstrap returned invalid JSON. ${safeErrorContext(url, body)}`);
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
export async function anthropicIdentity(credential, context) {
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
export async function openaiCodexProfile(credential, context) {
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

/**
 * OMP clears its in-process GitLab Duo direct-access cache after token
 * rotation. This plugin caches no direct-access credentials — every request
 * resolves the key store, so there is nothing to invalidate.
 * @param {any} credential
 */
export async function gitlabDuoClearCache(credential) {
    return credential;
}
