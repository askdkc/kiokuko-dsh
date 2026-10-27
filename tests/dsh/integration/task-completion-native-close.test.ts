import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConnection } from "../../../src/db/connection.js";
import { migrateDatabase } from "../../../src/db/migrate.js";
import { prepareAgentTask } from "../../../src/dsh/task-intake.js";
import { createLifecycle } from "../../../src/dsh/host-adapter/lifecycle.js";
import { DshTaskWorkflow } from "../../../src/dsh/task-state-host.js";
import { OwnedExecutionService } from "../../../src/dsh/owned-execution.js";
import {
  bindTaskRepository,
  captureTaskLease,
  readTaskSnapshot,
  transitionTask,
  type TaskLease,
} from "../../../src/dsh/task-state.js";

// Public task_operation service and real owned read, with a controlled native idle
// boundary. The separate CLI experiment covers installed plugin activation.
for (const resumeAt of ["never", "before-idle", "before-close"] as const) {
  test(
    `public completion retires only its exact native projection: resume ${resumeAt}`,
    { timeout: 15_000 },
    async () => {
      const base = await realpath(
        await mkdtemp(join(tmpdir(), "kiokuko-public-close-")),
      );
      const root = join(base, "repo");
      await mkdir(root);
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(join(root, "evidence.txt"), "Actual current evidence");
      const db = openConnection(join(base, "state.sqlite3"));
      let idle!: () => void;
      const idlePromise = new Promise<void>((resolve) => {
        idle = resolve;
      });
      let observed!: () => void;
      const checkpointed = new Promise<void>((resolve) => {
        observed = resolve;
      });
      let callbackFinished!: () => void;
      const callback = new Promise<void>((resolve) => {
        callbackFinished = resolve;
      });
      let service: DshTaskWorkflow | undefined,
        owned: OwnedExecutionService | undefined;
      let lifecycle: ReturnType<typeof createLifecycle> | undefined;
      try {
        migrateDatabase(db, join(process.cwd(), "migrations"));
        const prepared = await prepareAgentTask(db, {
          requestId: "public-completion",
          cwd: root,
          task: "Read evidence.txt and report its actual contents.",
          dshSessionId: "public-close",
          profileHints: {
            taskType: "research",
            target: "evidence.txt",
            expected: "report",
            constraints: null,
          },
          capabilities: [],
          skillDiscoveryMode: "off",
        });
        const identity = {
          taskId: prepared.run.runId,
          sessionId: "public-close",
          repositoryRoot: root,
        };
        bindTaskRepository(db, identity);
        const previous = captureTaskLease(db, identity);
        const session = {
          id: identity.sessionId,
          header: { cwd: root },
          seq: 1,
          snapshotEvents: () => [],
        };
        const agent = {
          id: "public-agent",
          session,
          status: "running",
          whenIdle: () => idlePromise,
        };
        const item: any = {
          runId: identity.taskId,
          sessionId: identity.sessionId,
          agentId: agent.id,
          repositoryRoot: root,
          workspace: prepared.project.workspace,
          cwd: root,
          turn: 1,
          prepared,
          authority: previous,
          nativeAgent: agent,
          nativeSession: session,
          closed: false,
          failed: false,
        };
        let turns = [item],
          resumeAfterValidation = false;
        const effects: Array<{
          kind: string;
          authority?: TaskLease | undefined;
        }> = [];
        const resume = () => {
          const current = readTaskSnapshot(db, identity);
          transitionTask(db, identity, {
            operation: "resume",
            operationId: "explicit-resume",
            expectedRevision: current.revision,
            expectedGeneration: current.generation,
            reason: "User continues this task.",
            explicit: true,
          });
          turns = [
            {
              ...item,
              authority: captureTaskLease(db, identity),
              closed: false,
              turn: 2,
            },
          ];
        };
        const runtime: any = {
          async withDatabase(fn: (database: typeof db) => unknown) {
            const result = await fn(db);
            if (resumeAfterValidation && item.authority !== previous) {
              resumeAfterValidation = false;
              resume();
            }
            return result;
          },
        };
        lifecycle = createLifecycle({
          runtime,
          sessions: { get: (id) => (id === session.id ? session : undefined) },
          sessionMirror: {} as any,
          memoryFinalizer: {} as any,
          autoReview: {
            worker: { abort: () => effects.push({ kind: "abort-review" }) },
          } as any,
          answerReview: {
            finish: async () => effects.push({ kind: "finish-review" }),
          } as any,
          ennoController: {
            retire: () => effects.push({ kind: "retire" }),
          } as any,
          ennoMemory: { clear: () => {} } as any,
          executionSupport: { clear: () => {} } as any,
          gate: { clearTurn: () => {} } as any,
          turnState: {
            allTurns: () => turns,
            releaseRun(_id: string, authority: TaskLease) {
              effects.push({ kind: "release", authority });
              turns = turns.filter(
                (turn) => turn.authority.generation !== authority.generation,
              );
            },
          } as any,
          getSelection: () => undefined,
          currentSession: () => turns.at(-1),
          currentForAgentEvent: () => turns.at(-1),
          stateForRun: () => prepared.ennoOduno,
          deliverCompletionReport: async () => {},
          reviewBinding: () => ({}) as any,
          evolutionConfig: { mode: "off" } as any,
          clearToolRun: () => effects.push({ kind: "clear-tools" }),
          sessionEventSource: () => ({}) as any,
          onRunClosed: (_id, _status, _session, authority) =>
            effects.push({ kind: "review", authority }),
        });
        service = new DshTaskWorkflow({
          runtime,
          agents: { get: () => agent },
          sessions: { get: () => session },
          skills: { snapshot: async () => ({ complete: true, skills: [] }) },
          tools: { schemas: () => [] },
          emit: () => {},
          checkpointSource: async () => {
            observed();
          },
          onCompleted: async (task) => {
            try {
              await lifecycle!.completeTask(task);
            } finally {
              callbackFinished();
            }
          },
        });
        owned = new OwnedExecutionService({
          runtime,
          resolve: (execution) =>
            execution.agent === agent
              ? {
                  runId: identity.taskId,
                  sessionId: session.id,
                  repositoryRoot: root,
                  workspace: prepared.project.workspace,
                  agent,
                  generation: "actual-owned-read",
                }
              : undefined,
        });
        const observation: any = await owned.execute(
          "kioku_read",
          { path: "evidence.txt" },
          {
            name: "kioku_read",
            callId: "read-evidence",
            agent,
            signal: new AbortController().signal,
          },
        );
        const done = await service.modelOperation(
          agent,
          {
            operation: "complete",
            taskId: identity.taskId,
            expectedRevision: previous.revision,
            expectedGeneration: previous.generation,
            reason: "The requested contents were observed.",
            evidence: [observation.receipt.evidenceRef],
          },
          { callId: "complete", signal: new AbortController().signal },
        );
        assert.equal(done.state, "Done");
        assert.equal(done.runStatus, "active");
        assert.equal(
          effects.length,
          0,
          "completion must wait for the final native answer",
        );
        if (resumeAt === "before-idle") resume();
        resumeAfterValidation = resumeAt === "before-close";
        agent.status = "idle";
        idle();
        await checkpointed;
        if (resumeAt !== "before-idle") await callback;
        else await new Promise((resolve) => setImmediate(resolve));
        const terminal = readTaskSnapshot(db, identity);
        if (resumeAt === "never") {
          assert.equal(terminal.runStatus, "completed");
          assert.equal(item.closed, true);
          assert.equal(turns.length, 0);
          const reviews = effects.filter((effect) => effect.kind === "review");
          assert.equal(reviews.length, 1);
          assert.equal(reviews[0]!.authority!.revision, terminal.revision);
          assert.equal(reviews[0]!.authority!.generation, terminal.generation);
          assert.ok(
            terminal.generation > done.generation,
            "ledger terminal trigger advances authority again",
          );
          await lifecycle.completeTask(done);
          assert.equal(
            effects.filter((effect) => effect.kind === "review").length,
            1,
          );
        } else {
          assert.equal(terminal.runStatus, "active");
          assert.equal(terminal.state, "Working");
          assert.equal(turns[0]!.closed, false);
          assert.equal(effects.length, 0);
          const authority = turns[0]!.authority;
          await lifecycle.completeTask(done);
          assert.equal(turns[0]!.authority, authority);
          assert.equal(effects.length, 0);
        }
      } finally {
        idle();
        service?.dispose();
        await owned?.close();
        await lifecycle?.runLifecycle.dispose();
        db.close();
        await rm(base, { recursive: true, force: true });
      }
    },
  );
}
