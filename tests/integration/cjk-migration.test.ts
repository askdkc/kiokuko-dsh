import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../../src/commands/doctor.js";
import { openConnection } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import {
  hybridSearchProjectionStatus,
  rebuildHybridSearch,
} from "../../src/memory/rebuild-search.js";
import {
  canonicalEntryRevisionContentHash,
  canonicalJson,
} from "../../src/serialization/validate.js";

const migrationsSource = path.resolve(import.meta.dirname, "../../migrations");

async function migrationFixture(): Promise<{
  databasePath: string;
  migrationsDirectory: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "kiokuko-cjk-migration-"),
  );
  const migrationsDirectory = path.join(directory, "migrations");
  await mkdir(migrationsDirectory);
  const names = (await readdir(migrationsSource))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) {
    if (Number(name.slice(0, 3)) > 19) continue;
    await copyFile(
      path.join(migrationsSource, name),
      path.join(migrationsDirectory, name),
    );
  }
  return {
    databasePath: path.join(directory, "kiokuko-dsh.sqlite3"),
    migrationsDirectory,
  };
}

function seedJapaneseEntry(database: ReturnType<typeof openConnection>): void {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const revision = {
    kind: "decision" as const,
    title: "履歴保全方針",
    body: "過去のマイグレーションは直接編集せず、新しいファイルで前方移行する。",
    summary: null,
    scope: {},
    provenance: {},
    tags: ["履歴保全"],
  };
  database
    .prepare(
      `
    INSERT INTO entries (
      id, workspace, status, trust_level, confidence, current_revision,
      superseded_by, created_by, created_at, updated_at, verified_at
    ) VALUES ('entry-cjk-upgrade', 'project:cjk-upgrade', 'verified', 'user_asserted', 1, 1,
      NULL, 'test', ?, ?, ?)
  `,
    )
    .run(timestamp, timestamp, timestamp);
  database
    .prepare(
      `
    INSERT INTO entry_revisions (
      entry_id, workspace, revision, kind, title, body, summary, scope_json,
      provenance_json, content_hash, created_by, created_at
    ) VALUES ('entry-cjk-upgrade', 'project:cjk-upgrade', 1, ?, ?, ?, NULL, ?, ?, ?, 'test', ?)
  `,
    )
    .run(
      revision.kind,
      revision.title,
      revision.body,
      canonicalJson(revision.scope),
      canonicalJson(revision.provenance),
      canonicalEntryRevisionContentHash(revision),
      timestamp,
    );
  database
    .prepare(
      `
    INSERT INTO entry_revision_tags (entry_id, revision, tag)
    VALUES ('entry-cjk-upgrade', 1, '履歴保全')
  `,
    )
    .run();
  const rowid = database
    .prepare("SELECT rowid FROM entries WHERE id = 'entry-cjk-upgrade'")
    .get<{ rowid: number }>()?.rowid;
  assert.ok(rowid);
  const projection = [
    rowid,
    revision.title,
    revision.body,
    "",
    "履歴保全",
  ] as const;
  database
    .prepare(
      "INSERT INTO entries_fts(rowid, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?)",
    )
    .run(...projection);
  database
    .prepare(
      "INSERT INTO entries_trigram(rowid, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?)",
    )
    .run(...projection);
  database
    .prepare(
      `
    INSERT INTO entry_search_signals(entry_id, signal_type, normalized_value)
    VALUES ('entry-cjk-upgrade', 'tag', '履歴保全')
  `,
    )
    .run();
}

test("migration 020 preserves current rows and rebuilds separate external-content word and trigram indexes", async () => {
  const fixture = await migrationFixture();
  const database = openConnection(fixture.databasePath);
  try {
    assert.equal(
      migrateDatabase(database, fixture.migrationsDirectory).currentVersion,
      19,
    );
    seedJapaneseEntry(database);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM entries_fts WHERE entries_fts MATCH ?",
        )
        .get<{ count: number }>('"マイグレーション"')?.count,
      0,
    );

    await copyFile(
      path.join(migrationsSource, "020_cjk_fts.sql"),
      path.join(fixture.migrationsDirectory, "020_cjk_fts.sql"),
    );
    assert.deepEqual(
      migrateDatabase(database, fixture.migrationsDirectory).applied,
      [20],
    );

    const wordDefinition =
      database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'")
        .get<{ sql: string }>()?.sql ?? "";
    const trigramDefinition =
      database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_trigram'")
        .get<{ sql: string }>()?.sql ?? "";
    assert.match(wordDefinition, /content='entry_search_documents'/u);
    assert.match(wordDefinition, /content_rowid='entry_rowid'/u);
    assert.match(wordDefinition, /unicode61 remove_diacritics 2/u);
    assert.match(trigramDefinition, /content='entry_search_documents'/u);
    assert.match(trigramDefinition, /content_rowid='entry_rowid'/u);
    assert.match(trigramDefinition, /tokenize='trigram'/u);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM entry_search_documents")
        .get<{ count: number }>()?.count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM entries_trigram WHERE entries_trigram MATCH ?",
        )
        .get<{ count: number }>('"マイグレーション"')?.count,
      1,
    );
    assert.deepEqual(hybridSearchProjectionStatus(database), {
      entries: 1,
      trigram: 1,
      signals: 1,
      missingSignals: 0,
      extraSignals: 0,
      staleTrigram: 0,
    });
  } finally {
    database.close();
  }

  const doctor = await runDoctor({
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
  });
  assert.equal(doctor.checks.fts.ok, true, doctor.checks.fts.detail);
  assert.match(doctor.checks.fts.detail ?? "", /currentMismatches=0/u);
  assert.equal(
    doctor.checks.hybridSearch.ok,
    true,
    doctor.checks.hybridSearch.detail,
  );
  assert.match(
    doctor.checks.hybridSearch.detail ?? "",
    /missingSignals=0.*staleTrigram=0/u,
  );
});

test("doctor rejects an empty external FTS index and rebuild restores MATCH", async () => {
  const fixture = await migrationFixture();
  const database = openConnection(fixture.databasePath);
  try {
    assert.equal(
      migrateDatabase(database, fixture.migrationsDirectory).currentVersion,
      19,
    );
    seedJapaneseEntry(database);
    await copyFile(
      path.join(migrationsSource, "020_cjk_fts.sql"),
      path.join(fixture.migrationsDirectory, "020_cjk_fts.sql"),
    );
    assert.deepEqual(
      migrateDatabase(database, fixture.migrationsDirectory).applied,
      [20],
    );
    database
      .prepare(
        "INSERT INTO entries_trigram(entries_trigram) VALUES ('delete-all')",
      )
      .run();
  } finally {
    database.close();
  }

  const broken = await runDoctor({
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.checks.hybridSearch.ok, false);

  const repaired = openConnection(fixture.databasePath);
  try {
    rebuildHybridSearch(repaired);
    assert.equal(
      repaired
        .prepare(
          "SELECT COUNT(*) AS count FROM entries_trigram WHERE entries_trigram MATCH ?",
        )
        .get<{ count: number }>('"マイグレーション"')?.count,
      1,
    );
    assert.doesNotThrow(() => hybridSearchProjectionStatus(repaired));
  } finally {
    repaired.close();
  }
});

test("the bundled migration 020 rollback restores both legacy indexes and the schema marker", async () => {
  const fixture = await migrationFixture();
  const database = openConnection(fixture.databasePath);
  try {
    assert.equal(
      migrateDatabase(database, fixture.migrationsDirectory).currentVersion,
      19,
    );
    seedJapaneseEntry(database);
    await copyFile(
      path.join(migrationsSource, "020_cjk_fts.sql"),
      path.join(fixture.migrationsDirectory, "020_cjk_fts.sql"),
    );
    assert.deepEqual(
      migrateDatabase(database, fixture.migrationsDirectory).applied,
      [20],
    );
    const down = await readFile(
      path.join(migrationsSource, "down", "020_cjk_fts.sql"),
      "utf8",
    );
    database.exec(down);

    assert.equal(
      database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get<{ version: number }>()?.version,
      19,
    );
    const wordDefinition =
      database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'")
        .get<{ sql: string }>()?.sql ?? "";
    const trigramDefinition =
      database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_trigram'")
        .get<{ sql: string }>()?.sql ?? "";
    assert.match(wordDefinition, /unicode61 remove_diacritics 2/u);
    assert.match(trigramDefinition, /tokenize='trigram'/u);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM entries_fts")
        .get<{ count: number }>()?.count,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM entries_trigram")
        .get<{ count: number }>()?.count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE name = 'entry_search_documents'",
        )
        .get(),
      undefined,
    );
  } finally {
    database.close();
  }
});
