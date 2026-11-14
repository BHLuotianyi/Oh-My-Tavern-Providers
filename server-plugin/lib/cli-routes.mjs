/**
 * Subscription providers whose vendors only allow their own clients.
 *
 * Google forbids third-party tools from reusing Gemini CLI / Antigravity OAuth,
 * and Anthropic forbids third-party apps from collecting Claude.ai credentials
 * or presenting themselves as Claude Code. By default these providers therefore
 * run the vendor's official CLI as a subprocess: the CLI owns sign-in and
 * transport, and OMTP never sees the subscription token.
 *
 * The original direct OAuth transport stays available behind the per-provider
 * `legacyOAuth` switch, off unless the user turns it on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStructuredCredential } from './oauth.mjs';
import { legacyOAuthEnabled } from './provider-config.mjs';

/**
 * @typedef {{adapter:string, command:string, envPath:string, label:string, apiKeys:boolean}} CliRoute
 * `apiKeys`: the provider also takes plain API keys, which keep the direct API.
 */

/** @type {Readonly<Record<string, Readonly<CliRoute>>>} */
export const CLI_ROUTES = Object.freeze({
    anthropic: Object.freeze({ adapter: 'claude-cli', command: 'claude', envPath: 'OMTP_CLAUDE_PATH', label: 'Claude Code', apiKeys: true }),
    'google-antigravity': Object.freeze({ adapter: 'agy-cli', command: 'agy', envPath: 'OMTP_AGY_PATH', label: 'Antigravity CLI', apiKeys: false }),
    'google-gemini-cli': Object.freeze({ adapter: 'gemini-cli', command: 'gemini', envPath: 'OMTP_GEMINI_PATH', label: 'Gemini CLI', apiKeys: false }),
});

/**
 * @param {string} providerId
 * @returns {boolean}
 */
export function hasCliRoute(providerId) {
    return Object.hasOwn(CLI_ROUTES, String(providerId || ''));
}

/** Claude subscription tokens that are not structured OAuth blobs. */
const SUBSCRIPTION_TOKEN = /^(?:sk-ant-oat|sk-ant-acc|oauth:)/;

/**
 * A credential minted by a subscription sign-in rather than an API console.
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isSubscriptionCredential(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return false;
    return Boolean(parseStructuredCredential(apiKey)) || SUBSCRIPTION_TOKEN.test(apiKey.trim());
}

/**
 * Install locations missing from a service manager's minimal PATH (systemd
 * user units, launchd agents) but used by the vendors' installers.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function fallbackDirs(env) {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return [
            env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
            path.join(home, '.local', 'bin'),
        ].filter(Boolean);
    }
    return [
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        path.join(home, '.npm-global', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
    ];
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutable(file) {
    try {
        if (!fs.statSync(file).isFile()) return false;
        if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {string} command
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function searchPath(command, env) {
    const pathVar = env.PATH ?? env.Path ?? '';
    const dirs = [...String(pathVar).split(path.delimiter), ...fallbackDirs(env)].filter(Boolean);
    const exts = process.platform === 'win32'
        ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const file = path.join(dir, command + ext);
            if (isExecutable(file)) return file;
        }
    }
    return '';
}

const LOOKUP_TTL_MS = 30_000;
/** @type {Map<string, {path:string, at:number}>} */
const lookupCache = new Map();

/**
 * Absolute path of the route's CLI, or '' when it is not installed. The
 * `OMTP_*_PATH` override wins over PATH. Results are cached briefly because
 * the provider roster resolves every provider on each refresh.
 * @param {CliRoute} route
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function locateCli(route, env = process.env) {
    const override = String(env[route.envPath] || '').trim();
    const key = `${route.command}\0${override}\0${env.PATH ?? env.Path ?? ''}`;
    const cached = lookupCache.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.path;
    const found = override ? (isExecutable(override) ? path.resolve(override) : '') : searchPath(route.command, env);
    lookupCache.set(key, { path: found, at: Date.now() });
    return found;
}

/** Forget cached lookups (tests, or after the user installs a CLI). */
export function clearCliLookupCache() {
    lookupCache.clear();
}

/**
 * Point a resolved provider at its official CLI unless the user opted back
 * into direct OAuth, or the provider holds a plain API key it can use directly.
 * The stored OAuth credential is left in place but never used on this route.
 *
 * @param {any} resolved output of `KeyStore.resolveProvider`, with the catalog id
 * @param {string} root OMTP data dir; the CLI runs in a private folder under it
 * @param {Record<string, string|undefined>} [env]
 * @returns {any}
 */
export function applyCliRoute(resolved, root, env = process.env) {
    const route = CLI_ROUTES[String(resolved?.id || '')];
    if (!route || legacyOAuthEnabled(resolved)) return resolved;
    if (route.apiKeys && resolved.apiKey && !isSubscriptionCredential(resolved.apiKey)) return resolved;
    const executable = locateCli(route, env);
    return {
        ...resolved,
        adapter: route.adapter,
        apiKey: '',
        headers: {},
        keySource: executable ? 'cli' : 'none',
        available: Boolean(executable) && !resolved.unreadable,
        cli: {
            command: route.command,
            label: route.label,
            path: executable,
            workDir: path.join(root, 'cli', route.command),
            legacyCredential: resolved.keySource === 'omtp' && Boolean(resolved.apiKey),
        },
    };
}
