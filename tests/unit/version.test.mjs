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

    // npm requires semver; `main` ships the bare release line.
    assert.equal(clientPackage.version, EXTENSION_VERSION);
    assert.equal(serverPackage.version, EXTENSION_VERSION);
    assert.equal(clientPackage.versionCode, EXTENSION_VERSION_CODE);
    assert.equal(serverPackage.versionCode, EXTENSION_VERSION_CODE);

    // The per-push `+git.<sha>` identity is gone: `main` carries the release
    // line, and only the nightly channel appends build metadata.
    assert.doesNotMatch(EXTENSION_VERSION, /\+git\./);
});
