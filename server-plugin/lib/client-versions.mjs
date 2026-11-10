/**
 * Client identities the gateway presents to services that gate on them. One
 * pin per client, tracking upstream OMP (`providers/claude-code-fingerprint.ts`,
 * `catalog/src/wire/gemini-headers.ts`, `registry/oauth/kimi.ts`).
 *
 * A stale pin fails visibly: Anthropic rejects a Claude Code version older than
 * the model requires ("version X or newer is required"), and Antigravity hides
 * newer Gemini models from old clients. Bump these with the catalog.
 *
 * Each value can be overridden with the same `PI_AI_*` variable OMP reads.
 */

/** Latest `@anthropic-ai/claude-code` release on npm. */
export const CLAUDE_CODE_VERSION = '2.1.322';
/** `@anthropic-ai/sdk` version bundled by that Claude Code release. */
export const CLAUDE_CODE_SDK_VERSION = '0.128.0';
export const GEMINI_CLI_VERSION = '0.46.0';
export const ANTIGRAVITY_VERSION = '2.26.0';
/** Changelist of the captured Antigravity client; the backend does not validate it. */
export const ANTIGRAVITY_CL = '1005016104';
export const KIMI_CLI_VERSION = '18.18.6';

/**
 * @param {Record<string, string|undefined>|undefined} env
 * @param {string} name
 */
function envValue(env, name) {
    const value = env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** @param {Record<string, string|undefined>} [env] */
export function claudeCodeVersion(env = process.env) {
    return envValue(env, 'PI_AI_CLAUDE_CODE_VERSION') || CLAUDE_CODE_VERSION;
}

/** User-Agent of Claude Code's CLI inference entrypoint. */
export function claudeCliUserAgent(env = process.env) {
    return `claude-cli/${claudeCodeVersion(env)} (external, cli)`;
}

/**
 * Gemini CLI format `GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)`; the
 * platform and arch are host facts.
 * @param {string} modelId
 * @param {Record<string, string|undefined>} [env]
 */
export function geminiCliUserAgent(modelId, env = process.env) {
    const version = envValue(env, 'PI_AI_GEMINI_CLI_VERSION') || GEMINI_CLI_VERSION;
    return `GeminiCLI/${version}/${modelId} (${process.platform}; ${process.arch}; terminal)`;
}

/**
 * Antigravity is gated on the client version; os/arch name the macOS build the
 * constants were captured from.
 * @param {Record<string, string|undefined>} [env]
 */
export function antigravityUserAgent(env = process.env) {
    const version = envValue(env, 'PI_AI_ANTIGRAVITY_VERSION') || ANTIGRAVITY_VERSION;
    const cl = envValue(env, 'PI_AI_ANTIGRAVITY_CL') || ANTIGRAVITY_CL;
    const os = envValue(env, 'PI_AI_ANTIGRAVITY_OS') || 'darwin';
    const arch = envValue(env, 'PI_AI_ANTIGRAVITY_ARCH') || 'arm64';
    return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}
