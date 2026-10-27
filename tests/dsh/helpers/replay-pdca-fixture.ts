import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgenticReplayRecorderDependencies } from "../../../src/dsh/agenticreplay-recorder.js";
import { agenticReplayFixture } from "./agenticreplay-fixture.js";
import {
  replayReflectionInput,
  type ReplayLessonApplication,
} from "../../../src/memory/replay-reflection.js";
import type { CompletionAssessment } from "../../../src/dsh/task-completion.js";

export const baselineProgram = `import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync('input.json','utf8'));
writeFileSync('output/answer.json',JSON.stringify({values:[...input.values].sort((a,b)=>a-b)}));\n`;
export const correctedProgram = `import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const input=JSON.parse(readFileSync('input.json','utf8'));
mkdirSync('output',{recursive:true});
writeFileSync('output/answer.json',JSON.stringify({values:[...input.values].sort((a,b)=>a-b)}));\n`;
const payload = JSON.stringify({ values: [10, 2, -1, 2] });
const checker = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.deepEqual(JSON.parse(readFileSync('output/answer.json','utf8')),{values:[-1,2,2,10]});
console.log('artifact exact values verified');\n`;
export const taskKey = createHash("sha256")
  .update(payload + "\0" + checker)
  .digest("hex");

/** Executes actual cold-state subprocesses; no model and no success-from-lesson flag. */
export async function runPdcaFixture(
  program: string,
  taskId: string,
  repetitions = 1,
  applied?: { reflectionId: string; actionSha256: string },
  dependencies: AgenticReplayRecorderDependencies = {},
) {
  const f = await agenticReplayFixture(
    { shutdownDrainTimeoutMs: 3000 },
    dependencies,
  );
  try {
    await writeFile(join(f.root, "input.json"), payload);
    await writeFile(join(f.root, "task.mjs"), program);
    await writeFile(join(f.root, "check.mjs"), checker);
    const binding = { ...f.binding, kiokukoRunId: taskId };
    f.recorder.start(binding);
    let executedSha256 = "";
    const measured: Array<{
      command: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }> = [];
    for (const [i, file] of [
      ...Array<string>(repetitions).fill("task.mjs"),
      "check.mjs",
    ].entries()) {
      const command = `node ${file}`;
      const execution = {
        token: Symbol(),
        callId: `${taskId}-${i}`,
        rootCallId: `${taskId}-${i}`,
        name: "bash",
        arguments: { command },
      };
      f.recorder.preTool(binding, execution);
      if (file === "task.mjs")
        executedSha256 = createHash("sha256")
          .update(await readFile(join(f.root, file)))
          .digest("hex");
      const result = spawnSync(process.execPath, [file], {
        cwd: f.root,
        encoding: "utf8",
        timeout: 5000,
      });
      measured.push({
        command,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      f.recorder.toolResult(binding, execution, {
        isError: result.status !== 0,
        value: {
          exitCode: result.status,
          processStarted: true,
          processStopped: true,
        },
        content: [{ type: "text", text: result.stdout + result.stderr }],
      });
    }
    await f.recorder.closeSessionRecording(f.binding.sessionId, "manual");
    const trace = f.recorder.status(f.binding.sessionId).trace!;
    if (trace.last_error_code) throw new Error(trace.last_error_code);
    const proposal = await f.reader.memoryEvidence(
      binding,
      trace.agenticreplay_run_id,
      {
        workspace: "project:pdca",
        taskId,
        request: {
          text: "Produce output/answer.json containing the input numeric values in ascending order, preserving duplicates. Verify the exact artifact from a cold directory.",
          evidenceRefs: [`fixture:${taskId}:request`],
        },
      },
    );
    // Deliberately false completion in the failing control, to challenge the check boundary.
    proposal.source.taskOutcome = "completed";
    const checkRef = proposal.attempts.at(-1)!.resultRef!;
    const passed = measured.at(-1)!.exitCode === 0;
    const assessment: CompletionAssessment = {
      mode: "enforce",
      required: 1,
      verified: passed,
      criteria: [
        {
          criterionId: "exact-artifact",
          description: "Artifact equals {values:[-1,2,2,10]}",
          state: passed ? "satisfied" : "unmet",
          reason: passed ? "artifact_exact_match" : "artifact_check_failed",
          evidenceRef: checkRef,
        },
      ],
    };
    let artifact: unknown;
    try {
      artifact = JSON.parse(
        await readFile(join(f.root, "output/answer.json"), "utf8"),
      );
    } catch {
      artifact = null;
    }
    const application: ReplayLessonApplication | undefined = applied
      ? { ...applied, callRef: proposal.attempts[0]!.callRef, executedSha256 }
      : undefined;
    return {
      ...f,
      proposal,
      assessment,
      application,
      packet: replayReflectionInput(proposal, assessment),
      measured,
      artifact,
      taskKey,
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
