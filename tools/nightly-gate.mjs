#!/usr/bin/env node
/**
 * Nightly gate: decide whether the previous UTC+8 day produced at least one
 * push to `main` whose CI run passed, and which commit should be built.
 *
 * Input is `gh run list --branch main --event push --json ...` output (a JSON
 * array). The newest successful push inside `[start, end)` wins; if there is
 * none the command prints nothing and exits 0, so the workflow can skip the
 * build without failing.
 *
 * Usage:
 *   node tools/nightly-gate.mjs runs.json 2026-11-02T00:00:00+08:00 2026-11-03T00:00:00+08:00
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Pick the commit to build nightly from.
 * @param {Array<{headSha?: string, createdAt?: string, conclusion?: string,
 *   event?: string, status?: string}>} runs
 * @param {string} start ISO instant, inclusive
 * @param {string} end ISO instant, exclusive
 * @returns {{sha: string, createdAt: string} | null}
 */
export function pickNightlyRun(runs, start, end) {
    const from = Date.parse(start);
    const to = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new RangeError(`invalid nightly window: ${start} .. ${end}`);
    }
    let picked = null;
    for (const run of Array.isArray(runs) ? runs : []) {
        // `gh` omits these on some payloads: a missing event counts as a push,
        // a missing conclusion falls back to the completed status.
        if (!run?.headSha) continue;
        if (run.event && run.event !== 'push') continue;
        const passed = run.conclusion ? run.conclusion === 'success' : run.status === 'completed';
        if (!passed) continue;
        const ms = Date.parse(run.createdAt);
        if (!Number.isFinite(ms) || ms < from || ms >= to) continue;
        // Ties keep the first candidate, i.e. the one `gh` listed first.
        if (picked && ms <= picked.ms) continue;
        picked = { sha: run.headSha, createdAt: run.createdAt || '', ms };
    }
    if (!picked) return null;
    return { sha: picked.sha, createdAt: picked.createdAt };
}

function main(argv) {
    const [file, start, end] = argv;
    if (!file || !start || !end) throw new Error('usage: node tools/nightly-gate.mjs <runs.json> <start> <end>');
    const runs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const picked = pickNightlyRun(runs, start, end);
    if (picked) process.stdout.write(`${picked.sha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`[omtp-nightly-gate] ${error.message}\n`);
        process.exit(1);
    }
}
