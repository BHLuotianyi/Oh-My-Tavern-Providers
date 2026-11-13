#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_EXPECTATIONS, validateCatalog } from '../server-plugin/lib/catalog-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = path.join(root, 'catalog/omtp-catalog.json');
const serverPath = path.join(root, 'server-plugin/catalog/omtp-catalog.json');
const keysPath = path.join(root, 'tools/native-adapter-keys.json');
const mapPath = path.join(root, 'tools/provider-map.source.json');
const personalityPath = path.join(root, 'catalog/personality.json');

// The plugin ships standalone, so it carries its own catalog copy; both must
// stay byte-identical (tools/build-catalog.mjs writes the same bytes to both).
const singleTarget = Boolean(process.argv[2]);
const targets = singleTarget ? [path.resolve(process.argv[2])] : [clientPath, serverPath];
const requiredFiles = [...targets, keysPath, mapPath, ...(singleTarget ? [] : [personalityPath])];

for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
        console.error(`[omtp] missing: ${file}`);
        process.exit(1);
    }
}

function validateProviderMapSync(catalog, providerMap, label, outErrors) {
    const providers = catalog?.providers || {};
    for (const [id, src] of Object.entries(providerMap.omtpProviders || {})) {
        const provider = providers[id];
        if (!provider) {
            outErrors.push(`${label}: missing omtpProvider ${id} from provider-map.source.json (run \`npm run catalog\`)`);
            continue;
        }
        if ((provider.baseUrl || '') !== (src.baseUrl || '')) {
            outErrors.push(`${label}: ${id} baseUrl differs from provider-map.source.json (run \`npm run catalog\`)`);
        }
        if (provider.gatewayAdapter !== src.gatewayAdapter) {
            outErrors.push(`${label}: ${id} gatewayAdapter differs from provider-map.source.json (run \`npm run catalog\`)`);
        }
        if (Boolean(provider.singleMaxTokens) !== (src.singleMaxTokens === true)) {
            outErrors.push(`${label}: ${id} singleMaxTokens differs from provider-map.source.json (run \`npm run catalog\`)`);
        }
        const expectedIds = new Set((src.models || []).map((m) => m.id));
        const actualIds = new Set((provider.models || []).map((m) => m.id));
        const modelsMatch = expectedIds.size === actualIds.size
            && [...expectedIds].every((modelId) => actualIds.has(modelId));
        if (!modelsMatch) {
            outErrors.push(`${label}: ${id} models differ from provider-map.source.json (run \`npm run catalog\`)`);
        }
    }
    for (const [id, exc] of Object.entries(providerMap.exceptions || {})) {
        const provider = providers[id];
        if (!provider) continue;
        if ((provider.stAdapter ?? null) !== (exc.stAdapter ?? null)) {
            outErrors.push(`${label}: ${id} stAdapter differs from provider-map.source.json (run \`npm run catalog\`)`);
        }
        if (exc.gatewayAdapter !== undefined && (provider.gatewayAdapter ?? null) !== (exc.gatewayAdapter ?? null)) {
            outErrors.push(`${label}: ${id} gatewayAdapter differs from provider-map.source.json (run \`npm run catalog\`)`);
        }
    }
}

function validatePersonality(personality, label, outErrors) {
    if (!personality || personality.schemaVersion !== 1) {
        outErrors.push(`${label}: schemaVersion must be 1`);
        return;
    }
    const indexes = personality.indexes;
    if (!Array.isArray(indexes) || indexes.length === 0 || indexes.some((idx) => typeof idx !== 'string' || !idx)) {
        outErrors.push(`${label}: indexes must be a non-empty array of strings`);
        return;
    }
    const indexSet = new Set(indexes);
    if (indexSet.size !== indexes.length) {
        outErrors.push(`${label}: duplicate entries in indexes`);
    }
    if (!personality.models || typeof personality.models !== 'object' || Array.isArray(personality.models)) {
        outErrors.push(`${label}: models must be an object`);
        return;
    }
    const entries = Object.entries(personality.models);
    if (entries.length === 0) {
        outErrors.push(`${label}: models must not be empty`);
        return;
    }
    for (const [slug, entry] of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            outErrors.push(`${label}: ${slug} must be an object`);
            continue;
        }
        if (typeof entry.mean !== 'number' || !Number.isFinite(entry.mean) || entry.mean < 0 || entry.mean > 100) {
            outErrors.push(`${label}: ${slug} mean must be a finite number in [0, 100]`);
        }
        if (!entry.scores || typeof entry.scores !== 'object' || Array.isArray(entry.scores)) {
            outErrors.push(`${label}: ${slug} scores must be an object`);
            continue;
        }
        for (const index of indexes) {
            const score = entry.scores[index];
            if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
                outErrors.push(`${label}: ${slug}.scores.${index} must be a finite number in [0, 100]`);
            }
        }
        for (const key of Object.keys(entry.scores)) {
            if (!indexSet.has(key)) {
                outErrors.push(`${label}: ${slug}.scores has unexpected key ${key}`);
            }
        }
        if (entry.traits !== undefined) {
            if (!entry.traits || typeof entry.traits !== 'object' || Array.isArray(entry.traits)) {
                outErrors.push(`${label}: ${slug}.traits must be an object`);
            } else {
                for (const [trait, value] of Object.entries(entry.traits)) {
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
                        outErrors.push(`${label}: ${slug}.traits.${trait} must be a finite number in [0, 100]`);
                    }
                }
            }
        }
    }
}

const adapterKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const providerMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const errors = [];

if (!singleTarget && !fs.readFileSync(clientPath).equals(fs.readFileSync(serverPath))) {
    errors.push('catalog/omtp-catalog.json and server-plugin/catalog/omtp-catalog.json differ; run `npm run catalog`');
}

let providers = 0;
let models = 0;
for (const file of targets) {
    const label = path.relative(root, file);
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = validateCatalog(catalog, {
        expectedProviders: CATALOG_EXPECTATIONS.providers,
        minModels: CATALOG_EXPECTATIONS.minModels,
        adapterKeys,
    });
    for (const error of result.errors) errors.push(`${label}: ${error}`);
    validateProviderMapSync(catalog, providerMap, label, errors);
    providers = result.providers;
    models = result.models;
}

let personalityCount = 0;
if (!singleTarget) {
    const personality = JSON.parse(fs.readFileSync(personalityPath, 'utf8'));
    validatePersonality(personality, path.relative(root, personalityPath), errors);
    personalityCount = Object.keys(personality?.models || {}).length;
}

if (errors.length) {
    console.error('[omtp] validation failed:');
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
}
const suffix = singleTarget ? '' : ` personality=${personalityCount}`;
console.log(`[omtp] valid: providers=${providers} models=${models} adapters=${adapterKeys.length}${suffix}`);
