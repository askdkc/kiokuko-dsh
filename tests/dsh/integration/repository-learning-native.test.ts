import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openConnection } from "../../../src/db/connection.js";
import { readRepositoryLearning } from "../../../src/memory/repository-learning.js";
import { nativeSkillFixture } from "../helpers/skill-native.js";
import { isolateSkillHome } from "../helpers/skill-home.js";

isolateSkillHome();
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), "tests/fixtures/dsh-runtime/node_modules");
const extra = {
  lisp: { enabled: false },
  typedDecisions: { mode: "off" },
  modelHandoff: { mode: "off" },
  answerReview: { mode: "off" },
  memoryReview: { mode: "off" },
  memoryEvolution: { mode: "off" },
  memoryIndexReasoning: { mode: "off" },
  deepPlanning: { enabled: false },
  modelAutoMode: { mode: "off" },
};
const section = "memory:repository-learning";
const memoryMessages = (request: any) =>
  request.messages.filter((message: any) =>
    message.source?.sections?.some((value: any) => value.name === section),
  );

test(
  "public native plugin learns each turn through its model route, injects repo compact, and survives reload/new session without cross-repo leakage",
  { timeout: 60_000 },
  async () => {
    // Public plugin bootstrap, not an injected host or external reflector. The
    // transport is deterministic; this proves wiring, not external model quality.
    const f = await nativeSkillFixture({ packages, explicit: false, extra });
    const requests: any[] = [],
      reflections: any[] = [],
      diagnostics: any[] = [],
      diagnosticRecords: any[] = [];
    const originalStream = f.model.stream.bind(f.model);
    const off = f.ctx.on(
      "session/event",
      (_session: any, event: any) => {
        if (event.type === "plugin:kiokuko-dsh/repository-learning") {
          diagnostics.push(event.data);
          diagnosticRecords.push(event);
        }
      },
      { global: true },
    );
    const dbPath = join(f.dir, "kiokuko-dsh.sqlite3");
    const snapshot = () => {
      const db = openConnection(dbPath);
      try {
        return readRepositoryLearning(db, f.dir);
      } finally {
        db.close();
      }
    };
    const waitForRevision = async (revision: number) => {
      const deadline = Date.now() + 10_000;
      while (snapshot().revision < revision && Date.now() < deadline)
        await delay(10);
      assert.equal(snapshot().revision, revision, JSON.stringify(diagnostics));
    };
    f.model.stream = async function* (request: any) {
      if (
        String(request.system).startsWith(
          "Extract compact repository-scoped learning",
        )
      ) {
        assert.equal(request.purpose, "compaction");
        assert.deepEqual(request.tools, []);
        const evidence = JSON.parse(request.messages[0].content[0].text);
        reflections.push(evidence);
        const index = reflections.length;
        yield* f.mock.textResponse(
          JSON.stringify({
            lessons:
              index <= 2
                ? [
                    {
                      hypothesis:
                        index === 1
                          ? "ALPHA_REPO_LESSON: parser delimiters require explicit checks."
                          : "BETA_CORRECTED_LESSON: parser delimiter checks apply only to unescaped tokens; the earlier broad hypothesis is too general.",
                      applicability:
                        "Only this repository parser; inspect current source before applying.",
                      nextAction:
                        "Inspect token escaping before selecting the parser assertion.",
                      verifyWith:
                        "Compare escaped and unescaped delimiter cases.",
                      evidenceRefs: [evidence.evidenceRefs[0]],
                      ...(index === 2
                        ? {
                            supersedes: [
                              JSON.parse(evidence.priorCompact).points.find(
                                (point: any) => point.kind === "hypothesis",
                              ).id,
                            ],
                            correctionReason:
                              "Current turn narrows the earlier blanket parser claim to unescaped tokens.",
                          }
                        : {}),
                    },
                  ]
                : [],
          }),
        );
        return;
      }
      if (request.purpose === "compaction") {
        yield* f.mock.textResponse('{"schemaVersion":4,"memoryOperations":[]}');
        return;
      }
      requests.push(request);
      yield* originalStream(request);
    };
    try {
      assert.equal(f.ctx.get("kiokukoReplayReflector", false), undefined);
      f.responses.push(
        f.mock.textResponse("The parser delimiters need explicit checks."),
      );
      await f.turn(
        "Review the parser delimiters as a discussion; do not use tools.",
      );
      await waitForRevision(1);
      assert.equal(
        memoryMessages(requests[0]).length,
        0,
        "first turn starts with an empty repository",
      );
      assert.equal(
        reflections.length,
        1,
        "no-tool turn still causes native model reflection",
      );
      assert.equal(reflections[0].outcome, "completed");
      assert.ok(
        reflections[0].observations.some(
          (value: any) => value.type === "user/message",
        ),
      );
      assert.match(snapshot().compact, /ALPHA_REPO_LESSON/);
      const originalHypothesisId = snapshot().points.find(
        (point) => point.kind === "hypothesis",
      )!.id;
      assert.ok(originalHypothesisId);

      // No keyword overlap with the learned parser fact: direct repo binding must
      // deliver it regardless of the ordinary keyword retrieval result.
      f.responses.push((request: any) => {
        const memory = memoryMessages(request);
        assert.equal(memory.length, 1);
        assert.match(JSON.stringify(memory), /ALPHA_REPO_LESSON/);
        return f.mock.textResponse(
          "Correction: checks apply only to unescaped tokens.",
        );
      });
      await f.turn("こんにちは。短い返事をください。");
      await waitForRevision(2);
      assert.match(reflections[1].priorCompact, /ALPHA_REPO_LESSON/);
      assert.match(snapshot().compact, /BETA_CORRECTED_LESSON/);
      assert.equal(snapshot().turnCount, 2);
      assert.doesNotMatch(snapshot().compact, /ALPHA_REPO_LESSON/);
      const corrected = snapshot().points.find(
        (point) => point.kind === "hypothesis",
      )!;
      assert.deepEqual(corrected.lesson?.supersedes, [originalHypothesisId]);
      assert.ok(
        corrected.evidenceRefs.includes(reflections[1].evidenceRefs[0]),
      );
      assert.equal(
        snapshot().assessment.supersession,
        "model_proposed_corrections",
      );
      assert.equal(snapshot().assessment.hypotheses, "unverified_proposals");
      const historyDb = openConnection(dbPath);
      try {
        const historical = historyDb
          .prepare(
            "SELECT turn_json FROM repository_learning_turns WHERE repository_key=? AND revision=1",
          )
          .get<{ turn_json: string }>(snapshot().repositoryKey);
        assert.ok(historical);
        assert.match(historical.turn_json, /ALPHA_REPO_LESSON/);
      } finally {
        historyDb.close();
      }
      // A new Node process reopens the actual SQLite file, rather than relying on
      // the original connection or JavaScript object's retained state.
      const durable = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
      import { openConnection } from ${JSON.stringify(new URL("../../../src/db/connection.js", import.meta.url).href)};
      import { readRepositoryLearning } from ${JSON.stringify(new URL("../../../src/memory/repository-learning.js", import.meta.url).href)};
      const db = openConnection(process.argv[1]);
      try { process.stdout.write(JSON.stringify(readRepositoryLearning(db, process.argv[2]))); }
      finally { db.close(); }
    `,
            dbPath,
            f.dir,
          ],
          { encoding: "utf8" },
        ),
      );
      assert.equal(durable.revision, 2);
      assert.match(durable.compact, /BETA_CORRECTED_LESSON/);
      assert.ok(
        diagnostics.some(
          (value) => value.phase === "retrieval" && value.status === "injected",
        ),
      );

      // Reload closes and rebuilds the public plugin, then a distinct native
      // session must receive the SQLite-backed notes without seeded fixture data.
      await f.reload("compiled");
      const sessions = await import(
        pathToFileURL(join(packages, "@deepseek-ai/dsh-session/lib/index.js"))
          .href
      );
      const fresh = await f.ctx.agentLoop.create(
        sessions.SessionId("learning-fresh"),
        { provider: "mock", model: "qwen3-coder" },
        { cwd: f.dir },
      );
      f.responses.push((request: any) => {
        assert.equal(memoryMessages(request).length, 1);
        assert.match(
          JSON.stringify(memoryMessages(request)),
          /BETA_CORRECTED_LESSON/,
        );
        return f.mock.textResponse(
          "New session received the corrected reference.",
        );
      });
      fresh.followup(
        f.llm.createUserMessage({
          source: { kind: "user" },
          content: [
            { type: "text", text: "別の話題について短く返事をしてください。" },
          ],
        }),
      );
      await fresh.whenIdle();
      await waitForRevision(3);

      const otherRoot = join(f.dir, "other-repository");
      await mkdir(join(otherRoot, ".git"), { recursive: true });
      const foreign = await f.ctx.agentLoop.create(
        sessions.SessionId("learning-foreign"),
        { provider: "mock", model: "qwen3-coder" },
        { cwd: otherRoot },
      );
      f.responses.push((request: any) => {
        assert.equal(memoryMessages(request).length, 0);
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /ALPHA_REPO_LESSON|BETA_CORRECTED_LESSON/,
        );
        return f.mock.textResponse(
          "The other repository receives no private reference.",
        );
      });
      foreign.followup(
        f.llm.createUserMessage({
          source: { kind: "user" },
          content: [
            { type: "text", text: "parser repository-learning completed" },
          ],
        }),
      );
      await foreign.whenIdle();
      assert.equal(snapshot().revision, 3);
      assert.equal(reflections.length, 3);
      assert.equal(f.responses.length, 0);
      const status = await f.ctx.commands.execute(
        fresh,
        "/kioku-memory learning status",
        [],
        new AbortController().signal,
      );
      assert.equal(status.result.kind, "success", status.result.text);
      assert.match(status.result.text, /"turnCount": 3/);
      assert.doesNotMatch(
        status.result.text,
        /ALPHA_REPO_LESSON|BETA_CORRECTED_LESSON/,
      );
      const reset = await f.ctx.commands.execute(
        fresh,
        "/kioku-memory learning reset",
        [],
        new AbortController().signal,
      );
      assert.equal(reset.result.kind, "success", reset.result.text);
      assert.equal(snapshot().points.length, 0);
      f.responses.push((request: any) => {
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /ALPHA_REPO_LESSON|BETA_CORRECTED_LESSON/,
        );
        assert.equal(
          memoryMessages(request).length,
          0,
          "reset must retire the persisted native memory section before the next model call",
        );
        return f.mock.textResponse(
          "The old compact is absent after explicit reset.",
        );
      });
      fresh.followup(
        f.llm.createUserMessage({
          source: { kind: "user" },
          content: [
            {
              type: "text",
              text: "Continue after resetting repository learning.",
            },
          ],
        }),
      );
      await fresh.whenIdle();
      assert.equal(f.responses.length, 0);
      assert.ok(diagnosticRecords.length > 0);
      assert.ok(
        diagnosticRecords.every((record) => record.ignorable === true),
        "plugin diagnostics must remain ignorable when a native session reopens",
      );
    } finally {
      off();
      await f.close();
    }
  },
);

test(
  "public native plugin records a failed no-tool turn without promoting a failed auxiliary model to learned success",
  { timeout: 30_000 },
  async () => {
    const f = await nativeSkillFixture({ packages, explicit: false, extra });
    const diagnostics: any[] = [];
    const off = f.ctx.on(
      "session/event",
      (_session: any, event: any) => {
        if (event.type === "plugin:kiokuko-dsh/repository-learning")
          diagnostics.push(event.data);
      },
      { global: true },
    );
    const originalStream = f.model.stream.bind(f.model);
    f.model.stream = async function* (request: any) {
      if (
        String(request.system).startsWith(
          "Extract compact repository-scoped learning",
        )
      ) {
        throw new Error("Deliberately unavailable auxiliary model");
      }
      if (request.purpose === "compaction") {
        yield* f.mock.textResponse('{"schemaVersion":4,"memoryOperations":[]}');
        return;
      }
      yield* originalStream(request);
    };
    try {
      f.responses.push(() => {
        throw new Error("Deliberate foreground model failure");
      });
      f.agent.followup(
        f.llm.createUserMessage({
          source: { kind: "user" },
          content: [
            { type: "text", text: "Explain the repository without tools." },
          ],
        }),
      );
      await f.agent.whenIdle();
      const deadline = Date.now() + 10_000;
      while (
        !diagnostics.some((value) => value.phase === "capture") &&
        Date.now() < deadline
      )
        await delay(10);
      const db = openConnection(join(f.dir, "kiokuko-dsh.sqlite3"));
      try {
        const stored = readRepositoryLearning(db, f.dir);
        assert.equal(stored.turnCount, 1, JSON.stringify(diagnostics));
        assert.equal(stored.outcomeCounts.completed, 0);
        assert.equal(stored.outcomeCounts.failed, 1);
        assert.equal(
          stored.points.filter((point) => point.kind === "hypothesis").length,
          0,
        );
        // Native DSH converts adapter failure to an error finish, which is not
        // a valid completed reflection stream. It must never become learned.
        assert.ok(
          stored.points.every((point) => point.reflectionStatus === "invalid"),
          JSON.stringify({ stored, diagnostics }),
        );
        assert.ok(
          diagnostics.some(
            (value) =>
              value.phase === "capture" &&
              value.reflection === "invalid" &&
              value.reason === "invalid_model_stream",
          ),
        );
      } finally {
        db.close();
      }
    } finally {
      off();
      await f.close();
    }
  },
);

for (const scenario of ["refusal", "cancelled", "secret"] as const) {
  test(
    `public native automatic learning honors ${scenario} boundaries`,
    { timeout: 30_000 },
    async () => {
      const f = await nativeSkillFixture({ packages, explicit: false, extra });
      const diagnostics: any[] = [];
      const off = f.ctx.on(
        "session/event",
        (_session: any, event: any) => {
          if (event.type === "plugin:kiokuko-dsh/repository-learning")
            diagnostics.push(event.data);
        },
        { global: true },
      );
      const auxiliary: any[] = [];
      const original = f.model.stream.bind(f.model);
      f.model.stream = async function* (request: any) {
        if (
          request.purpose === "compaction" &&
          String(request.system).startsWith(
            "Extract compact repository-scoped learning",
          )
        ) {
          auxiliary.push(request);
          yield* f.mock.textResponse(JSON.stringify({ lessons: [] }));
          return;
        }
        yield* original(request);
      };
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!predicate() && Date.now() < deadline) await delay(10);
        assert.ok(predicate(), JSON.stringify(diagnostics));
      };
      try {
        if (scenario === "cancelled") {
          let entered = false;
          f.responses.push(async function* (request: any) {
            entered = true;
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            request.signal.throwIfAborted();
          });
          f.agent.followup(
            f.llm.createUserMessage({
              source: { kind: "user" },
              content: [{ type: "text", text: "Discuss this repository." }],
            }),
          );
          await waitFor(() => entered);
          f.agent.cancel({ kind: "user" }, { keepInbox: true });
          await f.agent.whenIdle();
        } else {
          f.responses.push(f.mock.textResponse("Acknowledged."));
          await f.turn(
            scenario === "refusal"
              ? "この会話を保存しない"
              : "Discuss this dummy fixture credential: password=FixtureOnlyNotReal12345",
          );
        }
        await waitFor(() =>
          diagnostics.some((value) => value.phase === "capture"),
        );
        if (scenario === "refusal") {
          f.responses.push(f.mock.textResponse("Still excluded."));
          await f.turn("Now discuss the repository normally.");
          await waitFor(
            () =>
              diagnostics.filter((value) => value.phase === "capture").length >=
              2,
          );
          assert.equal(
            auxiliary.length,
            0,
            "persisted exclusion must suppress future reflection too",
          );
        }
        const db = openConnection(join(f.dir, "kiokuko-dsh.sqlite3"));
        try {
          const saved = readRepositoryLearning(db, f.dir);
          if (scenario === "refusal") assert.equal(saved.turnCount, 0);
          if (scenario === "cancelled") {
            assert.equal(saved.turnCount, 1);
            assert.equal(saved.outcomeCounts.cancelled, 1);
            assert.equal(saved.outcomeCounts.completed, 0);
          }
          if (scenario === "secret") {
            assert.equal(
              auxiliary.length,
              1,
              "sanitized observation must reach reflection, not pass vacuously",
            );
            assert.equal(saved.turnCount, 1);
            assert.doesNotMatch(
              JSON.stringify(auxiliary),
              /FixtureOnlyNotReal12345/,
            );
            assert.doesNotMatch(
              JSON.stringify(saved),
              /FixtureOnlyNotReal12345/,
            );
          }
        } finally {
          db.close();
        }
      } finally {
        off();
        await f.close();
      }
    },
  );
}

for (const interruption of ["stop", "reset", "reload"] as const) {
  test(
    `public native learning recovers from ${interruption} while its old model response is delayed`,
    { timeout: 30000 },
    async () => {
      const f = await nativeSkillFixture({ packages, explicit: false, extra });
      const original = f.model.stream.bind(f.model);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reflections = 0;
      const diagnostics: any[] = [];
      const off = f.ctx.on(
        "kiokuko/repository-learning",
        (_id: string, data: any) => diagnostics.push(data),
        { global: true },
      );
      const snapshot = () => {
        const db = openConnection(join(f.dir, "kiokuko-dsh.sqlite3"));
        try {
          return readRepositoryLearning(db, f.dir);
        } finally {
          db.close();
        }
      };
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate() && Date.now() < deadline) await delay(10);
        assert.ok(predicate(), JSON.stringify(diagnostics));
      };
      f.model.stream = async function* (request: any) {
        if (
          String(request.system).startsWith(
            "Extract compact repository-scoped learning",
          )
        ) {
          reflections++;
          if (reflections === 1) {
            entered();
            await gate;
          }
          yield* f.mock.textResponse('{"lessons":[]}');
          return;
        }
        yield* original(request);
      };
      try {
        f.responses.push(f.mock.textResponse("Ordinary first answer."));
        await f.turn("Discuss this fixture without using tools.");
        await started;
        if (interruption === "stop")
          f.agent.cancel({ kind: "user" }, { keepInbox: true });
        if (interruption === "reset") {
          const result = await f.ctx.commands.execute(
            f.agent,
            "/kioku-memory learning reset",
            [],
            new AbortController().signal,
          );
          assert.equal(result.result.kind, "success");
        }
        if (interruption === "reload") await f.reload("compiled");
        if (interruption === "stop")
          await waitFor(() =>
            diagnostics.some((data) => data.saveState === "discarded"),
          );
        release();
        await waitFor(() =>
          interruption === "reload"
            ? snapshot().turnCount === 1
            : diagnostics.some((data) => data.saveState === "discarded"),
        );
        assert.equal(snapshot().turnCount, interruption === "reload" ? 1 : 0);
        if (interruption !== "reload") {
          await f.reload("compiled");
          await delay(30);
          assert.equal(
            reflections,
            1,
            "discarded old turn is not dispatched again after reload",
          );
        }
        f.responses.push(f.mock.textResponse("New instruction completed."));
        await f.turn(
          "Now answer a different ordinary instruction without tools.",
        );
        await waitFor(
          () => snapshot().turnCount === (interruption === "reload" ? 2 : 1),
        );
      } finally {
        release?.();
        off();
        await f.close();
      }
    },
  );
}
