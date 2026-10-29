/**
 * About panel — identity, licence and runtime facts for the hub.
 *
 * Everything shown here is read at open time: the extension manifest (version,
 * author), the plugin's `/status` (gateway + catalog) and SillyTavern's own
 * version. Nothing is hard-coded except the licence, which is a property of the
 * source tree rather than of the running process.
 */
import { API_BASE } from '../constants.js';
import { tr, trf } from './dom.js';
import { el } from './helpers.js';

const LICENSE = 'GPL-3.0';
const LICENSE_URL = 'https://www.gnu.org/licenses/gpl-3.0.html';
const AUTHOR = 'BHLuotianyi';
const OMP_URL = 'https://github.com/can1357/oh-my-pi';

/** @type {HTMLElement|null} */
let host = null;

/** @param {HTMLElement} parent @param {string} label @param {Node|string} value */
function fact(parent, label, value) {
    const row = el('div', 'omtp-about-fact');
    row.append(el('span', 'omtp-about-fact-label', label));
    const cell = el('span', 'omtp-about-fact-value');
    cell.append(typeof value === 'string' ? document.createTextNode(value) : value);
    row.append(cell);
    parent.append(row);
    return row;
}

function link(href, text) {
    const anchor = el('a', null, text);
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
}

function section(title, body) {
    const node = el('section', 'omtp-about-section');
    node.append(el('h4', null, title));
    if (typeof body === 'string') node.append(el('p', null, body));
    else node.append(body);
    return node;
}

function list(items) {
    const ul = el('ul', 'omtp-about-list');
    for (const item of items) ul.append(el('li', null, item));
    return ul;
}

/** Reduce "SillyTavern 1.19.0 'release' (06bde93)" to "1.19.0". */
function shortVersion(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return '';
    const match = text.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : text;
}

/**
 * Render a version for display: never double the `v` prefix, since the
 * manifest ships `v1.2.3_beta_…` while the server package ships plain semver.
 * @param {unknown} value
 * @returns {string}
 */
function versionLabel(value) {
    const text = String(value ?? '').trim();
    if (!text || text === '—') return 'v—';
    return /^v/i.test(text) ? text : `v${text}`;
}

/** SillyTavern's own version, from whichever source is available. */
function sillyTavernVersion() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const version = shortVersion(ctx?.version || ctx?.VERSION);
        if (version) return version;
    } catch {
        // fall through to the DOM
    }
    const node = document.querySelector('#version_display, .version_display, #version');
    return shortVersion(node?.textContent) || '—';
}

/** @returns {Promise<{extension: any, status: any}>} */
async function loadFacts() {
    const facts = { extension: {}, status: null };
    try {
        const response = await fetch(new URL('../../manifest.json', import.meta.url), { cache: 'no-store' });
        if (response.ok) facts.extension = await response.json();
    } catch (error) {
        console.warn('[omtp] could not read the extension manifest', error);
    }
    try {
        const response = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) facts.status = await response.json();
    } catch (error) {
        console.warn('[omtp] could not read gateway status', error);
    }
    return facts;
}

function gatewayValue(status) {
    const gateway = status?.gateway || null;
    if (!gateway) return tr('omtp_about_gateway_stopped', 'Not running');
    if (gateway.running || gateway.listening) {
        return trf('omtp_about_gateway_running', 'Running at ${0}', gateway.url || API_BASE);
    }
    return gateway.lastError
        ? trf('omtp_about_gateway_failed', 'Stopped (${0})', gateway.lastError)
        : tr('omtp_about_gateway_stopped', 'Not running');
}

function catalogValue(status) {
    const catalog = status?.catalog;
    if (!catalog) return '—';
    const generated = catalog.generatedAt ? String(catalog.generatedAt).slice(0, 10) : '—';
    return trf(
        'omtp_about_catalog_value',
        '${0} models · ${1} providers · ${2}',
        catalog.models ?? '—',
        catalog.providers ?? '—',
        generated,
    );
}

/** @param {HTMLElement} container */
export async function mountAboutPanel(container) {
    host = container;
    const facts = await loadFacts();
    if (host !== container) return;

    const root = el('div', 'omtp-about');

    const hero = el('div', 'omtp-about-hero');
    hero.append(el('h3', 'omtp-about-name', tr('omtp_about_name', 'Oh My Tavern Providers')));
    const chips = el('div', 'omtp-about-chips');
    chips.append(el('span', 'omtp-about-chip', versionLabel(facts.extension.version)));
    chips.append(el('span', 'omtp-about-chip omtp-about-chip-license', LICENSE));
    hero.append(chips);
    hero.append(el('p', 'omtp-about-tagline', tr(
        'omtp_about_tagline',
        'Model hub and OpenAI-compatible gateway for SillyTavern — providers, models, reasoning effort and token accounting in one place.',
    )));
    hero.append(el('p', 'omtp-about-project', tr(
        'omtp_about_project',
        'This project is a part of SpaghettiTavern Saving Plan',
    )));
    root.append(hero);

    // The reference project sits above the facts: it shaped this whole extension.
    const omp = el('div', 'omtp-about-omp');
    omp.append(el('div', 'omtp-about-omp-label', tr('omtp_about_omp_label', 'Reference project')));
    const ompTitle = el('div', 'omtp-about-omp-title');
    ompTitle.append(link(OMP_URL, tr('omtp_about_omp_name', 'OMP (oh-my-pi)')));
    ompTitle.append(el('span', 'omtp-about-chip omtp-about-omp-chip', 'MIT'));
    omp.append(ompTitle);
    omp.append(el('p', 'omtp-about-omp-body', tr(
        'omtp_about_omp_body',
        'The gateway, the sign-in flow, the usage pages and the stats dashboard follow OMP\'s design and commands (`/login`, `/usage`, `stats`); the bundled catalog is derived from OMP\'s models.json.',
    )));
    root.append(omp);

    const meta = el('div', 'omtp-about-facts');
    fact(meta, tr('omtp_about_author', 'Author'), AUTHOR);
    const licenceCell = el('span');
    licenceCell.append(document.createTextNode(`${LICENSE} · `));
    licenceCell.append(link(LICENSE_URL, tr('omtp_about_license_link', 'GNU General Public License v3.0')));
    fact(meta, tr('omtp_about_license', 'License'), licenceCell);
    fact(meta, tr('omtp_about_version', 'Extension version'), versionLabel(facts.extension.version));
    fact(meta, tr('omtp_about_server_version', 'Server plugin'), facts.status?.serverPlugin
        ? trf('omtp_about_server_version_ok', '${0} · connected', versionLabel(facts.status.serverVersion))
        : tr('omtp_about_server_version_missing', 'Not installed'));
    fact(meta, tr('omtp_about_st_version', 'SillyTavern'), sillyTavernVersion());
    fact(meta, tr('omtp_about_gateway', 'Gateway'), gatewayValue(facts.status));
    fact(meta, tr('omtp_about_catalog', 'Model catalog'), catalogValue(facts.status));
    root.append(meta);

    root.append(section(tr('omtp_about_features', 'What it does'), list([
        tr('omtp_about_feature_hub', 'One hub for every provider: search, favorites, recents, profiles and per-model details.'),
        tr('omtp_about_feature_gateway', 'Runs an OpenAI-compatible gateway that SillyTavern talks to, with streaming, tools and reasoning verbatim.'),
        tr('omtp_about_feature_providers', 'Sign-in for OAuth plans and API keys, with per-provider live model probing.'),
        tr('omtp_about_feature_usage', 'Quota pages for subscription providers, refreshed from each provider\'s own usage endpoint.'),
        tr('omtp_about_feature_stats', 'Token and cost accounting per chat, per model and per day, plus the local dashboard (`/omtp stats`).'),
    ])));

    root.append(section(tr('omtp_about_data', 'Data and credits'), tr(
        'omtp_about_data_body',
        'Model metadata, pricing and capability flags come from OMP\'s models.json catalog; personality scores come from AA-PersonalityBench. Prices are estimates for orientation and are not a billing statement. Your credentials never leave the machine: they are encrypted under data/omtp and only used for requests you trigger.',
    )));

    const licenceBody = el('div', 'omtp-about-license');
    licenceBody.append(el('p', null, tr(
        'omtp_about_license_body',
        'This extension is free software released under the GNU General Public License v3.0: you may use, study, share and modify it, provided derivative works stay under the same licence and keep this notice.',
    )));
    licenceBody.append(el('p', 'omtp-about-copyright', trf(
        'omtp_about_copyright',
        '© ${0} ${1}. No warranty; see the licence for details.',
        new Date().getFullYear(),
        AUTHOR,
    )));
    root.append(section(tr('omtp_about_license_section', 'License'), licenceBody));

    // Sign-off, kept apart from the facts so it reads as a motto rather than data.
    const slogan = el('p', 'omtp-about-slogan', tr(
        'omtp_about_slogan',
        'We shall meet again at the far shore of the stars',
    ));
    root.append(slogan);

    container.replaceChildren(root);
}

export function disposeAboutPanel() {
    host = null;
}
