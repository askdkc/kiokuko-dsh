import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';

test('rejects a legacy mutable-memory migration history instead of upgrading it in place', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-release-legacy-'));
  const databasePath = path.join(root, 'legacy.sqlite3');
  const database = openConnection(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, summary TEXT, scope_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL, trust_level TEXT NOT NULL, confidence REAL NOT NULL,
        content_hash TEXT NOT NULL, revision INTEGER NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, ?, ?, ?)').run(
      '001_initial.sql',
      'bb4c8d69a418ee809fa057e4c656a65b896357ac222d86cfaf711cecddc41496',
      '2026-08-21T00:00:00.000Z',
    );
    database.prepare('INSERT INTO entries (id, workspace, kind, status, title, body, summary, scope_json, provenance_json, trust_level, confidence, content_hash, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-entry', 'project:legacy', 'lesson', 'candidate', 'Legacy', 'Legacy body', null, '{}', '{}', 'user_asserted', 0.5, 'a'.repeat(64), 1, 'test', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
    );
  } finally {
    database.close();
  }

  await assert.rejects(
    initializeDatabase({ databasePath }),
    (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /checksum mismatch/i.test((error as Error).message),
  );

  const unchanged = openConnection(databasePath);
  try {
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(unchanged.prepare('SELECT body FROM entries WHERE id = ?').get<{ body: string }>('legacy-entry')?.body, 'Legacy body');
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_revisions'").get(), undefined);
  } finally {
    unchanged.close();
  }
});
