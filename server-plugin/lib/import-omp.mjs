import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import util from 'node:util';
import { normalizeCatalog, validateCatalog } from './catalog-normalize.mjs';
import { IMPORTED_CATALOG_FILE, getOmtpRoot, omtpPath, writeJsonAtomic } from './config.mjs';
import { stripCatalogCredentials } from './catalog-normalize.mjs';
import { providerMapFromCatalog } from './catalog-service.mjs';
import { logError } from './redact.mjs';
import { OAUTH_PROVIDERS } from './oauth.mjs';

const execFileAsync = util.promisify(child_process.execFile);
const AUTH_QUERY = "SELECT provider, credential_type, data FROM auth_credentials WHERE credential_type IN ('api_key', 'oauth') AND disabled_cause IS NULL";

async function queryAuthCredentialsFallback(dbPath) {
    try {
        const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, AUTH_QUERY], { timeout: 10000 });
        const parsed = JSON.parse(stdout || '[]');
        if (Array.isArray(parsed)) return parsed;
    } catch {
        // Fall through to python.
    }

    for (const py of ['python3', 'python']) {
        try {
            const script = 'import sqlite3, json, sys\nconn = sqlite3.connect(sys.argv[1])\nconn.row_factory = sqlite3.Row\nc = conn.cursor()\nc.execute(sys.argv[2])\nrows = [dict(r) for r in c.fetchall()]\nprint(json.dumps(rows))';
            const { stdout } = await execFileAsync(py, ['-c', script, dbPath, AUTH_QUERY], { timeout: 10000 });
            const parsed = JSON.parse(stdout || '[]');
            if (Array.isArray(parsed)) return parsed;
        } catch {
            // Try next binary.
        }
    }

    return null;
}
export const DEFAULT_OMP_ROOT = '/home/winster42/test/oh-my-pi';

/**
 * @param {string} candidate
 * @returns {Promise<{modelsPath:string, rulesPath:string}|null>}
 */
async function resolveCatalogPaths(candidate) {
    if (!candidate) return null;
    const resolved = path.resolve(String(candidate).replace(/^~(?=$|\/)/, os.homedir()));
    /** @type {Array<{modelsPath:string, rulesPath:string}>} */
    const options = [];
    if (path.basename(resolved) === 'models.json') {
        const directory = path.dirname(resolved);
        options.push({ modelsPath: resolved, rulesPath: path.join(directory, 'compat', 'rules.json') });
        options.push({ modelsPath: resolved, rulesPath: path.join(directory, 'rules.json') });
    }
    options.push({
        modelsPath: path.join(resolved, 'packages', 'catalog', 'src', 'models.json'),
        rulesPath: path.join(resolved, 'packages', 'catalog', 'src', 'compat', 'rules.json'),
    });
    options.push({
        modelsPath: path.join(resolved, 'models.json'),
        rulesPath: path.join(resolved, 'rules.json'),
    });
    for (const option of options) {
        try {
            const [modelsStat, rulesStat] = await Promise.all([
                fs.promises.stat(option.modelsPath),
                fs.promises.stat(option.rulesPath),
            ]);
            if (modelsStat.isFile() && rulesStat.isFile()) return option;
        } catch {
            // Try the next layout.
        }
    }
    return null;
}

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJson(file) {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

/**
 * Import stored credentials from an OMP agent database: API keys and OAuth
 * sessions for providers the gateway knows how to drive. Disabled rows are
 * skipped. The `omp` binary is never executed.
 *
 * @param {{keyStore:any, homeDir?:string}} options
 * @returns {Promise<{available:boolean, imported:number, providers:string[], error?:string}>}
 */
export async function importOmpCredentials({ keyStore, homeDir = os.homedir(), _forceFallback = false }) {
    const dbPath = path.join(homeDir, '.omp', 'agent', 'agent.db');
    try {
        const stat = await fs.promises.stat(dbPath);
        if (!stat.isFile()) return { available: false, imported: 0, providers: [] };
    } catch {
        return { available: false, imported: 0, providers: [] };
    }

    /** @type {any[]} */
    let rows = [];
    /** @type {any} */
    let db = null;
    try {
        let sqlite = null;
        try {
            sqlite = await import('node:sqlite');
        } catch {
            sqlite = null;
        }

        if (!_forceFallback && sqlite && typeof sqlite.DatabaseSync === 'function') {
            db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            rows = db.prepare(AUTH_QUERY).all();
        } else {
            const fallbackRows = await queryAuthCredentialsFallback(dbPath);
            if (fallbackRows === null) {
                return { available: false, imported: 0, providers: [], error: 'SQLite reader unavailable (node:sqlite, sqlite3 CLI, or python3 required)' };
            }
            rows = fallbackRows;
        }
        const imported = new Set();
        for (const row of rows) {
            const provider = String(row.provider || '');
            if (!provider) continue;
            let parsed;
            try {
                parsed = JSON.parse(String(row.data || ''));
            } catch {
                continue;
            }
            if (row.credential_type === 'oauth') {
                if (!Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, provider)) continue;
                const access = parsed?.access ?? parsed?.token ?? parsed?.accessToken;
                if (typeof access !== 'string' || !access.trim()) continue;
                await keyStore.setProviderConfig(provider, { apiKey: JSON.stringify({ type: 'oauth', ...parsed }) });
                imported.add(provider);
                continue;
            }
            const key = typeof parsed?.key === 'string' ? parsed.key : typeof parsed?.apiKey === 'string' ? parsed.apiKey : '';
            if (!key.trim()) continue;
            await keyStore.setProviderConfig(provider, { apiKey: key.trim() });
            imported.add(provider);
        }
        return { available: true, imported: imported.size, providers: [...imported].sort() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('failed to import OMP credentials', error);
        return { available: true, imported: 0, providers: [], error: message };
    } finally {
        try {
            db?.close?.();
        } catch {
            // Ignore close failures.
        }
    }
}

/**
 * Import catalog data (and optionally credentials) from a local OMP checkout.
 * Writes `<DATA_ROOT>/omtp/imported-catalog.json`; never touches bundled/cached files.
 *
 * @param {{
 *   catalogPath?: string,
 *   credentials?: boolean,
 *   keyStore?: any,
 *   bundledCatalog?: any,
 *   root?: string,
 *   homeDir?: string,
 * }} [options]
 * @returns {Promise<any>}
 */
export async function importFromOmp(options = {}) {
    const root = options.root || getOmtpRoot();
    const requestedPath = options.catalogPath ? String(options.catalogPath).trim() : '';
    const candidates = requestedPath ? [requestedPath] : [DEFAULT_OMP_ROOT, path.join(os.homedir(), 'oh-my-pi')];

    /** @type {{modelsPath:string, rulesPath:string}|null} */
    let paths = null;
    for (const candidate of candidates) {
        paths = await resolveCatalogPaths(candidate);
        if (paths) break;
    }

    /** @type {any} */
    const result = {
        found: Boolean(paths),
        providers: 0,
        models: 0,
        credentials: 0,
        catalogPath: paths?.modelsPath || null,
    };

    if (paths) {
        try {
            const [models, rules] = await Promise.all([readJson(paths.modelsPath), readJson(paths.rulesPath)]);
            const providerMap = providerMapFromCatalog(options.bundledCatalog || null);
            const catalog = normalizeCatalog(models, rules, providerMap);
            const validation = validateCatalog(catalog, { expectedProviders: 0, minModels: 0 });
            if (!validation.ok) {
                result.error = `Imported catalog failed validation: ${validation.errors.slice(0, 5).join('; ')}`;
                result.found = false;
                return result;
            }
            await writeJsonAtomic(omtpPath(root, IMPORTED_CATALOG_FILE), {
                ...catalog,
                providers: stripCatalogCredentials(catalog.providers),
            });
            result.providers = validation.providers;
            result.models = validation.models;
        } catch (error) {
            result.found = false;
            result.error = error instanceof Error ? error.message : String(error);
            logError('failed to import local OMP catalog', error);
            return result;
        }
    }

    if (options.credentials) {
        if (!options.keyStore) {
            result.credentialError = 'Key store unavailable';
        } else {
            const credentials = await importOmpCredentials({ keyStore: options.keyStore, homeDir: options.homeDir });
            result.credentials = credentials.imported;
            result.credentialsAvailable = credentials.available;
            result.credentialProviders = credentials.providers;
            if (credentials.error) result.credentialError = credentials.error;
        }
    }

    return result;
}
