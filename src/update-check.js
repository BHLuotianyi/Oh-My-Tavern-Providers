/**
 * Update detection from the version numbers published on GitHub.
 *
 * Channels (see `tools/version.mjs`):
 *
 * - `main` ships the bare release line (`2.0.0`) and bumps `versionCode` when
 *   the version is written;
 * - the `nightly` branch appends build metadata (`2.0.0+nightly.20261103`) and
 *   bumps `versionCode` on every build.
 *
 * The checker only reads `manifest.json` from the followed channel; it never
 * looks at GitHub Releases or commit history, so a build is "newer" exactly
 * when its published version numbers are newer. Two channels exist:
 *
 * - `git` — `main`'s manifest;
 * - `nightly` — the `nightly` branch manifest.
 *
 * Without an explicit channel the build picks its own: nightly installs follow
 * `nightly`, everything else follows `git`. `versionCode` decides first and
 * semver precedence (plus the nightly date) breaks the tie.
 *
 * Verdicts:
 *
 * - `update`  — the channel publishes a higher version number.
 * - `ahead`   — this build's version number is higher than the channel's.
 * - `current` — the numbers match.
 * - `unknown` — GitHub unreachable or the payload was unusable.
 *
 * This module is dependency-free (no SillyTavern, no DOM) so the decision logic
 * is unit-tested directly.
 */

export const GITHUB_REPO = 'BHLuotianyi/Oh-My-Tavern-Providers';
export const GITHUB_BRANCH = 'main';
export const NIGHTLY_BRANCH = 'nightly';

/** How often the footer pill re-checks while the hub is open. */
export const UPDATE_POLL_MS = 30 * 60 * 1000;
/** Reuse a stored verdict for this long before touching GitHub again. */
export const UPDATE_CACHE_MS = 10 * 60 * 1000;
/** GitHub requests are aborted after this long. */
export const UPDATE_TIMEOUT_MS = 6000;

const RAW_ROOT = `https://raw.githubusercontent.com/${GITHUB_REPO}`;

export const UPDATE_ENDPOINTS = Object.freeze({
    mainManifest: `${RAW_ROOT}/${GITHUB_BRANCH}/manifest.json`,
    nightlyManifest: `${RAW_ROOT}/${NIGHTLY_BRANCH}/manifest.json`,
    commits: `https://github.com/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
    nightlyCommits: `https://github.com/${GITHUB_REPO}/commits/${NIGHTLY_BRANCH}`,
});

/** Channels the update check can follow. */
export const UPDATE_CHANNELS = Object.freeze(['nightly', 'git']);

/** Channel a build follows when nothing is selected and it is not nightly. */
export const DEFAULT_UPDATE_CHANNEL = 'git';

/** The channel a running build follows by default. */
export function defaultUpdateChannel(localVersion) {
    return isNightly(localVersion) ? 'nightly' : DEFAULT_UPDATE_CHANNEL;
}

/** True for channels the settings panel can select. */
export function isSelectableChannel(channel) {
    return UPDATE_CHANNELS.includes(channel);
}

/** Stored selection when usable, otherwise the build's default channel. */
export function resolveUpdateChannel(localVersion, channel) {
    return isSelectableChannel(channel) ? channel : defaultUpdateChannel(localVersion);
}

/**
 * Split a semver string into its precedence-relevant parts.
 * @param {unknown} value
 * @returns {{major:number,minor:number,patch:number,prerelease:string[]}|null}
 */
export function parseSemver(value) {
    const text = String(value ?? '').trim().replace(/^v/i, '');
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split('.') : [],
    };
}

function compareIdentifiers(left, right) {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Standard semver precedence (build metadata ignored).
 * @returns {-1|0|1}
 */
export function compareSemver(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b) return 0;
    for (const key of ['major', 'minor', 'patch']) {
        const diff = Math.sign(a[key] - b[key]);
        if (diff) return diff;
    }
    if (!a.prerelease.length && !b.prerelease.length) return 0;
    if (!a.prerelease.length) return 1;
    if (!b.prerelease.length) return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        if (a.prerelease[index] === undefined) return -1;
        if (b.prerelease[index] === undefined) return 1;
        const diff = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
        if (diff) return diff;
    }
    return 0;
}

/** The release line plus prerelease, i.e. the version without `+build`. */
export function releaseLine(version) {
    return String(version ?? '').trim().replace(/^v/i, '').split('+')[0];
}

/** True for a build published to the nightly branch. */
export function isNightly(version) {
    return /\+nightly\.\d{8}$/.test(String(version ?? '').trim());
}

/** The date part of a nightly build identity. */
export function nightlyDate(version) {
    const match = /\+nightly\.(\d{8})$/.exec(String(version ?? '').trim());
    return match ? match[1] : null;
}

function verdict(status, reason, extra = {}) {
    return { status, reason, ...extra };
}

/**
 * Fetch one URL as JSON.
 * @param {string} url
 * @param {{fetchImpl?: Function}} [options]
 */
async function fetchJson(url, { fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/**
 * Reduce a settled manifest fetch to the two version numbers the checker
 * uses; anything malformed counts as missing.
 * @param {PromiseSettledResult<object>} result
 * @returns {{version: string, versionCode: number|null}|null}
 */
function readManifest(result) {
    if (result.status !== 'fulfilled' || !result.value || typeof result.value !== 'object') return null;
    const version = typeof result.value.version === 'string' ? result.value.version : '';
    if (!version) return null;
    // Number(null) === 0 and Number('') === 0: treating a missing/malformed
    // code as 0 would make the local build look "ahead" forever.
    const rawCode = result.value.versionCode;
    const code = typeof rawCode === 'number' || (typeof rawCode === 'string' && rawCode.trim())
        ? Number(rawCode)
        : NaN;
    return { version, versionCode: Number.isFinite(code) ? code : null };
}

/**
 * Read the version numbers published on the followed channel.
 * @param {string} localVersion
 * @param {{fetchImpl?: Function, channel?: 'nightly'|'git'}} [options]
 * @returns {Promise<{main: object|null, nightly: object|null}>}
 */
export async function fetchRemoteInfo(localVersion, { fetchImpl, channel } = {}) {
    const followsNightly = channel ? channel === 'nightly' : isNightly(localVersion);
    const [mainManifest, nightlyManifest] = await Promise.allSettled([
        fetchJson(UPDATE_ENDPOINTS.mainManifest, { fetchImpl }),
        followsNightly
            ? fetchJson(UPDATE_ENDPOINTS.nightlyManifest, { fetchImpl })
            : Promise.resolve(null),
    ]);

    const main = readManifest(mainManifest);
    const nightly = followsNightly ? readManifest(nightlyManifest) : null;
    if (!main && !nightly) {
        throw new Error('GitHub returned no usable metadata');
    }
    return { main, nightly };
}

/**
 * Compare the running build against one channel's manifest.
 * @returns {object}
 */
function compareManifest({ local, localLine, localCode, remote, context, channelMatches = true }) {
    const ref = { remoteVersion: remote.version, remoteRef: null };
    const remoteCode = remote.versionCode;
    // Version codes are per-channel counters (see tools/version.mjs). When the
    // user follows a channel the running build does not belong to, comparing
    // them produces a permanent "local is ahead" verdict.
    if (channelMatches && Number.isFinite(localCode) && Number.isFinite(remoteCode) && localCode !== remoteCode) {
        return verdict(remoteCode > localCode ? 'update' : 'ahead', 'versionCode', { ...context, ...ref });
    }
    const precedence = compareSemver(remote.version, localLine);
    if (precedence > 0) return verdict('update', 'version', { ...context, ...ref });
    if (precedence < 0) return verdict('ahead', 'version', { ...context, ...ref });
    const localNightly = nightlyDate(local);
    const remoteNightly = nightlyDate(remote.version);
    if (remoteNightly && !localNightly) {
        return verdict('update', 'version', { ...context, ...ref });
    }
    if (localNightly && remoteNightly && localNightly !== remoteNightly) {
        return verdict(remoteNightly > localNightly ? 'update' : 'ahead', 'version', { ...context, ...ref });
    }
    return verdict('current', 'version', { ...context, ...ref });
}

/**
 * Decide whether the followed channel publishes newer version numbers.
 * @param {{localVersion?: string, localVersionCode?: number|string,
 *   main?: object|null, nightly?: object|null,
 *   channel?: 'nightly'|'git'}} input
 * @returns {{status:'update'|'ahead'|'current'|'unknown', reason:string,
 *   localVersion:string, localLine:string, remoteVersion:string, remoteRef:string|null}}
 */
export function evaluateUpdate({ localVersion, localVersionCode, main, nightly, channel } = {}) {
    const local = String(localVersion ?? '').trim();
    const localLine = releaseLine(local);
    const localCode = Number.isFinite(localVersionCode) ? Number(localVersionCode) : NaN;
    const context = {
        localVersion: local,
        localLine,
        remoteVersion: '',
        remoteRef: null,
    };

    const followsNightly = channel === 'nightly' || (channel == null && isNightly(local));
    const localChannel = isNightly(local) ? 'nightly' : 'git';
    const channelMatches = localChannel === (followsNightly ? 'nightly' : 'git');
    if (followsNightly) {
        if (!nightly?.version) {
            return verdict('unknown', 'no-nightly', context);
        }
        return compareManifest({ local, localLine, localCode, remote: nightly, context, channelMatches });
    }

    if (!main?.version) {
        return verdict('unknown', 'no-main', context);
    }
    return compareManifest({ local, localLine, localCode, remote: main, context, channelMatches });
}
