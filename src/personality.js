/**
 * AA-PersonalityBench scores for the model hub.
 *
 * The snapshot is built by `tools/fetch-personality.mjs` from Artificial
 * Analysis' public evaluation page (their free API needs an account and must
 * not be called from client code). Scores are percentiles 1-100 per index.
 */
import { matchPersonalityKey, normalizeName } from './personality-match.js';
import { tr, trf } from './ui/dom.js';

/** Public page this snapshot is built from. */
export const AA_PERSONALITY_URL = 'https://artificialanalysis.ai/evaluations/aa-personalitybench';

/** Dimensions in AA's published order. */
export const PERSONALITY_INDEXES = Object.freeze([
    'expressiveness',
    'organization',
    'informativeness',
    'transparency',
    'warmth',
    'conviction',
    'imagination',
    'slop',
]);

/** @type {any|null} */
let dataset = null;
/** @type {Promise<any>|null} */
let loading = null;
/** @type {Map<string, any>} */
const byNormalized = new Map();

/**
 * Load the bundled snapshot once.
 * @returns {Promise<any|null>}
 */
export function loadPersonality() {
    if (dataset) {
        return Promise.resolve(dataset);
    }
    if (!loading) {
        const url = new URL('../catalog/personality.json', import.meta.url);
        loading = fetch(url)
            .then((response) => (response.ok ? response.json() : null))
            .then((json) => {
                if (!json?.models) {
                    return null;
                }
                for (const [slug, record] of Object.entries(json.models)) {
                    byNormalized.set(slug, record);
                    const fromName = normalizeName(record.name);
                    if (fromName && !byNormalized.has(fromName)) {
                        byNormalized.set(fromName, record);
                    }
                }
                dataset = json;
                return json;
            })
            .catch(() => null)
            .finally(() => {
                loading = null;
            });
    }
    return loading;
}

/**
 * Look up a model's personality record.
 * @param {{model?: string, modelLabel?: string}|null} entry
 * @returns {{slug: string, record: any}|null}
 */
export function personalityFor(entry) {
    if (!dataset || !entry) {
        return null;
    }
    const slug = matchPersonalityKey(entry, byNormalized.keys());
    if (!slug) {
        return null;
    }
    const record = byNormalized.get(slug);
    return record ? { slug, record } : null;
}

/**
 * Weights for the roleplay/creative score.
 *
 * AA's index average treats every axis as equally useful, which is a poor fit
 * for prose and character work: organization, information density and
 * conviction matter less, a little slop is tolerable, and transparency only
 * matters through its "not sycophantic" half — so that trait gets its own
 * weight on top of the (smaller) transparency axis.
 */
const RP_WEIGHTS = Object.freeze({
    imagination: 0.26,
    warmth: 0.20,
    expressiveness: 0.18,
    antiSycophancy: 0.14,
    transparency: 0.07,
    conviction: 0.06,
    informativeness: 0.05,
    organization: 0.04,
});

/** Slop is penalised, but only lightly. */
const RP_SLOP_PENALTY = 0.08;

/**
 * Roleplay/creative score (0-100) derived from the personality indexes plus
 * the sycophancy trait percentile.
 * @param {any} record
 * @returns {number}
 */
export function roleplayScore(record) {
    const s = record?.scores || {};
    const sycophancy = Number(record?.traits?.sycophantic ?? 50);
    const parts = {
        imagination: s.imagination ?? 0,
        warmth: s.warmth ?? 0,
        expressiveness: s.expressiveness ?? 0,
        antiSycophancy: 100 - sycophancy,
        transparency: s.transparency ?? 0,
        conviction: s.conviction ?? 0,
        informativeness: s.informativeness ?? 0,
        organization: s.organization ?? 0,
    };
    let score = 0;
    for (const [key, weight] of Object.entries(RP_WEIGHTS)) {
        score += weight * parts[key];
    }
    score -= RP_SLOP_PENALTY * Number(s.slop ?? 0);
    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Short badge label for a model row, e.g. `AA 59`.
 * @param {any} record
 * @returns {string}
 */
export function personalityBadge(record) {
    return trf('omtp_pb_badge', 'AA ${0}', Math.round(record.mean));
}

/**
 * Badge label for the roleplay/creative score, e.g. `OMTP 62`.
 * @param {any} record
 * @returns {string}
 */
export function roleplayBadge(record) {
    return trf('omtp_rp_badge', 'OMTP ${0}', roleplayScore(record));
}

/**
 * Tooltip explaining how the roleplay score is weighted.
 * @param {any} record
 * @returns {string}
 */
export function roleplayTooltip(record) {
    return [
        trf('omtp_rp_title', 'Roleplay / creative score ${0}', roleplayScore(record)),
        tr('omtp_rp_formula', 'Weights: imagination 26% · warmth 20% · expressiveness 18% · non-sycophancy 14% · transparency 7% · conviction 6% · informativeness 5% · organization 4% · slop −8%'),
        tr('omtp_pb_attribution', 'Data: Artificial Analysis'),
    ].join('\n');
}

/**
 * Tooltip listing every index value.
 * @param {any} record
 * @returns {string}
 */
export function personalityTooltip(record) {
    const lines = PERSONALITY_INDEXES.map((index) => `${indexLabel(index)}: ${Math.round(record.scores[index] ?? 0)}`);
    return [
        tr('omtp_pb_title', 'AA-PersonalityBench'),
        ...lines,
        trf('omtp_pb_mean', 'Mean index ${0}', Math.round(record.mean)),
        record.published ? '' : tr('omtp_pb_derived', 'Indexes derived from AA trait z-scores'),
        tr('omtp_pb_attribution', 'Data: Artificial Analysis'),
    ].filter(Boolean).join('\n');
}

/**
 * Translated dimension name.
 * @param {string} index
 * @returns {string}
 */
export function indexLabel(index) {
    const fallback = index.charAt(0).toUpperCase() + index.slice(1);
    return tr(`omtp_pb_${index}`, fallback);
}

/**
 * Abbreviated dimension name for the radar axes.
 * @param {string} index
 * @returns {string}
 */
function indexShortLabel(index) {
    const fallback = index.slice(0, 4).replace(/^./, (c) => c.toUpperCase());
    return tr(`omtp_pb_${index}_short`, fallback);
}

/**
 * Text anchor for a radar axis label at horizontal offset `dx`.
 * @param {number} dx
 * @returns {'middle'|'start'|'end'}
 */
function labelAnchor(dx) {
    if (Math.abs(dx) < 0.2) {
        return 'middle';
    }
    return dx > 0 ? 'start' : 'end';
}

/**
 * Build the radar chart markup for a record.
 * @param {any} record
 * @param {{size?: number}} [options]
 * @returns {string} SVG markup
 */
export function personalityRadarSvg(record, { size = 236 } = {}) {
    const count = PERSONALITY_INDEXES.length;
    const centre = size / 2;
    const radius = size / 2 - 38;
    const angle = (i) => (Math.PI * 2 * i) / count - Math.PI / 2;
    const point = (i, value) => {
        const r = (Math.max(0, Math.min(100, value)) / 100) * radius;
        return [centre + Math.cos(angle(i)) * r, centre + Math.sin(angle(i)) * r];
    };
    const polygon = (values) => values
        .map((value, i) => point(i, value).map((n) => n.toFixed(1)).join(','))
        .join(' ');

    const rings = [25, 50, 75, 100].map((level) => (
        `<polygon points="${polygon(PERSONALITY_INDEXES.map(() => level))}" fill="none" stroke="currentColor" stroke-opacity="${level === 100 ? 0.45 : 0.16}" stroke-width="1"/>`
    )).join('');
    const spokes = PERSONALITY_INDEXES.map((_, i) => {
        const [x, y] = point(i, 100);
        return `<line x1="${centre}" y1="${centre}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.16" stroke-width="1"/>`;
    }).join('');
    const shape = PERSONALITY_INDEXES.map((index) => Number(record.scores[index] ?? 0));
    const labels = PERSONALITY_INDEXES.map((index, i) => {
        const [x, y] = point(i, 100);
        const dx = Math.cos(angle(i));
        const dy = Math.sin(angle(i));
        const anchor = labelAnchor(dx);
        const lx = x + dx * 8;
        const ly = y + dy * 8 + 3;
        return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="8.5" fill="currentColor" fill-opacity="0.8">${escapeXml(indexShortLabel(index))}</text>`;
    }).join('');

    return [
        `<svg class="omtp-pb-radar" viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px;height:auto" role="img" aria-label="${escapeXml(tr('omtp_pb_title', 'AA-PersonalityBench'))}">`,
        rings,
        spokes,
        `<polygon points="${polygon(shape)}" fill="var(--SmartThemeQuoteColor, #7aa2f7)" fill-opacity="0.22" stroke="var(--SmartThemeQuoteColor, #7aa2f7)" stroke-width="1.6"/>`,
        shape.map((value, i) => {
            const [x, y] = point(i, value);
            return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="var(--SmartThemeQuoteColor, #7aa2f7)"/>`;
        }).join(''),
        labels,
        '</svg>',
    ].join('');
}

/** @param {string} value */
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
