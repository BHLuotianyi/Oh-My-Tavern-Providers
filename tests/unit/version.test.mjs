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

    // npm requires semver in package.json; both copies must describe the same
    // release as the display string.
    const semver = EXTENSION_VERSION.replace(/^v/, '').replace(/_/g, '-');
    assert.equal(clientPackage.version, semver);
    assert.equal(serverPackage.version, semver);
    assert.equal(clientPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.equal(serverPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.match(semver, /^\d+\.\d+\.\d+/);
});
