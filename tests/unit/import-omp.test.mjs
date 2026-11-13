import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import { importFromOmp, importOmpCredentials } from '../../server-plugin/lib/import-omp.mjs';
import { KeyStore } from '../../server-plugin/lib/key-store.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omtp-import-test-'));
}

async function createSqliteDb(dbPath, initSql) {
  try {
    const sqlite = await import('node:sqlite');
    if (typeof sqlite?.DatabaseSync === 'function') {
      const db = new sqlite.DatabaseSync(dbPath);
      try {
        db.exec(initSql);
      } finally {
        db.close();
      }
      return true;
    }
  } catch {
    // Try sqlite3 CLI below.
  }
  try {
    child_process.execFileSync('sqlite3', [dbPath, initSql]);
    return true;
  } catch {
    return false;
  }
}

function hasCliOrPythonSqlite() {
  try {
    child_process.execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    // Check python3 / python sqlite3 module.
  }
  for (const py of ['python3', 'python']) {
    try {
      child_process.execFileSync(py, ['-c', 'import sqlite3'], { stdio: 'ignore' });
      return true;
    } catch {
      // Try next.
    }
  }
  return false;
}

test('importOmpCredentials returns available=false when agent.db is missing', async () => {
  const dir = tempDir();
  const store = new KeyStore({ root: dir, resolveStSecret: () => '' });
  const result = await importOmpCredentials({ keyStore: store, homeDir: dir });
  assert.equal(result.available, false);
  assert.equal(result.imported, 0);
  assert.deepEqual(result.providers, []);
});

test('importOmpCredentials imports API keys from an agent.db SQLite database', async (t) => {
  const dir = tempDir();
  const agentDir = path.join(dir, '.omp', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, 'agent.db');

  // Create SQLite database with mock credentials
  const initSql = `
    CREATE TABLE auth_credentials (
      provider TEXT,
      credential_type TEXT,
      data TEXT,
      disabled_cause TEXT
    );
    INSERT INTO auth_credentials VALUES ('cerebras', 'api_key', '{"apiKey":"test-cerebras-key"}', NULL);
    INSERT INTO auth_credentials VALUES ('groq', 'api_key', '{"key":"test-groq-key"}', NULL);
    INSERT INTO auth_credentials VALUES ('disabled_prov', 'api_key', '{"key":"disabled"}', 'revoked');
    INSERT INTO auth_credentials VALUES ('oauth_prov', 'oauth', '{"token":"oauth"}', NULL);
  `;

  if (!await createSqliteDb(dbPath, initSql)) {
    t.skip('no sqlite available');
    return;
  }

  const store = new KeyStore({ root: dir, resolveStSecret: () => '' });
  const result = await importOmpCredentials({ keyStore: store, homeDir: dir });

  assert.equal(result.available, true);
  assert.equal(result.imported, 2);
  assert.deepEqual(result.providers, ['cerebras', 'groq']);
  assert.deepEqual(result.skipped, []);

  const cerebrasCfg = await store.getProviderConfig('cerebras');
  assert.equal(cerebrasCfg.apiKey, 'test-cerebras-key');

  const groqCfg = await store.getProviderConfig('groq');
  assert.equal(groqCfg.apiKey, 'test-groq-key');
});

test('importOmpCredentials keeps importing valid rows and records skipped rows when one row fails', async (t) => {
  const dir = tempDir();
  const agentDir = path.join(dir, '.omp', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, 'agent.db');

  const initSql = `
    CREATE TABLE auth_credentials (
      provider TEXT,
      credential_type TEXT,
      data TEXT,
      disabled_cause TEXT
    );
    INSERT INTO auth_credentials VALUES ('bad/provider', 'api_key', '{"apiKey":"bad-key"}', NULL);
    INSERT INTO auth_credentials VALUES ('cerebras', 'api_key', '{"apiKey":"good-key"}', NULL);
  `;

  if (!await createSqliteDb(dbPath, initSql)) {
    t.skip('no sqlite available');
    return;
  }

  const store = new KeyStore({ root: dir, resolveStSecret: () => '' });
  const result = await importOmpCredentials({ keyStore: store, homeDir: dir });

  assert.equal(result.available, true);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.providers, ['cerebras']);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].provider, 'bad/provider');
  assert.match(result.skipped[0].reason, /Invalid provider id/);
  assert.equal((await store.getProviderConfig('cerebras')).apiKey, 'good-key');
});

test('importOmpCredentials works via CLI fallback when node:sqlite is bypassed', async (t) => {
  if (!hasCliOrPythonSqlite()) {
    t.skip('sqlite3 CLI and python3 sqlite3 unavailable');
    return;
  }
  const dir = tempDir();
  const agentDir = path.join(dir, '.omp', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, 'agent.db');

  const initSql = `
    CREATE TABLE auth_credentials (
      provider TEXT,
      credential_type TEXT,
      data TEXT,
      disabled_cause TEXT
    );
    INSERT INTO auth_credentials VALUES ('mistral', 'api_key', '{"apiKey":"mistral-fallback-key"}', NULL);
  `;

  if (!await createSqliteDb(dbPath, initSql)) {
    t.skip('no sqlite available');
    return;
  }

  const store = new KeyStore({ root: dir, resolveStSecret: () => '' });
  const result = await importOmpCredentials({ keyStore: store, homeDir: dir, _forceFallback: true });

  assert.equal(result.available, true);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.providers, ['mistral']);

  const mistralCfg = await store.getProviderConfig('mistral');
  assert.equal(mistralCfg.apiKey, 'mistral-fallback-key');
});

test('importFromOmp reports found=false for a missing catalog path', async () => {
  const dir = tempDir();
  const store = new KeyStore({ root: dir, resolveStSecret: () => '' });
  const result = await importFromOmp({ catalogPath: '/non/existent/path', credentials: false, keyStore: store });
  assert.equal(result.found, false);
});
