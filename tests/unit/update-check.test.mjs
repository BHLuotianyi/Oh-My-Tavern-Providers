import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compareSemver, compareUrl, evaluateUpdate, fetchRemoteInfo, isNightly, nightlyDate, parseSemver, releaseLine,
} from '../../src/update-check.js';

test('semver parsing keeps prerelease but drops build metadata', () => {
    assert.deepEqual(parseSemver('2.0.0+nightly.20261103'), { major: 2, minor: 0, patch: 0, prerelease: [] });
    assert.deepEqual(parseSemver('v2.1.3-beta.2+nightly.20261103'), {
        major: 2, minor: 1, patch: 3, prerelease: ['beta', '2'],
    });
    assert.equal(parseSemver('2.0'), null);
    assert.equal(parseSemver('2.0.0-beta.01'), null);
});

test('semver precedence follows the specification', () => {
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemver('1.9.9', '2.0.0'), -1);
    assert.equal(compareSemver('2.0.0-alpha.1', '2.0.0'), -1);
    assert.equal(compareSemver('2.0.0-alpha.1', '2.0.0-beta.1'), -1);
    assert.equal(compareSemver('2.0.0-beta.2', '2.0.0-beta.10'), -1);
    assert.equal(compareSemver('2.0.0+nightly.20261103', '2.0.0+nightly.20261104'), 0);
});

test('channel helpers separate the release line from nightly metadata', () => {
    assert.equal(releaseLine('2.0.0+nightly.20261103'), '2.0.0');
    assert.equal(releaseLine('v2.1.0-beta.1'), '2.1.0-beta.1');
    assert.equal(isNightly('2.0.0+nightly.20261103'), true);
    assert.equal(isNightly('2.0.0'), false);
    assert.equal(nightlyDate('2.0.0+nightly.20261103'), '20261103');
    assert.equal(nightlyDate('2.0.0'), null);
});

test('a release install is up to date when the release tag matches', () => {
    const info = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 10, sha: 'aaaaaaa' },
        release: { tag: 'v2.0.0', version: '2.0.0', sha: 'aaaaaaa' },
    });
    assert.equal(info.status, 'current');
    assert.equal(info.reason, 'release');
    assert.equal(info.releaseTag, 'v2.0.0');
});

test('unreleased main commits after the newest release are reported as pending', () => {
    const info = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 10, sha: 'bbbbbbb' },
        release: { tag: 'v2.0.0', version: '2.0.0', sha: 'aaaaaaa' },
    });
    assert.equal(info.status, 'pending');
    assert.equal(info.reason, 'commits');
    assert.equal(info.remoteRef, 'bbbbbbb');
});

test('a newer release wins over the running line', () => {
    const info = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.1.0', versionCode: 11, sha: 'bbbbbbb' },
        release: { tag: 'v2.1.0', version: '2.1.0', sha: 'bbbbbbb' },
    });
    assert.equal(info.status, 'update');
    assert.equal(info.reason, 'release');
    assert.equal(info.remoteVersion, '2.1.0');
});

test('a higher versionCode alone is enough to report an update', () => {
    const info = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 12, sha: 'bbbbbbb' },
    });
    assert.equal(info.status, 'update');
    assert.equal(info.reason, 'versionCode');

    const ahead = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 12,
        main: { version: '2.0.0', versionCode: 10, sha: 'bbbbbbb' },
    });
    assert.equal(ahead.status, 'ahead');
});

test('nightly installs compare against the nightly branch', () => {
    const update = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261102', localVersionCode: 11,
        main: { version: '2.0.0', versionCode: 10, sha: 'bbbbbbb' },
        nightly: { version: '2.0.0+nightly.20261103', versionCode: 12 },
    });
    assert.equal(update.status, 'update');
    assert.equal(update.reason, 'versionCode');

    const current = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: 12,
        nightly: { version: '2.0.0+nightly.20261103', versionCode: 12 },
    });
    assert.equal(current.status, 'current');

    const missing = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: 12,
    });
    assert.equal(missing.status, 'unknown');
    assert.equal(missing.reason, 'no-nightly');
});

test('without releases the main manifest decides', () => {
    const update = evaluateUpdate({
        localVersion: '1.9.0', localVersionCode: 5,
        main: { version: '2.0.0', versionCode: null, sha: 'bbbbbbb' },
    });
    assert.equal(update.status, 'update');
    assert.equal(update.reason, 'version');

    const current = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 10, sha: 'bbbbbbb' },
    });
    assert.equal(current.status, 'current');
    assert.equal(current.reason, 'version');
});

test('missing or unusable GitHub data is reported as unknown', () => {
    assert.equal(evaluateUpdate({ localVersion: '2.0.0', main: null }).status, 'unknown');
    assert.equal(evaluateUpdate({ localVersion: '2.0.0', main: {} }).status, 'unknown');
});

test('compare links resolve their starting ref', () => {
    assert.match(compareUrl('v2.0.0'), /compare\/v2\.0\.0\.\.\.main$/);
    assert.match(compareUrl('aaaaaaa'), /compare\/aaaaaaa\.\.\.main$/);
    assert.match(compareUrl(null), /compare\/main\.\.\.main$/);
    assert.match(compareUrl('  '), /compare\/main\.\.\.main$/);
});

/** Minimal stand-in for GitHub's REST API. */
function fakeFetch(routes) {
    return async (url) => {
        const key = Object.keys(routes).find((candidate) => url.includes(candidate));
        if (!key) return { ok: false, status: 404, json: async () => ({}) };
        const value = routes[key];
        if (value === 404) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => value };
    };
}

const COMMIT = (sha, date = '2026-11-05T10:00:00Z', message = 'chore: work') => ({
    sha,
    html_url: `https://github.com/x/y/commit/${sha}`,
    commit: { message, committer: { date } },
});

test('fetchRemoteInfo maps the GitHub payloads for release installs', async () => {
    const info = await fetchRemoteInfo('2.0.0', {
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'commits/main': COMMIT('bbbbbbb'),
            'releases/latest': { tag_name: 'v2.0.0', published_at: '2026-11-04T10:00:00Z' },
            'commits/v2.0.0': COMMIT('aaaaaaa', '2026-11-04T09:00:00Z'),
        }),
    });
    assert.equal(info.main.version, '2.0.0');
    assert.equal(info.main.versionCode, 10);
    assert.equal(info.main.sha, 'bbbbbbb');
    assert.equal(info.release.tag, 'v2.0.0');
    assert.equal(info.release.version, '2.0.0');
    assert.equal(info.release.sha, 'aaaaaaa');
    assert.equal(info.nightly, null);

    const verdict = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10, ...info,
    });
    assert.equal(verdict.status, 'pending');
});

test('fetchRemoteInfo tolerates a repository without releases', async () => {
    const info = await fetchRemoteInfo('2.0.0', {
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'commits/main': COMMIT('bbbbbbb'),
            'releases/latest': 404,
        }),
    });
    assert.equal(info.release, null);
    assert.equal(evaluateUpdate({ localVersion: '2.0.0', localVersionCode: 10, ...info }).status, 'current');
});

test('fetchRemoteInfo reads the nightly manifest for nightly installs', async () => {
    const info = await fetchRemoteInfo('2.0.0+nightly.20261103', {
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'commits/main': COMMIT('bbbbbbb'),
            'nightly/manifest.json': { version: '2.0.0+nightly.20261105', versionCode: 12 },
        }),
    });
    assert.equal(info.nightly.version, '2.0.0+nightly.20261105');
    assert.equal(info.release, null);
    assert.equal(evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: 11, ...info,
    }).status, 'update');
});

test('fetchRemoteInfo rejects a completely silent GitHub', async () => {
    await assert.rejects(() => fetchRemoteInfo('2.0.0', {
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    }));
});
