import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  baselineProgram,
  correctedProgram,
  runPdcaFixture,
} from "../helpers/replay-pdca-fixture.js";
import {
  reviewCompletedReplay,
  type ReplayMemoryProposal,
} from "../../../src/memory/replay-review.js";
import { compareReplayLessonEffect } from "../../../src/memory/replay-reflection.js";
import { createApprovedReplayMemoryStore } from "../../../src/memory/replay-store.js";
import { recordEntryInTransaction } from "../../../src/memory/entries.js";
import { serializeApprovedReplayContext } from "../../../src/context/replay-model-memory.js";
import { openConnection } from "../../../src/db/connection.js";
import { createRun } from "./evolution/fixture.js";

test("recorded failed task -> fixture reflection -> exact approval -> restart retrieval -> actual checked next run", async () => {
  const before = await runPdcaFixture(baselineProgram, "baseline", 2);
  let after: Awaited<ReturnType<typeof runPdcaFixture>> | undefined;
  try {
    assert.deepEqual(
      before.measured.map((m) => m.exitCode),
      [1, 1, 1],
    );
    assert.equal(before.artifact, null);
    assert.equal(before.packet.outcome, "failed");
    assert.equal(before.packet.repeatedActions[0]!.count, 2);
    createRun(before.database, "baseline", "project:pdca");
    let calls = 0,
      preview = "",
      approved: ReplayMemoryProposal | undefined,
      key = "";
    const store = createApprovedReplayMemoryStore(
      before.database,
      "project:pdca",
      (p) =>
        recordEntryInTransaction(before.database, {
          workspace: "project:pdca",
          kind: "reference",
          title: "Approved cold directory lesson",
          body: JSON.stringify(p),
          summary: p.findings[0]!.text,
          scope: { visibility: "project" },
          provenance: { type: "user_approved_replay", reference: key },
          trustLevel: "untrusted",
        }),
    );
    const receipt = await reviewCompletedReplay({
      completed: true,
      taskId: "baseline",
      sessionId: before.proposal.source.sessionId,
      workspace: "project:pdca",
      extract: async () => before.proposal,
      assessment: async () => before.assessment,
      reflector: {
        origin: "fixture",
        reflect: async (packet) => {
          calls++;
          assert.equal(packet.outcome, "failed");
          return {
            hypothesis:
              "A cold output directory is absent; repeating the unchanged write does not create it.",
            applicability:
              "Writing a new output file into a missing parent directory",
            nextAction:
              "Create the parent directory recursively before writing output/answer.json.",
            verifyWith: "Run unchanged node check.mjs in a fresh directory.",
            evidenceRefs: [packet.attempts[0]!.resultRef!],
          };
        },
      },
      ask: async (q) => {
        if (q.phase === "review") {
          preview = q.text;
          assert.match(preview, /Create the parent directory/);
        }
        return {
          questionId: q.id,
          choice: q.phase === "organize" ? "organize" : "approve",
        };
      },
      save: async (p, k) => {
        assert.ok(preview.includes(JSON.stringify(p, null, 2)));
        approved = p;
        key = k;
        store.save(p, k);
        store.save(p, k);
      },
    });
    assert.equal(receipt.status, "saved");
    assert.equal(calls, 1);
    assert.ok(approved?.lesson);
    assert.equal(
      before.database
        .prepare("SELECT COUNT(*) AS n FROM replay_memories")
        .get()!.n,
      1,
    );
    const reopened = openConnection(join(before.root, "index.sqlite3"));
    try {
      const recovered = createApprovedReplayMemoryStore(
        reopened,
        "project:pdca",
      );
      recovered.save(approved, key);
      const retrieved = recovered.query("output");
      assert.equal(retrieved.length, 1);
      const context = serializeApprovedReplayContext(reopened, retrieved);
      assert.match(context, /Create the parent directory/);
      assert.equal(retrieved[0]!.lesson!.origin, "fixture");
      after = await runPdcaFixture(correctedProgram, "next-task", 1, {
        reflectionId: retrieved[0]!.lesson!.reflectionId,
        actionSha256: createHash("sha256")
          .update(correctedProgram)
          .digest("hex"),
      });
      assert.deepEqual(
        after.measured.map((m) => m.exitCode),
        [0, 0],
      );
      assert.deepEqual(after.artifact, { values: [-1, 2, 2, 10] });
      assert.equal(
        await readFile(join(after.root, "input.json"), "utf8"),
        await readFile(join(before.root, "input.json"), "utf8"),
      );
      assert.equal(
        await readFile(join(after.root, "check.mjs"), "utf8"),
        await readFile(join(before.root, "check.mjs"), "utf8"),
      );
      const effect = compareReplayLessonEffect({
        before: before.packet,
        after: after.packet,
        lesson: retrieved[0]!.lesson!,
        beforeTaskKey: before.taskKey,
        afterTaskKey: after.taskKey,
        application: after.application!,
      });
      assert.equal(effect.effect, "observed_improvement");
      assert.equal(
        compareReplayLessonEffect({
          before: before.packet,
          after: after.packet,
          lesson: retrieved[0]!.lesson!,
          beforeTaskKey: before.taskKey,
          afterTaskKey: after.taskKey,
        }).effect,
        "unknown",
        "retrieval alone is not application",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await after?.dispose();
    await before.dispose();
  }
});

test("declined organization never dispatches reflection; rejected model lesson never saves", async () => {
  const f = await runPdcaFixture(baselineProgram, "declined");
  try {
    let reflects = 0,
      saves = 0;
    const deps = {
      completed: true,
      taskId: "declined",
      sessionId: f.proposal.source.sessionId,
      workspace: "project:pdca",
      extract: async () => f.proposal,
      reflector: {
        origin: "fixture" as const,
        reflect: async () => {
          reflects++;
          return { unsupported: true };
        },
      },
      save: async () => {
        saves++;
      },
    };
    const declined = await reviewCompletedReplay({
      ...deps,
      ask: async (q) => ({ questionId: q.id, choice: "decline" }),
    });
    assert.equal(declined.status, "declined");
    assert.equal(reflects, 0);
    const invalid = await reviewCompletedReplay({
      ...deps,
      ask: async (q) => ({
        questionId: q.id,
        choice: q.phase === "organize" ? "organize" : "approve",
      }),
    });
    assert.equal(invalid.status, "unavailable");
    assert.equal(reflects, 1);
    assert.equal(saves, 0);
  } finally {
    await f.dispose();
  }
});
