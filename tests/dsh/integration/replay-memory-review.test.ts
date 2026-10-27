import { KiokukoError } from "../../../src/errors.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DshLifecycleMemory } from "../../../src/dsh/lifecycle-memory.js";
import { DshCoreRuntime } from "../../../src/dsh/core-runtime.js";
import {
  REPLAY_REFLECTOR_SERVICE,
  type ReplayReflector,
} from "../../../src/memory/replay-reflection.js";
import {
  agenticReplayFixture,
  collect,
  chunks,
  request,
  response,
} from "../helpers/agenticreplay-fixture.js";

class Host {
  handlers = new Map<string, Function[]>();
  definitions = new Map<string, any>();
  agents = new Map<string, any>();
  sessions = new Map<string, any>();
  questions: any;
  asked: any[] = [];
  warnings: string[] = [];
  reflector: unknown;
  get(name: string) {
    if (name === REPLAY_REFLECTOR_SERVICE) return this.reflector;
    return name === "logger"
      ? { warn: (message: string) => this.warnings.push(message) }
      : name === "agents"
        ? {
            list: () => [...this.agents.values()],
            get: (id: string) => this.agents.get(id),
          }
        : name === "sessions"
          ? { get: (id: string) => this.sessions.get(id) }
          : name === "userQuestions"
            ? {
                ask: async (q: any) => {
                  this.asked.push(q);
                  return this.questions(q);
                },
              }
            : name === "tools"
              ? {
                  get: (n: string) => this.definitions.get(n),
                  register: (d: any) => {
                    this.definitions.set(d.name, d);
                    return () => this.definitions.delete(d.name);
                  },
                }
              : undefined;
  }
  on(name: string, fn: Function) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return () => {
      this.handlers.set(
        name,
        (this.handlers.get(name) ?? []).filter((x) => x !== fn),
      );
    };
  }
}
async function fixture(reflector?: unknown) {
  const f = await agenticReplayFixture({ shutdownDrainTimeoutMs: 3000 });
  execFileSync("git", ["init", "-q", f.root]);
  const runtime = new DshCoreRuntime({
    repositoryRoot: f.root,
    databasePath: join(f.root, "index.sqlite3"),
    autoRegisterRepository: true,
    migrationsDirectory: join(process.cwd(), "migrations"),
  });
  await runtime.start();
  const host = new Host(),
    session = { id: f.binding.sessionId, header: { cwd: f.root, version: 4 } },
    agent = { id: "memory-review-agent", session, ctx: host };
  host.reflector = reflector;
  host.agents.set(agent.id, agent);
  host.sessions.set(session.id, session);
  const workspace = f.database
    .prepare(
      "SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?",
    )
    .get<{ workspace: string }>(f.root)!.workspace;
  f.database
    .prepare(
      `INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,title,started_at,created_at,updated_at) VALUES('memory-task',?,?,'1','test','{}','completed','{}','Check parser behavior',?,?,?)`,
    )
    .run(workspace, session.id, ...Array(3).fill(new Date().toISOString()));
  let storageError: unknown;
  const memoryRuntime: Pick<DshCoreRuntime, "withDatabase"> = {
    withDatabase: async (operation) => {
      if (storageError) throw storageError;
      return runtime.withDatabase(operation);
    },
  };
  const memory = new DshLifecycleMemory(host as any, memoryRuntime, f.root);
  memory.connectAgenticReplay({
    config: f.config,
    withIndex: f.withIndex,
    resolveSessionBinding: (a: object, s: object) =>
      a === agent && s === session ? f.binding : undefined,
  } as any);
  const binding = { ...f.binding, kiokukoRunId: "memory-task" };
  return {
    ...f,
    host,
    session,
    agent,
    runtime,
    memory,
    workspace,
    binding,
    failStorage(error: unknown) {
      storageError = error;
    },
    async close() {
      memory.stop();
      await memory.whenIdle();
      await runtime.close();
      await f.dispose();
    },
  };
}
const result = (q: any, label: string, custom?: string) => ({
  answers: [
    {
      id: q.questions[0].id,
      selected: custom ? [] : [label],
      ...(custom ? { custom } : {}),
    },
  ],
});
async function record(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  for (let i = 0; i < count; i++) {
    const e = {
      token: Symbol(),
      callId: `call-${i}`,
      rootCallId: `call-${i}`,
      name: "bash",
      arguments: { command: `node parser-${i}.mjs` },
      agent: f.agent,
    };
    f.recorder.preTool(f.binding, e);
    f.recorder.toolResult(f.binding, e, {
      isError: false,
      value: { exitCode: i % 2, processStarted: true, processStopped: true },
      content: [
        {
          type: "text",
          text: JSON.stringify({ exitCode: i % 2, stdout: `result-${i}` }),
        },
      ],
    });
  }
  await f.recorder.closeSessionRecording(f.session.id, "manual");
}
const count = (db: any, table: string) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table)
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    : 0;

test("model-facing observation cannot persist a derived candidate before post-task human approval", async () => {
  const f = await fixture();
  try {
    const answer = await f.memory.observe({
      cwd: f.root,
      eventId: "model-proposed",
      sessionId: f.session.id,
      kind: "completion",
      summary: "claim from model",
      source: { producer: "test", runId: "memory-task", eventIds: ["call"] },
    });
    assert.equal(answer.recorded, false);
    assert.equal(count(f.database, "dsh_memory_observations"), 0);
    assert.equal(count(f.database, "replay_memories"), 0);
  } finally {
    await f.close();
  }
});
test("native organization decline creates no memory and does not change completed task", async () => {
  const f = await fixture();
  try {
    f.host.questions = (q: any) => result(q, "今回は保存しない");
    f.memory.completed("memory-task", "completed", f.session.id);
    await f.memory.whenIdle();
    assert.equal(f.host.asked.length, 1);
    assert.equal(count(f.database, "replay_memories"), 0);
    assert.equal(count(f.database, "dsh_memory_observations"), 0);
    assert.equal(
      f.database
        .prepare("SELECT status FROM ledger_runs WHERE run_id='memory-task'")
        .get()?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});
for (const attemptCount of [2, 40])
  test(`actual lifecycle questions save exact approved revision once and keyword lookup finds all ${attemptCount} attempts`, async () => {
    const f = await fixture();
    try {
      await record(f, attemptCount);
      f.host.questions = (q: any) =>
        result(
          q,
          q.questions[0].question.includes("整理")
            ? "整理して確認する"
            : "この内容を保存する",
        );
      f.memory.completed("memory-task", "completed", f.session.id);
      await f.memory.whenIdle();
      f.memory.completed("memory-task", "completed", f.session.id);
      await f.memory.whenIdle();
      assert.equal(f.host.asked.length, 2);
      assert.equal(count(f.database, "replay_memories"), 1);
      assert.equal(count(f.database, "dsh_memory_observations"), 0);
      const row = f.database
        .prepare("SELECT proposal_json FROM replay_memories")
        .get<{ proposal_json: string }>()!;
      const proposal = JSON.parse(row.proposal_json);
      assert.ok(
        f.host.asked[1].questions[0].detail.includes(
          JSON.stringify(proposal, null, 2),
        ),
      );
      const context: any = await f.memory.context({
        cwd: f.root,
        query: "parser",
      });
      assert.equal(context.replay.length, 1);
      assert.equal(context.replay[0].attempts.length, attemptCount);
      if (attemptCount === 40) {
        assert.ok(row.proposal_json.length > 20_000);
        assert.equal(
          f.database
            .prepare(
              "SELECT body FROM entry_revisions ORDER BY revision DESC LIMIT 1",
            )
            .get<{ body: string }>()!.body,
          row.proposal_json,
        );
      }
      assert.equal(proposal.attempts[0].outcome, "succeeded");
      assert.equal(proposal.attempts[1].outcome, "failed");
      assert.ok(proposal.findings.every((x: any) => x.basis !== "verified"));
    } finally {
      await f.close();
    }
  });
test("comments require a fresh preview and decline retains no draft or derived memory", async () => {
  const f = await fixture();
  try {
    await record(f);
    let n = 0;
    f.host.questions = (q: any) =>
      ++n === 1
        ? result(q, "整理して確認する")
        : n === 2
          ? result(
              q,
              "",
              "Parser is not verified; preserve only observed output",
            )
          : result(q, "保存しない");
    f.memory.completed("memory-task", "completed", f.session.id);
    await f.memory.whenIdle();
    assert.equal(n, 3);
    assert.match(f.host.asked[2].questions[0].detail, /revision 2/);
    assert.equal(count(f.database, "replay_memories"), 0);
    assert.equal(count(f.database, "entries"), 0);
    assert.equal(count(f.database, "dsh_memory_observations"), 0);
  } finally {
    await f.close();
  }
});
test("replay extraction covers later pages, pairs same-name attempts, excludes reasoning and labels prefix limits", async () => {
  const f = await fixture();
  try {
    await collect(
      f.recorder.stream(
        f.binding,
        {
          ...request,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "parser request ".repeat(800) }],
            },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "PRIVATE_REASONING_DO_NOT_RETAIN" },
              ],
            },
          ],
        },
        () => chunks(response()),
      ),
    );
    await record(f, 50);
    const trace = (await f.reader.list(f.binding))[0]!;
    const reader = f.reader as any;
    assert.equal(typeof reader.memoryEvidence, "function");
    const proposal = await reader.memoryEvidence(
      f.binding,
      trace.agenticreplay_run_id,
      { workspace: f.workspace, taskId: "memory-task" },
    );
    assert.equal(proposal.attempts.length, 50);
    assert.equal(proposal.attempts[49].command, "node parser-49.mjs");
    assert.equal(proposal.attempts[49].outcome, "failed");
    assert.ok(proposal.source.traces[0].eventsRead > 64);
    assert.ok(!JSON.stringify(proposal).includes("PRIVATE_REASONING"));
    const prefix = await reader.memoryEvidence(
      f.binding,
      trace.agenticreplay_run_id,
      { workspace: f.workspace, taskId: "memory-task" },
      { maxEvents: 20 },
    );
    assert.equal(prefix.source.traces[0].eventsRead, 20);
    assert.equal(prefix.source.traces[0].complete, false);
    assert.match(prefix.source.traces[0].gaps.join(" "), /prefix/);
    await assert.rejects(
      reader.memoryEvidence(
        { ...f.binding, sessionId: "other" },
        trace.agenticreplay_run_id,
        { workspace: f.workspace, taskId: "memory-task" },
      ),
      /trace_not_found/,
    );
  } finally {
    await f.close();
  }
});
test("memory outage or disposal cannot rewrite task success or allow late approval saving", async () => {
  const f = await fixture();
  try {
    await record(f);
    let release: any;
    f.host.questions = (q: any) =>
      q.questions[0].question.includes("整理")
        ? result(q, "整理して確認する")
        : new Promise((r) => {
            release = () => r(result(q, "この内容を保存する"));
          });
    f.memory.completed("memory-task", "completed", f.session.id);
    for (let i = 0; i < 100 && !release; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(release);
    f.memory.stop();
    release();
    await f.memory.whenIdle();
    assert.equal(count(f.database, "replay_memories"), 0);
    assert.equal(
      f.database
        .prepare("SELECT status FROM ledger_runs WHERE run_id='memory-task'")
        .get()?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

for (const selection of ["保存しない", "修正する"])
  test(`native mixed ${selection} and custom yes never approves the shown revision`, async () => {
    const f = await fixture();
    try {
      await record(f);
      let n = 0;
      f.host.questions = (q: any) =>
        ++n === 1
          ? result(q, "整理して確認する")
          : n === 2
            ? {
                answers: [
                  {
                    id: q.questions[0].id,
                    selected: [selection],
                    custom: "yes",
                  },
                ],
              }
            : result(q, "保存しない");
      f.memory.completed("memory-task", "completed", f.session.id);
      await f.memory.whenIdle();
      assert.equal(count(f.database, "replay_memories"), 0);
      assert.equal(count(f.database, "entries"), 0);
      assert.equal(n, selection === "修正する" ? 3 : 2);
    } finally {
      await f.close();
    }
  });

test("approved save failure exposes safe diagnosis without saved memory or a changed task outcome", async () => {
  const f = await fixture();
  try {
    await record(f);
    f.host.questions = (q: any) => {
      const organize = q.questions[0].question.includes("整理");
      if (!organize)
        f.failStorage(
          new KiokukoError(
            "DATABASE_ERROR",
            "SQLITE_BUSY while committing memory; api_key=short-fixture",
          ),
        );
      return result(q, organize ? "整理して確認する" : "この内容を保存する");
    };
    f.memory.completed("memory-task", "completed", f.session.id);
    await f.memory.whenIdle();
    const status = (await f.memory.reviewStatus()) as {
      statuses: Array<{
        status: string;
        diagnostic?: { code: string; message: string; phase: string };
      }>;
    };
    assert.equal(status.statuses.length, 1);
    assert.equal(status.statuses[0]!.status, "unavailable");
    assert.equal(status.statuses[0]!.diagnostic?.code, "DATABASE_ERROR");
    assert.equal(status.statuses[0]!.diagnostic?.phase, "save");
    assert.match(status.statuses[0]!.diagnostic!.message, /SQLITE_BUSY/);
    assert.doesNotMatch(
      JSON.stringify(status) + f.host.warnings.join("\n"),
      /short-fixture/,
    );
    assert.equal(count(f.database, "replay_memories"), 0);
    assert.equal(count(f.database, "entries"), 0);
    assert.equal(
      f.database
        .prepare("SELECT status FROM ledger_runs WHERE run_id='memory-task'")
        .get()?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("explicit profile service reflection is offered once, remains inferred, and reaches approved next-task context", async () => {
  let calls = 0;
  const reflector: ReplayReflector = {
    origin: "fixture",
    reflect: async (input) => {
      calls++;
      assert.equal(input.outcome, "unknown");
      return {
        hypothesis:
          "One recorded process failed, but task completion checks are absent.",
        applicability: "Parser work with observed failures",
        nextAction:
          "Inspect the failed parser output before claiming completion.",
        verifyWith: "Bind and run the exact parser completion check.",
        evidenceRefs: [input.attempts[1]!.resultRef!],
      };
    },
  };
  const f = await fixture(reflector);
  try {
    await record(f, 2);
    f.host.questions = (q: any) =>
      result(
        q,
        q.questions[0].question.includes("整理")
          ? "整理して確認する"
          : "この内容を保存する",
      );
    f.memory.completed("memory-task", "completed", f.session.id);
    await f.memory.whenIdle();
    f.memory.completed("memory-task", "completed", f.session.id);
    await f.memory.whenIdle();
    assert.equal(calls, 1);
    assert.equal(f.host.asked.length, 2);
    const context: any = await f.memory.context({
      cwd: f.root,
      query: "parser",
    });
    assert.equal(context.replay.length, 1);
    assert.equal(context.replay[0].lesson.origin, "fixture");
    assert.equal(context.replay[0].findings[0].basis, "inferred");
    assert.match(
      context.replay[0].lesson.nextAction,
      /Inspect the failed parser/,
    );
  } finally {
    await f.close();
  }
});

test("malformed profile services cannot enable reflection and organization decline still prevents dispatch", async () => {
  let calls = 0;
  const reflect = async () => {
    calls++;
    throw new Error("must not dispatch");
  };
  for (const [service, decline] of [
    [{ origin: "invalid", reflect }, false],
    [{ origin: "model", reflect: "not a function" }, false],
    [{ origin: "model", reflect }, true],
  ] as const) {
    const f = await fixture(service);
    try {
      await record(f);
      f.host.questions = (q: any) =>
        result(
          q,
          q.questions[0].question.includes("整理")
            ? decline
              ? "今回は保存しない"
              : "整理して確認する"
            : "この内容を保存する",
        );
      f.memory.completed("memory-task", "completed", f.session.id);
      await f.memory.whenIdle();
      assert.equal(calls, 0);
      assert.equal(count(f.database, "replay_memories"), decline ? 0 : 1);
      if (!decline) {
        const saved = f.database
          .prepare("SELECT proposal_json FROM replay_memories")
          .get<{ proposal_json: string }>()!;
        assert.equal(JSON.parse(saved.proposal_json).lesson, undefined);
      }
    } finally {
      await f.close();
    }
  }
});
