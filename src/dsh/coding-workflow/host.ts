import * as z from 'zod/v4'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshUserQuestions } from '../intake-questions.js'
import type { LispCodingService } from '../lisp/coding-choice.js'
import {
  askLispCodingQuestion,
  parseLispCodingChoice,
} from '../coding-question.js'
import { TransactionCommitUncertainError } from '../../db/transaction.js'
import { KiokukoError } from '../../errors.js'
import { LedgerStore } from '../../ledger/store.js'
import { readTaskSnapshot, taskCanExecute } from '../task-state.js'
import { foregroundNativeCommand } from '../memory-application.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import {
  CodingAnnotationSchema,
  CodingBlockerSchema,
  CodingDefinitionSchema,
  type CodingIdentity,
  type CodingWorkflow,
} from './contracts.js'
import {
  codingControlOrRead,
  codingControlCarrier,
  codingLiteralCarrier,
  executionRequestAction,
  CODING_READ_ONLY,
} from './intent.js'
import type {
  RequestIntentDecision,
  RequestIntentContext,
} from '../decisions/request-intent.js'
import { codingObservations } from './observations.js'
import { assertCodingIdentity, initializeCodingWorkflow, readCodingWorkflow } from './store.js'
import {
  answerCodingChoice,
  annotateCodingWorkflow,
  assertCodingDispatch,
  codingStatus,
  nextCodingWork,
  proposeCodingWorkflow,
  reportCodingBlocker,
  synchronizeCodingWorkflow,
  clearCodingRuntimeBlocker,
  assertCodingCommandRetry,
  onCodingInterrupted,
} from './service.js'

interface Execution {
  name: string
  callId: string
  arguments: unknown
  agent?: any
  parent?: unknown
  signal: AbortSignal
}
interface HostIdentity extends CodingIdentity {
  agent: any
  turn?: number | undefined
  task?: string | undefined
  requestIntent?: RequestIntentDecision | undefined
  requestIntentContext?: RequestIntentContext | undefined
}
export interface CodingHost {
  runtime: DshCoreRuntime
  resolve(execution: Execution): HostIdentity | undefined
  questions?: DshUserQuestions
  lisp(): LispCodingService | undefined
  preparationOnly?(execution: Execution): boolean
  nativeCommand?(execution: Execution): boolean
  nativeLisp?(execution: Execution): boolean
}
const statusSchema = z.object({ action: z.literal('status') }).strict()
const nextSchema = z.object({ action: z.literal('next') }).strict()
const applySchema = z
  .object({
    action: z.enum(['propose', 'revise']),
    expectedRevision: z.number().int().min(1),
    definition: CodingDefinitionSchema,
  })
  .strict()
const blockerSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    blocker: CodingBlockerSchema,
  })
  .strict()
const legacyBlockerSchema = z
  .object({
    action: z.literal('report_blocker'),
    expectedRevision: z.number().int().min(1),
    blocker: CodingBlockerSchema,
  })
  .strict()
const legacySchema = z.discriminatedUnion('action', [
  statusSchema,
  nextSchema,
  applySchema,
  legacyBlockerSchema,
])
const recordSchema = z.union([CodingAnnotationSchema, applySchema])
type WorkflowInput = z.infer<typeof legacySchema> | z.infer<typeof CodingAnnotationSchema>
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as Record<
    string,
    unknown
  >
}
const legacyParameters = {
  type: 'object',
  oneOf: [statusSchema, nextSchema, applySchema, legacyBlockerSchema].map(
    jsonSchema,
  ),
}
function validationCorrection(field: string): string {
  if (field === 'expectedRevision')
    return 'Use the current revision returned by coding_workflow status.'
  if (field === 'definition' || field.startsWith('definition.'))
    return 'Follow minimumValidInput: put constraints inside definition.goal; use unique goalId/itemId/criterionId values across the whole definition, and keep known references.'
  if (field === 'blocker' || field.startsWith('blocker.'))
    return 'Supply a blocker object with kind, cause, required recovery, and affected criterion IDs.'
  if (field === 'action')
    return 'Choose status/next on coding_workflow, annotate/propose/revise on coding_workflow_apply, or use coding_workflow_blocker.'
  return 'Correct this field if the record needs updating. Continue the requested work.'
}
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  toolName: string,
): z.infer<T> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map(issue => {
    const field = issue.path.map(String).join('.') || 'input'
    return { field, reason: issue.message.slice(0, 240), correction: validationCorrection(field) }
  })
  const summary = issues
    .map(({ field, reason, correction }) => `${field}: ${reason}. Correction: ${correction}`)
    .join('\n')
  throw new KiokukoError(
    'VALIDATION_ERROR',
    `Invalid ${toolName} input.\n${summary}`,
    { issues },
  )
}
const codingToolDefinitions = new WeakSet<object>()
function codingTool<T extends { execute: (...args: any[]) => unknown }>(
  definition: T,
): T {
  codingToolDefinitions.add(definition.execute)
  return definition
}
/** Only definitions produced by this plugin may join an already active Lisp fence. */
export function isCodingWorkflowTool(definition: unknown): boolean {
  return (
    typeof definition === 'object' &&
    definition !== null &&
    codingToolDefinitions.has((definition as { execute: object }).execute)
  )
}

export function isCodingWorkflowStatus(
  definition: unknown,
  args: unknown,
): boolean {
  return (
    isCodingWorkflowTool(definition) &&
    (definition as { name?: string }).name === 'coding_workflow' &&
    statusSchema.safeParse(args).success
  )
}

export const CODING_GUIDANCE =
  'Carry out the current user request using the authorized route. The host records observed tool activity. Optionally use coding_workflow status to inspect the record, or coding_workflow_apply annotate with notes and optional evidenceRefs to add context. Work and verification do not require a plan record, IDs, or a revision. Legacy propose/revise remain available. For implementation, repair and verification, use task_completion status and bind the missing check to current sources. Run it using the selected execution route. Fix observed failures and report any unmet condition. A tool result or a note alone is not proof of success.'

export function codingChoiceDetail(value: CodingWorkflow): string {
  const definition = value.definition
  if (!definition) return value.request
  const criterion = (id: string) => {
    const item = definition.criteria.find((item) => item.criterionId === id)!
    return `${item.outcome} / 確認: ${item.procedure} / 期待: ${item.expected}`
  }
  return [
    `Goal: ${definition.goal.ideal}`,
    `対象: ${definition.goal.target}`,
    ...definition.items.map(
      (item) =>
        `- ${item.change}\n${item.criterionIds.map((id) => `  ${criterion(id)}`).join('\n')}`,
    ),
    `最終確認: ${definition.goal.criterionIds.map(criterion).join('\n')}`,
    '選択はこのタスクだけに適用します。Lisp を使う場合は選択が必要です。取消・Skip は作業を保持してこの試行を中止します。カードを非表示にしても質問は残ります。実行には既存の権限と承認が適用されます。',
  ].join('\n\n')
}
export const parseCodingChoice = parseLispCodingChoice

/** The same host seam is mounted by the suite and by the independent core. */
export function mountCodingWorkflow(
  ctx: {
    tools: {
      register(tool: any): () => void
      get?(name: string, agent?: any): any
    }
    on(
      name: string,
      listener: (...args: any[]) => unknown,
      options?: { prepend: boolean },
    ): () => void
  },
  host: CodingHost,
): () => void {
  const questions = new Map<string, Promise<void>>()
  const controllers = new Map<
    string,
    { scope: number; controller: AbortController }
  >()
  const scopes = new WeakMap<
    object,
    { scopeVersion: number; identity: HostIdentity; execute: unknown }
  >()
  const current = (identity: HostIdentity, execution: Execution) => {
    const resolved = host.resolve(execution)
    if (
      !resolved ||
      resolved.runId !== identity.runId ||
      resolved.sessionId !== identity.sessionId ||
      resolved.repositoryRoot !== identity.repositoryRoot ||
      resolved.agent !== identity.agent
    )
      throw new KiokukoError(
        'CONFLICT',
        'Coding task changed while awaiting an answer',
      )
  }
  const choose = async (
    identity: HostIdentity,
    execution: Execution,
  ): Promise<void> => {
    const value = await host.runtime.withDatabase((db) =>
      readCodingWorkflow(db, identity.runId),
    )
    if (
      !value ||
      ['cancelled', 'superseded', 'completed'].includes(value.state)
    )
      return
    assertCodingIdentity(value, identity)
    if (value.choice.state === 'yes' || value.choice.state === 'no')
      host
        .lisp()
        ?.answered?.(
          identity.agent,
          value.request,
          value.choice.state,
          value.choice.answerRef ?? `stored-choice:${value.choice.questionId}`,
          `${value.workflowId}:${value.scopeVersion}`,
          Boolean(value.protocol),
        )
    if (value.choice.state !== 'pending') {
      if (value.choice.state === 'yes') {
        try {
          const lisp = host.lisp()
          if (!lisp?.activate)
            throw new Error('Selected Lisp runtime is unavailable')
          await lisp.activate(identity.agent)
          await host.runtime.withDatabase((db) =>
            clearCodingRuntimeBlocker(db, identity),
          )
        } catch (error) {
          const latest = await host.runtime.withDatabase((db) =>
            readCodingWorkflow(db, identity.runId),
          )
          if (latest?.scopeVersion === value.scopeVersion)
            await host.runtime.withDatabase((db) =>
              reportCodingBlocker(
                db,
                identity,
                `startup-retry:${latest.revision}`,
                latest.revision,
                {
                  criterionIds: [],
                  kind: 'runtime',
                  cause: String(error),
                  required:
                    'Restore Lisp or explicitly change this task’s route',
                  recovery: [],
                  resumeWhen: 'Lisp startup succeeds',
                },
              ),
            )
        }
      } else await host.lisp()?.exclude?.(identity.agent)
      return
    }
    const lisp = host.lisp()
    // Reuse only this task's answer or an explicit manual session preference.
    // A runtime left enabled by another task is not a human answer for this Goal.
    const explicit = lisp?.choiceFor?.(identity.agent, value.request)
    const manual =
      !explicit && (await lisp?.manualSelected?.(identity.agent)) === true
    const early =
      explicit ??
      (manual
        ? {
            choice: 'yes' as const,
            answerRef: `manual-session:${identity.sessionId}:${value.workflowId}:${value.scopeVersion}`,
          }
        : undefined)
    execution.signal.throwIfAborted()
    current(identity, execution)
    if (!value.definition && !early) return
    if (!host.questions && !early) return // Durable pending; never invent a default.
    const key = `${value.workflowId}:${value.scopeVersion}`
    const existing = questions.get(key)
    if (existing) return existing
    const operation = (async () => {
      const result = early
        ? { status: 'answered' as const, ...early }
        : await askLispCodingQuestion(host.questions, {
            agent: identity.agent,
            signal: execution.signal,
            questions: [
              {
                id: value.choice.questionId,
                header: 'Goal と実装項目',
                question: 'このタスクで Lisp モードを使いますか？',
                detail: codingChoiceDetail(value),
                options: ['使う', '使わない', '取消・作業を保持'].map(
                  (label) => ({ label }),
                ),
              },
            ],
          })
      execution.signal.throwIfAborted()
      current(identity, execution)
      if (result.status === 'pending') return
      if (result.status === 'unavailable')
        throw new KiokukoError(
          'CONFLICT',
          `Lisp question unavailable: ${result.reason}`,
        )
      const choice = result.status === 'cancelled' ? 'cancelled' : result.choice
      const answer = { questionId: value.choice.questionId, choice }
      const saved = await host.runtime.withDatabase((db) =>
        answerCodingChoice(db, identity, {
          callId: `human:${value.choice.questionId}:${canonicalContentHash(answer)}`,
          expectedRevision: value.revision,
          workflowId: value.workflowId,
          scopeVersion: value.scopeVersion,
          questionId: value.choice.questionId,
          questionRevision: value.choice.revision,
          answerRef:
            early?.answerRef ??
            `userQuestions:${value.choice.questionId}:${canonicalContentHash(answer)}`,
          choice,
        }),
      )
      current(identity, execution)
      if (choice === 'cancelled') {
        host.lisp()?.cancelled?.(identity.agent, value.request)
        controllers
          .get(identity.runId)
          ?.controller.abort(new Error('Coding task cancelled'))
        return
      }
      host
        .lisp()
        ?.answered?.(
          identity.agent,
          value.request,
          choice,
          saved.choice.answerRef!,
          `${saved.workflowId}:${saved.scopeVersion}`,
          Boolean(saved.protocol),
        )
      if (choice === 'no') {
        await host.lisp()?.exclude?.(identity.agent)
        return
      }
      try {
        const lisp = host.lisp()
        if (!lisp?.activate)
          throw new Error(
            'Lisp runtime is unavailable. Keep this task pending recovery or explicitly select another route.',
          )
        await lisp.activate(identity.agent)
        await host.runtime.withDatabase((db) =>
          clearCodingRuntimeBlocker(db, identity),
        )
      } catch (error) {
        const latest = await host.runtime.withDatabase((db) =>
          readCodingWorkflow(db, identity.runId),
        )
        if (
          latest?.scopeVersion === saved.scopeVersion &&
          latest.choice.state === 'yes'
        )
          await host.runtime.withDatabase((db) =>
            reportCodingBlocker(
              db,
              identity,
              `startup:${latest.revision}`,
              latest.revision,
              {
                criterionIds: [],
                kind: 'runtime',
                cause: error instanceof Error ? error.message : String(error),
                required:
                  'Restore the selected Lisp runtime or explicitly change this task’s execution route',
                recovery: [],
                resumeWhen: 'Lisp startup succeeds',
              },
            ),
          )
      }
    })()
    questions.set(key, operation)
    try {
      await operation
    } finally {
      if (questions.get(key) === operation) questions.delete(key)
    }
  }
  const definitions: (() => void)[] = []
  definitions.push(
    onCodingInterrupted((runId) =>
      controllers
        .get(runId)
        ?.controller.abort(new Error('Coding task stopped')),
    ),
  )
  const executeAction = async (
    input: WorkflowInput,
    identity: HostIdentity,
    execution: Execution,
  ) => {
    execution.signal.throwIfAborted()
    if (input.action === 'status') {
      current(identity, execution)
      return host.runtime.withDatabase(db => ({
        ...nextCodingWork(db, identity, { readOnly: true }),
        observations: codingObservations(db, identity),
      }))
    }
    if (input.action === 'annotate') {
      current(identity, execution)
      try {
        const annotation = await host.runtime.withDatabase(db => {
          if (!readCodingWorkflow(db, identity.runId)) {
            const task = readTaskSnapshot(db, { ...identity, taskId: identity.runId })
            const run = new LedgerStore(db).readRun(identity.runId)
            if (!taskCanExecute(task) || !task.request || run?.dshSessionId !== identity.sessionId)
              throw new KiokukoError('CONFLICT', 'Annotation requires the current native task')
            initializeCodingWorkflow(db, { ...identity, task: task.request,
              requestId: typeof run.metadata.requestId === 'string' ? run.metadata.requestId : `run:${run.runId}` })
          }
          const refs = new Set(codingObservations(db, identity, input.evidenceRefs ?? []).map(entry => entry.ref))
          return annotateCodingWorkflow(db, identity, execution.callId, input, refs)
        })
        return { recorded: true, annotation }
      } catch (error) {
        if (error instanceof KiokukoError) throw error
        if (error instanceof TransactionCommitUncertainError) return { recorded: null, reason: 'record_outcome_unknown' }
        return { recorded: false, reason: 'record_unavailable' }
      }
    }
    if (input.action === 'propose' || input.action === 'revise') {
      const before = await host.runtime.withDatabase((db) =>
        readCodingWorkflow(db, identity.runId),
      )
      const updated = await host.runtime.withDatabase((db) =>
        proposeCodingWorkflow(
          db,
          identity,
          execution.callId,
          input.expectedRevision,
          input.definition,
          input.action === 'revise',
        ),
      )
      if (before?.scopeVersion !== updated.scopeVersion)
        controllers
          .get(identity.runId)
          ?.controller.abort(new Error('Coding scope changed'))
      await choose(identity, execution)
    } else if (input.action === 'report_blocker') {
      await host.runtime.withDatabase((db) =>
        reportCodingBlocker(
          db,
          identity,
          execution.callId,
          input.expectedRevision,
          input.blocker,
        ),
      )
    } else if (input.action === 'next') await choose(identity, execution)
    current(identity, execution)
    return host.runtime.withDatabase((db) => {
      synchronizeCodingWorkflow(db, identity.runId)
      return nextCodingWork(db, identity)
    })
  }
  const tool = (
    name: string,
    schema: z.ZodTypeAny,
    parameters: Record<string, unknown>,
    normalize: (value: any) => WorkflowInput,
  ) =>
    codingTool({
      name,
      modelFacing: true,
      description: CODING_GUIDANCE,
      parameters,
      output: {
        schema: {},
        render: (_: unknown, result: unknown) => [
          { type: 'text', text: JSON.stringify(result) },
        ],
      },
      execute: async (raw: unknown, execution: Execution) => {
        const identity = host.resolve(execution)
        const input = normalize(parseInput(schema === recordSchema
          ? ((raw as { action?: unknown } | null)?.action === 'annotate' ? CodingAnnotationSchema : applySchema)
          : schema, raw, name))
        if (!identity && execution.name === name && input.action === 'status')
          return {
            applicable: false,
            reason: 'no_active_native_task',
            nextAction:
              'Continue ordinary native work. Use an explicitly prepared coding workflow only when the current request calls for it.',
          }
        if (!identity || execution.name !== name)
          throw new KiokukoError(
            'CONFLICT',
            'Coding workflow requires this active native task',
          )
        return executeAction(input, identity, execution)
      },
    })
  definitions.push(
    ctx.tools.register(
      tool('coding_workflow', legacySchema, legacyParameters, (input) => input),
    ),
  )
  definitions.push(
    ctx.tools.register(
      tool(
        'coding_workflow_apply',
        recordSchema,
        { type: 'object', ...jsonSchema(recordSchema) },
        (input) => input,
      ),
    ),
  )
  definitions.push(
    ctx.tools.register(
      tool(
        'coding_workflow_blocker',
        blockerSchema,
        jsonSchema(blockerSchema),
        (input) => ({ action: 'report_blocker', ...input }),
      ),
    ),
  )
  definitions.push(
    ctx.on(
      'tools/pre-execute',
      async (execution: Execution, next: () => Promise<any>) => {
        if (host.nativeCommand?.(execution) || host.nativeLisp?.(execution))
          return next()
        const identity = host.resolve(execution)
        if (!identity || host.preparationOnly?.(execution)) return next()
        const carrier = codingLiteralCarrier(
          execution.name,
          execution.arguments,
        )
        if (
          codingControlOrRead(execution.name) ||
          codingControlCarrier(execution.name, execution.arguments) ||
          (carrier &&
            ctx.tools.get?.(carrier, identity.agent)?.[CODING_READ_ONLY] ===
              true) ||
          ctx.tools.get?.(execution.name, identity.agent)?.[
            CODING_READ_ONLY
          ] === true
        )
          return next()
        try {
          executionRequestAction(identity.requestIntent, identity.requestIntentContext, carrier ?? execution.name)
          const value = await host.runtime.withDatabase(db => assertCodingDispatch(db, identity, carrier ?? execution.name))
          if (value) {
            const command = foregroundNativeCommand(
              execution,
              identity.repositoryRoot,
            )
            if (command)
              await host.runtime.withDatabase((db) =>
                assertCodingCommandRetry(db, identity, command),
              )
            scopes.set(execution, {
              scopeVersion: value.scopeVersion,
              identity,
              execute: ctx.tools.get?.(execution.name, identity.agent)?.execute,
            })
            let active = controllers.get(identity.runId)
            if (
              !active ||
              active.scope !== value.scopeVersion ||
              active.controller.signal.aborted
            ) {
              active = {
                scope: value.scopeVersion,
                controller: new AbortController(),
              }
              controllers.set(identity.runId, active)
            }
            execution.signal = AbortSignal.any([
              execution.signal,
              active.controller.signal,
            ])
          }
        } catch (error) {
          return {
            kind: 'deny',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
        return next()
      },
      { prepend: true },
    ),
  )
  definitions.push(
    ctx.on(
      'tools/execute',
      async (execution: Execution, next: () => Promise<any>) => {
        const scope = scopes.get(execution)
        if (scope) {
          current(scope.identity, execution)
          const value = await host.runtime.withDatabase((db) =>
            readCodingWorkflow(db, scope.identity.runId),
          )
          if (
            !value ||
            value.scopeVersion !== scope.scopeVersion ||
            ['cancelled', 'superseded'].includes(value.state) ||
            ctx.tools.get?.(execution.name, scope.identity.agent)?.execute !==
              scope.execute
          )
            throw new KiokukoError(
              'CONFLICT',
              'Coding dispatch changed during native approval',
            )
          execution.signal.throwIfAborted()
        }
        return next()
      },
      { prepend: true },
    ),
  )
  definitions.push(
    ctx.on('tools/result', async (execution: Execution) => {
      if (
        isCodingWorkflowStatus(
          ctx.tools.get?.(execution.name, execution.agent),
          execution.arguments,
        )
      )
        return
      const identity = host.resolve(execution)
      if (identity) {
        await host.runtime.withDatabase((db) =>
          synchronizeCodingWorkflow(db, identity.runId),
        ).catch(() => { /* The native result remains available if the record cannot be updated. */ })
      }
    }),
  )
  return () => {
    for (const active of controllers.values())
      active.controller.abort(new Error('Coding host stopped'))
    for (const dispose of definitions.reverse()) dispose()
  }
}
