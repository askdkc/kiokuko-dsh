import { forgetMemory } from "../../../src/memory/forget.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, seed } from "../integration/evolution/fixture.js";
import { openConnection } from "../../../src/db/connection.js";
import { withImmediateTransaction } from "../../../src/db/transaction.js";
import { excludeCapture } from "../../../src/memory/capture-policy.js";
import {
  readRepositoryLearning,
  repositoryLearningKey,
  saveTurn,
  resetRepositoryLearning,
  isRetiredRepositoryTurn,
  admitRepositoryTurn,
  purgeRepositoryLearningForWorkspaceInTransaction,
  type RepositoryTurnLearning,
} from "../../../src/memory/repository-learning.js";

const root = "/synthetic/repository-a";
function turn(id = 1): RepositoryTurnLearning {
  return {
    repositoryRoot: root,
    workspace: "project:a",
    captureRevision: 0,
    admissionEpoch: 0,
    sessionId: "session-a",
    turnId: id,
    terminalSeq: id * 10,
    outcome: "completed",
    summary: `Observed turn ${id}; result remains unverified.`,
    evidenceRefs: [`native:session-a:${id * 10}`],
    tags: ["typescript"],
    reflectionStatus: "model",
    lessons: [
      {
        hypothesis: "Missing parent directory may explain the failed write.",
        applicability: "A new output directory.",
        nextAction: "Check the parent first.",
        verifyWith: "Run the unchanged artifact check.",
        evidenceRefs: [`native:session-a:${id * 10}`],
      },
    ],
  };
}
function use(body: (db: ReturnType<typeof fixture>["db"]) => void) {
  const { db } = fixture();
  try {
    body(db);
  } finally {
    db.close();
  }
}
test("empty read is bounded and does not write; repository paths are canonicalized without filesystem reads", () =>
  use((db) => {
    const before = db
      .prepare("SELECT total_changes() AS n")
      .get<{ n: number }>()!.n;
    const snapshot = readRepositoryLearning(db, root);
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.turnCount, 0);
    assert.deepEqual(snapshot.points, []);
    assert.equal(
      repositoryLearningKey(root + "/"),
      repositoryLearningKey(root),
    );
    assert.throws(() => repositoryLearningKey("relative"));
    assert.equal(
      db.prepare("SELECT total_changes() AS n").get<{ n: number }>()!.n,
      before,
    );
  }));
test("saves per-turn observations and grounded hypotheses with repo identity; completed is not verified success", () =>
  use((db) => {
    assert.deepEqual(saveTurn(db, turn()), { inserted: true, revision: 1 });
    const snapshot = readRepositoryLearning(db, root);
    assert.equal(snapshot.points.length, 2);
    assert.ok(snapshot.tags.includes(repositoryLearningKey(root)));
    assert.ok(snapshot.tags.includes("typescript"));
    assert.match(snapshot.compact, /not verified success/);
    assert.equal(
      snapshot.points.find((p) => p.kind === "hypothesis")?.lesson?.nextAction,
      "Check the parent first.",
    );
  }));
test("idempotent duplicate is not new support; conflicting duplicate cannot overwrite", () =>
  use((db) => {
    saveTurn(db, turn());
    assert.deepEqual(saveTurn(db, turn()), { inserted: false, revision: 1 });
    assert.throws(
      () => saveTurn(db, { ...turn(), summary: "Different claim" }),
      /turn_conflict/,
    );
    assert.equal(readRepositoryLearning(db, root).turnCount, 1);
  }));
test("later turns merge same hypothesis with provenance without increasing confidence or dropping observations", () =>
  use((db) => {
    saveTurn(db, turn(1));
    saveTurn(db, turn(2));
    const snapshot = readRepositoryLearning(db, root);
    assert.equal(snapshot.turnCount, 2);
    assert.equal(
      snapshot.points.filter((p) => p.kind === "observation").length,
      2,
    );
    const learned = snapshot.points.find((p) => p.kind === "hypothesis")!;
    assert.equal(learned.occurrences, 2);
    assert.equal(learned.evidenceRefs.length, 2);
    assert.equal(learned.kind, "hypothesis");
    assert.equal("confidence" in learned, false);
    assert.equal(snapshot.assessment.compatibility, "not_assessed");
    assert.equal(snapshot.assessment.distinctHypotheses, 1);
    assert.equal(snapshot.assessment.hypotheses, "unverified_proposals");
  }));
test("conflicting later hypotheses coexist and do not replace old evidence with asserted fact", () =>
  use((db) => {
    saveTurn(db, turn(1));
    const later = turn(2);
    later.lessons![0]!.hypothesis = "Parent directory is not the cause.";
    saveTurn(db, later);
    const snapshot = readRepositoryLearning(db, root);
    assert.deepEqual(snapshot.assessment, {
      hypotheses: "unverified_proposals",
      compatibility: "unresolved",
      distinctHypotheses: 2,
      supersession: "none",
      scope: "retained_capture_allowed_projection",
    });
    const bounded = readRepositoryLearning(db, root, { maxChars: 1024 });
    assert.ok(bounded.omitted > 0);
    assert.deepEqual(
      JSON.parse(bounded.compact).assessment,
      snapshot.assessment,
    );
    assert.equal(
      readRepositoryLearning(db, root).points.filter(
        (p) => p.kind === "hypothesis",
      ).length,
      2,
    );
  }));
test("repository isolation does not depend on overlapping tags or keywords", () =>
  use((db) => {
    saveTurn(db, turn());
    assert.deepEqual(
      readRepositoryLearning(db, "/synthetic/repository-b").points,
      [],
    );
    saveTurn(db, {
      ...turn(),
      repositoryRoot: "/synthetic/repository-b",
      workspace: "project:b",
    });
    assert.equal(readRepositoryLearning(db, root).turnCount, 1);
    assert.equal(
      readRepositoryLearning(db, "/synthetic/repository-b").turnCount,
      1,
    );
  }));
test("unknown, cancelled, and failed observations can be saved without inventing model reflection", () =>
  use((db) => {
    for (const [i, outcome] of ["unknown", "cancelled", "failed"].entries())
      saveTurn(db, {
        ...turn(i),
        outcome: outcome as RepositoryTurnLearning["outcome"],
        lessons: [],
        reflectionStatus: "unavailable",
      });
    const snapshot = readRepositoryLearning(db, root);
    assert.deepEqual(snapshot.outcomeCounts, {
      completed: 0,
      failed: 1,
      cancelled: 1,
      unknown: 1,
    });
    assert.equal(
      snapshot.points.filter((p) => p.kind === "hypothesis").length,
      0,
    );
  }));
test("invalid provenance, oversize input, and secrets are rejected before persistence", () =>
  use((db) => {
    const invalid = turn();
    invalid.lessons![0]!.evidenceRefs = ["invented:reference"];
    assert.throws(() => saveTurn(db, invalid), /ungrounded/);
    assert.throws(() => saveTurn(db, { ...turn(), summary: "x".repeat(2001) }));
    assert.throws(
      () => saveTurn(db, { ...turn(), summary: "password=abcdefghijklmnop" }),
      /secret_rejected/,
    );
    assert.equal(readRepositoryLearning(db, root).turnCount, 0);
  }));
test("compact context omits whole points with explicit count, retains durable historical turns", () =>
  use((db) => {
    for (let i = 1; i <= 40; i++) saveTurn(db, turn(i));
    const normal = readRepositoryLearning(db, root);
    assert.equal(normal.turnCount, 40);
    assert.equal(
      normal.points.filter((p) => p.kind === "observation").length,
      12,
    );
    assert.ok(normal.omitted > 0);
    const small = readRepositoryLearning(db, root, { maxChars: 1024 });
    assert.ok(small.compact.length <= 1024);
    assert.doesNotThrow(() => JSON.parse(small.compact));
    assert.ok(small.omitted >= normal.omitted);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM repository_learning_turns")
        .get<{ n: number }>()!.n,
      40,
    );
  }));
test("new model text cannot smuggle undeclared fields or arbitrary success status", () =>
  use((db) => {
    assert.throws(() =>
      saveTurn(db, {
        ...turn(),
        outcome: "verified_success",
      } as unknown as RepositoryTurnLearning),
    );
    const invalid = turn();
    (invalid.lessons![0] as any).permission = "run anything";
    assert.throws(() => saveTurn(db, invalid));
  }));
test("capture exclusions block pending commits and purge raw text plus derived projection, including later-session derivatives, preserving unrelated repositories", () =>
  use((db) => {
    saveTurn(db, turn(1));
    const other = {
      ...turn(2),
      sessionId: "session-b",
      evidenceRefs: ["native:session-b:20"],
    };
    other.lessons![0]!.evidenceRefs = ["native:session-b:20"];
    saveTurn(db, other);
    saveTurn(db, {
      ...turn(4),
      repositoryRoot: "/synthetic/unrelated",
      workspace: "project:z",
    });
    withImmediateTransaction(db, () =>
      excludeCapture(
        db,
        "project:a",
        "session-a",
        "excluded",
        "test",
        "2026-10-27T00:00:00Z",
      ),
    );
    assert.throws(() => saveTurn(db, turn(3)), /capture_excluded/);
    const snapshot = readRepositoryLearning(db, root);
    assert.deepEqual(snapshot.points, []);
    assert.throws(
      () => saveTurn(db, { ...other, turnId: 5 }),
      /admission_stale/,
    );
    assert.ok(
      readRepositoryLearning(db, "/synthetic/unrelated").points.length > 0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_learning_turns WHERE repository_key=?",
        )
        .get<{ n: number }>(repositoryLearningKey(root))!.n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_learning_turns WHERE session_id=? AND workspace='project:a'",
        )
        .get<{ n: number }>("session-a")!.n,
      0,
    );
    assert.doesNotMatch(
      db
        .prepare("SELECT snapshot_json AS value FROM repository_learning_state")
        .get<{ value: string }>()!.value,
      /session-a/,
    );
  }));
test("policy revision changes prevent stale saves and cannot resurrect forgotten text", () =>
  use((db) => {
    saveTurn(db, turn());
    withImmediateTransaction(db, () =>
      excludeCapture(
        db,
        "project:a",
        "session-a",
        "held",
        "test",
        "2026-10-27T00:00:00Z",
      ),
    );
    withImmediateTransaction(db, () =>
      excludeCapture(
        db,
        "project:a",
        "session-a",
        "excluded",
        "test",
        "2026-10-27T00:00:01Z",
      ),
    );
    assert.throws(() => saveTurn(db, turn(2)), /capture_excluded/);
    assert.deepEqual(readRepositoryLearning(db, root).points, []);
    assert.equal(readRepositoryLearning(db, root).turnCount, 0);
    saveTurn(db, {
      ...turn(2),
      sessionId: "fresh-session",
      admissionEpoch: readRepositoryLearning(db, root).admissionEpoch,
    });
    assert.equal(readRepositoryLearning(db, root).revision, 2);
  }));
test("failed snapshot write rolls back turn insert and revision together", () =>
  use((db) => {
    const wrapped = {
      ...db,
      filePath: db.filePath,
      close: () => {},
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        if (sql.startsWith("INSERT INTO repository_learning_state"))
          throw new Error("disk failure fixture");
        return db.prepare(sql);
      },
    };
    assert.throws(() => saveTurn(wrapped, turn()), /disk failure/);
    assert.equal(readRepositoryLearning(db, root).revision, 0);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM repository_learning_turns")
        .get<{ n: number }>()!.n,
      0,
    );
  }));
test("restart and independent connections preserve accumulated revisions without lost updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "kiokuko-repository-learning-"));
  const file = join(directory, "memory.sqlite");
  const first = fixture(file).db;
  let second: ReturnType<typeof openConnection> | undefined;
  try {
    saveTurn(first, turn(1));
    second = openConnection(file);
    saveTurn(second, turn(2));
    saveTurn(first, turn(3));
    assert.equal(readRepositoryLearning(second, root).revision, 3);
    second.close();
    second = undefined;
    first.close();
    second = openConnection(file);
    assert.equal(readRepositoryLearning(second, root).turnCount, 3);
    assert.deepEqual(saveTurn(second, turn(1)), {
      inserted: false,
      revision: 1,
    });
  } finally {
    second?.close();
    try {
      first.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit repository reset cancels pending first saves and workspace forget purges all local derivatives", () =>
  use((db) => {
    const pending = turn();
    resetRepositoryLearning(db, root);
    assert.throws(() => saveTurn(db, pending), /admission_stale/);
    const epoch = readRepositoryLearning(db, root).admissionEpoch;
    saveTurn(db, { ...turn(), admissionEpoch: epoch });
    saveTurn(db, {
      ...turn(),
      repositoryRoot: "/synthetic/unrelated",
      workspace: "project:z",
      admissionEpoch: epoch,
    });
    withImmediateTransaction(db, () =>
      purgeRepositoryLearningForWorkspaceInTransaction(db, "project:a"),
    );
    assert.deepEqual(readRepositoryLearning(db, root).points, []);
    assert.equal(readRepositoryLearning(db, root).turnCount, 0);
    assert.ok(
      readRepositoryLearning(db, "/synthetic/unrelated").points.length > 0,
    );
    assert.throws(
      () => saveTurn(db, { ...turn(2), admissionEpoch: epoch }),
      /admission_stale/,
    );
  }));

test("existing forgetMemory entry API invalidates repository derivatives and delayed callbacks atomically", () =>
  use((db) => {
    const source = seed(db, "forget-learning-source", {
      workspace: "project:a",
    });
    saveTurn(db, turn());
    saveTurn(db, { ...turn(2), sessionId: "later-session" });
    const pending = { ...turn(3), sessionId: "later-session" };
    saveTurn(db, {
      ...turn(),
      repositoryRoot: "/synthetic/unrelated",
      workspace: "project:z",
    });
    const input = {
      workspace: source.workspace,
      entryId: source.sources[0]!.entryId,
      expectedRevision: 1,
      operationId: "forget-learning-test",
    };
    const result = forgetMemory(db, input);
    assert.equal(result.forgotten, true);
    assert.deepEqual(readRepositoryLearning(db, root).points, []);
    assert.equal(readRepositoryLearning(db, root).turnCount, 0);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_learning_turns WHERE workspace='project:a'",
        )
        .get<{ n: number }>()!.n,
      0,
    );
    assert.throws(() => saveTurn(db, pending), /admission_stale/);
    assert.ok(
      readRepositoryLearning(db, "/synthetic/unrelated").points.length > 0,
    );
    const epoch = readRepositoryLearning(db, root).admissionEpoch;
    assert.equal(isRetiredRepositoryTurn(db, root, "later-session", 2), true);
    assert.throws(
      () =>
        saveTurn(db, {
          ...turn(2),
          sessionId: "later-session",
          admissionEpoch: epoch,
        }),
      /turn_retired/,
    );
    assert.deepEqual(forgetMemory(db, input), result);
    assert.equal(readRepositoryLearning(db, root).admissionEpoch, epoch);
  }));

test("reset permanently retires saved turn identities even with a new admission epoch", () =>
  use((db) => {
    const old = turn();
    saveTurn(db, old);
    const reset = resetRepositoryLearning(db, root);
    assert.equal(
      isRetiredRepositoryTurn(db, root, old.sessionId, old.turnId),
      true,
    );
    assert.throws(
      () => saveTurn(db, { ...old, admissionEpoch: reset.admissionEpoch }),
      /turn_retired/,
    );
    assert.equal(
      isRetiredRepositoryTurn(
        db,
        "/synthetic/unrelated",
        old.sessionId,
        old.turnId,
      ),
      false,
    );
    saveTurn(db, { ...turn(2), admissionEpoch: reset.admissionEpoch });
    assert.equal(readRepositoryLearning(db, root).turnCount, 1);
    const retired = db
      .prepare("SELECT * FROM repository_learning_retired_turns")
      .all();
    assert.deepEqual(Object.keys(retired[0] as object).sort(), [
      "repository_key",
      "session_id",
      "turn_id",
    ]);
  }));

test("durable predispatch admission retires unsaved in-flight turns after reset and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "learning-admission-"));
  const path = join(directory, "memory.sqlite");
  const f = fixture(path);
  const old = turn();
  admitRepositoryTurn(f.db, root, old.sessionId, old.turnId, 0);
  admitRepositoryTurn(f.db, root, old.sessionId, old.turnId, 0);
  const reset = resetRepositoryLearning(f.db, root);
  f.db.close();
  const db = openConnection(path);
  try {
    assert.equal(
      isRetiredRepositoryTurn(db, root, old.sessionId, old.turnId),
      true,
    );
    assert.throws(
      () =>
        admitRepositoryTurn(
          db,
          root,
          old.sessionId,
          old.turnId,
          reset.admissionEpoch,
        ),
      /turn_retired/,
    );
    assert.throws(
      () => saveTurn(db, { ...old, admissionEpoch: reset.admissionEpoch }),
      /turn_retired/,
    );
    admitRepositoryTurn(db, root, old.sessionId, 2, reset.admissionEpoch);
    saveTurn(db, { ...turn(2), admissionEpoch: reset.admissionEpoch });
    assert.equal(isRetiredRepositoryTurn(db, root, old.sessionId, 2), false);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_learning_pending_admissions WHERE turn_id='2'",
        )
        .get<{ n: number }>()!.n,
      0,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
