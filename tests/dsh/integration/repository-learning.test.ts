import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DshCoreRuntime } from "../../../src/dsh/core-runtime.js";
import { DshLifecycleMemory } from "../../../src/dsh/lifecycle-memory.js";
import {
  readRepositoryLearning,
  resetRepositoryLearning,
} from "../../../src/memory/repository-learning.js";
import { excludeCapture } from "../../../src/memory/capture-policy.js";
import { withImmediateTransaction } from "../../../src/db/transaction.js";

class Host {
  handlers = new Map<string, Function[]>();
  definitions = new Map<string, any>();
  agents = new Map<string, any>();
  sessions = new Map<string, any>();
  modelCalls: any[] = [];
  questions: any[] = [];
  answer?: (request: any) => Promise<any>;
  model?: (request: any) => AsyncIterable<any>;
  get(name: string) {
    if (name === "userQuestions" && this.answer) return { ask: async (request: any) => {
      this.questions.push(request);
      return this.answer!(request);
    } };
    if (name === "agents")
      return {
        list: () => [...this.agents.values()],
        get: (id: string) => this.agents.get(id),
      };
    if (name === "sessions")
      return { get: (id: string) => this.sessions.get(id) };
    if (name === "tools")
      return {
        get: (id: string) => this.definitions.get(id),
        register: (d: any) => {
          this.definitions.set(d.name, d);
          return () => this.definitions.delete(d.name);
        },
      };
    if (name === "llm" && this.model)
      return {
        stream: (r: any) => {
          this.modelCalls.push(r);
          return this.model!(r);
        },
      };
  }
  on(name: string, fn: Function) {
    const rows = this.handlers.get(name) ?? [];
    rows.push(fn);
    this.handlers.set(name, rows);
    return () => {
      this.handlers.set(
        name,
        (this.handlers.get(name) ?? []).filter((x) => x !== fn),
      );
    };
  }
  emit(name: string, ...args: any[]) {
    if (name === "kiokuko/repository-learning") {
      this.sessions.get(args[0])?.append(name, args[1]);
    }
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
}
async function fixture(nestedLaunch = false, learningOptions: any = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repo-learning-")));
  execFileSync("git", ["init", "-q", root]);
  const launchCwd = nestedLaunch ? join(root, "nested") : root;
  await mkdir(launchCwd, { recursive: true });
  let runtime = new DshCoreRuntime({
    repositoryRoot: launchCwd,
    databasePath: join(root, "memory.sqlite3"),
    autoRegisterRepository: true,
    migrationsDirectory: join(process.cwd(), "migrations"),
  });
  await runtime.start();
  const host = new Host();
  // This fixture explicitly approves the concrete native proposal; production has
  // no default answer. Consent rejection is exercised separately below.
  host.answer = async request => ({ answers: [{ id: request.questions[0].id,
    selected: [request.questions[0].options[0].label] }] });
  let memory: DshLifecycleMemory;
  host.model = async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text);
    yield {
      type: "text-delta",
      text: JSON.stringify({
        lessons: [
          {
            hypothesis: "Create output directory before writing the artifact.",
            applicability: "Fresh repository output paths.",
            nextAction: "Create output directory before writing.",
            verifyWith: "Run from a cold directory and inspect output.",
            evidenceRefs: [input.evidenceRefs[0]],
          },
        ],
      }),
    };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  function agent(id: string, cwd = launchCwd) {
    const local = new Host(),
      events: any[] = [];
    const session: any = {
      id,
      header: { cwd },
      seq: 0,
      surface: { nodes: [] },
      eventAt: (seq: number) => events[seq],
      append(type: string, data: any) {
        const e = { type, data, seq: events.length };
        events.push(e);
        session.seq = events.length;
        host.emit("session/event", session, e);
        return e;
      },
    };
    const a: any = {
      id,
      session,
      ctx: local,
      cancel() {},
      model: { current: () => ({ provider: "fixture", model: "model" }) },
    };
    host.agents.set(id, a);
    host.sessions.set(id, session);
    host.emit("agent/created", { agent: a });
    return {
      a,
      events,
      append: session.append,
      async step(turn: number, query: string | null = "unrelated keyword") {
        let next = async () => ({ kind: "enter", messages: [] });
        for (const fn of [
          ...(local.handlers.get("agent/pre-step") ?? []),
        ].reverse()) {
          const rest = next;
          next = () =>
            fn(
              {
                agent: a,
                turn,
                signal: new AbortController().signal,
                messages: query === null ? [] : [
                  {
                    role: "user",
                    content: [{ type: "text", text: query }],
                    source: { kind: "user" },
                  },
                ],
              },
              rest,
            );
        }
        return next();
      },
    };
  }
  memory = new DshLifecycleMemory(host as any, runtime, launchCwd, learningOptions);
  return {
    root,
    host,
    agent,
    get memory() {
      return memory;
    },
    get runtime() {
      return runtime;
    },
    snapshot: () =>
      runtime.withDatabase((db) => readRepositoryLearning(db, root)),
    async restart() {
      memory.stop();
      await memory.whenIdle();
      await runtime.close();
      runtime = new DshCoreRuntime({
        repositoryRoot: launchCwd,
        databasePath: join(root, "memory.sqlite3"),
        autoRegisterRepository: true,
        migrationsDirectory: join(process.cwd(), "migrations"),
      });
      await runtime.start();
      memory = new DshLifecycleMemory(host as any, runtime, launchCwd, learningOptions);
    },
    async close() {
      memory.stop();
      await memory.whenIdle();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function turn(
  a: ReturnType<Awaited<ReturnType<typeof fixture>>["agent"]>,
  id: number,
  outcome = "completed",
  prompt = "Write artifact",
) {
  a.append("turn/start", { turn: id });
  a.append("user/message", {
    turn: id,
    source: { kind: "user" },
    content: [{ type: "text", text: prompt }],
  });
  a.append("tool/call", {
    turn: id,
    callId: `call-${id}`,
    name: "bash",
    arguments: { command: "node make-output.mjs" },
  });
  a.append("tool/result", {
    turn: id,
    message: {
      isError: true,
      content: [{ type: "text", text: "ENOENT output directory missing" }],
    },
  });
  a.append("assistant/message", {
    turn: id,
    message: {
      content: [
        { type: "text", text: "Directory creation must precede writing." },
      ],
    },
  });
  a.append("turn/end", { turn: id, reason: { kind: outcome } });
}

test('automatic compaction saves after a native turn without a question service', async () => {
  const f = await fixture(false, { mode: 'automatic' });
  try {
    delete f.host.answer;
    const a = f.agent('automatic');
    turn(a, 1);
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 1);
    assert.equal(f.host.questions.length, 0);
  } finally { await f.close(); }
});

test('automatic references survive tool-only steps within the same turn, never another turn', async () => {
  const f = await fixture(false, { mode: 'automatic' });
  try {
    const a = f.agent('continuing-reference');
    turn(a, 1);
    await f.memory.whenIdle();
    a.append('turn/start', { turn: 2 });
    a.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'output directory' }] });
    assert.match(JSON.stringify((await a.step(2, 'output directory')).messages), /Create output directory/);
    assert.match(JSON.stringify((await a.step(2, null)).messages), /Create output directory/);
    a.append('turn/start', { turn: 3 });
    assert.deepEqual((await a.step(3, null)).messages, []);
  } finally { await f.close(); }
});

test('a pending compaction cannot hold another chat or cancel a completed turn on new input', async () => {
  const f = await fixture(false, { mode: 'automatic' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = f.host.model!;
  f.host.model = async function* (request) { entered(); await gate; yield* model(request); };
  try {
    const a = f.agent('background'), b = f.agent('foreground');
    turn(a, 1);
    await started;
    const result = await Promise.race([b.step(1), new Promise(resolve => setTimeout(() => resolve('blocked'), 150))]);
    assert.notEqual(result, 'blocked');
    a.append('turn/start', { turn: 2 });
    release();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 1);
  } finally { release(); await f.close(); }
});

test('forgetting during Akinator selection discards the reference without blocking work', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const decisions = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, batch: any) => {
    enter(); await wait;
    return { status: 'completed', result: { answers: batch.questions.map((q: any) => ({ id: q.id, status: 'selected', choiceId: 'use' })) } };
  } };
  const f = await fixture(false, { mode: 'automatic', decisions });
  try {
    const a = f.agent('forget-selection');
    turn(a, 1);
    await f.memory.whenIdle();
    const step = a.step(2, 'output directory');
    await entered;
    await f.runtime.withDatabase(db => resetRepositoryLearning(db, f.root));
    release();
    assert.deepEqual((await step).messages, []);
  } finally { release(); await f.close(); }
});
test("greetings leave the conversation usable without a memory question or save", async () => {
  const f = await fixture();
  try {
    f.host.model = async function* () {
      yield { type: "text-delta", text: '{"lessons":[]}' };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    const a = f.agent("greeting");
    for (const [index, prompt] of ["yo", "thanks", "こんにちは"].entries()) {
      const turn = index + 1;
      a.append("turn/start", { turn });
      a.append("user/message", { turn, source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
      a.append("assistant/message", { turn, message: { content: [{ type: "text", text: "Hello!" }] } });
      a.append("turn/end", { turn, reason: { kind: "completed" } });
      await f.memory.whenIdle();
      assert.equal(f.host.questions.length, 0);
      assert.equal((await f.snapshot()).turnCount, 0);
      assert.equal((await a.step(turn + 1)).kind, "enter");
    }
    assert.equal(f.host.modelCalls.length, 3);
  } finally { await f.close(); }
});
test("useful learning asks once with concrete content and saves only the approved proposal", async () => {
  const f = await fixture();
  try {
    const a = f.agent("consent");
    f.host.answer = async request => ({ answers: [{ id: request.questions[0].id, selected: ["今回は保存しない"] }] });
    turn(a, 1);
    await f.memory.whenIdle();
    assert.equal(f.host.questions.length, 1);
    assert.equal(f.host.modelCalls.length, 1);
    assert.equal((await f.snapshot()).turnCount, 0);
    f.host.answer = async request => ({ answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }] });
    turn(a, 2);
    await f.memory.whenIdle();
    assert.equal(f.host.questions.length, 2);
    assert.match(f.host.questions[1].questions[0].detail, /Create output directory/);
    assert.equal((await f.snapshot()).turnCount, 1, JSON.stringify(a.events.filter(e => e.type === 'kiokuko/repository-learning')));
  } finally { await f.close(); }
});
test("an unavailable review UI cannot silently save turn memories", async () => {
  const f = await fixture();
  try {
    delete f.host.answer;
    turn(f.agent("headless"), 1);
    await f.memory.whenIdle();
    assert.equal(f.host.modelCalls.length, 0);
    assert.equal((await f.snapshot()).turnCount, 0);
  } finally { await f.close(); }
});
test("useful no-tool learning still prompts, and closing its proposal saves nothing", async () => {
  const f = await fixture();
  try {
    const a = f.agent("no-tool");
    f.host.answer = async request => ({ answers: [{ id: request.questions[0].id,
      selected: [] }] });
    a.append("turn/start", { turn: 1 });
    a.append("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "Explain the parser" }] });
    a.append("assistant/message", { turn: 1, message: { content: [{ type: "text", text: "The parser reads tokens." }] } });
    a.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await f.memory.whenIdle();
    assert.equal(f.host.questions.length, 1);
    assert.equal((await f.snapshot()).turnCount, 0);
  } finally { await f.close(); }
});
test("a new turn discards a pending save approval and its late answer", async () => {
  const f = await fixture();
  let resolve!: (value: any) => void, shown!: () => void;
  const displayed = new Promise<void>(done => { shown = done; });
  try {
    const a = f.agent("late-approval");
    let questionId = '';
    f.host.answer = async request => {
      questionId = request.questions[0].id;
      shown();
      return new Promise(done => { resolve = done; });
    };
    turn(a, 1);
    await displayed;
    a.append("turn/start", { turn: 2 });
    resolve({ answers: [{ id: questionId, selected: ["この内容を保存する"] }] });
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    assert.equal((await a.step(2)).kind, 'enter');
  } finally { await f.close(); }
});
for (const nestedLaunch of [false, true]) {
test(`normal lifecycle reflects, persists and injects repository learning after restart (${nestedLaunch ? "nested cwd" : "root cwd"})`, async () => {
  const f = await fixture(nestedLaunch);
  try {
    const first = f.agent("first");
    turn(first, 1);
    await f.memory.whenIdle();
    let snapshot = await f.snapshot();
    assert.equal(snapshot.turnCount, 1);
    assert(snapshot.points.some((p) => p.kind === "hypothesis"));
    assert.equal(f.host.modelCalls.length, 1);
    const next = await first.step(2, "completely different query");
    assert.match(JSON.stringify(next.messages), /Create output directory/);
    assert.match(JSON.stringify(next.messages), /reference data/);
    turn(first, 2);
    await f.memory.whenIdle();
    snapshot = await f.snapshot();
    assert.equal(snapshot.turnCount, 2);
    assert.match(
      f.host.modelCalls[1].messages[0].content[0].text,
      /priorCompact/,
    );
    await f.restart();
    const another = f.agent("new-session");
    const resumed = await another.step(1, "irrelevant");
    assert.match(JSON.stringify(resumed.messages), /Create output directory/);
    const foreign = f.agent("foreign", tmpdir());
    assert.deepEqual((await foreign.step(1)).messages, []);
    const diagnostics = first.events.filter(
      (e) => e.type === "kiokuko/repository-learning",
    );
    assert(diagnostics.some((e) => e.data.status === "saved"));
    assert(diagnostics.some((e) => e.data.status === "injected"));
  } finally {
    await f.close();
  }
});
}
test("cancelled turns neither prompt nor save; duplicate event is ignored", async () => {
  const f = await fixture();
  try {
    const a = f.agent("simple");
    a.append("turn/start", { turn: 1 });
    a.append("user/message", {
      source: { kind: "user" },
      content: [{ type: "text", text: "Explain this repository" }],
    });
    const terminal = a.append("turn/end", {
      turn: 1,
      reason: { kind: "aborted" },
    });
    await f.memory.whenIdle();
    f.host.emit("session/event", a.a.session, terminal);
    await f.memory.whenIdle();
    const snapshot = await f.snapshot();
    assert.equal(snapshot.turnCount, 0);
    assert.equal(f.host.questions.length, 0);
  } finally {
    await f.close();
  }
});
test("capture refusal, excluded session and delayed model result cannot create repository learning", async () => {
  const f = await fixture();
  try {
    const a = f.agent("private");
    turn(a, 1, "completed", "この会話を覚えないで");
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    turn(a, 2);
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    const delayed = f.agent("delayed");
    let release: () => void = () => {};
    let started: () => void = () => {};
    const began = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    f.host.model = async function* (request) {
      started();
      await gate;
      yield { type: "text-delta", text: '{"lessons":[]}' };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    turn(delayed, 1);
    await began;
    await f.runtime.withDatabase((db) => {
      const row = db
        .prepare(
          "SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?",
        )
        .get<{ workspace: string }>(f.root)!;
      withImmediateTransaction(db, () =>
        excludeCapture(
          db,
          row.workspace,
          "delayed",
          "excluded",
          "user_refusal",
          new Date().toISOString(),
        ),
      );
    });
    release();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
  } finally {
    await f.close();
  }
});
test("missing model route neither prompts nor saves and reports unavailable", async () => {
  const f = await fixture();
  try {
    delete f.host.model;
    const a = f.agent("missing");
    turn(a, 1);
    await f.memory.whenIdle();
    const snapshot = await f.snapshot();
    assert.equal(snapshot.turnCount, 0);
    assert.equal(f.host.questions.length, 0);
    assert.equal(
      snapshot.points.filter((p) => p.kind === "hypothesis").length,
      0,
    );
    assert(
      a.events.some(
        (e) =>
          e.type === "kiokuko/repository-learning" &&
          e.data.reflection === "unavailable",
      ),
    );
  } finally {
    await f.close();
  }
});

test("retrieval failure retires a persisted prior projection rather than reusing stale memory", async () => {
  const f = await fixture();
  const original = f.runtime.withDatabase;
  try {
    const a = f.agent("stale-projection");
    a.append("user/message", {
      content: [{ type: "text", text: "stale repository memory" }],
      source: {
        kind: "plugin:kiokuko-dsh",
        form: "snapshot",
        sections: [
          {
            name: "memory:repository-learning",
            text: "stale repository memory",
          },
        ],
      },
    });
    a.a.session.surface.nodes = [0];
    f.runtime.withDatabase = async () => {
      throw new Error("database unavailable");
    };
    const decision = await a.step(2);
    assert.equal(decision.messages.length, 0);
    assert(
      a.events.some(
        (e) =>
          e.type === "user/message" &&
          e.data.source?.sections?.[0]?.name ===
            "memory:repository-learning-retired",
      ),
    );
    assert(
      a.events.some(
        (e) =>
          e.type === "kiokuko/repository-learning" &&
          e.data.phase === "retrieval" &&
          e.data.status === "unavailable",
      ),
    );
  } finally {
    f.runtime.withDatabase = original;
    await f.close();
  }
});

test("repository reset invalidates a different session reflection already in flight", async () => {
  const f = await fixture();
  try {
    const source = f.agent("original-source");
    turn(source, 1);
    await f.memory.whenIdle();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reflect = f.host.model!;
    f.host.model = async function* (request) {
      entered();
      await gate;
      yield* reflect(request);
    };
    const later = f.agent("later-derived");
    turn(later, 1);
    await started;
    const queued = f.agent("queued-before-reset");
    turn(queued, 1);
    await f.runtime.withDatabase((db) => resetRepositoryLearning(db, f.root));
    release();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    const callsBeforeRestart = f.host.modelCalls.length;
    await f.restart();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    assert.equal(
      f.host.modelCalls.length,
      callsBeforeRestart,
      "reset must not re-reflect saved or pending old turns during native recovery",
    );
    assert(
      later.events.some(
        (e) =>
          e.type === "kiokuko/repository-learning" &&
          e.data.status === "unavailable",
      ),
    );
  } finally {
    await f.close();
  }
});

for (const boundary of [
  "before-response",
  "mid-stream",
  "after-response",
] as const) {
  test(`repository reflection connection loss ${boundary} does not prompt or save and the next turn remains usable`, async () => {
    const f = await fixture();
    const original = f.host.model!;
    try {
      f.host.model = async function* () {
        if (boundary !== "before-response")
          yield {
            type: "text-delta",
            text: boundary === "mid-stream" ? '{"lessons":[' : '{"lessons":[]}',
          };
        if (boundary === "after-response")
          yield { type: "finish", reason: { kind: "stop" } };
        throw new Error(
          "private network failure detail must not enter diagnostics",
        );
      };
      const a = f.agent("network-recovery");
      turn(a, 1);
      await f.memory.whenIdle();
      const first = await f.snapshot();
      assert.equal(first.turnCount, 0);
      assert.equal(f.host.questions.length, 0);
      assert.ok(
        first.points.every(
          (point) =>
            point.kind === "observation" &&
            point.reflectionStatus === "unavailable",
        ),
      );
      assert.ok(
        a.events.some(
          (event) =>
            event.type === "kiokuko/repository-learning" &&
            event.data.status === "unavailable" &&
            event.data.reason === "model_call_failed",
        ),
      );
      assert.ok(!JSON.stringify(first).includes("private network failure"));
      f.host.model = original;
      turn(a, 2);
      await f.memory.whenIdle();
      assert.equal((await f.snapshot()).turnCount, 1);
      assert.equal(
        f.host.modelCalls.length,
        2,
        "there is no automatic network retry loop",
      );
    } finally {
      await f.close();
    }
  });
}

for (const boundary of [
  "transaction",
  "commit-ack",
  "commit-ack-unreadable",
] as const) {
  test(`repository save recovery reconciles ${boundary} against real SQLite without duplicate saves`, async () => {
    const f = await fixture();
    const original = f.runtime.withDatabase.bind(f.runtime);
    let injected = false;
    try {
      f.runtime.withDatabase = async (operation) => {
        if (injected && boundary === "commit-ack-unreadable")
          throw new Error("read unavailable fixture");
        let saved = false;
        const result = await original((db, config) =>
          operation(
            {
              filePath: db.filePath,
              close() {},
              exec: (sql) => db.exec(sql),
              prepare: (sql) => {
                if (
                  !injected &&
                  sql.startsWith("INSERT INTO repository_learning_state")
                ) {
                  saved = true;
                  if (boundary === "transaction") {
                    injected = true;
                    throw new Error("write failure fixture");
                  }
                }
                return db.prepare(sql);
              },
            },
            config,
          ),
        );
        if (saved && !injected) {
          injected = true;
          throw new Error("commit succeeded but acknowledgement lost");
        }
        return result;
      };
      const a = f.agent("save-recovery");
      turn(a, 1);
      await f.memory.whenIdle();
      f.runtime.withDatabase = original;
      assert.equal(
        (await f.snapshot()).turnCount,
        boundary === "transaction" ? 0 : 1,
      );
      const last = a.events
        .filter(
          (event) =>
            event.type === "kiokuko/repository-learning" &&
            event.data.phase === "capture",
        )
        .at(-1)!;
      assert.equal(
        last.data.saveState,
        boundary === "transaction"
          ? "not_saved"
          : boundary === "commit-ack"
            ? "saved"
            : "unknown",
      );
      const calls = f.host.modelCalls.length;
      await f.restart();
      await f.memory.whenIdle();
      assert.equal((await f.snapshot()).turnCount, boundary === "transaction" ? 0 : 1);
      assert.equal(
        f.host.modelCalls.length,
        calls,
      );
      assert.equal(
        await f.runtime.withDatabase(
          (db) =>
            db
              .prepare(
                "SELECT count(*) AS n FROM repository_learning_pending_admissions",
              )
              .get<{ n: number }>()!.n,
        ),
        boundary === "transaction" ? 1 : 0,
      );
      turn(a, 2);
      await f.memory.whenIdle();
      assert.equal((await f.snapshot()).turnCount, boundary === "transaction" ? 1 : 2);
    } finally {
      f.runtime.withDatabase = original;
      await f.close();
    }
  });
}

test("a delayed repository reflection cannot commit after its native agent moves to another workspace", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.model = async function* () {
      started();
      await gate;
      yield { type: "text-delta", text: '{"lessons":[]}' };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    const a = f.agent("moved-workspace");
    turn(a, 1);
    await entered;
    a.a.session.header.cwd = "/";
    release();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
  } finally {
    release?.();
    await f.close();
  }
});

test("native user Stop discards the in-flight reflection and reload does not resurrect it", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.model = async function* () {
      started();
      await gate;
      yield { type: "text-delta", text: '{"lessons":[]}' };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    const a = f.agent("stopped-reflection");
    turn(a, 1);
    await entered;
    a.a.cancel({ kind: "user" });
    release();
    await f.memory.whenIdle();
    assert.equal((await f.snapshot()).turnCount, 0);
    const calls = f.host.modelCalls.length;
    await f.restart();
    await f.memory.whenIdle();
    assert.equal(f.host.modelCalls.length, calls);
    assert.equal((await f.snapshot()).turnCount, 0);
  } finally {
    release?.();
    await f.close();
  }
});
