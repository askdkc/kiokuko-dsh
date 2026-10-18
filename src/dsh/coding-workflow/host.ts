import * as z from 'zod/v4'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshUserQuestions } from '../intake-questions.js'
import type { LispCodingService } from '../lisp/coding-choice.js'
import { KiokukoError } from '../../errors.js'
import { foregroundNativeCommand } from '../memory-application.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { CodingBlockerSchema, CodingDefinitionSchema, type CodingIdentity, type CodingWorkflow } from './contracts.js'
import { codingControlOrRead, codingControlCarrier, codingLiteralCarrier, executionRequestAction, CODING_READ_ONLY } from './intent.js'
import type { RequestIntentDecision, RequestIntentContext } from '../decisions/request-intent.js'
import { readCodingWorkflow } from './store.js'
import { answerCodingChoice, beginCodingDispatch, codingStatus, nextCodingWork, proposeCodingWorkflow,
  reportCodingBlocker, synchronizeCodingWorkflow, clearCodingRuntimeBlocker, assertCodingCommandRetry, projectEnnoCodingWorkflow, onCodingInterrupted } from './service.js'

interface Execution { name: string; callId: string; arguments: unknown; agent?: any; parent?: unknown; signal: AbortSignal }
interface HostIdentity extends CodingIdentity {
  agent: any; task?: string | undefined
  requestIntent?: RequestIntentDecision | undefined
  requestIntentContext?: RequestIntentContext | undefined
}
export interface CodingHost {
  runtime: DshCoreRuntime;
  resolve(execution: Execution): HostIdentity | undefined
  questions?: DshUserQuestions
  lisp(): LispCodingService | undefined
  preparationOnly?(execution: Execution): boolean
  nativeCommand?(execution: Execution): boolean
  nativeLisp?(execution: Execution): boolean
}
const statusSchema = z.object({ action: z.literal('status') }).strict()
const nextSchema = z.object({ action: z.literal('next') }).strict()
const applySchema = z.object({ action: z.enum(['propose', 'revise']), expectedRevision: z.number().int().min(1), definition: CodingDefinitionSchema }).strict()
const blockerSchema = z.object({ expectedRevision: z.number().int().min(1), blocker: CodingBlockerSchema }).strict()
const legacyBlockerSchema = z.object({ action: z.literal('report_blocker'), expectedRevision: z.number().int().min(1), blocker: CodingBlockerSchema }).strict()
const legacySchema = z.discriminatedUnion('action', [statusSchema, nextSchema, applySchema, legacyBlockerSchema])
type LegacyInput = z.infer<typeof legacySchema>
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as Record<string, unknown>
}
const legacyParameters = { type: 'object', oneOf: [statusSchema, nextSchema, applySchema, legacyBlockerSchema].map(jsonSchema) }
function validationCorrection(field: string): string {
  if (field === 'expectedRevision') return 'Use the current revision returned by coding_workflow status.'
  if (field === 'definition' || field.startsWith('definition.')) return 'Follow minimumValidInput: put constraints inside definition.goal; use unique goalId/itemId/criterionId values across the whole definition, and separate item checks from final Goal checks.'
  if (field === 'blocker' || field.startsWith('blocker.')) return 'Supply a blocker object with kind, cause, required recovery, and affected criterion IDs.'
  if (field === 'action') return 'Choose status/next on coding_workflow, propose/revise on coding_workflow_apply, or use coding_workflow_blocker.'
  return 'Correct the indicated field and retry with the current workflow revision.'
}
function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown, toolName: string): z.infer<T> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map(issue => {
    const field = issue.path.map(String).join('.') || 'input'
    return { field, reason: issue.message.slice(0, 240), correction: issue.message.startsWith('Duplicate IDs:') ? 'Use unique goalId/itemId/criterionId declaration values; keep reference arrays pointing to the intended declarations.' : issue.message.includes('Goal criterion has no implementing item') ? 'Preserve the final Goal check. Add its named ID to the responsible definition.items[].goalCriterionIds; do not invent which item implements it.' : issue.message.includes('Unknown Goal criterion') ? 'Use a declared definition.goal.criterionIds value in this item reference.' : validationCorrection(field) }
  })
  const summary = issues.map(issue => `${issue.field}: ${issue.reason}. Correction: ${issue.correction}`).join('\n')
  throw new KiokukoError('VALIDATION_ERROR', `Invalid ${toolName} input.\n${summary}`, { issues })
}
const codingToolDefinitions = new WeakSet<object>()
function codingTool<T extends { execute: (...args: any[]) => unknown }>(definition: T): T { codingToolDefinitions.add(definition.execute); return definition }
/** Only definitions produced by this plugin may join an already active Lisp fence. */
export function isCodingWorkflowTool(definition: unknown): boolean {
  return typeof definition === 'object' && definition !== null && codingToolDefinitions.has((definition as { execute: object }).execute)
}

export const CODING_GUIDANCE = 'For this coding task, use coding_workflow status/next to inspect the current revision and pending action. Submit new or revised Goals with coding_workflow_apply (action propose/revise, expectedRevision, definition); register blockers with coding_workflow_blocker. Legacy coding_workflow propose/revise/report_blocker calls remain accepted for compatibility. Preserve the exact request interpretation and evidence references shown by the host. A pending scope change requires a revised Goal before implementation; a same-scope continuation keeps its existing Goal, Lisp choice, and unfinished items. The host shows the Goal/items/criteria and asks once whether to use Lisp for this task. Pending choice blocks implementation, not conversation or reads. Bind checks with task_completion before executing them. Use host-observed selected tests, output/artifact assertions or browser assertions; exit 0 and model claims alone cannot complete this workflow. Fix failures autonomously within existing permissions. Final Goal verification must run after item checks on the current artifact. Report the Goal, evidence, ordinary-use result and remaining blockers.'

export function codingChoiceDetail(value: CodingWorkflow): string {
  const definition = value.definition!
  const criterion = (id: string) => { const item = definition.criteria.find(item => item.criterionId === id)!; return `${item.outcome} / 確認: ${item.procedure} / 期待: ${item.expected}` }
  return [`Goal: ${definition.goal.ideal}`, `対象: ${definition.goal.target}`,
    ...definition.items.map(item => `- ${item.change}\n${item.criterionIds.map(id => `  ${criterion(id)}`).join('\n')}`),
    `最終確認: ${definition.goal.criterionIds.map(criterion).join('\n')}`,
    '選択はこのタスクだけに適用します。未回答や閉じる操作では実装を開始しません。Lisp は通常の開発環境で動き、既存の権限と承認は引き続き適用されます。'].join('\n\n')
}
export function parseCodingChoice(answer: { selected?: readonly string[]; custom?: string }): 'yes' | 'no' | 'cancelled' | undefined {
  if ((answer.selected?.length ?? 0) > 1) return undefined
  const text = (answer.custom?.trim() || answer.selected?.[0] || '').trim()
  if (/^(?:1|使う|yes|use lisp|Lispモードを使う（通常実行）)$/iu.test(text)) return 'yes'
  if (/^(?:2|使わない|no|do not use lisp|Lispモードを使わない)$/iu.test(text)) return 'no'
  if (/^(?:3|取消|キャンセル|cancel|取消・作業を保持)$/iu.test(text)) return 'cancelled'
  return undefined
}

/** The same host seam is mounted by the suite and by the independent core. */
export function mountCodingWorkflow(ctx: {
  tools: { register(tool: any): () => void; get?(name: string, agent?: any): any }
  on(name: string, listener: (...args: any[]) => unknown, options?: { prepend: boolean }): () => void
}, host: CodingHost): () => void {
  const questions = new Map<string, Promise<void>>()
  const controllers = new Map<string, { scope: number; controller: AbortController }>()
  const scopes = new WeakMap<object, { scopeVersion: number; identity: HostIdentity; execute: unknown }>()
  const current = (identity: HostIdentity, execution: Execution) => {
    const resolved = host.resolve(execution)
    if (!resolved || resolved.runId !== identity.runId || resolved.sessionId !== identity.sessionId || resolved.agent !== identity.agent)
      throw new KiokukoError('CONFLICT', 'Coding task changed while awaiting an answer')
  }
  const choose = async (identity: HostIdentity, execution: Execution): Promise<void> => {
    await host.runtime.withDatabase(db => projectEnnoCodingWorkflow(db, identity))
    const value = await host.runtime.withDatabase(db => readCodingWorkflow(db, identity.runId))
    if (!value?.definition || ['cancelled', 'superseded', 'completed'].includes(value.state)) return
    if (value.choice.state === 'yes' || value.choice.state === 'no') host.lisp()?.answered?.(identity.agent, value.request, value.choice.state, value.choice.answerRef ?? `stored-choice:${value.choice.questionId}`)
    if (value.choice.state !== 'pending') {
      if (value.choice.state === 'yes') {
        try {
          const lisp = host.lisp()
          if (!lisp?.activate) throw new Error('Selected Lisp runtime is unavailable')
          await lisp.activate(identity.agent)
          await host.runtime.withDatabase(db => clearCodingRuntimeBlocker(db, identity))
        } catch (error) {
          const latest = await host.runtime.withDatabase(db => readCodingWorkflow(db, identity.runId))
          if (latest?.scopeVersion === value.scopeVersion) await host.runtime.withDatabase(db => reportCodingBlocker(db, identity, `startup-retry:${latest.revision}`, latest.revision, {
            criterionIds: [], kind: 'runtime', cause: String(error), required: 'Restore Lisp or explicitly change this task’s route', recovery: [], resumeWhen: 'Lisp startup succeeds',
          }))
        }
      }
      else await host.lisp()?.exclude?.(identity.agent)
      return
    }
    const early = host.lisp()?.choiceFor?.(identity.agent, value.request)
    if (!host.questions && !early) return // Durable pending; never invent a default.
    const key = `${value.workflowId}:${value.scopeVersion}`
    const existing = questions.get(key)
    if (existing) return existing
    const operation = (async () => {
      let response: Awaited<ReturnType<DshUserQuestions['ask']>>
      try { response = early ? { answers: [{ id: value.choice.questionId, selected: [early.choice === 'yes' ? '使う' : '使わない'] }] } : await host.questions!.ask({ agent: identity.agent, signal: execution.signal, questions: [{
        id: value.choice.questionId, header: 'Goal と実装項目', question: 'このタスクで Lisp モードを使いますか？',
        detail: codingChoiceDetail(value), options: ['使う', '使わない', '取消・作業を保持'].map(label => ({ label })),
      }] }) } catch (error) { execution.signal.throwIfAborted(); return }
      execution.signal.throwIfAborted(); current(identity, execution)
      const answer = response.answers?.[0]
      if (!answer || answer.id !== value.choice.questionId) return
      const choice = parseCodingChoice(answer)
      if (!choice) return
      const saved = await host.runtime.withDatabase(db => answerCodingChoice(db, identity, {
        callId: `human:${value.choice.questionId}:${canonicalContentHash(answer)}`, expectedRevision: value.revision,
        workflowId: value.workflowId, scopeVersion: value.scopeVersion, questionId: value.choice.questionId,
        questionRevision: value.choice.revision, answerRef: early?.answerRef ?? `userQuestions:${value.choice.questionId}:${canonicalContentHash(answer)}`, choice,
      }))
      current(identity, execution)
      if (choice === 'cancelled') { controllers.get(identity.runId)?.controller.abort(new Error('Coding task cancelled')); return }
      host.lisp()?.answered?.(identity.agent, value.request, choice, saved.choice.answerRef!)
      if (choice === 'no') { await host.lisp()?.exclude?.(identity.agent); return }
      try {
        const lisp = host.lisp()
        if (!lisp?.activate) throw new Error('Lisp runtime is unavailable. Keep this task pending recovery or explicitly select another route.')
        await lisp.activate(identity.agent)
        await host.runtime.withDatabase(db => clearCodingRuntimeBlocker(db, identity))
      } catch (error) {
        const latest = await host.runtime.withDatabase(db => readCodingWorkflow(db, identity.runId))
        if (latest?.scopeVersion === saved.scopeVersion && latest.choice.state === 'yes') await host.runtime.withDatabase(db => reportCodingBlocker(db, identity, `startup:${latest.revision}`, latest.revision, {
          criterionIds: [], kind: 'runtime', cause: error instanceof Error ? error.message : String(error),
          required: 'Restore the selected Lisp runtime or explicitly change this task’s execution route', recovery: [], resumeWhen: 'Lisp startup succeeds',
        }))
      }
    })()
    questions.set(key, operation)
    try { await operation } finally { if (questions.get(key) === operation) questions.delete(key) }
  }
  const definitions: (() => void)[] = []
  definitions.push(onCodingInterrupted(runId => controllers.get(runId)?.controller.abort(new Error('Coding task stopped'))))
  const executeAction = async (input: LegacyInput, identity: HostIdentity, execution: Execution) => {
    execution.signal.throwIfAborted()
    if (input.action === 'propose' || input.action === 'revise') {
      const before = await host.runtime.withDatabase(db => readCodingWorkflow(db, identity.runId))
      const updated = await host.runtime.withDatabase(db => proposeCodingWorkflow(db, identity, execution.callId,
        input.expectedRevision, input.definition, input.action === 'revise'))
      if (before?.scopeVersion !== updated.scopeVersion) controllers.get(identity.runId)?.controller.abort(new Error('Coding scope changed'))
      await choose(identity, execution)
    } else if (input.action === 'report_blocker') {
      await host.runtime.withDatabase(db => reportCodingBlocker(db, identity, execution.callId, input.expectedRevision, input.blocker))
    } else if (input.action === 'next') await choose(identity, execution)
    current(identity, execution)
    return host.runtime.withDatabase(db => { synchronizeCodingWorkflow(db, identity.runId); return nextCodingWork(db, identity) })
  }
  const tool = (name: string, schema: z.ZodTypeAny, parameters: Record<string, unknown>, normalize: (value: any) => LegacyInput) => codingTool({
    name, modelFacing: true, description: CODING_GUIDANCE, parameters,
    output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (raw: unknown, execution: Execution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.name !== name) throw new KiokukoError('CONFLICT', 'Coding workflow requires this active native task')
      const input = normalize(parseInput(schema, raw, name))
      return executeAction(input, identity, execution)
    },
  })
  definitions.push(ctx.tools.register(tool('coding_workflow', legacySchema, legacyParameters, input => input)))
  definitions.push(ctx.tools.register(tool('coding_workflow_apply', applySchema, jsonSchema(applySchema), input => input)))
  definitions.push(ctx.tools.register(tool('coding_workflow_blocker', blockerSchema, jsonSchema(blockerSchema), input => ({ action: 'report_blocker', ...input }))))
  definitions.push(ctx.on('tools/pre-execute', async (execution: Execution, next: () => Promise<any>) => {
    if (host.nativeCommand?.(execution) || host.nativeLisp?.(execution)) return next()
    const identity = host.resolve(execution)
    if (!identity || host.preparationOnly?.(execution)) return next()
    const carrier = codingLiteralCarrier(execution.name, execution.arguments)
    if (codingControlOrRead(execution.name) || codingControlCarrier(execution.name,execution.arguments)
      || carrier && ctx.tools.get?.(carrier, identity.agent)?.[CODING_READ_ONLY] === true
      || ctx.tools.get?.(execution.name, identity.agent)?.[CODING_READ_ONLY] === true) return next()
    const workflow = await host.runtime.withDatabase(db => readCodingWorkflow(db, identity.runId))
    try {
      const action = executionRequestAction(identity.requestIntent, identity.requestIntentContext, carrier ?? execution.name)
      if (action === 'verify') {
        if (workflow?.pendingScopeChange) return { kind: 'deny', reason: 'Revise the pending Goal scope before execution.' }
        return next() // Verification is authorized by the request and still goes through native permissions.
      }
    } catch (error) { return { kind: 'deny', reason: error instanceof Error ? error.message : 'Request interpretation is not current' } }
    if (!workflow) return next()
    try {
      const value = await host.runtime.withDatabase(db => beginCodingDispatch(db, identity, execution.callId, execution.name))
      if (value) {
        const command = foregroundNativeCommand(execution, identity.repositoryRoot)
        if (command) await host.runtime.withDatabase(db => assertCodingCommandRetry(db, identity, command))
        scopes.set(execution, { scopeVersion: value.scopeVersion, identity, execute: ctx.tools.get?.(execution.name, identity.agent)?.execute })
        let active = controllers.get(identity.runId)
        if (!active || active.scope !== value.scopeVersion || active.controller.signal.aborted) {
          active = { scope: value.scopeVersion, controller: new AbortController() }; controllers.set(identity.runId, active)
        }
        execution.signal = AbortSignal.any([execution.signal, active.controller.signal])
      }
    } catch (error) { return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) } }
    return next()
  }, { prepend: true }))
  definitions.push(ctx.on('tools/execute', async (execution: Execution, next: () => Promise<any>) => {
    const scope = scopes.get(execution)
    if (scope) {
      current(scope.identity, execution)
      const value = await host.runtime.withDatabase(db => readCodingWorkflow(db, scope.identity.runId))
      if (!value || value.scopeVersion !== scope.scopeVersion || ['cancelled', 'superseded'].includes(value.state)
        || ctx.tools.get?.(execution.name, scope.identity.agent)?.execute !== scope.execute) throw new KiokukoError('CONFLICT', 'Coding dispatch changed during native approval')
      execution.signal.throwIfAborted()
    }
    return next()
  }, { prepend: true }))
  definitions.push(ctx.on('tools/result', async (execution: Execution) => {
    const identity = host.resolve(execution)
    if (identity) {
      if (['enno_plan_submit', 'enno_plan_review'].includes(execution.name)) await choose(identity, execution)
      await host.runtime.withDatabase(db => synchronizeCodingWorkflow(db, identity.runId))
    }
  }))
  return () => { for (const active of controllers.values()) active.controller.abort(new Error('Coding host stopped')); for (const dispose of definitions.reverse()) dispose() }
}
