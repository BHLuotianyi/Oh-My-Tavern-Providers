#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_EXPECTATIONS, validateCatalog } from '../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = path.join(root, 'catalog/omtp-catalog.json');
const serverPath = path.join(root, 'server-plugin/catalog/omtp-catalog.json');
const keysPath = path.join(root, 'tools/native-adapter-keys.json');

// The plugin ships standalone, so it carries its own catalog copy; both must
// stay byte-identical (tools/build-catalog.mjs writes the same bytes to both).
const targets = process.argv[2] ? [path.resolve(process.argv[2])] : [clientPath, serverPath];

for (const file of [...targets, keysPath]) {
    if (!fs.existsSync(file)) {
        console.error(`[omtp] missing: ${file}`);
        process.exit(1);
    }
}

const adapterKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const errors = [];

if (!process.argv[2] && !fs.readFileSync(clientPath).equals(fs.readFileSync(serverPath))) {
    errors.push('catalog/omtp-catalog.json and server-plugin/catalog/omtp-catalog.json differ; run `npm run catalog`');
}

let providers = 0;
let models = 0;
for (const file of targets) {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = validateCatalog(catalog, {
        expectedProviders: CATALOG_EXPECTATIONS.providers,
        minModels: CATALOG_EXPECTATIONS.minModels,
        adapterKeys,
    });
    for (const error of result.errors) errors.push(`${path.relative(root, file)}: ${error}`);
    providers = result.providers;
    models = result.models;
}

if (errors.length) {
    console.error('[omtp] validation failed:');
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
}
console.log(`[omtp] valid: providers=${providers} models=${models} adapters=${adapterKeys.length}`);
