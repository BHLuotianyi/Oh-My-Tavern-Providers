#!/usr/bin/env node
/**
 * Release identity writer for OMTP.
 *
 * Versions are standard semver: `MAJOR.MINOR.FIX` is the release line, and an
 * optional `-alpha.N` / `-beta.N` prerelease is only ever set by hand (alpha is
 * rareley used). Automation only appends build metadata, which semver ignores
 * for precedence, and only when it publishes a build:
 *
 *   <line>                       `main`, always — the shipped release line
 *   <line>+nightly.<YYYYMMDD>    nightly branch, UTC+8 date of the built day
 *
 * `main` never receives an automated commit: build identities belong to the
 * nightly branch and to releases, so the repository history stays human-only.
 *
 * `versionCode` is an integer kept independent of the readable version and
 * incremented on every write. The counters are per channel: `main` only reads
 * its own files, and the nightly job passes `--floor-code` with the highest
 * code visible on the `nightly` branch. The two are never compared.
 *
 * The same string is written to `manifest.json`, `package.json`,
 * `server-plugin/package.json` and `src/constants.js`; only the version fields
 * are touched, so formatting, ordering and trailing newlines stay intact.
 *
 * Usage:
 *   node tools/version.mjs nightly --date YYYYMMDD [--floor-code N] [--json-out FILE]
 *   node tools/version.mjs manual 2.0.0 | 2.0.0-beta.1 [--json-out FILE]
 *   node tools/version.mjs check-tag v2.0.0
 *
 * `--root` overrides the repository root (used by unit tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';

/** Fixed build timezone: UTC+8, with no daylight saving. */
export const BUILD_TZ_OFFSET_MINUTES = 8 * 60;

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files that carry the release identity. */
const TARGETS = [
    { file: 'manifest.json' },
    { file: 'package.json' },
    { file: 'server-plugin/package.json' },
    { file: 'src/constants.js', constants: true },
];

/** semver.org's reference grammar (without the optional `v` prefix). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** True for a standard semver string (prerelease and build metadata allowed). */
export function isSemver(version) {
    return SEMVER.test(String(version).replace(/^v/, ''));
}

/** The release line plus manual prerelease, i.e. the version without `+build`. */
export function lineFromDisplay(display) {
    return String(display).replace(/^v/, '').split('+')[0];
}

/** Human-owned release line: everything before `-prerelease` / `+build`. */
export function baseFromDisplay(display) {
    return String(display).replace(/^v/, '').split(/[-+]/, 1)[0];
}

/** `YYYYMMDD` in UTC+8 for an instant (defaults to now). */
export function buildDate(ms = Date.now()) {
    const shifted = new Date(ms + BUILD_TZ_OFFSET_MINUTES * 60_000);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/** The UTC+8 day before `ms`, as `YYYYMMDD` — the nightly build's window. */
export function previousBuildDate(ms = Date.now()) {
    return buildDate(ms - 86_400_000);
}

/** Build identity for a channel. */
export function buildVersion({ line, channel, date = previousBuildDate() }) {
    if (!SEMVER.test(line) || line.includes('+')) throw new RangeError(`invalid release line: ${line}`);
    if (channel === 'manual') return line;
    if (channel === 'nightly') {
        if (!/^\d{8}$/.test(date)) throw new RangeError(`invalid build date: ${date}`);
        return `${line}+nightly.${date}`;
    }
    throw new RangeError(`unknown channel: ${channel}`);
}

function readJson(root, file) {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

/** Read the current identity from `manifest.json` plus the npm packages. */
export function readCurrent(root = DEFAULT_ROOT) {
    const manifest = readJson(root, 'manifest.json');
    const display = String(manifest.version || '');
    const codes = [manifest.versionCode, readJson(root, 'package.json').versionCode,
        readJson(root, 'server-plugin/package.json').versionCode].map(Number);
    return {
        display,
        line: lineFromDisplay(display),
        base: baseFromDisplay(display),
        versionCode: Math.max(...codes.filter(Number.isFinite), 0),
    };
}

/**
 * Replace the single version field. Re-running with the same value is a no-op,
 * not an error: nightly re-builds of one day share a display string and only
 * `versionCode` moves.
 */
function replaceOnce(source, pattern, replacement, file) {
    if (!pattern.test(source)) throw new Error(`${file}: version field not found (${pattern})`);
    return source.replace(pattern, replacement);
}

function writeJsonField(source, key, literal, file) {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)(?:"[^"]*"|\\d+)`);
    return replaceOnce(source, pattern, `$1${literal}`, file);
}

/** Write the identity to every file that carries it. */
export function applyVersion(root, { display, versionCode }) {
    if (!isSemver(display)) throw new RangeError(`not a semver version: ${display}`);
    const code = Number(versionCode);
    if (!Number.isInteger(code) || code < 0) throw new RangeError(`invalid versionCode: ${versionCode}`);
    const written = [];

    for (const target of TARGETS) {
        const file = path.join(root, target.file);
        const original = fs.readFileSync(file, 'utf8');
        let content = original;
        if (target.constants) {
            content = replaceOnce(content, /(export const EXTENSION_VERSION = ')[^']*(';)/, `$1${display}$2`, target.file);
            content = replaceOnce(content, /(export const EXTENSION_VERSION_CODE = )\d+(;)/, `$1${code}$2`, target.file);
        } else {
            content = writeJsonField(content, 'version', JSON.stringify(display), target.file);
            content = writeJsonField(content, 'versionCode', String(code), target.file);
        }
        // Leave untouched files untouched: no mtime churn, no noisy diffs.
        if (content !== original) fs.writeFileSync(file, content);
        written.push(target.file);
    }

    return { display, versionCode: code, files: written };
}

/**
 * Compute and write the new identity. `floorCode` keeps `versionCode`
 * monotonic within a channel; `version` writes an explicit (manual) version.
 */
export function bumpVersion({
    root = DEFAULT_ROOT, channel, date = previousBuildDate(), floorCode = 0, version,
} = {}) {
    const current = readCurrent(root);
    const nextDisplay = version
        ? lineFromDisplay(version)
        : buildVersion({ line: current.line, channel, date });
    const versionCode = Math.max(current.versionCode, Number(floorCode) || 0) + 1;
    const result = applyVersion(root, { display: nextDisplay, versionCode });
    const build = channel === 'nightly' ? { date } : {};
    return { ...result, channel, ...build };
}

/** A release tag is valid for `v<line>`, `v<line without prerelease>` or `v<display>`. */
export function matchesTag(tag, display) {
    const value = String(tag).replace(/^v/i, '');
    return value === lineFromDisplay(display) || value === baseFromDisplay(display) || value === display;
}

function parseArgs(argv) {
    const { values, positionals } = parseCliArgs({
        args: argv,
        allowPositionals: true,
        options: {
            root: { type: 'string' },
            date: { type: 'string' },
            'floor-code': { type: 'string' },
            'json-out': { type: 'string' },
        },
    });
    const [command, ...rest] = positionals;
    return { command, flags: { ...values, _: rest } };
}

function emit(result, file) {
    const payload = JSON.stringify(result, null, 2);
    if (file) fs.writeFileSync(file, `${payload}\n`);
    process.stdout.write(`${payload}\n`);
}

function main(argv) {
    const { command, flags } = parseArgs(argv);
    const root = path.resolve(flags.root || DEFAULT_ROOT);
    const floorCode = flags['floor-code'] !== undefined && flags['floor-code'] !== ''
        ? Number(flags['floor-code'])
        : 0;
    if (!Number.isFinite(floorCode)) throw new Error(`invalid --floor-code: ${flags['floor-code']}`);

    switch (command) {
        case 'nightly': {
            const result = bumpVersion({ root, channel: 'nightly', date: flags.date, floorCode });
            return emit(result, flags['json-out']);
        }
        case 'manual': {
            const version = String(flags._[0] || '').replace(/^v/i, '');
            if (!version) throw new Error('usage: node tools/version.mjs manual <MAJOR.MINOR.FIX[-alpha.N|-beta.N]>');
            const result = bumpVersion({ root, channel: 'manual', version, floorCode });
            return emit(result, flags['json-out']);
        }
        case 'check-tag': {
            const tag = flags._[0] || process.env.GITHUB_REF_NAME;
            const { display } = readCurrent(root);
            if (!tag || !matchesTag(tag, display)) {
                // Without a prerelease the line and base coincide; name it once.
                const expected = [...new Set([lineFromDisplay(display), baseFromDisplay(display)])].map((value) => `v${value}`);
                throw new Error(`tag ${tag} does not match ${display} (expected ${expected.join(' or ')})`);
            }
            return emit({ ok: true, tag, display });
        }
        default:
            throw new Error(`unknown command: ${command}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`[omtp-version] ${error.message}\n`);
        process.exit(1);
    }
}
