/**
 * Update detection from GitHub metadata and commit history.
 *
 * Channels (see `tools/version.mjs`):
 *
 * - `main` ships the bare release line (`2.0.0`), so the only metadata that can
 *   move there is `versionCode` and the commit history itself;
 * - the `nightly` branch appends build metadata (`2.0.0+nightly.20261103`) and
 *   bumps `versionCode` on every build;
 * - cuts are tagged `v<line>` and published as GitHub Releases.
 *
 * The checker follows one channel at a time (`UPDATE_CHANNELS`):
 *
 * 1. `git` — `main`'s manifest plus its tip commit;
 * 2. `nightly` — the `nightly` branch manifest;
 * 3. `release` — the latest GitHub Release and the commit it points at
 *    (listed but greyed out until the first Release exists).
 *
 * Without an explicit channel the build picks its own: nightly installs follow
 * `nightly`, everything else follows `git`. `versionCode` is only compared
 * inside that channel (see `CONTRIBUTING.md`); semver decides first.
 *
 * Verdicts:
 *
 * - `update`  — a newer release, a higher `versionCode`, or a newer nightly
 *   build exists.
 * - `pending` — the running build is the newest release, but `main` has commits
 *   past that release (a `git pull` picks them up, no Release exists yet).
 * - `ahead`   — this build is newer than the compared channel (nightly or a
 *   manually set prerelease).
 * - `current` — nothing to pull.
 * - `unknown` — GitHub unreachable or the payload was unusable.
 *
 * This module is dependency-free (no SillyTavern, no DOM) so the decision logic
 * is unit-tested directly.
 */

export const GITHUB_REPO = 'BHLuotianyi/Oh-My-Tavern-Providers';
export const GITHUB_BRANCH = 'main';
export const NIGHTLY_BRANCH = 'nightly';

/** How often the header pill re-checks while the hub is open. */
export const UPDATE_POLL_MS = 30 * 60 * 1000;
/** Reuse a stored verdict for this long before touching GitHub again. */
export const UPDATE_CACHE_MS = 10 * 60 * 1000;
/** GitHub requests are aborted after this long. */
export const UPDATE_TIMEOUT_MS = 6000;

const RAW_ROOT = `https://raw.githubusercontent.com/${GITHUB_REPO}`;
const API_ROOT = `https://api.github.com/repos/${GITHUB_REPO}`;

export const UPDATE_ENDPOINTS = Object.freeze({
    mainManifest: `${RAW_ROOT}/${GITHUB_BRANCH}/manifest.json`,
    nightlyManifest: `${RAW_ROOT}/${NIGHTLY_BRANCH}/manifest.json`,
    mainCommit: `${API_ROOT}/commits/${GITHUB_BRANCH}`,
    latestRelease: `${API_ROOT}/releases/latest`,
    commit: (ref) => `${API_ROOT}/commits/${encodeURIComponent(String(ref))}`,
    commits: `https://github.com/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
    nightlyCommits: `https://github.com/${GITHUB_REPO}/commits/${NIGHTLY_BRANCH}`,
    releasePage: (tag) => `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(String(tag))}`,
});

/**
 * Channels the update check can follow. `release` is listed but disabled until
 * the repository publishes its first GitHub Release.
 */
export const UPDATE_CHANNELS = Object.freeze([
    { id: 'release', enabled: false },
    { id: 'nightly', enabled: true },
    { id: 'git', enabled: true },
]);

/** Channel a build follows when nothing is selected and it is not nightly. */
export const DEFAULT_UPDATE_CHANNEL = 'git';

/** The channel a running build follows by default. */
export function defaultUpdateChannel(localVersion) {
    return isNightly(localVersion) ? 'nightly' : DEFAULT_UPDATE_CHANNEL;
}

/** True for channels that are published and can be selected in the UI. */
export function isSelectableChannel(channel) {
    return UPDATE_CHANNELS.some((entry) => entry.enabled && entry.id === channel);
}

/** Stored selection when usable, otherwise the build's default channel. */
export function resolveUpdateChannel(localVersion, channel) {
    return isSelectableChannel(channel) ? channel : defaultUpdateChannel(localVersion);
}

/**
 * Compare page for "what am I missing". Nightly builds have no commit hash in
 * their version, so they compare from the newest release tag (or the branch).
 * @param {string|null} from tag, branch or commit
 * @returns {string}
 */
export function compareUrl(from) {
    const ref = typeof from === 'string' && from.trim() ? from.trim() : GITHUB_BRANCH;
    return `https://github.com/${GITHUB_REPO}/compare/${ref}...${GITHUB_BRANCH}`;
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
 * Fetch one URL as JSON. `allowMissing` turns a 404 into `null` — GitHub
 * answers `/releases/latest` with 404 while the repository has no release.
 * @param {string} url
 * @param {{allowMissing?: boolean, fetchImpl?: Function}} [options]
 */
async function fetchJson(url, { allowMissing = false, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/**
 * Resolve a ref (`main`, a tag or a sha) to a commit summary.
 * @param {string} ref
 * @param {{fetchImpl?: Function}} [options]
 */
export async function fetchCommit(ref, { fetchImpl } = {}) {
    const payload = await fetchJson(UPDATE_ENDPOINTS.commit(ref), { fetchImpl });
    const node = Array.isArray(payload) ? payload[0] : payload;
    if (!node || typeof node !== 'object') throw new Error('empty commit payload');
    return {
        sha: typeof node.sha === 'string' ? node.sha : null,
        committedAt: node.commit?.committer?.date || node.commit?.author?.date || null,
        message: String(node.commit?.message || '').split('\n')[0].trim(),
        htmlUrl: typeof node.html_url === 'string' ? node.html_url : null,
    };
}

/**
 * Read everything the verdict needs from GitHub: `main`'s manifest and tip
 * commit, the newest release (with the commit its tag points at) for release
 * installs, or the `nightly` manifest for nightly installs.
 * @param {string} localVersion
 * @param {{fetchImpl?: Function, channel?: 'release'|'nightly'|'git'}} [options]
 * @returns {Promise<{main: object, nightly: object|null, release: object|null}>}
 */
export async function fetchRemoteInfo(localVersion, { fetchImpl, channel } = {}) {
    const wantsNightly = channel ? channel === 'nightly' : isNightly(localVersion);
    const wantsRelease = channel ? channel === 'release' : !wantsNightly;
    const [mainManifest, mainCommit, channelPayload] = await Promise.allSettled([
        fetchJson(UPDATE_ENDPOINTS.mainManifest, { fetchImpl }),
        fetchCommit(GITHUB_BRANCH, { fetchImpl }),
        wantsNightly
            ? fetchJson(UPDATE_ENDPOINTS.nightlyManifest, { fetchImpl })
            : wantsRelease
                ? fetchJson(UPDATE_ENDPOINTS.latestRelease, { allowMissing: true, fetchImpl })
                : Promise.resolve(null),
    ]);

    const main = {
        version: '',
        versionCode: null,
        sha: null,
        committedAt: null,
        message: '',
        htmlUrl: null,
    };
    if (mainManifest.status === 'fulfilled' && mainManifest.value && typeof mainManifest.value === 'object') {
        const manifest = mainManifest.value;
        main.version = typeof manifest.version === 'string' ? manifest.version : '';
        main.versionCode = Number.isFinite(Number(manifest.versionCode)) ? Number(manifest.versionCode) : null;
    }
    if (mainCommit.status === 'fulfilled') Object.assign(main, mainCommit.value);

    let nightly = null;
    let release = null;
    const payload = channelPayload.status === 'fulfilled' ? channelPayload.value : null;
    if (wantsNightly) {
        if (payload && typeof payload === 'object' && typeof payload.version === 'string') {
            nightly = {
                version: payload.version,
                versionCode: Number.isFinite(Number(payload.versionCode)) ? Number(payload.versionCode) : null,
            };
        }
    } else if (payload && typeof payload === 'object' && typeof payload.tag_name === 'string') {
        release = {
            tag: payload.tag_name,
            version: String(payload.tag_name).replace(/^v/i, ''),
            publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
            htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : null,
            sha: null,
        };
        try {
            const tagged = await fetchCommit(release.tag, { fetchImpl });
            release.sha = tagged.sha;
            release.committedAt = tagged.committedAt;
        } catch (error) {
            // Without the tagged commit the verdict still works from versions;
            // only the "unreleased commits" comparison is skipped.
            console.warn('[omtp] could not resolve the release commit', error);
        }
    }

    if (!main.version && !main.sha && !nightly && !release) {
        throw new Error('GitHub returned no usable metadata');
    }
    return { main, nightly, release };
}

/**
 * Compare a non-nightly build against `main`'s manifest and commit tip.
 * @returns {object}
 */
function compareWithMain({ local, localLine, localCode, main, context }) {
    if (!main?.version && !main?.sha) {
        return verdict('unknown', 'no-remote', context);
    }
    const remoteMainVersion = typeof main?.version === 'string' ? main.version : '';
    const remoteMainCode = Number.isFinite(main?.versionCode) ? Number(main.versionCode) : NaN;
    const ref = { remoteVersion: remoteMainVersion, remoteRef: main?.sha || null };
    if (Number.isFinite(localCode) && Number.isFinite(remoteMainCode) && localCode !== remoteMainCode) {
        return verdict(remoteMainCode > localCode ? 'update' : 'ahead', 'versionCode', { ...context, ...ref });
    }
    const precedence = compareSemver(remoteMainVersion, localLine);
    if (precedence > 0) return verdict('update', 'version', { ...context, ...ref });
    if (precedence < 0) return verdict('ahead', 'version', { ...context, ...ref });
    if (remoteMainVersion && remoteMainVersion === local) {
        return verdict('current', 'version', { ...context, ...ref });
    }
    return verdict('unknown', 'incomparable', context);
}

/**
 * Decide whether anything newer is published.
 * @param {{localVersion?: string, localVersionCode?: number|string,
 *   main?: object|null, nightly?: object|null, release?: object|null,
 *   channel?: 'release'|'nightly'|'git'}} input
 * @returns {{status:'update'|'pending'|'ahead'|'current'|'unknown', reason:string,
 *   localVersion:string, localLine:string, remoteVersion:string, remoteRef:string|null}}
 */
export function evaluateUpdate({ localVersion, localVersionCode, main, nightly, release, channel } = {}) {
    const local = String(localVersion ?? '').trim();
    const localLine = releaseLine(local);
    const localCode = Number.isFinite(localVersionCode) ? Number(localVersionCode) : NaN;
    const releaseTag = release?.tag || null;
    const context = {
        localVersion: local,
        localLine,
        releaseTag,
        remoteVersion: '',
        remoteRef: null,
    };

    const followsNightly = channel === 'nightly' || (channel == null && isNightly(local));
    if (followsNightly) {
        if (!nightly || typeof nightly.version !== 'string' || !nightly.version) {
            return verdict('unknown', 'no-nightly', context);
        }
        const remoteCode = Number.isFinite(nightly.versionCode) ? Number(nightly.versionCode) : NaN;
        const remote = { remoteVersion: nightly.version, remoteRef: NIGHTLY_BRANCH };
        if (Number.isFinite(localCode) && Number.isFinite(remoteCode) && localCode !== remoteCode) {
            return verdict(remoteCode > localCode ? 'update' : 'ahead', 'versionCode', { ...context, ...remote });
        }
        const precedence = compareSemver(nightly.version, local);
        if (precedence > 0) return verdict('update', 'version', { ...context, ...remote });
        if (precedence < 0) return verdict('ahead', 'version', { ...context, ...remote });
        return verdict('current', 'version', { ...context, ...remote });
    }

    if (channel === 'git') {
        return compareWithMain({ local, localLine, localCode, main, context });
    }

    if (!main?.version && !main?.sha && !release?.tag) {
        return verdict('unknown', 'no-remote', context);
    }

    const remoteMainVersion = typeof main?.version === 'string' ? main.version : '';
    const remoteMainCode = Number.isFinite(main?.versionCode) ? Number(main.versionCode) : NaN;
    const mainRef = { remoteVersion: remoteMainVersion, remoteRef: main?.sha || null };

    if (release?.tag) {
        const releaseRef = { remoteVersion: release.version || release.tag, remoteRef: release.tag };
        const precedence = compareSemver(release.version, localLine);
        if (precedence > 0) return verdict('update', 'release', { ...context, ...releaseRef });
        if (precedence < 0) return verdict('ahead', 'release', { ...context, ...releaseRef });
        // Same release line: the counter or the commit history decides.
        if (Number.isFinite(localCode) && Number.isFinite(remoteMainCode) && localCode !== remoteMainCode) {
            return verdict(remoteMainCode > localCode ? 'update' : 'ahead', 'versionCode', { ...context, ...mainRef });
        }
        if (release.sha && main?.sha && release.sha !== main.sha) {
            return verdict('pending', 'commits', { ...context, ...mainRef });
        }
        return verdict('current', 'release', { ...context, ...releaseRef });
    }

    return compareWithMain({ local, localLine, localCode, main, context });
}
