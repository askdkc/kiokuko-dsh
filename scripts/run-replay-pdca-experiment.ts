// Cloud-only experiment: a precomputed native-agent response, never a configured DSH provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runPdcaFixture,
  baselineProgram,
} from "../tests/dsh/helpers/replay-pdca-fixture.js";
import { createRun } from "../tests/dsh/integration/evolution/fixture.js";
import { openConnection } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  reviewCompletedReplay,
  type ReplayMemoryProposal,
} from "../src/memory/replay-review.js";
import { createApprovedReplayMemoryStore } from "../src/memory/replay-store.js";
import { recordEntryInTransaction } from "../src/memory/entries.js";
import { serializeApprovedReplayContext } from "../src/context/replay-model-memory.js";
import { compareReplayLessonEffect } from "../src/memory/replay-reflection.js";
const [baselinePath, responsePath, outputPath, nextTaskPath] =
  process.argv.slice(2);
if (!baselinePath || !responsePath || !outputPath)
  throw new Error("Expected baseline.json response.json output.json");
const before = JSON.parse(await readFile(baselinePath, "utf8"));
const response = JSON.parse(await readFile(responsePath, "utf8"));
const nextTask = nextTaskPath
  ? JSON.parse(await readFile(nextTaskPath, "utf8"))
  : undefined;
const root = await mkdtemp(join(tmpdir(), "kiokuko-pdca-memory-"));
let db = openConnection(join(root, "memory.sqlite3"));
let after: Awaited<ReturnType<typeof runPdcaFixture>> | undefined,
  control: typeof after;
try {
  migrateDatabase(db);
  createRun(db, before.proposal.source.taskId, "project:pdca");
  let approved: ReplayMemoryProposal | undefined,
    key = "",
    preview = "",
    reflects = 0;
  const store = createApprovedReplayMemoryStore(db, "project:pdca", (p) =>
    recordEntryInTransaction(db, {
      workspace: "project:pdca",
      kind: "reference",
      title: "Approved native model reflection",
      body: JSON.stringify(p),
      summary: p.findings[0]!.text,
      scope: { visibility: "project" },
      provenance: { type: "user_approved_replay", reference: key },
      trustLevel: "untrusted",
    }),
  );
  const receipt = await reviewCompletedReplay({
    completed: true,
    taskId: before.proposal.source.taskId,
    sessionId: before.proposal.source.sessionId,
    workspace: "project:pdca",
    extract: async () => before.proposal,
    assessment: async () => before.assessment,
    reflector: {
      origin: "model",
      reflect: async () => {
        reflects++;
        return response.lesson;
      },
    },
    ask: async (q) => {
      if (q.phase === "review") preview = q.text;
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
  assert.ok(approved?.lesson);
  assert.equal(reflects, 1);
  db.close();
  db = openConnection(join(root, "memory.sqlite3"));
  const recovered = createApprovedReplayMemoryStore(db, "project:pdca");
  recovered.save(approved, key);
  const retrieved = recovered.query("output");
  assert.equal(retrieved.length, 1);
  const context = serializeApprovedReplayContext(db, retrieved);
  assert.ok(context.includes("create output/"));
  if (nextTask)
    assert.equal(
      nextTask.appliedReflectionId,
      retrieved[0]!.lesson!.reflectionId,
    );
  const selectedProgram = nextTask?.program ?? response.program;
  after = await runPdcaFixture(selectedProgram, "native-lesson-next", 1, {
    reflectionId: retrieved[0]!.lesson!.reflectionId,
    actionSha256: createHash("sha256").update(selectedProgram).digest("hex"),
  });
  control = await runPdcaFixture(baselineProgram, "native-no-lesson-control");
  assert.deepEqual(
    after.measured.map((m) => m.exitCode),
    [0, 0],
  );
  assert.deepEqual(after.artifact, { values: [-1, 2, 2, 10] });
  assert.deepEqual(
    control.measured.map((m) => m.exitCode),
    [1, 1],
  );
  assert.equal(control.artifact, null);
  assert.equal(after.taskKey, before.taskKey);
  assert.equal(control.taskKey, before.taskKey);
  const comparison = compareReplayLessonEffect({
    before: before.packet,
    after: after.packet,
    lesson: retrieved[0]!.lesson!,
    beforeTaskKey: before.taskKey,
    afterTaskKey: after.taskKey,
    application: after.application!,
  });
  assert.equal(comparison.effect, "observed_improvement");
  const result = {
    scope:
      "Actual native-agent response bridged into optional host callback; not DSH model-provider dispatch. Human organization/save approval is simulated only for disposable test data.",
    receipt,
    nextTask: nextTask ?? null,
    application: after.application,
    reflectionInvocations: reflects,
    approvedRows: db.prepare("SELECT COUNT(*) AS n FROM replay_memories").get()!
      .n,
    lesson: retrieved[0]!.lesson,
    modelContext: JSON.parse(context),
    comparison,
    before: {
      packet: before.packet,
      measured: before.measured,
      artifact: before.artifact,
      taskKey: before.taskKey,
    },
    after: {
      packet: after.packet,
      measured: after.measured,
      artifact: after.artifact,
      taskKey: after.taskKey,
    },
    control: {
      packet: control.packet,
      measured: control.measured,
      artifact: control.artifact,
      taskKey: control.taskKey,
    },
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  await cp(after.root + "/.agenticreplay", outputPath + ".after-trace", {
    recursive: true,
  });
  await cp(control.root + "/.agenticreplay", outputPath + ".control-trace", {
    recursive: true,
  });
  console.log(
    JSON.stringify(
      {
        scope: result.scope,
        comparison,
        reflectionInvocations: reflects,
        approvedRows: result.approvedRows,
        before: before.measured.map((m: any) => m.exitCode),
        after: after.measured.map((m) => m.exitCode),
        control: control.measured.map((m) => m.exitCode),
        artifact: after.artifact,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  await after?.dispose();
  await control?.dispose();
  await rm(root, { recursive: true, force: true });
}
