import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_VERSION, EXTENSION_VERSION_CODE } from '../../src/constants.js';
import { applyVersion, buildDate, bumpVersion, matchesTag, previousBuildDate } from '../../tools/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('release identity is consistent across manifest, packages and constants', () => {
    const manifest = readJson('manifest.json');
    const clientPackage = readJson('package.json');
    const serverPackage = readJson('server-plugin/package.json');

    // SillyTavern reads `manifest.version` verbatim, so it is the display string.
    assert.equal(manifest.version, EXTENSION_VERSION);
    assert.equal(manifest.versionCode, EXTENSION_VERSION_CODE);

    // npm requires semver; `main` ships the bare release line.
    assert.equal(clientPackage.version, EXTENSION_VERSION);
    assert.equal(serverPackage.version, EXTENSION_VERSION);
    assert.equal(clientPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.equal(serverPackage.versionCode, EXTENSION_VERSION_CODE);

    // The per-push `+git.<sha>` identity is gone: `main` carries the release
    // line, and only the nightly channel appends build metadata.
    assert.doesNotMatch(EXTENSION_VERSION, /\+git\./);
});

test('an unchanged display version rewrites only the bumped fields', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-version-'));
    fs.mkdirSync(path.join(tempRoot, 'src'));
    fs.mkdirSync(path.join(tempRoot, 'server-plugin'));
    const identity = { version: '2.0.0', versionCode: 10 };
    for (const file of ['manifest.json', 'package.json', 'server-plugin/package.json']) {
        fs.writeFileSync(path.join(tempRoot, file), `${JSON.stringify(identity, null, 2)}\n`);
    }
    fs.writeFileSync(path.join(tempRoot, 'src/constants.js'), [
        "export const EXTENSION_VERSION = '2.0.0';",
        'export const EXTENSION_VERSION_CODE = 10;',
        '',
    ].join('\n'));

    // Same display string, higher code: this used to throw "version field not
    // found" because the no-op replacement looked like a missing pattern.
    const first = bumpVersion({ root: tempRoot, channel: 'manual', version: '2.0.0' });
    assert.deepEqual(first.files, ['manifest.json', 'package.json', 'server-plugin/package.json', 'src/constants.js']);
    assert.equal(first.versionCode, 11);
    for (const file of ['manifest.json', 'package.json', 'server-plugin/package.json']) {
        const parsed = JSON.parse(fs.readFileSync(path.join(tempRoot, file), 'utf8'));
        assert.equal(parsed.version, '2.0.0');
        assert.equal(parsed.versionCode, 11);
    }
    assert.match(fs.readFileSync(path.join(tempRoot, 'src/constants.js'), 'utf8'), /EXTENSION_VERSION_CODE = 11/);

    // A byte-identical write is skipped entirely.
    const before = fs.readFileSync(path.join(tempRoot, 'server-plugin/package.json'), 'utf8');
    applyVersion(tempRoot, { display: '2.0.0', versionCode: 11 });
    assert.equal(fs.readFileSync(path.join(tempRoot, 'server-plugin/package.json'), 'utf8'), before);
});

test('buildDate and previousBuildDate follow UTC+8 calendar boundaries', () => {
    assert.equal(buildDate(Date.parse('2026-11-13T15:59:59.999Z')), '20261113');
    assert.equal(buildDate(Date.parse('2026-11-13T16:00:00.000Z')), '20261114');
    assert.equal(previousBuildDate(Date.parse('2026-11-13T15:59:59.999Z')), '20261112');
    assert.equal(previousBuildDate(Date.parse('2026-11-13T16:00:00.000Z')), '20261113');
});

test('matchesTag accepts release line, base line and full display tag', () => {
    assert.equal(matchesTag('v2.2.1', '2.2.1'), true);
    assert.equal(matchesTag('v2.2.1', '2.2.1+nightly.20261113'), true);
    assert.equal(matchesTag('v2.2.1+nightly.20261113', '2.2.1+nightly.20261113'), true);
    assert.equal(matchesTag('v2.2.1-beta.1', '2.2.1-beta.1+nightly.20261113'), true);
    assert.equal(matchesTag('v2.2.1', '2.2.1-beta.1+nightly.20261113'), true);
    assert.equal(matchesTag('v2.2.0', '2.2.1'), false);
    assert.equal(matchesTag('v2.2.1-alpha.1', '2.2.1-beta.1'), false);
});
