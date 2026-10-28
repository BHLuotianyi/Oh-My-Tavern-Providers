/**
 * Refresh `catalog/personality.json` from Artificial Analysis.
 *
 * Source: https://artificialanalysis.ai/evaluations/aa-personalitybench
 * The page is server-rendered (Next.js flight payload), so the per-model trait
 * scores are parsed straight out of the HTML — no API key involved. AA's free
 * API needs an account, and keys must not live in client-side code, so a
 * snapshot is the only sane option for an extension.
 *
 * AA publishes the eight index percentiles for a subset of models. The rest
 * expose the 30 trait z-scores; we derive the index percentile exactly as the
 * methodology describes (mean trait z-score per index, sycophantic inverted in
 * Transparency, percentile ranked across every evaluated model). Every run
 * prints published-vs-derived deltas so a regression is visible.
 *
 *   node tools/fetch-personality.mjs            # refresh the snapshot
 *   node tools/fetch-personality.mjs --verify   # only check the derivation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://artificialanalysis.ai/evaluations/aa-personalitybench';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'catalog', 'personality.json');
const CACHE_FILE = path.join(ROOT, '.cache', 'aa-personalitybench.html');

/** Index → traits, in AA's published order. */
const INDEXES = {
    expressiveness: ['lexicallyVaried', 'eloquent', 'literate', 'naturalSounding', 'metaphorical'],
    organization: ['structured', 'scannable', 'summarizesBottomLine', 'answerFirst'],
    informativeness: ['informationDense', 'evidenceBased', 'resourceSpecific', 'providesActionableGuidance', 'pragmatic'],
    transparency: ['truthful', 'admitsUncertainty', 'disclaimsWithAssumptions', 'flagsNuances', 'sycophantic'],
    warmth: ['friendly', 'humorous', 'sincere', 'emotionallyIntelligent'],
    conviction: ['direct', 'confident', 'opinionated', 'constructivelyPushesBack'],
    imagination: ['creative', 'openEnded'],
    slop: ['slop'],
};

/** Traits scored in the opposite direction (more is not "more of the index"). */
const INVERTED = new Set(['transparency:sycophantic']);

const INDEX_KEYS = Object.keys(INDEXES);

/** @param {number[]} values */
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Decode the Next.js flight payload out of the page HTML.
 * @param {string} html
 * @returns {string}
 */
function flightPayload(html) {
    const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
        .map((match) => {
            try {
                return JSON.parse(match[1]);
            } catch {
                return '';
            }
        });
    return chunks.join('');
}

/**
 * Index just past the JSON object that opens at `start`, or -1 if truncated.
 * @param {string} payload
 * @param {number} start
 * @returns {number}
 */
function matchObjectEnd(payload, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < payload.length; i++) {
        const char = payload[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

/**
 * Every model record that carries trait data.
 * @param {string} payload
 */
function extractModels(payload) {
    /** @type {any[]} */
    const out = [];
    const re = /\{"(?:id|slug)":/g;
    let match;
    while ((match = re.exec(payload))) {
        const start = match.index;
        const end = matchObjectEnd(payload, start);
        if (end < 0) break;
        re.lastIndex = end;
        const chunk = payload.slice(start, end);
        if (!chunk.includes('zScores')) continue;
        try {
            const record = JSON.parse(chunk);
            if (record.slug && (record.judged?.zScores || record.zScores)) out.push(record);
        } catch {
            // Not a model record (truncated or unrelated object).
        }
    }
    return out;
}

/**
 * Mean trait z-score per index.
 * @param {Record<string, number>} zScores
 */
function indexZScores(zScores) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [index, traits] of Object.entries(INDEXES)) {
        out[index] = mean(traits.map((trait) => {
            const value = Number(zScores[trait] ?? 0);
            return INVERTED.has(`${index}:${trait}`) ? -value : value;
        }));
    }
    return out;
}

/**
 * Percentile rank (0-100) of every row along one key.
 * @param {any[]} rows
 * @param {(row: any) => number} keyFn
 * @param {(row: any, percentile: number) => void} assign
 */
function rankBy(rows, keyFn, assign) {
    const sorted = [...rows].sort((a, b) => keyFn(a) - keyFn(b));
    sorted.forEach((row, position) => assign(row, (position / (sorted.length - 1)) * 100));
}

/**
 * @returns {Promise<string>} page HTML
 */
async function loadPage() {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    try {
        const response = await fetch(SOURCE_URL, { headers: { 'user-agent': 'omtp-personality-fetch/1.0' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        fs.writeFileSync(CACHE_FILE, html);
        return html;
    } catch (error) {
        if (fs.existsSync(CACHE_FILE)) {
            console.warn(`[personality] fetch failed (${error.message}); using cached page`);
            return fs.readFileSync(CACHE_FILE, 'utf8');
        }
        throw error;
    }
}

/**
 * One row per evaluated model: AA's published indexes plus derived percentiles.
 * @param {string} html
 */
function buildRows(html) {
    const records = extractModels(flightPayload(html));
    if (!records.length) {
        throw new Error('no personality records found — the page layout probably changed');
    }

    /** @type {Map<string, any>} */
    const bySlug = new Map();
    for (const record of records) {
        const previous = bySlug.get(record.slug);
        // Prefer the record AA published index percentiles for.
        if (!previous || (record.judged?.indexScores && !previous.judged?.indexScores)) {
            bySlug.set(record.slug, record);
        }
    }

    const rows = [...bySlug.values()].map((record) => ({
        slug: record.slug,
        name: record.name,
        creator: record.creator?.name || '',
        published: record.judged?.indexScores || null,
        z: indexZScores(record.judged?.zScores || record.zScores),
        derived: {},
        traits: {},
        raw: record.judged?.zScores || record.zScores,
    }));
    for (const index of INDEX_KEYS) {
        rankBy(rows, (row) => row.z[index], (row, percentile) => {
            row.derived[index] = percentile;
        });
    }
    // Trait percentiles let the roleplay score weigh a single trait (e.g.
    // sycophancy) on its own.
    rankBy(rows, (row) => row.raw?.sycophantic ?? 0, (row, percentile) => {
        row.traits.sycophantic = percentile;
    });
    return rows;
}

/**
 * Compare the derived percentiles with AA's published values.
 * @param {any[]} rows
 */
function verifyPublished(rows) {
    let checked = 0;
    let worstDelta = 0;
    const deltas = [];
    for (const row of rows) {
        if (!row.published) continue;
        for (const index of INDEX_KEYS) {
            const delta = Math.abs(row.published[index] - row.derived[index]);
            checked++;
            worstDelta = Math.max(worstDelta, delta);
            if (delta > 1.5) deltas.push(`${row.slug} ${index}: published ${row.published[index].toFixed(1)} vs derived ${row.derived[index].toFixed(1)}`);
        }
    }
    console.log(`[personality] models=${rows.length} published=${rows.filter((r) => r.published).length} checked=${checked} worstDelta=${worstDelta.toFixed(2)}`);
    if (deltas.length) {
        console.warn('[personality] derivation drifted from published values:\n  ' + deltas.join('\n  '));
    }
}

/**
 * Write `catalog/personality.json` from the ranked rows.
 * @param {any[]} rows
 */
function writeSnapshot(rows) {
    /** @type {Record<string, any>} */
    const models = {};
    for (const row of rows) {
        const scores = {};
        for (const index of INDEX_KEYS) {
            const value = row.published ? row.published[index] : row.derived[index];
            scores[index] = Math.round(value * 10) / 10;
        }
        const traits = {};
        for (const [trait, value] of Object.entries(row.traits)) {
            traits[trait] = Math.round(value * 10) / 10;
        }
        models[row.slug] = {
            name: row.name,
            creator: row.creator,
            published: Boolean(row.published),
            mean: Math.round(mean(INDEX_KEYS.map((index) => scores[index])) * 10) / 10,
            scores,
            ...(Object.keys(traits).length ? { traits } : {}),
        };
    }

    const payload = {
        schemaVersion: 1,
        source: SOURCE_URL,
        attribution: 'Artificial Analysis — AA-PersonalityBench',
        method: 'Personality indexes are percentiles (1-100) across every model AA evaluated; models without published indexes are derived from the 30 trait z-scores using AA\'s documented aggregation. Trait percentiles cover the same 41 models.',
        fetchedAt: new Date().toISOString().slice(0, 10),
        indexes: INDEX_KEYS,
        models,
    };
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[personality] wrote ${path.relative(ROOT, OUT_FILE)} (${Object.keys(models).length} models)`);
}

async function main() {
    const rows = buildRows(await loadPage());
    verifyPublished(rows);
    if (process.argv.includes('--verify')) return;
    writeSnapshot(rows);
}

await main();
