import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
    autoStart: true,
    port: 4100,
    requireAuth: true,
});

export const CONFIG_FILE = 'config.json';
export const PROVIDERS_FILE = 'providers.json';
export const MASTER_KEY_FILE = 'master.key';
export const TOKEN_FILE = 'gateway-token';
export const CACHED_CATALOG_FILE = 'catalog.json';
export const IMPORTED_CATALOG_FILE = 'imported-catalog.json';

/**
 * Root directory for OMTP server state: `<DATA_ROOT>/omtp`.
 * @returns {string}
 */
export function getOmtpRoot() {
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' && globalThis.DATA_ROOT
        ? globalThis.DATA_ROOT
        : path.resolve(process.cwd(), 'data');
    return path.join(dataRoot, 'omtp');
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
export function omtpPath(root, file) {
    return path.join(root, file);
}

/**
 * Create the OMTP directory if needed.
 * @param {string} root
 */
export async function ensureOmtpRoot(root = getOmtpRoot()) {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    return root;
}

/**
 * Write a file atomically with the requested mode.
 * @param {string} filePath
 * @param {string|Buffer} contents
 * @param {number} [mode]
 */
export async function writeFileAtomic(filePath, contents, mode = 0o600) {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmpPath, contents, { mode });
    try {
        await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
        await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
        throw error;
    }
    try {
        await fs.promises.chmod(filePath, mode);
    } catch {
        // Best effort on filesystems that do not support chmod.
    }
}

/**
 * @param {string} filePath
 * @returns {Promise<any|null>}
 */
export async function readJsonFile(filePath) {
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {number} [mode]
 */
export async function writeJsonAtomic(filePath, value, mode = 0o600) {
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/**
 * Clamp a port to a usable range.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizePort(value, fallback = DEFAULT_CONFIG.port) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
    return parsed;
}

/**
 * Load gateway configuration, filling defaults.
 * @param {string} root
 * @returns {Promise<{autoStart:boolean, port:number, requireAuth:boolean}>}
 */
export async function loadConfig(root = getOmtpRoot()) {
    let raw = null;
    try {
        raw = await readJsonFile(omtpPath(root, CONFIG_FILE));
    } catch {
        raw = null;
    }
    return {
        autoStart: typeof raw?.autoStart === 'boolean' ? raw.autoStart : DEFAULT_CONFIG.autoStart,
        port: normalizePort(raw?.port, DEFAULT_CONFIG.port),
        requireAuth: typeof raw?.requireAuth === 'boolean' ? raw.requireAuth : DEFAULT_CONFIG.requireAuth,
    };
}

/**
 * Merge and persist gateway configuration atomically.
 * @param {string} root
 * @param {Partial<{autoStart:boolean, port:number, requireAuth:boolean}>} patch
 * @returns {Promise<{autoStart:boolean, port:number, requireAuth:boolean}>}
 */
export async function saveConfig(root, patch = {}) {
    const current = await loadConfig(root);
    const next = {
        autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : current.autoStart,
        port: patch.port === undefined ? current.port : normalizePort(patch.port, current.port),
        requireAuth: typeof patch.requireAuth === 'boolean' ? patch.requireAuth : current.requireAuth,
    };
    await ensureOmtpRoot(root);
    await writeJsonAtomic(omtpPath(root, CONFIG_FILE), next);
    return next;
}

/**
 * Ensure the gateway token exists. Returns the token.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function ensureGatewayToken(root = getOmtpRoot()) {
    const tokenPath = omtpPath(root, TOKEN_FILE);
    try {
        const existing = (await fs.promises.readFile(tokenPath, 'utf8')).trim();
        if (existing) return existing;
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await writeFileAtomic(tokenPath, `${token}\n`, 0o600);
    return token;
}

/**
 * Constant-time string comparison for tokens.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokensEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}
