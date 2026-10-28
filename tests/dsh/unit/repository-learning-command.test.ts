import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../integration/evolution/fixture.js";
import { mountMemoryApplication } from "../../../src/dsh/memory-application.js";
import type { DshNativeCommandDefinition } from "../../../src/dsh/commands.js";
import {
  readRepositoryLearning,
  saveTurn,
  type RepositoryTurnLearning,
} from "../../../src/memory/repository-learning.js";

function setup() {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "learning-command-"));
  const root = join(directory, "repo-a");
  const other = join(directory, "repo-b");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"));
  mkdirSync(other);
  const commands = new Map<string, DshNativeCommandDefinition>();
  const agent = { id: "native-agent" };
  let identity: { sessionId: string; repositoryRoot: string } | undefined = {
    sessionId: "session-a",
    repositoryRoot: join(root, "src"),
  };
  const dispose = mountMemoryApplication(
    {
      tools: { register: () => () => {} },
      on: () => () => {},
      commands: {
        register(command) {
          commands.set(command.name, command);
          return () => {};
        },
      },
    },
    {
      runtime: f.runtime as any,
      resolve: () => undefined,
      refresh: async () => {},
      session: (owner) => (owner === agent ? identity : undefined),
    },
  );
  const invoke = (
    rawInput: string,
    signal = new AbortController().signal,
    owner = agent,
  ) =>
    commands.get("kioku-memory")!.handler({ rawInput, signal, agent: owner });
  const input = (root: string, sessionId: string): RepositoryTurnLearning => ({
    repositoryRoot: root,
    workspace: "project:test",
    captureRevision: 0,
    admissionEpoch: readRepositoryLearning(f.db, root).admissionEpoch,
    sessionId,
    turnId: 1,
    terminalSeq: 10,
    outcome: "completed",
    summary: "PRIVATE-SOURCE-TEXT",
    evidenceRefs: [`native:${sessionId}:10`],
    tags: ["private-tag"],
    reflectionStatus: "model",
    lessons: [],
  });
  return {
    ...f,
    root,
    other,
    directory,
    invoke,
    input,
    clearIdentity: () => {
      identity = undefined;
    },
    close: () => {
      dispose();
      f.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("public registered learning command reports safe counts, resets exact repository and rejects stale insertion", async () => {
  const f = setup();
  try {
    const a = f.input(f.root, "session-a");
    const b = f.input(f.other, "session-b");
    saveTurn(f.db, a);
    saveTurn(f.db, b);
    const status = await f.invoke("learning status");
    assert.equal(status.kind, "success");
    assert.match(status.text!, /"turnCount": 1/u);
    assert.doesNotMatch(status.text!, /PRIVATE-SOURCE-TEXT|private-tag/u);
    assert.ok(!status.text!.includes(f.directory));
    const result = await f.invoke("learning reset");
    assert.equal(result.kind, "success");
    assert.match(result.text!, /Automatic learning remains enabled/u);
    assert.equal(
      readRepositoryLearning(f.db, a.repositoryRoot).points.length,
      0,
    );
    assert.equal(readRepositoryLearning(f.db, b.repositoryRoot).turnCount, 1);
    assert.throws(() => saveTurn(f.db, { ...a, turnId: 2, terminalSeq: 20 }));
    const next = f.input(a.repositoryRoot, "session-next");
    saveTurn(f.db, next);
    assert.equal(readRepositoryLearning(f.db, a.repositoryRoot).turnCount, 1);
  } finally {
    f.close();
  }
});

test("learning command rejects target overrides, unknown sessions and aborted requests without writes", async () => {
  const f = setup();
  try {
    saveTurn(f.db, f.input(f.root, "session-a"));
    const before = readRepositoryLearning(f.db, f.root);
    for (const input of [
      "learning",
      "learning status --json",
      "learning reset /trusted/repo-b",
      "learning reset --all",
      "learning unknown",
    ])
      assert.equal((await f.invoke(input)).kind, "error");
    assert.equal(
      (await f.invoke("learning reset", AbortSignal.abort())).kind,
      "error",
    );
    assert.equal(
      (await f.invoke("learning reset", undefined, { id: "other-agent" })).kind,
      "error",
    );
    f.clearIdentity();
    assert.equal((await f.invoke("learning reset")).kind, "error");
    assert.deepEqual(readRepositoryLearning(f.db, f.root), before);
  } finally {
    f.close();
  }
});
