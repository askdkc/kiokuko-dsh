import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  isHostExecutionResult,
  observeProcessResult,
} from "../../../src/dsh/execution-result.js";
import {
  assessTaskCompletion,
  beginTaskCompletionExecution,
  bindTaskCriterion,
  finishTaskCompletionExecution,
} from "../../../src/dsh/task-completion.js";
import { prepareAgentTask } from "../../../src/dsh/task-intake.js";
import { reviewCompletedReplay } from "../../../src/memory/replay-review.js";
import { createApprovedReplayMemoryStore } from "../../../src/memory/replay-store.js";
import { agenticReplayFixture } from "../helpers/agenticreplay-fixture.js";

const cases = [
  ["passed", "satisfied", "verified_success"],
  ["failed", "unmet", "failed"],
  ["omitted", "unknown", "unknown"],
  ["changed", "stale", "unknown"],
  ["mismatch", "unmet", "failed"],
  ["unbranded_passed", "unknown", "unknown"],
  ["unbranded_mismatch", "unknown", "unknown"],
  ["unbranded_failed", "unmet", "failed"],
  ["unbranded_changed", "stale", "unknown"],
] as const;

for (const [scenario, state, outcome] of cases) {
  test(`actual bound checker ${scenario}: its assessment reaches reflection before approval`, async () => {
    const f = await agenticReplayFixture({ shutdownDrainTimeoutMs: 3000 });
    try {
      // Own repository discovery even if a temporary-directory ancestor is a checkout.
      await mkdir(join(f.root, ".git"));
      await writeFile(join(f.root, "input.json"), "[2,1,2]");
      await writeFile(
        join(f.root, "task.mjs"),
        `import {readFileSync,writeFileSync} from 'node:fs';
const values=JSON.parse(readFileSync('input.json','utf8'));
writeFileSync('output.json',JSON.stringify(${scenario.endsWith("failed") ? "values" : "values.sort((a,b)=>a-b)"}));\n`,
      );
      await writeFile(
        join(f.root, "check.mjs"),
        `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.deepEqual(JSON.parse(readFileSync('output.json','utf8')),[1,2,2]);
console.log('${scenario.endsWith("mismatch") ? "different checker output" : "exact artifact verified"}');\n`,
      );
      const task =
        "保存内容を確認する。\n完了条件:\n- 独立チェックが期待する保存内容と一致する";
      const prepared = await prepareAgentTask(f.database, {
        requestId: `replay-completion-${scenario}`,
        cwd: f.root,
        task,
        dshSessionId: f.binding.sessionId,
        profileHints: {
          taskType: "research",
          target: "保存内容",
          expected: "独立チェックで確認する",
          constraints: null,
        },
        completionMode: "enforce",
        capabilities: [],
        skillDiscoveryMode: "off",
      });
      assert.equal(prepared.executionContext.repositoryRoot, f.root);
      const runId = prepared.run.runId;
      const binding = { ...f.binding, kiokukoRunId: runId };
      const order: string[] = [];
      const measured: Array<{ callId: string; exitCode: number | null }> = [];
      f.recorder.start(binding);
      const execute = (file: string, callId: string, completion = false) => {
        const command = `node ${file}`;
        const execution = {
          token: Symbol(),
          callId,
          rootCallId: callId,
          name: "bash",
          arguments: { command },
        };
        if (completion) {
          assert.equal(
            beginTaskCompletionExecution(f.database, {
              runId,
              callId,
              command,
              repositoryRoot: f.root,
            }),
            true,
          );
        }
        f.recorder.preTool(binding, execution);
        const processResult = spawnSync(process.execPath, [file], {
          cwd: f.root,
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(processResult.error, undefined);
        const observed = observeProcessResult({
          isError: processResult.status !== 0,
          value: {
            exitCode: processResult.status,
            signal: processResult.signal,
            timedOut: false,
            aborted: false,
            processStarted: true,
            processStopped: true,
            outputComplete: true,
          },
          content: [
            {
              type: "text",
              text: processResult.stdout + processResult.stderr,
            },
          ],
        });
        // Serialization retains actual process data, not the host's private proof.
        const result =
          completion && scenario.startsWith("unbranded_")
            ? structuredClone(observed)
            : observed;
        assert.equal(
          isHostExecutionResult(result),
          !(completion && scenario.startsWith("unbranded_")),
        );
        measured.push({ callId, exitCode: processResult.status });
        f.recorder.toolResult(binding, execution, result);
        if (completion) {
          finishTaskCompletionExecution(f.database, { runId, callId, result });
          order.push("checker-recorded");
        }
      };
      execute("task.mjs", "generate");
      assert.equal(measured[0]!.exitCode, 0);
      const criteria = assessTaskCompletion(f.database, runId).criteria;
      assert.equal(criteria.length, 1);
      bindTaskCriterion(f.database, {
        runId,
        callId: "approve-exact-check",
        criterionId: criteria[0]!.criterionId,
        method: {
          kind: "native_command",
          command: "node check.mjs",
          cwd: ".",
          sourcePaths: ["task.mjs", "input.json", "check.mjs", "output.json"],
          assertion: "output_matches",
          expectedOutput: "exact artifact verified",
        },
        approved: true,
      });
      if (scenario !== "omitted") execute("check.mjs", "verify", true);
      if (scenario.endsWith("changed")) {
        await writeFile(
          join(f.root, "task.mjs"),
          (await readFile(join(f.root, "task.mjs"), "utf8")) +
            "// changed after verification\n",
        );
      }
      assert.deepEqual(
        measured.map((result) => result.exitCode),
        scenario === "omitted" ? [0] : [0, scenario.endsWith("failed") ? 1 : 0],
      );
      await f.recorder.closeSessionRecording(binding.sessionId, "manual");
      const trace = f.recorder.status(binding.sessionId).trace!;
      assert.equal(trace.last_error_code, null);
      const proposal = await f.reader.memoryEvidence(
        binding,
        trace.agenticreplay_run_id,
        {
          workspace: prepared.project.workspace,
          taskId: runId,
          request: { text: task, evidenceRefs: [`ledger:${runId}:title`] },
        },
      );
      assert.ok(proposal.attempts.every((attempt) => attempt.taskId === runId));
      const store = createApprovedReplayMemoryStore(
        f.database,
        prepared.project.workspace,
      );
      let reflected = 0;
      let preview = "";
      const receipt = await reviewCompletedReplay({
        completed: true,
        // A completion claim must not defeat a failed, absent, or stale check.
        taskOutcome: "completed",
        taskId: runId,
        sessionId: binding.sessionId,
        workspace: prepared.project.workspace,
        extract: async () => proposal,
        assessment: async () => {
          order.push("assessed");
          const assessment = assessTaskCompletion(f.database, runId);
          assert.equal(assessment.criteria[0]!.state, state);
          assert.equal(assessment.verified, scenario === "passed");
          return assessment;
        },
        reflector: {
          origin: "fixture",
          reflect: async (packet) => {
            reflected++;
            order.push("reflected");
            assert.equal(packet.claimedOutcome, "completed");
            assert.equal(packet.outcome, outcome);
            assert.equal(packet.checks[0]!.state, state);
            assert.equal(
              packet.checks[0]!.evidenceRef,
              scenario === "omitted" ? undefined : "verify",
            );
            return {
              hypothesis:
                "Task claims must be checked against current observed evidence.",
              applicability:
                "A task with an explicitly approved artifact check",
              nextAction:
                "Run the approved checker after the last source change.",
              verifyWith:
                "Use the current bound checker assessment, not the assistant's conclusion.",
              evidenceRefs: [packet.attempts.at(-1)!.resultRef!],
            };
          },
        },
        ask: async (question) => {
          order.push(question.phase);
          if (question.phase === "organize") assert.equal(reflected, 0);
          else {
            assert.equal(reflected, 1);
            preview = question.text;
          }
          return {
            questionId: question.id,
            choice: question.phase === "organize" ? "organize" : "approve",
          };
        },
        save: async (value, approvalKey) => {
          assert.ok(preview.includes(JSON.stringify(value, null, 2)));
          order.push("saved");
          store.save(value, approvalKey);
        },
      });
      assert.equal(receipt.status, "saved");
      assert.deepEqual(order, [
        ...(scenario === "omitted" ? [] : ["checker-recorded"]),
        "organize",
        "assessed",
        "reflected",
        "review",
        "saved",
      ]);
      assert.equal(
        f.database.prepare("SELECT COUNT(*) AS n FROM replay_memories").get()!
          .n,
        1,
      );
    } finally {
      await f.dispose();
    }
  });
}
