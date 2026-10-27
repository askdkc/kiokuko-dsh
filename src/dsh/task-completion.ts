import {
  assertionForCriterion,
  COMPLETION_BINDING_GUIDE,
} from "./task-completion-guidance.js";
import {
  ProtocolRecipeSchema,
  PROTOCOL_CAPABILITIES,
} from "./guardrail/contracts.js";
import {
  enrollProtocol,
  invalidateProtocolBinding,
  protocolCompletionReady,
  unresolvedManaged,
} from "./guardrail/service.js";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import type { SqliteDatabase, SqliteRow } from "../db/adapter.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { KiokukoError } from "../errors.js";
import { applicationSourceDigest } from "../memory/application.js";
import { canonicalContentHash } from "../serialization/validate.js";
import { completionVerifiers } from "./completion-verifiers.js";
import { readExecutionFrame } from "./execution-frame.js";
import {
  hasExplicitTestCases,
  parseNodeTapSummary,
  parseTestSummary,
  selectedNodeTestCommand,
  type TapSummary,
} from "./node-tap-summary.js";
import { isHostExecutionResult } from "./execution-result.js";
import {
  executionCommand,
  EXECUTION_COMMAND_VERSION,
  hasShellPipeline,
} from "./execution-command.js";
import { readCodingWorkflow } from "./coding-workflow/store.js";
import { recordCodingAttempt } from "./coding-workflow/service.js";

export const CompletionConfig = z
  .object({ mode: z.enum(["shadow", "enforce"]).default("shadow") })
  .strict();
export type CompletionMode = z.infer<typeof CompletionConfig>["mode"];
const text = z.string().trim().min(1).max(4096);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !/[\p{Cc}\p{Cf}]/u.test(value),
  );
export const CompletionMethodSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native_command"),
      command: text,
      cwd: text,
      sourcePaths: z.array(relativePath).min(1).max(32),
      assertion: z.enum([
        "exit_zero",
        "selected_tests_pass",
        "output_matches",
        "artifact_matches",
      ]),
      protocol: ProtocolRecipeSchema.optional(),
      expectedOutput: text.optional(),
      artifactPath: relativePath.optional(),
      artifactSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.protocol && value.assertion !== "selected_tests_pass")
        ctx.addIssue({
          code: "custom",
          path: ["assertion"],
          message: "Protocol recipes require selected tests",
        });
      if (value.assertion === "output_matches" && !value.expectedOutput)
        ctx.addIssue({
          code: "custom",
          path: ["expectedOutput"],
          message: "Output assertion requires expectedOutput",
        });
      if (value.assertion === "artifact_matches") {
        if (!value.artifactPath)
          ctx.addIssue({
            code: "custom",
            path: ["artifactPath"],
            message: "Artifact assertion requires path",
          });
        if (!value.artifactSha256)
          ctx.addIssue({
            code: "custom",
            path: ["artifactSha256"],
            message: "Artifact assertion requires SHA-256",
          });
      }
    }),
  z
    .object({
      kind: z.literal("enno_verifier"),
      verifierId: text,
      workUnitId: text.optional(),
      assertion: z.enum(["exit_zero", "selected_tests_pass"]),
    })
    .strict(),
]);
export type CompletionMethod = z.infer<typeof CompletionMethodSchema>;
export type CriterionAssessment = {
  criterionId: string;
  description: string;
  state: "satisfied" | "unmet" | "unknown" | "stale";
  reason: string;
  evidenceRef?: string;
};
export type CompletionAssessment = {
  mode: CompletionMode;
  verified: boolean;
  required: number;
  criteria: CriterionAssessment[];
  workflowReady?: boolean;
  managedOperationsReady?: boolean;
  coding?: {
    workflowId: string;
    state: string;
    scopeVersion: number;
    protocol?: {
      kind: "bounded-tdd-v1";
      phase: string;
      reason?: string;
      generation: number;
      capabilities: typeof PROTOCOL_CAPABILITIES;
    };
    goalCriterionIds: string[];
    itemCriterionIds: string[];
  };
};
interface CompletionCriterion {
  id: string;
  description: string;
  revision: number;
  approval: "explicit" | "approved";
}
interface BindingRow extends SqliteRow {
  criterion_id: string;
  criterion_revision: number;
  method_json: string;
  method_digest: string;
  approved: number;
}
interface ExecutionRow extends SqliteRow {
  call_id: string;
  method_digest: string;
  source_digest: string;
  outcome: string;
  coding_scope: number | null;
  coding_goal_ready: number | null;
  coding_inputs_json: string | null;
  exit_code: number | null;
  tap_summary_json: string | null;
}
export { parseNodeTapSummary, selectedNodeTestCommand };

export function initializeTaskCompletion(
  database: SqliteDatabase,
  runId: string,
  mode: CompletionMode,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO dsh_completion_runs(run_id,mode,created_at) VALUES(?,?,?)",
    )
    .run(runId, mode, new Date().toISOString());
}

function runMode(database: SqliteDatabase, runId: string): CompletionMode {
  return (
    database
      .prepare("SELECT mode FROM dsh_completion_runs WHERE run_id = ?")
      .get<{ mode: CompletionMode }>(runId)?.mode ?? "shadow"
  );
}

function criteriaForRun(
  database: SqliteDatabase,
  runId: string,
): { criteria: CompletionCriterion[]; repositoryRoot: string; enno: boolean } {
  const coding = readCodingWorkflow(database, runId);
  if (coding)
    return {
      repositoryRoot: coding.repositoryRoot,
      enno:
        database
          .prepare(
            "SELECT 1 FROM dsh_execution_selections WHERE run_id=? AND json_extract(state_json,'$.mode')='enno'",
          )
          .get(runId) !== undefined,
      criteria: (coding.definition?.criteria ?? []).map((item) => ({
        id: `coding:${coding.workflowId}:${item.criterionId}`,
        description: `${item.outcome} / ${item.procedure} / ${item.expected}`,
        revision: item.revision,
        approval: "explicit",
      })),
    };
  const row = database
    .prepare(
      `SELECT contract.repository_root AS root, contract.workspace,
    contract.orchestration_session_id AS orchestrationId FROM ledger_runs AS ledger
    LEFT JOIN enno_contracts AS contract ON contract.run_id = ledger.run_id WHERE ledger.run_id = ?`,
    )
    .get<{
      root: string;
      workspace: string | null;
      orchestrationId: string | null;
    }>(runId);
  if (!row)
    throw new KiokukoError("NOT_FOUND", "Task completion run does not exist");
  if (row.workspace && row.orchestrationId && row.root) {
    const snapshot = completionVerifiers().criteria(database, {
      runId,
      workspace: row.workspace,
      orchestrationId: row.orchestrationId,
    });
    return {
      repositoryRoot: row.root,
      enno: true,
      criteria: snapshot.criteria.map((item) => ({
        id: item.id,
        description: item.description,
        revision: snapshot.revision,
        approval: "approved",
      })),
    };
  }
  const frame = readExecutionFrame(database, runId);
  return {
    repositoryRoot: frame?.workspace ?? "",
    enno: false,
    criteria: (frame?.conditions ?? [])
      .filter(
        (item) => item.field === "completion" && item.approval !== "proposed",
      )
      .map((item, index) => ({
        id: `condition-${canonicalContentHash({
          runId,
          revision: frame!.revision,
          index,
          text: item.text,
          source: item.source,
        }).slice(0, 24)}`,
        description: item.text,
        revision: frame!.revision,
        approval: item.approval as "explicit" | "approved",
      })),
  };
}

/** Advice reads the same immutable criterion contract as binding; it cannot supply execution proof. */
export function taskCompletionBindingGuide(
  database: SqliteDatabase,
  runId: string,
) {
  const source = criteriaForRun(database, runId),
    coding = readCodingWorkflow(database, runId);
  return {
    ...structuredClone(COMPLETION_BINDING_GUIDE),
    kind: source.enno ? "enno_verifier" : "native_command",
    criteria: source.criteria.map((criterion) => {
      const definition = coding?.definition?.criteria.find(
        (item) =>
          criterion.id === `coding:${coding.workflowId}:${item.criterionId}`,
      );
      return {
        criterionId: criterion.id,
        requiredAssertion: definition
          ? assertionForCriterion(definition.evidence)
          : null,
      };
    }),
  };
}

function binding(
  database: SqliteDatabase,
  runId: string,
  criterionId: string,
): BindingRow | undefined {
  return database
    .prepare(
      "SELECT * FROM dsh_completion_bindings WHERE run_id = ? AND criterion_id = ?",
    )
    .get<BindingRow>(runId, criterionId);
}

function validateMethod(
  database: SqliteDatabase,
  runId: string,
  method: CompletionMethod,
  repositoryRoot: string,
  enno: boolean,
): void {
  const coding = readCodingWorkflow(database, runId);
  if (coding && method.assertion === "exit_zero")
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Coding criteria require selected tests or observable output/artifact assertions, not exit 0 alone",
    );
  if (enno !== (method.kind === "enno_verifier"))
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Completion method does not match execution mode",
      {
        field: "method.kind",
        expected: enno ? "enno_verifier" : "native_command",
      },
    );
  if (method.kind === "native_command") {
    const cwd = realpathSync(path.resolve(repositoryRoot, method.cwd));
    const relative = path.relative(realpathSync(repositoryRoot), cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new KiokukoError(
        "SECURITY_REJECTION",
        "Completion cwd must be inside the repository",
      );
    applicationSourceDigest(repositoryRoot, method.sourcePaths);
    // The pre-bound command selects the operation; complete process output,
    // rather than a command-name allowlist, establishes test coverage.
  } else {
    const row = database
      .prepare("SELECT contract_json FROM enno_contracts WHERE run_id = ?")
      .get<{ contract_json: string }>(runId);
    const contract = row
      ? (JSON.parse(row.contract_json) as {
          finalVerifiers?: { id: string; executable: string; args: string[] }[];
          workPlan?: {
            units: {
              id: string;
              focusedVerifiers: {
                id: string;
                executable: string;
                args: string[];
              }[];
            }[];
          };
        })
      : undefined;
    const verifiers = method.workUnitId
      ? contract?.workPlan?.units.find((unit) => unit.id === method.workUnitId)
          ?.focusedVerifiers
      : contract?.finalVerifiers;
    const verifier = verifiers?.find((item) => item.id === method.verifierId);
    if (!verifier)
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "Completion verifier is absent from the approved Enno contract",
        { field: "method.verifierId", expected: "approved_contract_verifier" },
      );
    if (
      !coding &&
      method.assertion === "selected_tests_pass" &&
      !selectedNodeTestCommand(
        [verifier.executable, ...verifier.args].join(" "),
      )
    ) {
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "Selected-test proof requires an explicit Node TAP verifier",
      );
    }
  }
}

export function bindTaskCriterion(
  database: SqliteDatabase,
  input: {
    runId: string;
    callId: string;
    criterionId: string;
    method: unknown;
    approved: boolean;
  },
): { criterionId: string; approved: boolean; methodDigest: string } {
  const method = CompletionMethodSchema.parse(input.method);
  const requestDigest = canonicalContentHash({
    criterionId: input.criterionId,
    method,
  });
  const previous = database
    .prepare(
      "SELECT request_digest, response_json FROM dsh_completion_bind_ops WHERE run_id = ? AND call_id = ?",
    )
    .get<{ request_digest: string; response_json: string }>(
      input.runId,
      input.callId,
    );
  if (previous) {
    if (previous.request_digest !== requestDigest)
      throw new KiokukoError(
        "CONFLICT",
        "Task completion call ID was reused with changed input",
      );
    return JSON.parse(previous.response_json);
  }
  const source = criteriaForRun(database, input.runId);
  const criterion = source.criteria.find(
    (item) => item.id === input.criterionId,
  );
  if (!criterion)
    throw new KiokukoError(
      "CONFLICT",
      "Completion criterion is absent or its revision changed",
    );
  const codingWorkflow = readCodingWorkflow(database, input.runId);
  const codingCriterion = codingWorkflow?.definition?.criteria.find(
    (item) =>
      input.criterionId ===
      `coding:${codingWorkflow.workflowId}:${item.criterionId}`,
  );
  const requiredAssertion = assertionForCriterion(
    codingCriterion?.evidence ?? "selected_tests",
  );
  if (codingCriterion && method.assertion !== requiredAssertion)
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Bound assertion does not match this criterion’s required evidence",
      { field: "method.assertion", expected: requiredAssertion },
    );
  if (
    method.kind === "native_command" &&
    method.artifactPath &&
    !method.sourcePaths.includes(method.artifactPath)
  )
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Include the asserted artifact in sourcePaths so changes invalidate its evidence",
      { field: "method.sourcePaths", expected: "include_asserted_artifact" },
    );
  validateMethod(
    database,
    input.runId,
    method,
    source.repositoryRoot,
    source.enno,
  );
  const approved =
    input.approved ||
    criterion.description.trim() ===
      (method.kind === "native_command" ? method.command : method.verifierId);
  // One approved command may substantiate several criteria in the same
  // revision, but never a criterion from a later contract revision.
  const coding = readCodingWorkflow(database, input.runId);
  const methodDigest = canonicalContentHash({
    revision: criterion.revision,
    method,
    ...(coding ? { scope: coding.scopeVersion } : {}),
  });
  const response = { criterionId: criterion.id, approved, methodDigest };
  withImmediateTransaction(database, () => {
    const prior = binding(database, input.runId, criterion.id);
    if (
      !prior ||
      prior.criterion_revision !== criterion.revision ||
      prior.method_digest !== methodDigest ||
      prior.approved !== (approved ? 1 : 0)
    ) {
      database
        .prepare(
          `INSERT INTO dsh_completion_bindings(run_id,criterion_id,criterion_revision,method_json,method_digest,approved,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,criterion_id) DO UPDATE SET
          criterion_revision=excluded.criterion_revision,method_json=excluded.method_json,method_digest=excluded.method_digest,
          approved=excluded.approved,updated_at=excluded.updated_at`,
        )
        .run(
          input.runId,
          criterion.id,
          criterion.revision,
          JSON.stringify(method),
          methodDigest,
          approved ? 1 : 0,
          new Date().toISOString(),
        );
    }
    if (approved && method.kind === "native_command" && method.protocol)
      enrollProtocol(
        database,
        {
          runId: input.runId,
          sessionId: coding!.sessionId,
          repositoryRoot: source.repositoryRoot,
        },
        {
          criterionId: input.criterionId,
          methodDigest,
          command: method.command,
          cwd: method.cwd,
          sourcePaths: method.sourcePaths,
          recipe: method.protocol,
        },
      );
    else
      invalidateProtocolBinding(
        database,
        input.runId,
        input.criterionId,
        methodDigest,
      );
    database
      .prepare(
        "INSERT INTO dsh_completion_bind_ops(run_id,call_id,request_digest,response_json) VALUES(?,?,?,?)",
      )
      .run(input.runId, input.callId, requestDigest, JSON.stringify(response));
  });
  return response;
}

export function readTaskCriterionBindingReplay(
  database: SqliteDatabase,
  runId: string,
  callId: string,
  criterionId: string,
  method: unknown,
):
  { criterionId: string; approved: boolean; methodDigest: string } | undefined {
  const parsed = CompletionMethodSchema.parse(method);
  const row = database
    .prepare(
      "SELECT request_digest, response_json FROM dsh_completion_bind_ops WHERE run_id = ? AND call_id = ?",
    )
    .get<{ request_digest: string; response_json: string }>(runId, callId);
  if (!row) return undefined;
  if (
    row.request_digest !== canonicalContentHash({ criterionId, method: parsed })
  ) {
    throw new KiokukoError(
      "CONFLICT",
      "Task completion call ID was reused with changed input",
    );
  }
  return JSON.parse(row.response_json);
}

export function beginTaskCompletionExecution(
  database: SqliteDatabase,
  input: {
    runId: string;
    callId: string;
    command: string;
    repositoryRoot: string;
    cwd?: string;
  },
): boolean {
  const source = criteriaForRun(database, input.runId);
  if (
    source.enno ||
    realpathSync(input.repositoryRoot) !== realpathSync(source.repositoryRoot)
  )
    return false;
  const rows = database
    .prepare(
      "SELECT * FROM dsh_completion_bindings WHERE run_id = ? AND approved = 1",
    )
    .all<BindingRow>(input.runId);
  const matching = rows.filter((row) => {
    const method = CompletionMethodSchema.parse(JSON.parse(row.method_json));
    return (
      method.kind === "native_command" &&
      executionCommand(method.command) === executionCommand(input.command) &&
      realpathSync(path.resolve(source.repositoryRoot, method.cwd)) ===
        realpathSync(input.cwd ?? input.repositoryRoot) &&
      source.criteria.some(
        (criterion) =>
          criterion.id === row.criterion_id &&
          criterion.revision === row.criterion_revision,
      )
    );
  });
  const coding = readCodingWorkflow(database, input.runId);
  const assessment = coding
    ? assessTaskCompletion(database, input.runId)
    : undefined;
  const goalReady =
    coding?.definition?.items.every((item) =>
      item.criterionIds.every((id) =>
        assessment!.criteria.some(
          (criterion) =>
            criterion.criterionId === `coding:${coding.workflowId}:${id}` &&
            criterion.state === "satisfied",
        ),
      ),
    ) ?? false;
  const isGoal = (row: BindingRow) =>
    coding?.definition?.goal.criterionIds.some(
      (id) => row.criterion_id === `coding:${coding.workflowId}:${id}`,
    );
  // A protocol recipe changes the item method identity. Observe final Goal
  // bindings separately, only after item evidence exists on the current source.
  const current = coding?.protocol
    ? goalReady
      ? (matching.find(
          (row) =>
            isGoal(row) &&
            assessment!.criteria.find(
              (item) => item.criterionId === row.criterion_id,
            )?.state !== "satisfied",
        ) ??
        matching.find(isGoal) ??
        matching[0])
      : (matching.find(
          (row) => row.criterion_id === coding.protocol!.criterionId,
        ) ?? matching[0])
    : matching[0];
  if (!current) return false;
  const method = CompletionMethodSchema.parse(JSON.parse(current.method_json));
  if (method.kind !== "native_command") return false;
  const digest = completionSourceDigest(
    database,
    input.runId,
    source.repositoryRoot,
    method.sourcePaths,
  );
  const codingInputs = coding?.definition
    ? coding.definition.items.flatMap((item) =>
        item.criterionIds.map((id) => ({
          id,
          evidenceRef:
            assessment!.criteria.find(
              (criterion) =>
                criterion.criterionId === `coding:${coding.workflowId}:${id}`,
            )?.evidenceRef ?? null,
        })),
      )
    : null;
  const existing = database
    .prepare(
      "SELECT method_digest, source_digest, outcome FROM dsh_completion_executions WHERE run_id = ? AND call_id = ?",
    )
    .get<{ method_digest: string; source_digest: string; outcome: string }>(
      input.runId,
      input.callId,
    );
  if (existing) {
    if (
      existing.method_digest !== current.method_digest ||
      existing.source_digest !== digest
    ) {
      throw new KiokukoError(
        "CONFLICT",
        "Task completion execution ID was reused with changed bound input",
      );
    }
    return existing.outcome === "started";
  }
  database
    .prepare(
      `INSERT OR IGNORE INTO dsh_completion_executions
    (run_id,call_id,method_digest,source_digest,outcome,updated_at,coding_scope,coding_goal_ready,coding_inputs_json) VALUES(?,?,?,?,'started',?,?,?,?)`,
    )
    .run(
      input.runId,
      input.callId,
      current.method_digest,
      digest,
      new Date().toISOString(),
      coding?.scopeVersion ?? null,
      goalReady ? 1 : 0,
      codingInputs ? JSON.stringify(codingInputs) : null,
    );
  return true;
}

export function finishTaskCompletionExecution(
  database: SqliteDatabase,
  input: {
    runId: string;
    callId: string;
    result: unknown;
  },
): void {
  const row = database
    .prepare(
      "SELECT * FROM dsh_completion_executions WHERE run_id = ? AND call_id = ?",
    )
    .get<ExecutionRow>(input.runId, input.callId);
  if (!row || row.outcome !== "started") return;
  const source = criteriaForRun(database, input.runId);
  const bindingRow = database
    .prepare(
      "SELECT * FROM dsh_completion_bindings WHERE run_id = ? AND method_digest = ?",
    )
    .get<BindingRow>(input.runId, row.method_digest);
  if (!bindingRow) return;
  const method = CompletionMethodSchema.parse(
    JSON.parse(bindingRow.method_json),
  );
  if (method.kind !== "native_command") return;
  let sourceDigest: string | undefined;
  try {
    sourceDigest = completionSourceDigest(
      database,
      input.runId,
      source.repositoryRoot,
      method.sourcePaths,
    );
  } catch {
    /* stale or unavailable */
  }
  const response = input.result as {
    isError?: boolean;
    value?: {
      exitCode?: number;
      exit_code?: number;
      kind?: string;
      timedOut?: boolean;
      aborted?: boolean;
      signal?: unknown;
    };
    content?: unknown;
  };
  const exit = response?.value?.exitCode ?? response?.value?.exit_code;
  const content =
    typeof response?.content === "string"
      ? response.content
      : Array.isArray(response?.content)
        ? response.content
            .map((block) => (typeof block?.text === "string" ? block.text : ""))
            .join("\n")
        : "";
  const coding = readCodingWorkflow(database, input.runId);
  const tap =
    method.assertion === "selected_tests_pass" &&
    (!coding || hasExplicitTestCases(content))
      ? parseTestSummary(content, isHostExecutionResult(input.result))
      : undefined;
  const observable =
    method.assertion === "output_matches"
      ? content.replace(/\r\n/gu, "\n").trimEnd() ===
          method.expectedOutput!.replace(/\r\n/gu, "\n").trimEnd() &&
        isHostExecutionResult(input.result)
      : method.assertion === "artifact_matches"
        ? artifactMatches(source.repositoryRoot, method)
        : true;
  const outcome =
    sourceDigest !== row.source_digest ||
    (coding &&
      (row.coding_scope !== coding.scopeVersion ||
        ["cancelled", "superseded"].includes(coding.state)))
      ? "stale"
      : response?.isError ||
          response?.value?.timedOut ||
          response?.value?.aborted ||
          response?.value?.signal ||
          response?.value?.kind === "background" ||
          (Number.isSafeInteger(exit) && exit !== 0)
        ? "failed"
        : ((coding || method.assertion === "output_matches") &&
              !isHostExecutionResult(input.result)) ||
            !Number.isSafeInteger(exit) ||
            (method.assertion === "exit_zero" &&
              hasShellPipeline(method.command)) ||
            (method.assertion === "selected_tests_pass" && !tap)
          ? "unknown"
          : (tap &&
                (tap.fail > 0 ||
                  tap.cancelled > 0 ||
                  tap.skipped > 0 ||
                  tap.todo > 0)) ||
              !observable
            ? "failed"
            : "passed";
  database
    .prepare(
      `UPDATE dsh_completion_executions SET outcome=?,exit_code=?,tap_summary_json=?,result_digest=?,updated_at=?
    WHERE run_id=? AND call_id=? AND outcome='started'`,
    )
    .run(
      outcome,
      Number.isSafeInteger(exit) ? (exit as number) : null,
      tap ? JSON.stringify(tap) : null,
      canonicalContentHash({
        isError: response?.isError === true,
        value: response?.value,
        content: response?.content,
      }),
      new Date().toISOString(),
      input.runId,
      input.callId,
    );
  if (coding?.definition && (outcome === "failed" || outcome === "unknown")) {
    const fingerprint = canonicalContentHash({
      method: row.method_digest,
      source: row.source_digest,
      outcome,
      exit: exit ?? null,
      tap: tap ?? null,
    });
    const affected = database
      .prepare(
        "SELECT criterion_id FROM dsh_completion_bindings WHERE run_id=? AND method_digest=?",
      )
      .all<{ criterion_id: string }>(input.runId, row.method_digest);
    for (const affectedCriterion of affected) {
      const id = affectedCriterion.criterion_id.slice(
        `coding:${coding.workflowId}:`.length,
      );
      if (
        coding.definition.goal.criterionIds.includes(id) &&
        row.coding_goal_ready !== 1
      )
        continue;
      recordCodingAttempt(
        database,
        coding,
        `failure:${input.callId}:${id}`,
        id,
        fingerprint,
        Date.now(),
        row.source_digest,
      );
    }
  }
}

export function assessTaskCompletion(
  database: SqliteDatabase,
  runId: string,
): CompletionAssessment {
  const source = criteriaForRun(database, runId);
  const coding = readCodingWorkflow(database, runId);
  const assessments: CriterionAssessment[] = source.criteria.map(
    (criterion) => {
      const row = binding(database, runId, criterion.id);
      if (!row || row.approved !== 1)
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state: "unknown",
          reason: row ? "binding_not_approved" : "no_binding",
        };
      if (row.criterion_revision !== criterion.revision)
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state: "stale",
          reason: "criterion_changed",
        };
      const method = CompletionMethodSchema.parse(JSON.parse(row.method_json));
      if (method.kind === "enno_verifier") {
        const contractRow = database
          .prepare(
            "SELECT workspace, orchestration_session_id AS orchestrationId FROM enno_contracts WHERE run_id = ?",
          )
          .get<{ workspace: string; orchestrationId: string }>(runId)!;
        const fresh = completionVerifiers().results(
          database,
          { runId, ...contractRow },
          source.repositoryRoot,
          method.workUnitId,
        );
        const result = fresh?.find(
          (item) => item.verifierId === method.verifierId,
        );
        if (!result)
          return {
            criterionId: criterion.id,
            description: criterion.description,
            state: "stale",
            reason: "verifier_evidence_missing_or_stale",
          };
        const complete =
          method.assertion === "exit_zero" ||
          ((!coding || result.explicitCases === true) &&
            result.tapSummary !== undefined &&
            result.tapSummary.tests > 0 &&
            result.tapSummary.pass === result.tapSummary.tests &&
            result.tapSummary.skipped === 0 &&
            result.tapSummary.todo === 0);
        const skipped =
          method.assertion === "selected_tests_pass" &&
          result.tapSummary !== undefined &&
          (result.tapSummary.skipped > 0 ||
            result.tapSummary.todo > 0 ||
            result.tapSummary.fail > 0);
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state:
            result.status !== "passed" || skipped
              ? "unmet"
              : complete
                ? "satisfied"
                : "unknown",
          reason:
            result.status !== "passed"
              ? "verifier_failed"
              : skipped
                ? "selected_tests_unmet"
                : complete
                  ? "fresh_verifier"
                  : "selected_test_coverage_unknown",
          evidenceRef: result.receiptId ?? `${runId}:${method.verifierId}`,
        };
      }
      const executions = database
        .prepare(
          `SELECT * FROM dsh_completion_executions WHERE run_id = ? AND method_digest = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .all<ExecutionRow>(runId, row.method_digest);
      const execution = executions[0];
      if (!execution)
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state: "unknown",
          reason: "command_not_observed",
        };
      let currentDigest: string | undefined;
      try {
        currentDigest = completionSourceDigest(
          database,
          runId,
          source.repositoryRoot,
          method.sourcePaths,
        );
      } catch {
        /* unknown */
      }
      if (
        execution.source_digest !== currentDigest ||
        execution.outcome === "stale" ||
        (coding && execution.coding_scope !== coding.scopeVersion)
      )
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state: "stale",
          reason: "source_changed",
          evidenceRef: execution.call_id,
        };
      const tap = execution.tap_summary_json
        ? (JSON.parse(execution.tap_summary_json) as TapSummary)
        : undefined;
      const finalGoal = coding?.definition?.goal.criterionIds.some(
        (id) => criterion.id === `coding:${coding.workflowId}:${id}`,
      );
      if (finalGoal && execution.coding_goal_ready !== 1)
        return {
          criterionId: criterion.id,
          description: criterion.description,
          state: "unknown",
          reason: "final_goal_must_run_after_item_checks",
          evidenceRef: execution.call_id,
        };
      const complete =
        method.assertion === "exit_zero" ||
        method.assertion === "output_matches" ||
        (method.assertion === "artifact_matches" &&
          artifactMatches(source.repositoryRoot, method)) ||
        (tap !== undefined &&
          tap.tests > 0 &&
          tap.pass === tap.tests &&
          tap.skipped === 0 &&
          tap.todo === 0);
      const skipped =
        method.assertion === "selected_tests_pass" &&
        tap !== undefined &&
        (tap.skipped > 0 || tap.todo > 0 || tap.fail > 0);
      return {
        criterionId: criterion.id,
        description: criterion.description,
        state:
          execution.outcome === "failed" || skipped
            ? "unmet"
            : execution.outcome === "passed" && complete
              ? "satisfied"
              : "unknown",
        reason:
          execution.outcome === "failed"
            ? "command_failed"
            : skipped
              ? "selected_tests_unmet"
              : execution.outcome === "passed" && complete
                ? "observed_command"
                : method.assertion === "exit_zero" &&
                    hasShellPipeline(method.command)
                  ? "pipeline_stage_status_unknown_use_direct_verifier"
                  : "coverage_unknown",
        evidenceRef: execution.call_id,
      };
    },
  );
  const managedOperationsReady = !unresolvedManaged(database, runId);
  const workflowReady =
    !coding ||
    Boolean(
      protocolCompletionReady(database, runId) &&
      coding.definition &&
      ["yes", "no"].includes(coding.choice.state) &&
      !["cancelled", "superseded", "blocked"].includes(coding.state),
    );
  if (coding?.definition) {
    const find = (id: string) =>
      assessments.find(
        (item) => item.criterionId === `coding:${coding.workflowId}:${id}`,
      )!;
    const visited = new Set<string>();
    const evaluate = (id: string): boolean => {
      const item = coding.definition!.items.find((item) => item.itemId === id)!;
      if (!visited.has(id)) {
        visited.add(id);
        if (!item.dependsOn.every(evaluate))
          for (const id of item.criterionIds) {
            const criterion = find(id);
            if (criterion.state === "satisfied") {
              criterion.state = "stale";
              criterion.reason = "dependency_unmet";
            }
          }
      }
      return item.criterionIds.every((id) => find(id).state === "satisfied");
    };
    const itemsReady = coding.definition.items
      .map((item) => evaluate(item.itemId))
      .every(Boolean);
    for (const id of coding.definition.goal.criterionIds) {
      const criterion = find(id);
      if (criterion.state !== "satisfied") continue;
      const row = database
        .prepare(
          "SELECT coding_inputs_json FROM dsh_completion_executions WHERE run_id=? AND call_id=?",
        )
        .get<{ coding_inputs_json: string | null }>(
          runId,
          criterion.evidenceRef!,
        );
      const inputs = row?.coding_inputs_json
        ? (JSON.parse(row.coding_inputs_json) as {
            id: string;
            evidenceRef: string | null;
          }[])
        : [];
      if (
        !itemsReady ||
        inputs.some(
          (input) =>
            find(input.id)?.evidenceRef !== input.evidenceRef &&
            find(input.id)?.evidenceRef !== criterion.evidenceRef,
        )
      ) {
        criterion.state = "stale";
        criterion.reason = "item_evidence_changed";
      }
    }
  }
  return {
    mode: runMode(database, runId),
    managedOperationsReady,
    verified:
      managedOperationsReady &&
      workflowReady &&
      assessments.length > 0 &&
      assessments.every((item) => item.state === "satisfied"),
    required: assessments.length,
    criteria: assessments,
    ...(coding
      ? {
          workflowReady,
          coding: {
            workflowId: coding.workflowId,
            state: coding.state,
            scopeVersion: coding.scopeVersion,
            ...(coding.protocol
              ? {
                  protocol: {
                    kind: coding.protocol.recipe.kind,
                    phase:
                      coding.protocol.schema === 2
                        ? coding.protocol.phase
                        : "rebind-required",
                    ...(coding.protocol.schema !== 2
                      ? {
                          reason:
                            "Legacy schema 1 evidence is retained read-only; explicitly rebind this unit",
                        }
                      : coding.protocol.reason
                        ? { reason: coding.protocol.reason }
                        : {}),
                    generation: coding.protocol.generation,
                    capabilities: PROTOCOL_CAPABILITIES,
                  },
                }
              : {}),
            goalCriterionIds: (coding.definition?.goal.criterionIds ?? []).map(
              (id) => `coding:${coding.workflowId}:${id}`,
            ),
            itemCriterionIds: (coding.definition?.items ?? []).flatMap((item) =>
              item.criterionIds.map(
                (id) => `coding:${coding.workflowId}:${id}`,
              ),
            ),
          },
        }
      : {}),
  };
}

export function saveTaskCompletionReceipt(
  database: SqliteDatabase,
  runId: string,
): CompletionAssessment {
  const assessment = assessTaskCompletion(database, runId);
  if (
    !database
      .prepare("SELECT run_id FROM dsh_completion_runs WHERE run_id = ?")
      .get(runId)
  )
    return assessment;
  database
    .prepare(
      `INSERT INTO dsh_completion_receipts(run_id,assessment_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET assessment_json=excluded.assessment_json,updated_at=excluded.updated_at`,
    )
    .run(runId, JSON.stringify(assessment), new Date().toISOString());
  return assessment;
}

export function taskCompletionBlocksClose(
  assessment: CompletionAssessment,
): boolean {
  return (
    assessment.managedOperationsReady === false ||
    (assessment.mode === "enforce" &&
      (assessment.required > 0 || assessment.workflowReady !== undefined) &&
      !assessment.verified)
  );
}

/** Include the consumer configuration and runtime alongside selected source paths. */
export function completionSourceDigest(
  database: SqliteDatabase,
  runId: string,
  root: string,
  paths: string[],
): string {
  const workflow = readCodingWorkflow(database, runId);
  if (!workflow)
    return canonicalContentHash({
      commandIdentityVersion: EXECUTION_COMMAND_VERSION,
      source: applicationSourceDigest(root, paths),
    });
  const configuration = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ].filter((file) => existsSync(path.join(root, file)));
  return canonicalContentHash({
    commandIdentityVersion: EXECUTION_COMMAND_VERSION,
    source: applicationSourceDigest(root, [
      ...new Set([...paths, ...configuration]),
    ]),
    scopeVersion: workflow.scopeVersion,
    runtime: {
      node: process.version,
      executable: process.execPath,
      pathDigest: canonicalContentHash(process.env.PATH ?? ""),
      platform: process.platform,
      arch: process.arch,
    },
  });
}
function artifactMatches(
  root: string,
  method: Extract<CompletionMethod, { kind: "native_command" }>,
): boolean {
  if (!method.artifactPath || !method.artifactSha256) return false;
  try {
    const file = realpathSync(path.join(root, method.artifactPath)),
      relative = path.relative(realpathSync(root), file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return (
      createHash("sha256").update(readFileSync(file)).digest("hex") ===
      method.artifactSha256
    );
  } catch {
    return false;
  }
}
