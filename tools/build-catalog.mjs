#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CATALOG_EXPECTATIONS, normalizeCatalog, validateCatalog } from '../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
    options: {
        'omp-root': { type: 'string' },
        'out-client': { type: 'string' },
        'out-server': { type: 'string' },
    },
});

const ompRoot = path.resolve(args['omp-root'] || path.join(os.homedir(), 'oh-my-pi'));
const outClient = path.resolve(args['out-client'] || path.join(root, 'catalog/omtp-catalog.json'));
const outServer = path.resolve(args['out-server'] || path.join(root, 'server-plugin/catalog/omtp-catalog.json'));

if (!fs.existsSync(ompRoot)) {
    console.error(`OMP root not found: ${ompRoot} (use --omp-root)`);
    process.exit(1);
}

const modelsPath = path.join(ompRoot, 'packages/catalog/src/models.json');
const rulesPath = path.join(ompRoot, 'packages/catalog/src/compat/rules.json');
const mapPath = path.join(root, 'tools/provider-map.source.json');
const keysPath = path.join(root, 'tools/native-adapter-keys.json');

for (const file of [modelsPath, rulesPath, mapPath, keysPath]) {
    if (!fs.existsSync(file)) {
        console.error(`[omtp] missing required input: ${file}`);
        process.exit(1);
    }
}

const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
const providerMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const adapterKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

const catalog = normalizeCatalog(models, rules, providerMap, { generatedAt: new Date().toISOString() });
const result = validateCatalog(catalog, {
    expectedProviders: CATALOG_EXPECTATIONS.providers,
    minModels: CATALOG_EXPECTATIONS.minModels,
    adapterKeys,
});
if (!result.ok) {
    console.error('[omtp] catalog validation failed:');
    for (const error of result.errors) console.error(` - ${error}`);
    process.exit(1);
}

function writeFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tempPath, content);
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
        throw error;
    }
}

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
writeFileAtomic(outClient, serialized);
writeFileAtomic(outServer, serialized);

console.log(`[omtp] providers=${result.providers} models=${result.models}`);
console.log(`[omtp] wrote ${path.relative(root, outClient)} and ${path.relative(root, outServer)}`);
