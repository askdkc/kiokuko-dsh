import { completionInputError } from './task-completion-guidance.js'
import { readCodingWorkflow } from './coding-workflow/store.js'
import { ProtocolRecipeSchema } from './guardrail/contracts.js'
import * as z from 'zod/v4'
import type { DshCoreRuntime } from './core-runtime.js'
import { KiokukoError } from '../errors.js'
import { foregroundNativeCommand } from './memory-application.js'
import { observedMemoryInput } from './memory-sidebar.js'
import { capturePolicy } from '../memory/capture-policy.js'
import { readEntry } from '../memory/entries.js'
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js'
import { AppliedMemoriesSchema, assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, CompletionMethodSchema,
  finishTaskCompletionExecution, readTaskCriterionBindingReplay, saveTaskCompletionReceipt, taskCompletionBindingGuide } from './task-completion.js'
import { authorizeTaskLease, type TaskLease, type TaskAuthorityExecution } from './task-state.js'
import { captureExecutionTaskLease } from './task-authority-context.js'
import { withImmediateTransaction } from '../db/transaction.js'

interface NativeExecution extends TaskAuthorityExecution { callId: string; name: string; arguments: any; parent?: unknown; agent?: any; signal: AbortSignal }
interface Context {
  tools: { register(tool: any): () => void }
  on(name: string, listener: (...args: any[]) => unknown, options?: { prepend: boolean }): () => void
}
export interface CompletionHost {
  runtime: DshCoreRuntime
  resolve(execution: NativeExecution): { runId: string; sessionId: string; repositoryRoot: string; agent: any } | undefined
  approve?(identity: { runId: string; sessionId: string; repositoryRoot: string; agent: any },
    criterion: { criterionId: string; description: string }, method: z.infer<typeof CompletionMethodSchema>, signal: AbortSignal): Promise<boolean>
}
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('bind'), criterionId: z.string().min(1).max(256), method: CompletionMethodSchema }).strict(),
])
const transport = z.object({ action: z.enum(['status', 'bind']), criterionId: z.string().optional(),
  method: z.object({ kind: z.literal('native_command'), command: z.string(),
    cwd: z.string(), sourcePaths: z.array(z.string()).min(1).max(32).describe('Required: at least one current repository-relative implementation/test path; include an asserted artifact.'),
    protocol: ProtocolRecipeSchema.optional(), appliedMemories: AppliedMemoriesSchema.optional().describe('Optional exact entryId/revision pairs from status.deliveredMemories. Include only a memory whose use this check tests.'),
    assertion: z.enum(['exit_zero', 'selected_tests_pass','output_matches','artifact_matches']).describe('Match the criterion evidence. selected_tests_pass needs complete Node TAP: node --test --test-reporter=tap <test files>. output_matches requires expectedOutput; artifact_matches requires artifactPath, artifactSha256, and artifact in sourcePaths. Coding never accepts exit_zero alone.').optional(),expectedOutput:z.string().optional(),artifactPath:z.string().optional(),artifactSha256:z.string().optional() }).strict().optional(),
}).strict()

/** A model proposes a check; the host owns identity, approval, observation and verdict. */
export function mountTaskCompletion(ctx: Context, host: CompletionHost): () => void {
  const pending = new WeakMap<object, { runId: string; callId: string; agent: object; sessionId: string; lease: TaskLease }>()
  const disposers: (() => void)[] = []
  disposers.push(ctx.tools.register({ name: 'task_completion', modelFacing: true,
    description: 'Inspect task completion criteria or propose one exact check before running it. Bind never runs a command or marks a criterion successful. The host checks approval and actual evidence. Supply command, cwd, nonempty sourcePaths and assertion. Read status for criterion-specific requirements. To record memory reuse, optionally add method.appliedMemories from status.deliveredMemories only when the check tests its application.',
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(transport, { unrepresentable: 'any' }))),
    output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, execution: NativeExecution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.name !== 'task_completion') {
        throw new KiokukoError('CONFLICT', 'Task completion requires an exact active native run')
      }
      execution.signal.throwIfAborted()
      const validation=input.safeParse(args)
      if(!validation.success)throw completionInputError(validation.error.issues.map(issue=>({field:issue.path.map(String).join('.')||'input',
        reason:issue.code==='custom'?issue.message:'Missing, invalid or unexpected field for this action/method'})))
      const parsed=validation.data
      const session = identity.agent?.session
      const observed = session?.id === identity.sessionId ? observedMemoryInput(session) : undefined
      if (parsed.action === 'status') return host.runtime.withDatabase(db => ({
        ...saveTaskCompletionReceipt(db, identity.runId), bindingGuide: taskCompletionBindingGuide(db, identity.runId),
        deliveredMemories: (observed?.items ?? []).map(({ entryId, revision }) => ({ entryId, revision })),
      }))
      const applied = parsed.method.appliedMemories
      if (applied && !applied.every(item => observed?.items.some(entry => entry.entryId === item.entryId && entry.revision === item.revision)))
        throw new KiokukoError('CONFLICT', 'Memory reuse requires the exact revision sent to the model for this request')
      const criterion = await host.runtime.withDatabase(db => {
        const criteria = assessTaskCompletion(db, identity.runId).criteria
        const exact = criteria.find(item => item.criterionId === parsed.criterionId)
        if (exact) return exact
        const workflow = readCodingWorkflow(db, identity.runId)
        // A local Goal criterion ID is unambiguous only in this active workflow.
        // Never strip a supplied namespace: that could accept a stale/foreign ID.
        if (!workflow?.definition?.criteria.some(item => item.criterionId === parsed.criterionId)) return undefined
        return criteria.find(item => item.criterionId === `coding:${workflow.workflowId}:${parsed.criterionId}`)
      })
      if (!criterion) throw completionInputError([{ field: 'criterionId', reason: 'Completion criterion is absent or stale; read current status.' }])
      const replay = await host.runtime.withDatabase(db => readTaskCriterionBindingReplay(db, identity.runId,
        execution.callId, criterion.criterionId, parsed.method))
      if (replay) return replay
      const approved = await host.approve?.(identity, criterion, parsed.method, execution.signal) ?? false
      execution.signal.throwIfAborted()
      if (host.resolve(execution)?.runId !== identity.runId) throw new KiokukoError('CONFLICT', 'Native task changed during completion review')
      return host.runtime.withDatabase(db => {
        if (applied) {
          const run = db.prepare('SELECT workspace, status FROM ledger_runs WHERE run_id=? AND dsh_session_id=?')
            .get<{ workspace: string; status: string }>(identity.runId, identity.sessionId)
          if (!run || run.status !== 'active' || observedMemoryInput(session) !== observed ||
            capturePolicy(db, run.workspace, identity.sessionId).mode !== 'allowed')
            throw new KiokukoError('CONFLICT', 'Memory reuse is unavailable for this task or the model input changed')
          for (const item of applied) {
            const selection = observed!.items.find(entry => entry.entryId === item.entryId)!
            const entry = readEntry(db, { workspace: selection.workspace, entryId: item.entryId })
            if (entry.revision !== item.revision || !isRetrievableEntry(db, entry))
              throw new KiokukoError('CONFLICT', 'Applied memory changed or became unavailable')
          }
        }
        return bindTaskCriterion(db, { runId: identity.runId, callId: execution.callId,
          criterionId: criterion.criterionId, method: parsed.method, approved })
      }).catch(error=>{
          if(error instanceof KiokukoError&&error.code==='VALIDATION_ERROR')throw completionInputError([{field:typeof error.details.field==='string'?error.details.field:'method',
            reason:error.message,...(typeof error.details.expected==='string'?{expected:error.details.expected}:{})}])
          throw error
        })
    },
  }))
  disposers.push(ctx.on('tools/pre-execute', async (execution: NativeExecution, next: () => Promise<unknown>) => {
    const identity = host.resolve(execution)
    if (!identity) return next()
    const command = foregroundNativeCommand(execution, identity.repositoryRoot)
    if (command !== null) {
      try {
        const lease = await host.runtime.withDatabase(db => captureExecutionTaskLease(db, {
          taskId: identity.runId, sessionId: identity.sessionId, repositoryRoot: identity.repositoryRoot,
        }, execution))
        const tracked = await host.runtime.withDatabase(db => withImmediateTransaction(db, () => {
          authorizeTaskLease(db, lease)
          return beginTaskCompletionExecution(db, {
            runId: identity.runId, callId: execution.callId, command, repositoryRoot: identity.repositoryRoot })
        }))
        if (tracked) pending.set(execution, { runId: identity.runId, callId: execution.callId, agent: identity.agent,
          sessionId: identity.sessionId, lease })
      } catch { /* Missing optional proof cannot authorize completion or veto a native tool. */ }
    }
    return next()
  }, { prepend: true }))
  disposers.push(ctx.on('tools/result', (execution: NativeExecution, result: unknown) => {
    const tracked = pending.get(execution)
    if (!tracked) return
    pending.delete(execution)
    const identity = host.resolve(execution)
    if (!identity || identity.runId !== tracked.runId || identity.sessionId !== tracked.sessionId
      || identity.agent !== tracked.agent) return
    return host.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      authorizeTaskLease(db, tracked.lease)
      finishTaskCompletionExecution(db, { runId: tracked.runId, callId: tracked.callId, result })
      saveTaskCompletionReceipt(db, tracked.runId)
    })).catch(() => { /* Stale or missing proof remains unknown. */ })
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
