/**
 * `kimi-fingerprint` header hook.
 *
 * OMP port: `packages/ai/src/registry/oauth/kimi.ts#getKimiCommonHeaders`.
 * Kimi's API only accepts requests that carry the CLI fingerprint headers; the
 * device id is stable per install (OMP keeps `kimi-device-id` in its agent dir,
 * we keep it next to our config).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Sanitised against Kimi's CLI version at the time of porting. */
const CLI_VERSION = '18.12.6';
const DEVICE_ID_FILE = 'kimi-device-id';

/** @type {Map<string, string>} */
const deviceIds = new Map();

/**
 * @param {string} root OMTP data directory.
 * @returns {string}
 */
function deviceId(root) {
    const cached = deviceIds.get(root);
    if (cached) return cached;
    const file = path.join(root, DEVICE_ID_FILE);
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing) {
            deviceIds.set(root, existing);
            return existing;
        }
    } catch {
        // missing/unreadable → create one below
    }
    const created = crypto.randomUUID().replace(/-/g, '');
    try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(file, `${created}\n`, { mode: 0o600 });
    } catch {
        // persistence is best-effort; the process keeps using `created`
    }
    deviceIds.set(root, created);
    return created;
}

/** @param {string} value */
function header(value) {
    return String(value || '').replace(/[\r\n]/g, ' ').trim() || 'unknown';
}

/**
 * @param {string} name
 * @param {string} root
 * @returns {Record<string, string>} Headers to merge into every request.
 */
export function headersForHook(name, root) {
    if (name !== 'kimi-fingerprint') return {};
    return {
        'User-Agent': `KimiCLI/${CLI_VERSION}`,
        'X-Msh-Platform': 'kimi_cli',
        'X-Msh-Version': CLI_VERSION,
        'X-Msh-Device-Name': header(os.hostname()),
        'X-Msh-Device-Model': header(os.machine?.() || 'unknown'),
        'X-Msh-Os-Version': header(os.version()),
        'X-Msh-Device-Id': header(deviceId(root)),
    };
}

/**
 * @param {string|undefined} name
 * @returns {boolean} Whether this header hook is implemented locally.
 */
export function headerHookSupported(name) {
    return name === 'kimi-fingerprint';
}
