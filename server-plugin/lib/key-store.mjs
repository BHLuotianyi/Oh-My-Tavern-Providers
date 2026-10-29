import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    MASTER_KEY_FILE,
    PROVIDERS_FILE,
    ensureOmtpRoot,
    getOmtpRoot,
    omtpPath,
    readJsonFile,
    writeFileAtomic,
    writeJsonAtomic,
} from './config.mjs';
import { buildProviderConfig, isKeylessProvider, isSupportedAdapter } from './provider-config.mjs';
import { headersForHook } from './custom-logins/kimi-fingerprint.mjs';
import { logError } from './redact.mjs';

export class KeyStoreUnreadableError extends Error {
    constructor(message = 'OMTP key store unreadable; re-enter provider keys') {
        super(message);
        this.name = 'KeyStoreUnreadableError';
        this.code = 'OMTP_KEYSTORE_UNREADABLE';
    }
}

const ENC_PREFIX = 'enc:v1:';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number|null}
 */
function numberOrNull(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Normalize a custom model entry.
 * @param {any} model
 * @returns {any|null}
 */
export function normalizeCustomModel(model) {
    if (!model || typeof model !== 'object') return null;
    const id = String(model.id || model.name || '').trim();
    if (!id) return null;
    return {
        id,
        name: String(model.name || id),
        contextWindow: numberOrNull(model.contextWindow),
        maxTokens: numberOrNull(model.maxTokens),
        input: Array.isArray(model.input) && model.input.length > 0 ? model.input.map(String) : ['text'],
        supportsTools: Boolean(model.supportsTools),
        reasoning: Boolean(model.reasoning),
        efforts: Array.isArray(model.efforts) ? model.efforts.map(String) : [],
        kind: 'chat',
    };
}

/**
 * @param {unknown} models
 * @returns {any[]|undefined}
 */
function normalizeModels(models) {
    if (!Array.isArray(models)) return undefined;
    return models.map(normalizeCustomModel).filter(Boolean);
}

/**
 * Encrypted provider config store.
 *
 * The whole provider config (including its API key) is encrypted with
 * AES-256-GCM under `<root>/master.key`. `providers.json` only contains
 * `enc:v1:<iv>:<tag>:<ciphertext>` strings.
 */
export class KeyStore {
    /**
     * @param {{
     *   root?: string,
     *   resolveStSecret?: ((providerId:string)=>string)|null,
     *   env?: Record<string, string|undefined>,
     * }} [options]
     */
    constructor(options = {}) {
        this.root = options.root || getOmtpRoot();
        this.resolveStSecret = options.resolveStSecret || null;
        this.env = options.env || process.env;
        /** @type {Buffer|null} */
        this._masterKey = null;
        /** @type {Promise<Buffer>|null} */
        this._masterKeyPromise = null;
        /** Serializes read-modify-write cycles on `providers.json`. */
        this._mutations = Promise.resolve();
    }

    /**
     * @returns {Promise<Buffer>}
     */
    async ensureMasterKey() {
        if (this._masterKey) return this._masterKey;
        // Concurrent first calls must share one key: the loser of a generate
        // race would otherwise encrypt under a key that is no longer on disk.
        this._masterKeyPromise ??= this._loadOrCreateMasterKey();
        try {
            return await this._masterKeyPromise;
        } catch (error) {
            // Do not memoize a failed load; a transient read error is retryable.
            this._masterKeyPromise = null;
            throw error;
        }
    }

    /**
     * @returns {Promise<Buffer>}
     */
    async _loadOrCreateMasterKey() {
        const keyPath = omtpPath(this.root, MASTER_KEY_FILE);
        try {
            const raw = (await fs.promises.readFile(keyPath, 'utf8')).trim();
            if (/^[0-9a-f]{64}$/i.test(raw)) {
                this._masterKey = Buffer.from(raw, 'hex');
                return this._masterKey;
            }
            logError('master key invalid; regenerating (stored provider configs will need re-entry)', new Error('invalid master.key'));
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
                if (error instanceof KeyStoreUnreadableError) throw error;
                throw new KeyStoreUnreadableError();
            }
        }
        const key = crypto.randomBytes(32);
        await writeFileAtomic(keyPath, `${key.toString('hex')}\n`, 0o600);
        this._masterKey = key;
        return key;
    }

    /**
     * @param {Record<string, any>} config
     * @returns {Promise<string>}
     */
    async encrypt(config) {
        const key = await this.ensureMasterKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
    }

    /**
     * @param {string} blob
     * @returns {Promise<Record<string, any>>}
     */
    async decrypt(blob) {
        if (typeof blob !== 'string' || !blob.startsWith(ENC_PREFIX)) {
            throw new KeyStoreUnreadableError();
        }
        const parts = blob.slice(ENC_PREFIX.length).split(':');
        if (parts.length !== 3) throw new KeyStoreUnreadableError();
        const [ivRaw, tagRaw, dataRaw] = parts;
        try {
            const key = await this.ensureMasterKey();
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'));
            decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
            const plaintext = Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64')), decipher.final()]);
            const parsed = JSON.parse(plaintext.toString('utf8'));
            if (!isPlainObject(parsed)) throw new Error('invalid provider config');
            return parsed;
        } catch (error) {
            if (error instanceof KeyStoreUnreadableError) throw error;
            throw new KeyStoreUnreadableError();
        }
    }

    /**
     * @returns {Promise<Record<string, string>>}
     */
    async readEncryptedProviders() {
        let raw;
        try {
            raw = await readJsonFile(omtpPath(this.root, PROVIDERS_FILE));
        } catch (error) {
            // A corrupt file is not an empty store: treating it as one would
            // overwrite ciphertext that may still be recoverable.
            logError('providers.json is unreadable', error);
            throw new KeyStoreUnreadableError();
        }
        if (!raw || !isPlainObject(raw.providers)) return {};
        /** @type {Record<string,string>} */
        const out = {};
        for (const [id, blob] of Object.entries(raw.providers)) {
            if (typeof blob === 'string') out[id] = blob;
        }
        return out;
    }

    /**
     * @param {Record<string, string>} providers
     */
    async writeEncryptedProviders(providers) {
        await ensureOmtpRoot(this.root);
        await writeJsonAtomic(omtpPath(this.root, PROVIDERS_FILE), { providers });
    }

    /**
     * Run one read-modify-write cycle under the store's mutation lock.
     * `providers.json` is re-read inside the lock, so concurrent writers cannot
     * drop each other's credentials or resurrect a cleared key.
     * @template T
     * @param {(providers: Record<string, string>) => Promise<{result: T, providers?: Record<string, string>}>} mutate
     * @returns {Promise<T>}
     */
    async _mutate(mutate) {
        const run = this._mutations.then(async () => {
            const providers = await this.readEncryptedProviders();
            const { result, providers: next } = await mutate(providers);
            if (next) await this.writeEncryptedProviders(next);
            return result;
        });
        // A failed mutation must not poison the queue for later callers.
        this._mutations = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * @param {string} providerId
     * @returns {Promise<Record<string, any>>}
     */
    async getProviderConfig(providerId) {
        const providers = await this.readEncryptedProviders();
        const blob = providers[providerId];
        if (!blob) return {};
        return this.decrypt(blob);
    }

    /**
     * Read a provider config without throwing on unreadable data.
     * @param {string} providerId
     * @returns {Promise<{config:Record<string, any>, unreadable:boolean}>}
     */
    async getConfigSafe(providerId) {
        try {
            return { config: await this.getProviderConfig(providerId), unreadable: false };
        } catch (error) {
            if (error instanceof KeyStoreUnreadableError) return { config: {}, unreadable: true };
            throw error;
        }
    }

    /**
     * Merge a patch into the stored provider config and persist it encrypted.
     * @param {string} providerId
     * @param {Record<string, any>} patch
     * @returns {Promise<Record<string, any>>} Sanitized public config.
     */
    async setProviderConfig(providerId, patch = {}) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(providerId || ''))) {
            throw new Error('Invalid provider id');
        }
        return this._mutate(async (providers) => {
            // Never replace an unreadable config: its ciphertext may still be
            // recoverable, and silently overwriting it loses that chance.
            const existing = providers[providerId]
                ? await this.decrypt(providers[providerId])
                : {};

            /** @type {Record<string, any>} */
            const next = { ...existing, id: providerId };
            for (const key of ['label', 'adapter', 'baseUrl', 'headers', 'extraConfig', 'custom', 'models', 'apiKey', 'ignoreStSecret']) {
                if (!(key in patch)) continue;
                const value = patch[key];
                if (key === 'apiKey') {
                    next.apiKey = typeof value === 'string' ? value.trim() : '';
                    continue;
                }
                if (key === 'headers' || key === 'extraConfig') {
                    if (value === null) delete next[key];
                    else if (isPlainObject(value)) next[key] = value;
                    continue;
                }
                if (key === 'models') {
                    const models = normalizeModels(value);
                    if (models) next.models = models;
                    continue;
                }
                if (key === 'custom' || key === 'ignoreStSecret') {
                    if (value === false || value === null) delete next[key];
                    else next[key] = Boolean(value);
                    continue;
                }
                if (key === 'adapter') {
                    if (value === null || value === '') delete next.adapter;
                    else if (isSupportedAdapter(value)) next.adapter = String(value);
                    else throw new Error(`Unsupported adapter: ${value}`);
                    continue;
                }
                if (value === null || value === '') delete next[key];
                else next[key] = String(value);
            }

            next.updatedAt = Date.now();
            providers[providerId] = await this.encrypt(next);
            return { providers, result: this.publicConfig(next) };
        });
    }

    /**
     * Remove the stored API key while keeping other overrides.
     * @param {string} providerId
     * @returns {Promise<Record<string, any>>}
     */
    async clearProviderKey(providerId) {
        return this._mutate(async (providers) => {
            // Unlike `setProviderConfig`, this path keeps the existing
            // KeyStoreUnreadableError: signing out of unreadable data cannot
            // be done safely.
            const base = providers[providerId]
                ? await this.decrypt(providers[providerId])
                : {};
            // A key can come from SillyTavern's own secrets instead of this store;
            // clearing must opt out of that fallback, or "Sign out" changes nothing.
            base.ignoreStSecret = true;
            const next = { ...base };
            delete next.apiKey;
            next.updatedAt = Date.now();
            providers[providerId] = await this.encrypt(next);
            return { providers, result: this.publicConfig(next) };
        });
    }

    /**
     * Remove all stored config for a provider.
     * @param {string} providerId
     * @returns {Promise<boolean>}
     */
    async deleteProviderConfig(providerId) {
        return this._mutate(async (providers) => {
            if (!(providerId in providers)) return { result: false };
            delete providers[providerId];
            return { providers, result: true };
        });
    }

    /**
     * @returns {Promise<Array<{id:string, config:Record<string, any>, unreadable:boolean}>>}
     */
    async listProviderConfigs() {
        const providers = await this.readEncryptedProviders();
        /** @type {Array<{id:string, config:Record<string, any>, unreadable:boolean}>} */
        const out = [];
        for (const [id, blob] of Object.entries(providers)) {
            try {
                out.push({ id, config: await this.decrypt(blob), unreadable: false });
            } catch {
                out.push({ id, config: {}, unreadable: true });
            }
        }
        return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * @param {string} providerId
     * @returns {string}
     */
    resolveEnvKey(providerId, catalogProvider = null) {
        const envVars = Array.isArray(catalogProvider?.envVars) ? catalogProvider.envVars : [];
        for (const name of envVars) {
            const value = this.env[name];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    }

    /**
     * Resolve a provider into the gateway adapter config.
     * Key order: OMTP store -> ST secrets -> catalog env vars -> none.
     *
     * @param {any} catalogProvider
     * @returns {Promise<any>}
     */
    async resolveProvider(catalogProvider) {
        if (typeof catalogProvider === 'string') catalogProvider = { id: catalogProvider };
        const providerId = String(catalogProvider?.id || '');
        const { config: stored, unreadable } = await this.getConfigSafe(providerId);
        let apiKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
        /** @type {'omtp'|'st'|'env'|'none'} */
        let keySource = apiKey ? 'omtp' : 'none';

        if (!apiKey && this.resolveStSecret && stored.ignoreStSecret !== true) {
            try {
                const value = this.resolveStSecret(providerId);
                if (typeof value === 'string' && value.trim()) {
                    apiKey = value.trim();
                    keySource = 'st';
                }
            } catch {
                // ST secrets are unavailable outside a running server; ignore.
            }
        }
        if (!apiKey) {
            const value = this.resolveEnvKey(providerId, catalogProvider);
            if (value) {
                apiKey = value;
                keySource = 'env';
            }
        }

        const resolved = buildProviderConfig(catalogProvider, {
            stored,
            apiKey,
            keySource,
            keyless: isKeylessProvider(catalogProvider) || stored.keyless === true,
            hookHeaders: headersForHook(catalogProvider?.authLogin?.headersHook, this.root),
        });
        resolved.unreadable = unreadable;
        if (unreadable) resolved.available = false;
        return resolved;
    }

    /**
     * Public (never raw-key) view of a stored config.
     * @param {Record<string, any>|null|undefined} config
     * @returns {Record<string, any>}
     */
    publicConfig(config) {
        if (!config) return {};
        return {
            id: config.id,
            label: config.label,
            adapter: config.adapter,
            baseUrl: config.baseUrl,
            custom: Boolean(config.custom),
            models: Array.isArray(config.models) ? config.models : [],
            hasKey: Boolean(config.apiKey),
            last4: typeof config.apiKey === 'string' ? config.apiKey.slice(-4) : '',
            updatedAt: config.updatedAt || 0,
        };
    }
}
