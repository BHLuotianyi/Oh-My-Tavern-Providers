import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_VERSION, EXTENSION_VERSION_CODE } from '../../src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('release identity is consistent across manifest, packages and constants', () => {
    const manifest = readJson('manifest.json');
    const clientPackage = readJson('package.json');
    const serverPackage = readJson('server-plugin/package.json');

    // SillyTavern reads `manifest.version` verbatim, so it is the display string.
    assert.equal(manifest.version, EXTENSION_VERSION);
    assert.equal(manifest.versionCode, EXTENSION_VERSION_CODE);

    // npm requires semver, so `1.0.2_beta_20261029002` becomes
    // `1.0.2-beta.20261029002`: the first separator opens the prerelease, the
    // remaining ones become its dot-separated identifiers.
    const [core, ...prerelease] = EXTENSION_VERSION.replace(/^v/, '').split('_');
    const semver = prerelease.length ? `${core}-${prerelease.join('.')}` : core;
    assert.equal(clientPackage.version, semver);
    assert.equal(serverPackage.version, semver);
    assert.equal(clientPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.equal(serverPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.match(semver, /^\d+\.\d+\.\d+/);
    assert.match(EXTENSION_VERSION, /^\d+\.\d+\.\d+_[a-z]+_\d+$/);
});
