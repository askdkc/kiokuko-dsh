import * as z from 'zod/v4'
import type { DshCoreRuntime } from './core-runtime.js'
import { KiokukoError } from '../errors.js'
import { foregroundNativeCommand } from './memory-application.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, CompletionMethodSchema,
  finishTaskCompletionExecution, readTaskCriterionBindingReplay, saveTaskCompletionReceipt } from './task-completion.js'

interface NativeExecution { callId: string; name: string; arguments: any; parent?: unknown; agent?: any; signal: AbortSignal }
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
  method: z.object({ kind: z.enum(['native_command', 'enno_verifier']), command: z.string().optional(),
    cwd: z.string().optional(), sourcePaths: z.array(z.string()).optional(), verifierId: z.string().optional(),
    assertion: z.enum(['exit_zero', 'selected_tests_pass']).optional() }).strict().optional(),
}).strict()

/** A model proposes a check; the host owns identity, approval, observation and verdict. */
export function mountTaskCompletion(ctx: Context, host: CompletionHost): () => void {
  const pending = new WeakMap<object, { runId: string; callId: string; agent: object; sessionId: string }>()
  const disposers: (() => void)[] = []
  disposers.push(ctx.tools.register({ name: 'task_completion', modelFacing: true,
    description: 'Inspect task completion criteria or propose one exact check before running it. Bind never runs a command or marks a criterion successful. The host checks approval and actual evidence.',
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(transport, { unrepresentable: 'any' }))),
    output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, execution: NativeExecution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.name !== 'task_completion' || execution.parent !== undefined) {
        throw new KiokukoError('CONFLICT', 'Task completion requires an exact active native run')
      }
      execution.signal.throwIfAborted()
      const parsed = input.parse(args)
      if (parsed.action === 'status') return host.runtime.withDatabase(db => saveTaskCompletionReceipt(db, identity.runId))
      const replay = await host.runtime.withDatabase(db => readTaskCriterionBindingReplay(db, identity.runId,
        execution.callId, parsed.criterionId, parsed.method))
      if (replay) return replay
      const criterion = await host.runtime.withDatabase(db => assessTaskCompletion(db, identity.runId).criteria
        .find(item => item.criterionId === parsed.criterionId))
      if (!criterion) throw new KiokukoError('CONFLICT', 'Completion criterion is absent or stale')
      const approved = await host.approve?.(identity, criterion, parsed.method, execution.signal) ?? false
      execution.signal.throwIfAborted()
      if (host.resolve(execution)?.runId !== identity.runId) throw new KiokukoError('CONFLICT', 'Native task changed during completion review')
      return host.runtime.withDatabase(db => bindTaskCriterion(db, { runId: identity.runId, callId: execution.callId,
        criterionId: parsed.criterionId, method: parsed.method, approved }))
    },
  }))
  disposers.push(ctx.on('tools/pre-execute', async (execution: NativeExecution, next: () => Promise<unknown>) => {
    const identity = host.resolve(execution)
    if (!identity) return next()
    const command = foregroundNativeCommand(execution, identity.repositoryRoot)
    if (command !== null) {
      try {
        const tracked = await host.runtime.withDatabase(db => beginTaskCompletionExecution(db, {
          runId: identity.runId, callId: execution.callId, command, repositoryRoot: identity.repositoryRoot }))
        if (tracked) pending.set(execution, { runId: identity.runId, callId: execution.callId, agent: identity.agent,
          sessionId: identity.sessionId })
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
    return host.runtime.withDatabase(db => {
      finishTaskCompletionExecution(db, { runId: tracked.runId, callId: tracked.callId, result })
      saveTaskCompletionReceipt(db, tracked.runId)
    }).catch(() => { /* Missing proof remains unknown. */ })
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
