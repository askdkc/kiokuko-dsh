import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../integration/evolution/fixture.js";
import {
  saveTurn,
  readRepositoryLearning,
  type RepositoryTurnLearning,
} from "../../../src/memory/repository-learning.js";

test("grounded correction retires only named active proposal, keeps source ledger, and never becomes verified fact", () => {
  const { db } = fixture();
  const root = "/synthetic/correction-repo";
  const turn = (id: number): RepositoryTurnLearning => ({
    repositoryRoot: root,
    workspace: "project:a",
    captureRevision: 0,
    admissionEpoch: 0,
    sessionId: "a",
    turnId: id,
    terminalSeq: id,
    outcome: "completed",
    summary: "Lifecycle completion is unverified.",
    evidenceRefs: [`native:a:${id}`],
    reflectionStatus: "model",
    lessons: [
      {
        hypothesis: "Directory absence may explain failure.",
        applicability: "Output artifact",
        nextAction: "Check directory",
        verifyWith: "Inspect output",
        evidenceRefs: [`native:a:${id}`],
      },
    ],
  });
  try {
    saveTurn(db, turn(1));
    const old = readRepositoryLearning(db, root).points.find(
      (p) => p.kind === "hypothesis",
    )!;
    assert.match(old.id!, /^hypothesis:/);
    const correction = turn(2);
    correction.lessons![0] = {
      ...correction.lessons![0]!,
      hypothesis: "Current evidence instead indicates invalid JSON.",
      nextAction: "Validate JSON before write",
      supersedes: [old.id!],
      correctionReason:
        "Turn 2 inspected the already existing output directory.",
    };
    saveTurn(db, correction);
    const active = readRepositoryLearning(db, root);
    assert(!active.points.some((p) => p.id === old.id));
    assert.deepEqual(
      active.points.find((p) => p.kind === "hypothesis")!.lesson!.supersedes,
      [old.id],
    );
    assert.equal(active.assessment.hypotheses, "unverified_proposals");
    assert.equal(active.assessment.supersession, "model_proposed_corrections");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM repository_learning_turns")
        .get<{ n: number }>()!.n,
      2,
    );
    const stale = turn(3);
    stale.lessons![0] = {
      ...correction.lessons![0]!,
      evidenceRefs: ["native:a:3"],
    };
    assert.throws(() => saveTurn(db, stale), /invalid_supersession/);
    assert.equal(readRepositoryLearning(db, root).revision, 2);
    const foreign = turn(4);
    foreign.lessons![0] = {
      ...foreign.lessons![0]!,
      supersedes: ["foreign"],
      correctionReason: "Not an owned proposal",
    };
    assert.throws(() => saveTurn(db, foreign), /invalid_supersession/);
    const noReason = turn(5);
    noReason.lessons![0]!.supersedes = [
      active.points.find((p) => p.kind === "hypothesis")!.id!,
    ];
    assert.throws(() => saveTurn(db, noReason), /correction_reason_required/);
  } finally {
    db.close();
  }
});
