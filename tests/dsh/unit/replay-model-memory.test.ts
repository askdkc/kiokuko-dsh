import { recordEntryInTransaction } from "../../../src/memory/entries.js";
import {
  reviewCompletedReplay,
  type ReplayMemoryProposal,
} from "../../../src/memory/replay-review.js";
import { DEFAULT_CONTEXT_CHARACTERS } from "../../../src/memory/context-budget.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../integration/evolution/fixture.js";
import { approveFixtureMemory } from "../helpers/approved-fixture-memory.js";
import { createApprovedReplayMemoryStore } from "../../../src/memory/replay-store.js";
import { serializeApprovedReplayContext } from "../../../src/context/replay-model-memory.js";

test("approved replay delivers valid whole JSON beyond 12000 UTF-16 units with existing indexed IDs", async () => {
  const { db } = fixture();
  try {
    const entry = await approveFixtureMemory(
      db,
      "project:test",
      "😀".repeat(12000),
      ["replay"],
    );
    const linked = await approveFixtureMemory(
      db,
      "project:test",
      "Linked replay evidence",
      ["replay"],
    );
    for (const type of [
      "supports",
      "contradicts",
      "derived_from",
      "related_to",
    ])
      db.prepare("INSERT INTO entry_links VALUES(?,?,?,?,?)").run(
        entry.id,
        linked.id,
        type,
        "2026-10-18T00:00:00.000Z",
        "fixture",
      );
    const replay = createApprovedReplayMemoryStore(db, "project:test").query(
      "replay",
    );
    const text = serializeApprovedReplayContext(db, replay),
      payload = JSON.parse(text);
    assert.ok(text.length > 24000);
    assert.equal(payload.items.length, 2);
    assert.ok(payload.items.some((item: any) => item.entryId === entry.id));
    assert.equal(payload.items[0].workspace, "project:test");
    assert.ok(
      payload.items.some((item: any) => item.text.includes("😀".repeat(12000))),
    );
    assert.equal(payload.relationDelivery.status, "complete");
    assert.equal(payload.relationDelivery.edges.length, 4);
  } finally {
    db.close();
  }
});
test("oversized replay bodies are omitted whole with a separate explicit status frame", async () => {
  const { db } = fixture();
  try {
    await approveFixtureMemory(db, "project:test", "界".repeat(20000), [
      "replay",
    ]);
    const replay = createApprovedReplayMemoryStore(db, "project:test").query(
      "replay",
    );
    const payload = JSON.parse(serializeApprovedReplayContext(db, replay));
    assert.deepEqual(payload.items, []);
    assert.ok(
      payload.relationDelivery.selectionOmissions.includes("body_budget"),
    );
    const legacy = JSON.parse(
      serializeApprovedReplayContext(db, [
        { ...replay[0]!, proposalId: "unindexed-old-proposal" },
      ]),
    );
    assert.deepEqual(legacy.items, []);
    assert.equal(legacy.relationDelivery.status, "omitted_legacy");
  } finally {
    db.close();
  }
});

test("approved large replay delivers its whole compact lesson with the indexed identity, not the raw log", async () => {
  const { db } = fixture();
  try {
    const workspace = "project:test";
    const lesson = {
      hypothesis:
        "Prepare the output directory before running the unchanged generator.",
      applicability:
        "A local generator writes a verified artifact into a missing directory.",
      nextAction:
        "Create the directory, run the unchanged generator, bind and run the independent checker.",
      verifyWith:
        "Require the host receipt for the exact checker and compare protected source hashes.",
      evidenceRefs: ["fixture:call", "fixture:result"],
    };
    const proposal: ReplayMemoryProposal = {
      schemaVersion: 1,
      proposalId: "fixture-large-reflection",
      revision: 1,
      source: {
        workspace,
        taskId: "fixture-task",
        sessionId: "fixture-session",
        traces: [
          {
            runId: "fixture-trace",
            eventsSha256: "a".repeat(64),
            eventsRead: 4,
            totalEvents: 5,
            complete: false,
            digestScope: "observed_prefix",
            gaps: ["one event missing"],
          },
        ],
      },
      request: {
        text: "replay artifact verification",
        evidenceRefs: ["fixture:request"],
      },
      languages: [],
      tags: ["replay"],
      keywords: ["replay"],
      attempts: [
        {
          taskId: "fixture-task",
          attemptId: "fixture-attempt",
          tool: "kioku_exec",
          command: "node check.mjs",
          callRef: "fixture:call",
          resultRef: "fixture:result",
          outcome: "succeeded",
          execution: "completed",
          exitCode: 0,
          payloadHashes: [],
          limitations: [],
        },
      ],
      findings: [
        {
          kind: "key_point",
          text: "raw-observation:".repeat(2000),
          basis: "observed",
          evidenceRefs: ["fixture:result"],
        },
      ],
    };
    let entry!: ReturnType<typeof recordEntryInTransaction>;
    let preview = "";
    const result = await reviewCompletedReplay({
      completed: true,
      taskId: proposal.source.taskId,
      sessionId: proposal.source.sessionId,
      workspace,
      extract: async () => proposal,
      reflector: { origin: "fixture", reflect: async () => lesson },
      ask: async (question) => {
        if (question.phase === "review") preview = question.text;
        return {
          questionId: question.id,
          choice: question.phase === "organize" ? "organize" : "approve",
        };
      },
      save: async (shown, key) => {
        assert.ok(preview.includes(JSON.stringify(shown, null, 2)));
        createApprovedReplayMemoryStore(
          db,
          workspace,
          (value) =>
            (entry = recordEntryInTransaction(db, {
              workspace,
              kind: "reference",
              title: "Approved replay",
              body: JSON.stringify(value),
              scope: { visibility: "project" },
              provenance: { type: "user_approved_replay", reference: key },
              trustLevel: "untrusted",
            })),
        ).save(shown, key);
      },
    });
    assert.equal(result.status, "saved");
    assert.ok(Array.from(entry.body).length > DEFAULT_CONTEXT_CHARACTERS);
    const replay = createApprovedReplayMemoryStore(db, workspace).query(
      "replay",
    );
    const payload = JSON.parse(serializeApprovedReplayContext(db, replay));
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].entryId, entry.id);
    assert.equal(payload.items[0].workspace, workspace);
    for (const value of [
      lesson.hypothesis,
      lesson.applicability,
      lesson.nextAction,
      lesson.verifyWith,
      ...lesson.evidenceRefs,
    ])
      assert.ok(payload.items[0].text.includes(value), value);
    assert.match(payload.items[0].text, /untrusted reference/u);
    assert.match(payload.items[0].text, /Raw task log omitted/u);
    assert.ok(
      payload.items[0].text.includes('"claimedTaskOutcome":"completed"'),
    );
    assert.ok(payload.items[0].text.includes('"complete":false'));
    assert.ok(
      payload.items[0].text.includes('"digestScope":"observed_prefix"'),
    );
    assert.ok(!payload.items[0].text.includes("raw-observation:"));
    assert.ok(
      Array.from(payload.items[0].text).length <= DEFAULT_CONTEXT_CHARACTERS,
    );
    assert.deepEqual(payload.relationDelivery.selectionOmissions, []);
    const tampered = structuredClone(replay);
    tampered[0]!.lesson!.nextAction = "Unapproved replacement action";
    const rejected = JSON.parse(serializeApprovedReplayContext(db, tampered));
    assert.deepEqual(rejected.items, []);
    assert.equal(rejected.relationDelivery.status, "omitted_legacy");
    db.prepare(
      "UPDATE replay_memory_entries SET entry_revision=entry_revision+1 WHERE entry_id=?",
    ).run(entry.id);
    assert.deepEqual(
      JSON.parse(serializeApprovedReplayContext(db, replay)).items,
      [],
    );
    db.prepare(
      "UPDATE replay_memory_entries SET entry_revision=entry_revision-1 WHERE entry_id=?",
    ).run(entry.id);
    const replacement = await approveFixtureMemory(
      db,
      workspace,
      "replacement",
      ["replacement"],
    );
    db.prepare(
      "UPDATE entries SET status='superseded',superseded_by=? WHERE id=?",
    ).run(replacement.id, entry.id);
    assert.deepEqual(
      JSON.parse(serializeApprovedReplayContext(db, replay)).items,
      [],
    );
  } finally {
    db.close();
  }
});
