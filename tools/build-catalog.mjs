#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCatalog, validateCatalog } from '../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ompRoot = path.resolve(arg('omp-root', '/home/winster42/test/oh-my-pi'));
const outClient = path.resolve(arg('out-client', path.join(root, 'catalog/omtp-catalog.json')));
const outServer = path.resolve(arg('out-server', path.join(root, 'server-plugin/catalog/omtp-catalog.json')));

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
const result = validateCatalog(catalog, { expectedProviders: 99, minModels: 5700, adapterKeys });
if (!result.ok) {
  console.error('[omtp] catalog validation failed:');
  for (const error of result.errors) console.error(` - ${error}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outClient), { recursive: true });
fs.mkdirSync(path.dirname(outServer), { recursive: true });
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
fs.writeFileSync(outClient, serialized);
fs.writeFileSync(outServer, serialized);

console.log(`[omtp] providers=${result.providers} models=${result.models}`);
console.log(`[omtp] wrote ${path.relative(root, outClient)} and ${path.relative(root, outServer)}`);
