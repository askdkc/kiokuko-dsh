import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../../src/commands/doctor.js";
import { exportWorkspace } from "../../src/commands/export.js";
import { importWorkspace } from "../../src/commands/import.js";
import { openConnection } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { recordEntry, type EntryRecord } from "../../src/memory/entries.js";
import {
  canonicalContentHash,
  canonicalJson,
  canonicalTagOrder,
  type JsonObject,
} from "../../src/serialization/validate.js";

const LEGACY_TAG_ORDER = ["漢", "😀", "z", "å", "ä", "a"];
const REVISION_TRIGGER = `CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END`;

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const databasePath = path.join(directory, "kiokuko-dsh.sqlite3");
  const db = openConnection(databasePath);
  migrateDatabase(db);
  return { db, databasePath, directory };
}

function structuredV2Scope(): JsonObject {
  return { schemaVersion: 2, visibility: "project" };
}

function structuredV3Scope(): JsonObject {
  return {
    schemaVersion: 3,
    visibility: "project",
    retrievalScope: "project-only",
  };
}

function legacyHash(entry: EntryRecord, tags: string[]): string {
  return canonicalContentHash({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope: entry.scope,
    provenance: entry.provenance,
    tags,
  });
}

function installLegacyRevisionHash(
  db: ReturnType<typeof openConnection>,
  entry: EntryRecord,
  hashOrder: string[],
  persistedOrder: string[] = hashOrder,
): string {
  const contentHash = legacyHash(entry, hashOrder);
  db.exec("DROP TRIGGER entry_revisions_immutable_update");
  db.prepare(
    "UPDATE entry_revisions SET content_hash = ? WHERE entry_id = ? AND revision = ?",
  ).run(contentHash, entry.id, entry.revision);
  db.prepare(
    "DELETE FROM entry_revision_tags WHERE entry_id = ? AND revision = ?",
  ).run(entry.id, entry.revision);
  for (const tag of persistedOrder) {
    db.prepare(
      "INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)",
    ).run(entry.id, entry.revision, tag);
  }
  db.exec(REVISION_TRIGGER);
  return contentHash;
}

function archiveWithLegacyHash(content: string, tags: string[]): string {
  const lines = content
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const entry = lines.find((line) => line.type === "entry");
  if (entry === undefined) throw new Error("test archive entry is missing");
  entry.content_hash = canonicalContentHash({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope: JSON.parse(String(entry.scope_json)),
    provenance: JSON.parse(String(entry.provenance_json)),
    tags,
  });
  const firstTagIndex = lines.findIndex((line) => line.type === "tag");
  const withoutTags = lines.filter((line) => line.type !== "tag");
  const tagLines = tags.map((tag) => ({
    type: "tag",
    entry_id: entry.id,
    tag,
  }));
  withoutTags.splice(firstTagIndex, 0, ...tagLines);
  const payload = `${withoutTags.map((line) => canonicalJson(line)).join("\n")}\n`;
  const checksum = createHash("sha256").update(payload, "utf8").digest("hex");
  return `${canonicalJson({ type: "checksum", sha256: checksum })}\n${payload}`;
}

test("doctor rejects every post-migration legacy tag hash preimage", async () => {
  const exact = await database("doctor-exact-legacy-hash");
  const forged = await database("doctor-forged-legacy-hash");
  try {
    const exactEntry = recordEntry(exact.db, {
      workspace: "project:doctor-exact-legacy-hash",
      kind: "lesson",
      title: "Released locale ordering",
      body: "The persisted insertion order is the bounded legacy preimage.",
      scope: structuredV3Scope(),
      tags: LEGACY_TAG_ORDER,
    });
    installLegacyRevisionHash(exact.db, exactEntry, LEGACY_TAG_ORDER);

    const forgedEntry = recordEntry(forged.db, {
      workspace: "project:doctor-forged-legacy-hash",
      kind: "lesson",
      title: "Forged locale ordering",
      body: "A different persisted order must not validate the stored hash.",
      scope: structuredV3Scope(),
      tags: LEGACY_TAG_ORDER,
    });
    installLegacyRevisionHash(
      forged.db,
      forgedEntry,
      LEGACY_TAG_ORDER,
      [...LEGACY_TAG_ORDER].reverse(),
    );

    const exactReport = await runDoctor({
      databasePath: exact.databasePath,
      runtimeDescriptorPath: path.join(exact.directory, "runtime.json"),
    });
    const forgedReport = await runDoctor({
      databasePath: forged.databasePath,
      runtimeDescriptorPath: path.join(forged.directory, "runtime.json"),
    });

    assert.deepEqual(exactReport.checks.revisionHashes, {
      ok: false,
      count: 1,
    });
    assert.deepEqual(forgedReport.checks.revisionHashes, {
      ok: false,
      count: 1,
    });
  } finally {
    exact.db.close();
    forged.db.close();
  }
});

test("doctor rejects a missing canonical revision-hash format marker", async () => {
  const source = await database("doctor-missing-revision-hash-format");
  try {
    source.db.prepare("DELETE FROM entry_revision_hash_format").run();
    const report = await runDoctor({
      databasePath: source.databasePath,
      runtimeDescriptorPath: path.join(source.directory, "runtime.json"),
    });
    assert.deepEqual(report.checks.revisionHashes, { ok: false, count: 1 });
  } finally {
    source.db.close();
  }
});

test("memory export uses canonical tag order instead of SQLite binary order", async () => {
  const source = await database("archive-canonical-tag-source");
  const target = await database("archive-canonical-tag-target");
  const archivePath = path.join(source.directory, "memory.jsonl");
  const tags = ["\uE000", "\u{10000}"];
  try {
    recordEntry(source.db, {
      workspace: "project:archive-canonical-tags",
      kind: "fact",
      title: "Portable canonical tags",
      body: "UTF-16 order and SQLite UTF-8 binary order differ for this pair.",
      tags,
    });
    const exported = exportWorkspace(source.db, {
      workspace: "project:archive-canonical-tags",
    });
    const tagLines = exported.content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === "tag")
      .map((line) => line.tag);
    assert.deepEqual(tagLines, canonicalTagOrder(tags));

    await writeFile(archivePath, exported.content, "utf8");
    await importWorkspace(target.db, { input: archivePath });
    assert.equal(
      exportWorkspace(target.db, {
        workspace: "project:archive-canonical-tags",
      }).content,
      exported.content,
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("memory archive rejects noncanonical revision hashes without a legacy branch", async () => {
  const source = await database("archive-legacy-source");
  const target = await database("archive-legacy-target");
  const archivePath = path.join(source.directory, "legacy.jsonl");
  try {
    const entry = recordEntry(source.db, {
      workspace: "project:archive-legacy-hash",
      kind: "lesson",
      title: "Legacy archive hash",
      body: "Noncanonical revision hashes are rejected at every runtime boundary.",
      scope: structuredV2Scope(),
      tags: LEGACY_TAG_ORDER,
    });
    const canonicalArchive = exportWorkspace(source.db, {
      workspace: entry.workspace,
    }).content;
    await writeFile(
      archivePath,
      archiveWithLegacyHash(canonicalArchive, LEGACY_TAG_ORDER),
      "utf8",
    );
    await assert.rejects(
      importWorkspace(target.db, { input: archivePath, dryRun: true }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INTEGRITY_ERROR",
    );

    installLegacyRevisionHash(source.db, entry, LEGACY_TAG_ORDER);
    assert.throws(
      () => exportWorkspace(source.db, { workspace: entry.workspace }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INTEGRITY_ERROR",
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});
