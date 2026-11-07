import { mountNativeTools } from "../helpers/native-tools.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { readRepositoryLearning } from "../../../src/memory/repository-learning.js";
import { DshLifecycleMemory } from "../../../src/dsh/lifecycle-memory.js";
import { DshCoreRuntime } from "../../../src/dsh/core-runtime.js";
import { createDshAgenticReplayHost } from "../../../src/dsh/agenticreplay-host.js";
import { DshAgenticReplayReadService } from "../../../src/dsh/agenticreplay-read-service.js";
import { AgenticReplayConfig } from "../../../src/dsh/config.js";
import { agenticReplayFixture } from "../helpers/agenticreplay-fixture.js";
import { nativeMock, nativeToolResults } from "../helpers/native-mock.js";
import * as harness from "../../../src/dsh/harness/index.js";
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), "tests/fixtures/dsh-runtime/node_modules");
const load = (n: string) =>
  import(
    pathToFileURL(
      join(
        packages,
        "@deepseek-ai",
        n === "cordis" ? n : `dsh-${n}`,
        "lib/index.js",
      ),
    ).href
  );
const pause = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn: () => boolean) => {
  const end = Date.now() + 10000;
  while (!fn() && Date.now() < end) await pause();
  assert.ok(fn(), "condition not reached");
};
const count = (db: any, table: string) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table)
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    : 0;
test("actual unowned native Bash -> final answer -> approved repository learning", async () => {
  const f = await agenticReplayFixture({ shutdownDrainTimeoutMs: 3000 });
  execFileSync("git", ["init", "-q", f.root]);
  const [cordis, llm, session] = await Promise.all(
    ["cordis", "llm", "session"].map(load),
  );
  const ctx = new cordis.Context(),
    fibers: any[] = [],
    asked: any[] = [],
    errors: any[] = [];
  let runtime: any,
    memory: any,
    replay: any,
    mainCalls = 0,
    reflectionInputs: any[] = [],
    toolObserved = false,
    extractions = 0;
  const original = DshAgenticReplayReadService.prototype.memoryEvidence;
  assert.equal(
    typeof original,
    "function",
    "Native replay memory evidence reader is installed",
  );
  const extraction = mock.method(
    DshAgenticReplayReadService.prototype,
    "memoryEvidence",
    function (this: any, ...args: any[]) {
      extractions++;
      return original.apply(this, args as any);
    },
  );
  try {
    for (const name of [
      "llm",
      "session",
      "session-projection",
      "system-prompt",
      "tools",
      "agent",
      "user-questions",
      "working-directory",
      "fs-local",
      "subprocess-local",
      "bash-local",
      "shell-env",
      "tool-bash",
    ]) {
      const plugin = await load(name);
      if(name==='tools'){
        await mountNativeTools(ctx,plugin,packages,fibers);
        continue;
      }
      fibers.push(
        await ctx.plugin(
          plugin.default ?? plugin,
          name === "system-prompt"
            ? { persona: "" }
            : name === "working-directory"
              ? { defaultDirectory: f.root }
              : name === "fs-local" || name === "bash-local"
                ? { cwd: f.root }
                : name === "shell-env"
                  ? { dshHome: f.root }
                  : undefined,
        ),
      );
    }
    fibers.push(await ctx.plugin(harness));
    const native = nativeMock(llm);
    class Provider extends llm.LlmAdapter {
      async listModels(provider: string) {
        return [{ provider, id: "mock", name: "mock" }];
      }
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id };
      }
      async *stream(q: any) {
        if (
          q.purpose === "compaction" &&
          String(q.system).startsWith(
            "Extract compact repository-scoped learning",
          )
        ) {
          reflectionInputs.push(JSON.parse(q.messages[0].content[0].text));
          const evidence = reflectionInputs.at(-1);
          yield* native.textResponse(JSON.stringify({ lessons: [{
            hypothesis: "Native Bash completion needs the observed tool result, not just an assistant claim.",
            applicability: "Verifying native Bash output in this repository.",
            nextAction: "Check the tool result before reporting completion.",
            verifyWith: "Match reported output to the native tool receipt.",
            evidenceRefs: [evidence.observations.find((o: any) => o.type === "tool/result").ref],
          }] }));
          return;
        }
        mainCalls++;
        if (mainCalls === 1) {
          yield* native.toolCallResponse("unowned-command", "bash", {
            command: "printf UNOWNED_NATIVE_RESULT",
            description: "Read a harmless fixed result",
          });
          return;
        }
        if (mainCalls === 2) {
          const r = nativeToolResults(q.messages).find(
            (v: any) => v.toolCallId === "unowned-command",
          );
          assert.ok(r && !r.isError, JSON.stringify(r));
          assert.match(JSON.stringify(r.content), /UNOWNED_NATIVE_RESULT/);
          toolObserved = true;
          assert.equal(count(f.database, "ledger_runs"), 0);
          assert.equal(count(f.database, "entries"), 0);
          assert.equal(extractions, 0);
          assert.equal(asked.length, 0);
        }
        yield* native.textResponse(
          "The requested command finished and printed UNOWNED_NATIVE_RESULT.",
        );
      }
    }
    ctx.llm.registerAdapter(["mock"], new Provider());
    ctx.on("agent/error", (e: any) => errors.push(e.error), { global: true });
    ctx.on(
      "user-questions/request",
      (q: any) => {
        asked.push(q);
        return { answers: [{ id: q.questions[0].id, selected: [q.questions[0].options[0].label] }] };
      },
      { global: true },
    );
    runtime = new DshCoreRuntime({
      repositoryRoot: f.root,
      databasePath: join(f.root, "index.sqlite3"),
      autoRegisterRepository: true,
      migrationsDirectory: join(process.cwd(), "migrations"),
    });
    await runtime.start();
    replay = createDshAgenticReplayHost(
      ctx,
      AgenticReplayConfig.parse({
        enabled: true,
        askOnStart: false,
        shutdownDrainTimeoutMs: 3000,
      }),
      runtime,
      {
        session: (id) => ctx.sessions.get(id),
        agent: (id) => ctx.agents.get(id),
        logicalRun: () => undefined,
        questions: ctx.userQuestions,
      },
    );
    memory = new DshLifecycleMemory(ctx, runtime, f.root);
    memory.connectAgenticReplay(replay);
    const {agent} = await ctx.agents.create({
      sessionId: session.SessionId(f.binding.sessionId),
      agentOptions: { provider: "mock", model: "mock" },
      meta: { cwd: f.root },
    });
    assert.equal(agent.constructor.name,'KiokukoHarnessAgent');
    agent.followup(
      llm.createUserMessage({
        source: { kind: "user" },
        content: [
          {
            type: "text",
            text: "Run printf UNOWNED_NATIVE_RESULT and tell me what it printed.",
          },
        ],
      }),
    );
    await wait(() => toolObserved && agent.status === "idle");
    await memory.whenIdle();
    assert.equal(
      mainCalls,
      2,
      "auxiliary reflection cannot consume foreground response",
    );
    assert.equal(
      asked.length,
      1,
      "useful native learning requires one exact proposal approval",
    );
    assert.equal(count(f.database, "ledger_runs"), 0);
    assert.equal(count(f.database, "replay_memories"), 0);
    assert.equal(count(f.database, "entries"), 0);
    assert.equal(extractions, 0);
    assert.deepEqual(errors, []);
    const saved = readRepositoryLearning(f.database, f.root);
    assert.equal(saved.turnCount, 1);
    assert.equal(saved.outcomeCounts.completed, 1);
    assert.ok(
      saved.points.some(
        (p) => p.kind === "observation" && p.reflectionStatus === "model",
      ),
    );
    assert.equal(reflectionInputs.length, 1);
    assert.match(
      JSON.stringify(reflectionInputs[0].observations),
      /UNOWNED_NATIVE_RESULT/,
    );
    const observedPoint = saved.points[0];
    assert.ok(observedPoint);
    assert.ok(
      observedPoint.evidenceRefs.some((ref) =>
        reflectionInputs[0].observations.some(
          (o: any) => o.type === "tool/result" && o.ref === ref,
        ),
      ),
    );
    const binding=replay.resolveSessionBinding(agent,agent.session);
    assert.ok(binding);
    await replay.closeSessionRecording(agent.session.id,'acceptance');
    const reader=new DshAgenticReplayReadService(replay.config,replay.withIndex);
    const traces=await reader.list(binding);
    assert.equal(traces.length,1);
    const trace=await reader.show(binding,traces[0]!.agenticreplay_run_id);
    assert.ok(trace.events.some((e:any)=>e.type==='note'&&e.attrs?.action==='tool'&&e.attrs?.phase==='result'&&e.attrs?.call_id==='unowned-command'),'Native tool receipt must correlate with the harness action');
  } finally {
    memory?.stop();
    await memory?.whenIdle();
    await replay?.shutdown();
    await runtime?.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    extraction.mock.restore();
    await f.dispose();
  }
});
