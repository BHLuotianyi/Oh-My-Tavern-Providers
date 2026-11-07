import test from 'node:test';
import assert from 'node:assert/strict';
import {
    UPDATE_CHANNELS,
    compareSemver,
    defaultUpdateChannel,
    evaluateUpdate,
    fetchRemoteInfo,
    isNightly,
    isSelectableChannel,
    nightlyDate,
    parseSemver,
    releaseLine,
    resolveUpdateChannel,
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

test('only the nightly and main channels are selectable', () => {
    assert.deepEqual([...UPDATE_CHANNELS], ['nightly', 'git']);
    assert.equal(defaultUpdateChannel('2.0.0'), 'git');
    assert.equal(defaultUpdateChannel('2.0.0+nightly.20261105'), 'nightly');
    assert.equal(resolveUpdateChannel('2.0.0', null), 'git');
    assert.equal(resolveUpdateChannel('2.0.0+nightly.20261105', 'git'), 'git');
    assert.equal(resolveUpdateChannel('2.0.0', 'release'), 'git');
    assert.equal(isSelectableChannel('release'), false);
    assert.equal(isSelectableChannel('nightly'), true);
});

test('a stable build follows main by version number', () => {
    const update = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 12 },
    });
    assert.equal(update.status, 'update');
    assert.equal(update.reason, 'versionCode');

    const byVersion = evaluateUpdate({
        localVersion: '1.9.0', localVersionCode: 5,
        main: { version: '2.0.0', versionCode: null },
    });
    assert.equal(byVersion.status, 'update');
    assert.equal(byVersion.reason, 'version');

    const ahead = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 12,
        main: { version: '2.0.0', versionCode: 10 },
    });
    assert.equal(ahead.status, 'ahead');

    const current = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 10 },
    });
    assert.equal(current.status, 'current');
    assert.equal(current.reason, 'version');
});

test('a nightly build follows the nightly branch by version number', () => {
    const update = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261102', localVersionCode: 11,
        nightly: { version: '2.0.0+nightly.20261103', versionCode: 12 },
    });
    assert.equal(update.status, 'update');
    assert.equal(update.reason, 'versionCode');

    const current = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: 12,
        nightly: { version: '2.0.0+nightly.20261103', versionCode: 12 },
    });
    assert.equal(current.status, 'current');

    // Without versionCode the nightly date still orders two builds of one line.
    const byDate = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: null,
        nightly: { version: '2.0.0+nightly.20261105', versionCode: null },
    });
    assert.equal(byDate.status, 'update');
    assert.equal(byDate.reason, 'version');

    const missing = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261103', localVersionCode: 12,
    });
    assert.equal(missing.status, 'unknown');
    assert.equal(missing.reason, 'no-nightly');
});

test('versionCode counters are only compared within the build\'s own channel', () => {
    // A git build following the nightly channel: the counters live on
    // different scales, so only semver/nightly date may decide.
    const forcedNightly = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 10 },
        nightly: { version: '2.0.0+nightly.20261105', versionCode: 12 },
        channel: 'nightly',
    });
    assert.equal(forcedNightly.status, 'update');
    assert.equal(forcedNightly.reason, 'version');

    // A nightly build following git must not look "ahead" forever just
    // because nightly counters are larger.
    const nightlyOnGit = evaluateUpdate({
        localVersion: '2.0.0+nightly.20261105', localVersionCode: 100,
        main: { version: '2.0.0', versionCode: 10 },
        nightly: { version: '2.0.0+nightly.20261106', versionCode: 101 },
        channel: 'git',
    });
    assert.equal(nightlyOnGit.status, 'current');

    // Same channel: the counter still wins over semver.
    const sameChannel = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.0.0', versionCode: 11 },
        channel: 'git',
    });
    assert.equal(sameChannel.status, 'update');
    assert.equal(sameChannel.reason, 'versionCode');

    // A malformed remote code must not be treated as 0 ("local is ahead").
    const missingCode = evaluateUpdate({
        localVersion: '2.0.0', localVersionCode: 10,
        main: { version: '2.1.0', versionCode: null },
        channel: 'git',
    });
    assert.equal(missingCode.status, 'update');
});

test('missing or unusable GitHub data is reported as unknown', () => {
    assert.equal(evaluateUpdate({ localVersion: '2.0.0', main: null }).status, 'unknown');
    assert.equal(evaluateUpdate({ localVersion: '2.0.0', main: {} }).status, 'unknown');
});

/** Minimal stand-in for GitHub's raw manifest host. */
function fakeFetch(routes) {
    return async (url) => {
        const key = Object.keys(routes).find((candidate) => url.includes(candidate));
        if (!key) return { ok: false, status: 404, json: async () => ({}) };
        const value = routes[key];
        if (value === 404) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => value };
    };
}

test('fetchRemoteInfo follows the selected channel', async () => {
    const git = await fetchRemoteInfo('2.0.0', {
        channel: 'git',
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'nightly/manifest.json': { version: '2.0.0+nightly.20261105', versionCode: 12 },
        }),
    });
    assert.deepEqual(git.main, { version: '2.0.0', versionCode: 10 });
    assert.equal(git.nightly, null);

    const nightly = await fetchRemoteInfo('2.0.0', {
        channel: 'nightly',
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'nightly/manifest.json': { version: '2.0.0+nightly.20261105', versionCode: 12 },
        }),
    });
    assert.equal(nightly.main.version, '2.0.0');
    assert.deepEqual(nightly.nightly, { version: '2.0.0+nightly.20261105', versionCode: 12 });
});

test('fetchRemoteInfo uses the build type when no channel is given', async () => {
    const info = await fetchRemoteInfo('2.0.0+nightly.20261105', {
        fetchImpl: fakeFetch({
            'main/manifest.json': { version: '2.0.0', versionCode: 10 },
            'nightly/manifest.json': { version: '2.0.0+nightly.20261106', versionCode: 13 },
        }),
    });
    assert.equal(info.nightly.version, '2.0.0+nightly.20261106');
});

test('fetchRemoteInfo rejects a completely silent GitHub', async () => {
    await assert.rejects(() => fetchRemoteInfo('2.0.0', {
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    }));
});
