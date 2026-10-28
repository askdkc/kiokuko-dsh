import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  model?: (request: any) => AsyncIterable<any>;
  get(name: string) {
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repo-learning-"));
  execFileSync("git", ["init", "-q", root]);
  let runtime = new DshCoreRuntime({
    repositoryRoot: root,
    databasePath: join(root, "memory.sqlite3"),
    autoRegisterRepository: true,
    migrationsDirectory: join(process.cwd(), "migrations"),
  });
  await runtime.start();
  const host = new Host();
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
  function agent(id: string, cwd = root) {
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
      async step(turn: number, query = "unrelated keyword") {
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
                messages: [
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
  memory = new DshLifecycleMemory(host as any, runtime, root);
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
        repositoryRoot: root,
        databasePath: join(root, "memory.sqlite3"),
        autoRegisterRepository: true,
        migrationsDirectory: join(process.cwd(), "migrations"),
      });
      await runtime.start();
      memory = new DshLifecycleMemory(host as any, runtime, root);
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
test("normal lifecycle automatically reflects, persists and injects repository learning regardless of keywords, including restart", async () => {
  const f = await fixture();
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
test("no tools and cancelled turns are observed without being promoted to success; duplicate event is not resaved", async () => {
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
    assert.equal(snapshot.turnCount, 1);
    assert.equal(snapshot.points[0]?.outcome, "cancelled");
    assert.match(snapshot.compact, /unverified/);
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
test("missing model route saves bounded observed turn and reports unavailable instead of claiming a generated lesson", async () => {
  const f = await fixture();
  try {
    delete f.host.model;
    const a = f.agent("missing");
    turn(a, 1);
    await f.memory.whenIdle();
    const snapshot = await f.snapshot();
    assert.equal(snapshot.turnCount, 1);
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
    f.host.model = async function* () {
      entered();
      await gate;
      yield { type: "text-delta", text: '{"lessons":[]}' };
      yield { type: "finish", reason: { kind: "stop" } };
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
