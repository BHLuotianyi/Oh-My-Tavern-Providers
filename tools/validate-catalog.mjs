#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.resolve(process.argv[2] || path.join(root, 'catalog/omtp-catalog.json'));
const keysPath = path.join(root, 'tools/native-adapter-keys.json');
const mapPath = path.join(root, 'tools/provider-map.source.json');

for (const file of [catalogPath, keysPath, mapPath]) {
  if (!fs.existsSync(file)) {
    console.error(`[omtp] missing: ${file}`);
    process.exit(1);
  }
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const adapterKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const result = validateCatalog(catalog, { expectedProviders: 99, minModels: 5700, adapterKeys });
const errors = [...result.errors];
const catalogIds = new Set(Object.keys(catalog.providers || {}));
for (const id of catalogIds) {
  if (!map.exceptions?.[id] && !map.remainingGatewayAdapter) errors.push(`${id}: no provider-map entry and no remaining rule`);
}
if (errors.length) {
  console.error('[omtp] validation failed:');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log(`[omtp] valid: providers=${result.providers} models=${result.models} adapters=${adapterKeys.length}`);
