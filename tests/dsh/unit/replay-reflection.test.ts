import test from "node:test";
import assert from "node:assert/strict";
import {
  replayReflectionInput,
  acceptReplayLesson,
  compareReplayLessonEffect,
} from "../../../src/memory/replay-reflection.js";
import type { ReplayMemoryProposal } from "../../../src/memory/replay-review.js";
import type { CompletionAssessment } from "../../../src/dsh/task-completion.js";
function proposal(): ReplayMemoryProposal {
  return {
    schemaVersion: 1,
    proposalId: "p",
    revision: 1,
    source: {
      workspace: "project:test",
      taskId: "task",
      sessionId: "session",
      taskOutcome: "completed",
      traces: [
        {
          runId: "r",
          eventsSha256: "0".repeat(64),
          eventsRead: 2,
          totalEvents: 2,
          complete: true,
          gaps: [],
        },
      ],
    },
    request: { text: "test", evidenceRefs: ["request"] },
    languages: [],
    attempts: [
      {
        taskId: "task",
        attemptId: "a",
        tool: "bash",
        command: "node task.mjs",
        callRef: "call",
        resultRef: "result",
        outcome: "succeeded",
        execution: "completed",
        exitCode: 0,
        payloadHashes: [],
        limitations: [],
      },
    ],
    findings: [],
    tags: [],
    keywords: [],
  };
}
const check = (
  state: "satisfied" | "unmet" | "unknown" | "stale",
): CompletionAssessment => ({
  mode: "enforce",
  required: 1,
  verified: state === "satisfied",
  criteria: [
    {
      criterionId: "check",
      description: "Exact artifact",
      state,
      reason: "test",
      evidenceRef: "check-result",
    },
  ],
});
const lesson = {
  hypothesis: "Check missing parent",
  applicability: "Cold output directory",
  nextAction: "Create parent before write",
  verifyWith: "Run unchanged artifact checker",
  evidenceRefs: ["result"],
};

test("complete evidence and actual nonempty host checks verify success", () =>
  assert.equal(
    replayReflectionInput(proposal(), check("satisfied")).outcome,
    "verified_success",
  ));
test("a completed claim never overrides failed, missing, skipped/unknown or zero checks", () => {
  assert.equal(
    replayReflectionInput(proposal(), check("unmet")).outcome,
    "failed",
  );
  for (const c of [
    undefined,
    check("unknown"),
    check("stale"),
    { ...check("satisfied"), required: 0, criteria: [] },
  ])
    assert.equal(replayReflectionInput(proposal(), c).outcome, "unknown");
});
test("interrupted, unsealed and missing results remain incomplete, not failed", () => {
  for (const kind of ["cancelled", "unsealed", "missing"] as const) {
    const p = proposal();
    if (kind === "cancelled") p.attempts[0]!.outcome = "cancelled";
    if (kind === "unsealed") p.source.traces[0]!.complete = false;
    if (kind === "missing") delete p.attempts[0]!.resultRef;
    assert.equal(
      replayReflectionInput(p, check("satisfied")).outcome,
      "incomplete",
    );
  }
});
test("empty evidence is unknown and unassigned session attempts cannot prove a loop", () => {
  const p = proposal();
  p.source.traces = [];
  p.attempts = [];
  assert.equal(replayReflectionInput(p).outcome, "unknown");
  const q = proposal();
  q.attempts[0]!.taskId = null;
  q.attempts.push({ ...q.attempts[0]!, callRef: "other" });
  assert.equal(replayReflectionInput(q).repeatedActions.length, 0);
});
test("repeated failed actions are counted, duplicated records are not independent support", () => {
  const p = proposal();
  p.attempts[0]!.outcome = "failed";
  p.attempts.push(
    { ...p.attempts[0]!, callRef: "call2", resultRef: "result2" },
    p.attempts[0]!,
  );
  assert.equal(replayReflectionInput(p).repeatedActions[0]!.count, 2);
  assert.equal(
    replayReflectionInput(p).reflectionId,
    replayReflectionInput({ ...p, proposalId: "new" }).reflectionId,
  );
});
test("lesson accepts cited observations but rejects invented refs, extra fields and empty action", () => {
  const input = replayReflectionInput(proposal());
  assert.equal(acceptReplayLesson(input, lesson, "fixture").origin, "fixture");
  for (const raw of [
    { ...lesson, evidenceRefs: ["made-up"] },
    { ...lesson, nextAction: "" },
    { ...lesson, passed: true },
  ])
    assert.throws(() => acceptReplayLesson(input, raw, "model"));
});
test("only comparable measured runs plus observed application get a paired effect", () => {
  const before = replayReflectionInput(proposal(), check("unmet")),
    after = replayReflectionInput(proposal(), check("satisfied"));
  const accepted = acceptReplayLesson(before, lesson, "fixture");
  const input = {
    before,
    after,
    lesson: accepted,
    beforeTaskKey: "same",
    afterTaskKey: "same",
    application: {
      reflectionId: accepted.reflectionId,
      callRef: "call",
      actionSha256: "a".repeat(64),
      executedSha256: "a".repeat(64),
    },
  };
  assert.equal(compareReplayLessonEffect(input).effect, "observed_improvement");
  for (const changed of [
    { ...input, application: { ...input.application, callRef: "unobserved" } },
    { ...input, afterTaskKey: "changed" },
    { ...input, after: replayReflectionInput(proposal()) },
    { ...input, lesson: { ...accepted, reflectionId: "other" } },
  ])
    assert.equal(compareReplayLessonEffect(changed).effect, "unknown");
  assert.equal(
    compareReplayLessonEffect({ ...input, after: before }).effect,
    "no_observed_change",
  );
  const checker = {
    ...after,
    attempts: [
      ...after.attempts,
      {
        ...after.attempts[0]!,
        callRef: "checker",
        resultRef: "check-result",
        command: "node check.mjs",
      },
    ],
  };
  assert.equal(
    compareReplayLessonEffect({
      ...input,
      after: checker,
      application: { ...input.application, callRef: "checker" },
    }).effect,
    "unknown",
  );
  assert.equal(
    compareReplayLessonEffect({
      ...input,
      application: { ...input.application, executedSha256: "b".repeat(64) },
    }).effect,
    "unknown",
  );
  for (const state of ["unknown", "stale"] as const) {
    const p = proposal();
    p.source.taskOutcome = "failed";
    const uncertain = replayReflectionInput(p, check(state));
    const l = acceptReplayLesson(uncertain, lesson, "fixture");
    assert.equal(
      compareReplayLessonEffect({
        ...input,
        before: uncertain,
        lesson: l,
        application: { ...input.application, reflectionId: l.reflectionId },
      }).effect,
      "unknown",
    );
  }
});

test("unsafe extracted payload is rejected before any model dispatch", async () => {
  const { reviewCompletedReplay } =
    await import("../../../src/memory/replay-review.js");
  for (const body of [
    "x".repeat(256 * 1024),
    "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  ]) {
    const p = proposal();
    p.request.text = body;
    let calls = 0;
    const result = await reviewCompletedReplay({
      completed: true,
      taskId: "task",
      sessionId: "session",
      workspace: "project:test",
      extract: async () => p,
      reflector: {
        origin: "fixture",
        reflect: async () => {
          calls++;
          return lesson;
        },
      },
      ask: async (q) => ({ questionId: q.id, choice: "organize" }),
      save: async () => {
        throw new Error("must_not_save");
      },
    });
    assert.equal(result.status, "unavailable");
    assert.equal(calls, 0);
  }
});
