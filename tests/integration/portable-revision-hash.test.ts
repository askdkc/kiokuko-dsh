import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportWorkspace } from "../../src/commands/export.js";
import { importWorkspace } from "../../src/commands/import.js";
import { initializeDatabase } from "../../src/commands/init.js";
import { openConnection } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { KiokukoError } from "../../src/errors.js";
import {
  readEntry,
  recordEntry,
  type EntryRecord,
  type RecordEntryInput,
} from "../../src/memory/entries.js";
import { readEntryRevision } from "../../src/memory/revisions.js";
import {
  canonicalContentHash,
  canonicalEntryRevisionContentHash,
  canonicalJson,
  canonicalTagOrder,
  type JsonObject,
} from "../../src/serialization/validate.js";

const repositoryMigrations = path.resolve(
  import.meta.dirname,
  "../../migrations",
);
const TAGS = ["漢", "z", "ä", "😀", "a", "å"];
const LEGACY_TAG_ORDER = ["漢", "😀", "z", "å", "ä", "a"];
const REVISION_TRIGGER = `CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END`;

interface V8Database {
  readonly db: ReturnType<typeof openConnection>;
  readonly directory: string;
  readonly databasePath: string;
  readonly migrationsDirectory: string;
}

async function v8Database(prefix: string): Promise<V8Database> {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const databasePath = path.join(directory, "kiokuko-dsh.sqlite3");
  const migrationsDirectory = path.join(directory, "migrations");
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(repositoryMigrations);
  for (let version = 1; version <= 8; version += 1) {
    const prefixValue = `${String(version).padStart(3, "0")}_`;
    const name = migrationFiles.find((candidate) =>
      candidate.startsWith(prefixValue),
    );
    assert.notEqual(name, undefined);
    await copyFile(
      path.join(repositoryMigrations, name as string),
      path.join(migrationsDirectory, name as string),
    );
  }
  const db = openConnection(databasePath);
  assert.deepEqual(
    migrateDatabase(db, migrationsDirectory).applied,
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  return { db, directory, databasePath, migrationsDirectory };
}

async function installMigration009(database: V8Database): Promise<void> {
  await copyFile(
    path.join(repositoryMigrations, "009_external_skill_discovery.sql"),
    path.join(database.migrationsDirectory, "009_external_skill_discovery.sql"),
  );
}

function replaceRevisionWithReleasedPreimage(
  db: ReturnType<typeof openConnection>,
  entry: EntryRecord,
  content: EntryRecord,
  persistedScope: JsonObject,
  hashTags: readonly string[],
  persistedTags: readonly string[] = hashTags,
): string {
  const contentHash = canonicalContentHash({
    kind: content.kind,
    title: content.title,
    body: content.body,
    summary: content.summary,
    scope: persistedScope,
    provenance: content.provenance,
    tags: [...hashTags],
  });
  db.exec("DROP TRIGGER entry_revisions_immutable_update");
  db.prepare(
    `
    UPDATE entry_revisions
       SET kind = ?, title = ?, body = ?, summary = ?, scope_json = ?,
           provenance_json = ?, content_hash = ?
     WHERE entry_id = ? AND revision = ?
  `,
  ).run(
    content.kind,
    content.title,
    content.body,
    content.summary,
    canonicalJson(persistedScope),
    canonicalJson(content.provenance),
    contentHash,
    entry.id,
    entry.revision,
  );
  db.prepare(
    "DELETE FROM entry_revision_tags WHERE entry_id = ? AND revision = ?",
  ).run(entry.id, entry.revision);
  for (const tag of persistedTags) {
    db.prepare(
      "INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)",
    ).run(entry.id, entry.revision, tag);
  }
  db.exec(REVISION_TRIGGER);
  return contentHash;
}

function migrationVersion(db: ReturnType<typeof openConnection>): number {
  return Number(
    db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get<{ version: unknown }>()?.version,
  );
}

test("migration 009 canonicalizes released hashes and scope before runtime, export, and import", async () => {
  const source = await v8Database("canonical-revision-upgrade");
  const input: RecordEntryInput = {
    workspace: "project:canonical-revision-upgrade",
    kind: "lesson",
    title: "One revision hash format",
    body: "Legacy preimages are rewritten at the schema boundary.",
    scope: {
      schemaVersion: 3,
      visibility: "project",
      retrievalScope: "project-only",
      applicability: { frameworks: [{ name: "z" }, { name: "ä" }] },
    },
    provenance: { type: "agent_observation", reference: "migration-009" },
    tags: TAGS,
  };
  try {
    const entry = recordEntry(source.db, input);
    const persistedScope: JsonObject = {
      ...entry.scope,
      applicability: { frameworks: [{ name: "ä" }, { name: "z" }] },
    };
    const legacyHash = replaceRevisionWithReleasedPreimage(
      source.db,
      entry,
      entry,
      persistedScope,
      LEGACY_TAG_ORDER,
    );
    assert.notEqual(legacyHash, entry.contentHash);

    await installMigration009(source);
    const initialized = await initializeDatabase({
      databasePath: source.databasePath,
      migrationsDirectory: source.migrationsDirectory,
    });
    assert.deepEqual(initialized.applied, [9]);
    assert.notEqual(initialized.backupPath, null);
    assert.equal(migrationVersion(source.db), 9);
    assert.deepEqual(
      {
        ...source.db
          .prepare(
            "SELECT singleton, algorithm FROM entry_revision_hash_format",
          )
          .get(),
      },
      { singleton: 1, algorithm: "canonical-json-utf16-tags-v1" },
    );

    const upgraded = readEntry(source.db, {
      workspace: entry.workspace,
      entryId: entry.id,
    });
    assert.equal(
      upgraded.contentHash,
      canonicalEntryRevisionContentHash(upgraded),
    );
    assert.deepEqual(upgraded.tags, canonicalTagOrder(TAGS));
    assert.deepEqual(
      (
        (upgraded.scope.applicability as JsonObject).frameworks as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
      ["z", "ä"],
    );
    const replay = recordEntry(source.db, input);
    assert.equal(replay.id, entry.id);
    assert.equal(
      source.db
        .prepare("SELECT COUNT(*) AS count FROM entries WHERE workspace = ?")
        .get<{ count: number }>(entry.workspace)?.count,
      1,
    );
    const normalizedWrite = recordEntry(source.db, {
      ...input,
      workspace: `${entry.workspace}:new`,
      scope: persistedScope,
    });
    assert.deepEqual(
      (
        (normalizedWrite.scope.applicability as JsonObject)
          .frameworks as Array<{ name: string }>
      ).map(({ name }) => name),
      ["z", "ä"],
    );

    const archive = exportWorkspace(source.db, { workspace: entry.workspace });
    const archivePath = path.join(source.directory, "memory.jsonl");
    await writeFile(archivePath, archive.content, "utf8");
    const targetDirectory = await mkdtemp(
      path.join(tmpdir(), "kiokuko-canonical-revision-import-"),
    );
    const target = openConnection(
      path.join(targetDirectory, "kiokuko-dsh.sqlite3"),
    );
    try {
      migrateDatabase(target);
      assert.equal(
        (await importWorkspace(target, { input: archivePath })).imported,
        1,
      );
      assert.equal(
        exportWorkspace(target, { workspace: entry.workspace }).content,
        archive.content,
      );
    } finally {
      target.close();
    }
  } finally {
    source.db.close();
  }
});

test("migration 009 rejects an unbound legacy preimage and rolls back every schema change", async () => {
  const source = await v8Database("forged-revision-upgrade");
  try {
    const entry = recordEntry(source.db, {
      workspace: "project:forged-revision-upgrade",
      kind: "lesson",
      title: "Reject forged preimage",
      body: "The hash must bind the exact persisted tag order.",
      tags: TAGS,
    });
    const legacyHash = replaceRevisionWithReleasedPreimage(
      source.db,
      entry,
      entry,
      entry.scope,
      LEGACY_TAG_ORDER,
      [...LEGACY_TAG_ORDER].reverse(),
    );
    await installMigration009(source);

    assert.throws(
      () => migrateDatabase(source.db, source.migrationsDirectory),
      (error: unknown) =>
        error instanceof KiokukoError && error.code === "INTEGRITY_ERROR",
    );
    assert.equal(migrationVersion(source.db), 8);
    assert.equal(
      source.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE name = 'entry_revision_hash_format'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      source.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE name = 'agent_task_skill_discovery_attempts'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      source.db
        .prepare("SELECT content_hash FROM entry_revisions WHERE entry_id = ?")
        .get<{ content_hash: string }>(entry.id)?.content_hash,
      legacyHash,
    );
    assert.notEqual(
      source.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'entry_revisions_immutable_update'",
        )
        .get(),
      undefined,
    );
  } finally {
    source.db.close();
  }
});

test("initializeDatabase recovers an unreadable revision chain from its pre-upgrade backup", async () => {
  const source = await v8Database("recover-revision-chain");
  let entry: EntryRecord;
  try {
    entry = recordEntry(source.db, {
      workspace: "project:recover-revision-chain",
      kind: "lesson",
      title: "Unreadable chain",
      body: "The backup keeps this original row while setup recovers the active database.",
    });
    source.db.exec(`
      CREATE TABLE recovery_entry_ref (entry_id TEXT NOT NULL REFERENCES entries(id));
      CREATE TABLE recovery_revision_ref (
        entry_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision)
      );
    `);
    source.db
      .prepare("INSERT INTO recovery_entry_ref (entry_id) VALUES (?)")
      .run(entry.id);
    source.db
      .prepare(
        "INSERT INTO recovery_revision_ref (entry_id, revision) VALUES (?, ?)",
      )
      .run(entry.id, entry.revision);
    source.db.exec("DROP TRIGGER entry_revisions_immutable_update");
    source.db
      .prepare(
        `
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        entry.id,
        entry.workspace,
        entry.kind,
        entry.title,
        entry.body,
        entry.summary,
        canonicalJson(entry.scope),
        canonicalJson(entry.provenance),
        "0".repeat(64),
        entry.createdBy,
        entry.updatedAt,
      );
    source.db
      .prepare("UPDATE entries SET current_revision = 4 WHERE id = ?")
      .run(entry.id);
    source.db.exec(REVISION_TRIGGER);
    await installMigration009(source);
  } finally {
    source.db.close();
  }

  const initialized = await initializeDatabase({
    databasePath: source.databasePath,
    migrationsDirectory: source.migrationsDirectory,
  });
  assert.deepEqual(initialized.applied, [9]);
  assert.equal(initialized.recoveredEntries, 1);
  const upgraded = openConnection(source.databasePath, { readOnly: true });
  try {
    assert.equal(
      upgraded
        .prepare("SELECT COUNT(*) AS count FROM entries")
        .get<{ count: number }>()?.count,
      0,
    );
    assert.equal(
      upgraded
        .prepare("SELECT COUNT(*) AS count FROM recovery_entry_ref")
        .get<{ count: number }>()?.count,
      0,
    );
    assert.equal(
      upgraded
        .prepare("SELECT COUNT(*) AS count FROM recovery_revision_ref")
        .get<{ count: number }>()?.count,
      0,
    );
    assert.equal(
      upgraded
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get<{ version: number }>()?.version,
      9,
    );
  } finally {
    upgraded.close();
  }
  const backup = openConnection(initialized.backupPath!, { readOnly: true });
  try {
    assert.equal(
      backup
        .prepare("SELECT COUNT(*) AS count FROM entries WHERE id = ?")
        .get<{ count: number }>(entry.id)?.count,
      1,
    );
  } finally {
    backup.close();
  }
});

test("migration 009 rejects canonical identity collisions without partially rewriting rows", async () => {
  const source = await v8Database("colliding-revision-upgrade");
  try {
    const canonical = recordEntry(source.db, {
      workspace: "project:colliding-revision-upgrade",
      kind: "lesson",
      title: "Canonical identity",
      body: "Only one revision may own a canonical content identity.",
      tags: TAGS,
    });
    const seed = recordEntry(source.db, {
      workspace: canonical.workspace,
      kind: "fact",
      title: "Collision seed",
      body: "This row models released data with a distinct stored hash.",
      tags: ["seed"],
    });
    const legacyHash = replaceRevisionWithReleasedPreimage(
      source.db,
      seed,
      canonical,
      canonical.scope,
      LEGACY_TAG_ORDER,
    );
    assert.notEqual(legacyHash, canonical.contentHash);
    await installMigration009(source);

    assert.throws(
      () => migrateDatabase(source.db, source.migrationsDirectory),
      (error: unknown) =>
        error instanceof KiokukoError &&
        error.code === "INTEGRITY_ERROR" &&
        /collide/u.test(error.message),
    );
    assert.equal(migrationVersion(source.db), 8);
    assert.equal(
      source.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE name = 'agent_task_skill_discovery_attempts'",
        )
        .get(),
      undefined,
    );
    assert.deepEqual(
      source.db
        .prepare(
          "SELECT entry_id, content_hash FROM entry_revisions ORDER BY entry_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { entry_id: canonical.id, content_hash: canonical.contentHash },
        { entry_id: seed.id, content_hash: legacyHash },
      ].sort((left, right) => (left.entry_id < right.entry_id ? -1 : 1)),
    );
  } finally {
    source.db.close();
  }
});

test("post-migration runtime rejects legacy hashes instead of entering a compatibility path", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "kiokuko-runtime-revision-clean-break-"),
  );
  const db = openConnection(path.join(directory, "kiokuko-dsh.sqlite3"));
  try {
    migrateDatabase(db);
    const entry = recordEntry(db, {
      workspace: "project:runtime-revision-clean-break",
      kind: "lesson",
      title: "No runtime fallback",
      body: "A legacy hash introduced after migration is corruption.",
      tags: TAGS,
    });
    replaceRevisionWithReleasedPreimage(
      db,
      entry,
      entry,
      entry.scope,
      LEGACY_TAG_ORDER,
    );

    for (const operation of [
      () => readEntry(db, { workspace: entry.workspace, entryId: entry.id }),
      () =>
        readEntryRevision(db, {
          workspace: entry.workspace,
          entryId: entry.id,
          revision: entry.revision,
        }),
      () => exportWorkspace(db, { workspace: entry.workspace }),
    ]) {
      assert.throws(
        operation,
        (error: unknown) =>
          error instanceof KiokukoError && error.code === "INTEGRITY_ERROR",
      );
    }
  } finally {
    db.close();
  }
});
