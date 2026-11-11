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
export const COMPANION_TOKEN_FILE = 'companion-token';
export const INSTALL_ID_FILE = 'install-id';
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
 * Read a random hex token file, creating it on first use.
 * @param {string} root
 * @param {string} file
 * @returns {Promise<string>}
 */
async function ensureTokenFile(root, file) {
    const tokenPath = omtpPath(root, file);
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
 * Ensure the gateway token exists. Returns the token.
 * @param {string} root
 * @returns {Promise<string>}
 */
export function ensureGatewayToken(root = getOmtpRoot()) {
    return ensureTokenFile(root, TOKEN_FILE);
}

/**
 * Token the standalone companion requires on management calls (they come
 * cross-origin from TauriTavern's WebView, so the Origin guard cannot apply).
 * @param {string} root
 * @returns {Promise<string>}
 */
export function ensureCompanionToken(root = getOmtpRoot()) {
    return ensureTokenFile(root, COMPANION_TOKEN_FILE);
}

/** @type {Map<string,string>} In-process install id per OMTP root. */
const installIdCache = new Map();

/** `crypto.randomUUID()` output: a v4 UUID. */
const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} value */
function isInstallId(value) {
    return INSTALL_ID_PATTERN.test(value);
}

/**
 * Stable per-installation id: random UUID v4 persisted at the OMTP root.
 * Used to label requests that have no conversation (usage polls, model
 * discovery) and as the HMAC key for derived per-chat session ids.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function ensureInstallId(root = getOmtpRoot()) {
    const cached = installIdCache.get(root);
    if (cached) return cached;
    await ensureOmtpRoot(root);
    const idPath = omtpPath(root, INSTALL_ID_FILE);
    let id = '';
    try {
        const existing = (await fs.promises.readFile(idPath, 'utf8')).trim();
        if (isInstallId(existing)) id = existing;
        else await fs.promises.rm(idPath, { force: true });
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    if (!id) {
        const candidate = crypto.randomUUID();
        try {
            await fs.promises.writeFile(idPath, `${candidate}\n`, { flag: 'wx', mode: 0o600 });
            id = candidate;
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
            // Another process won the create; adopt its id when it is usable.
            const existing = (await fs.promises.readFile(idPath, 'utf8').catch(() => '')).trim();
            id = isInstallId(existing) ? existing : candidate;
        }
    }
    installIdCache.set(root, id);
    return id;
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
