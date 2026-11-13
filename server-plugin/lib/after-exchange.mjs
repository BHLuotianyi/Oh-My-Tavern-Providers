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
import { anthropicIdentity, gitlabDuoClearCache, openaiCodexProfile } from './after-exchange/identity.mjs';
import { discoverAntigravityProject, discoverGeminiProject, googleProjectHook } from './after-exchange/google-projects.mjs';
import { zaiMintKey } from './after-exchange/zai-mint-key.mjs';
import { attachMuseCodeApiKey } from './after-exchange/muse-code-key.mjs';
import { attachFactoryDroidRegion } from './after-exchange/factory-droid-region.mjs';

/** Hook names already reported as unimplemented, so the log stays one-per-hook. */
const reportedUnknownHooks = new Set();

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
