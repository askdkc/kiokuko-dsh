import { z } from 'zod'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DshCoreRuntime } from './core-runtime.js'
import type { DshNativeCommandDefinition } from './commands.js'
import { beginMemoryExecution, completeMemoryExecution, memoryApplicationReviewSchema,
  memoryApplicationStatus, recordMemoryApplicationReview, type MemoryApplicationIdentity } from '../memory/application.js'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('review'), review: memoryApplicationReviewSchema }).strict(),
  z.object({ action: z.literal('refresh'), query: z.string().trim().min(1).max(4000) }).strict(),
])
export const MEMORY_APPLICATION_GUIDANCE = 'For selected actionable memory, use task_memory_review(action=status), then record adopted/not_applicable/contradicted with current source paths and grounds. Adoption needs an invariant, counterexample and verification method. Code changes also need the exact Bash command before running it through the native tool, or an existing approved Enno verifier expressed as executable and arguments joined by single spaces (repository-root cwd). Only a typed successful foreground result on unchanged declared sources counts as observed proof. Changed deliveries, entries or files require review/verification again. Use action=refresh when a concrete error or target changes the search; it keeps the current run. Missing proof cannot complete successfully. Judgments are model-reported, not automatically proven.'

interface NativeExecution { callId: string; name: string; arguments: any; parent?: unknown; agent?: any; signal: AbortSignal }
interface SurfaceContext {
  tools: { register(tool: any): () => void }
  commands?: { register(command: DshNativeCommandDefinition): () => void }
  on(name: string, handler: (...args: any[]) => unknown, options?: { prepend: boolean }): () => void
}
export interface ApplicationHost {
  runtime: DshCoreRuntime
  /** Exact native Agent and Session matching is the caller's responsibility. */
  resolve(execution: NativeExecution): MemoryApplicationIdentity | undefined
  session?(agent: unknown): { sessionId: string; repositoryRoot: string } | undefined
  refresh(execution: NativeExecution, query: string): Promise<unknown>
}
// Exact native read tools only; never classify arbitrary shell strings as read-only.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Skill', 'read_file', 'glob', 'grep', 'skill', 'observation_read'])
const CONTROL_TOOLS = new Set(['task_memory_review', 'memory_checkpoint', 'curator_check', 'enno_finish', 'enno_work_report', 'enno_plan_review', 'enno_plan_submit', 'enno_ideal_submit', 'enno_meditation_submit'])

/** Mount on the actual DSH pre-execute/result path; it never grants native permission. */
export function mountMemoryApplication(ctx: SurfaceContext, host: ApplicationHost): () => void {
  const pending = new WeakMap<object, MemoryApplicationIdentity>()
  const disposers: (() => void)[] = []
  if (ctx.commands && host.session) disposers.push(ctx.commands.register({ name: 'kioku-memory-application',
    description: 'Show memory application and regression verification status for this native session.', input: { hint: 'status [--json]' },
    handler: async invocation => {
      invocation.signal.throwIfAborted()
      if (!['', 'status', 'status --json'].includes(invocation.rawInput.trim())) return { kind: 'error', text: 'Use /kioku-memory-application status [--json].' }
      const session = host.session!(invocation.agent)
      if (!session) return { kind: 'error', text: 'Native session identity is unavailable.' }
      const status = await host.runtime.withDatabase(db => {
        const row = db.prepare('SELECT run_id FROM task_memory_bindings WHERE session_id=? AND repository_root=? ORDER BY rowid DESC LIMIT 1')
          .get<{run_id:string}>(session.sessionId, session.repositoryRoot)
        return { integration: 'native_active', ...(row ? memoryApplicationStatus(db, row.run_id) : { supported: false, ready: false, verification: 'unobserved' }) }
      })
      if (invocation.rawInput.includes('--json')) return { kind: 'success', text: JSON.stringify(status, null, 2) }
      return { kind: 'success', text: !status.supported ? '記憶適用の連携は稼働中です。この会話で準備済みの依頼はありません。'
        : `記憶適用: ${status.ready ? '未処理なし' : '確認が必要'}\n取得: ${'retrieval' in status ? status.retrieval : 'unavailable'}\n検証: ${status.verification}\n未処理: ${'pending' in status ? status.pending.length : 0}\n実行中・終了未確認: ${'running' in status ? status.running : 0}\nモデルによる判断の正しさは自動認定しません。詳細は status --json で確認できます。` }
    } }))
  disposers.push(ctx.tools.register({ name: 'task_memory_review', modelFacing: true,
    description: MEMORY_APPLICATION_GUIDANCE,
    // Zod attaches non-enumerable ~standard metadata; DSH requires plain JSON.
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(inputSchema))), output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, execution: NativeExecution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.parent !== undefined || execution.name !== 'task_memory_review') throw new Error('No active native task for memory application')
      execution.signal.throwIfAborted()
      const input = inputSchema.parse(args)
      if (input.action === 'refresh') return host.refresh(execution, input.query)
      return host.runtime.withDatabase(db => {
        execution.signal.throwIfAborted()
        if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
        if (input.action === 'review') recordMemoryApplicationReview(db, identity, execution.callId, input.review)
        return memoryApplicationStatus(db, identity.runId)
      })
    } }))
  disposers.push(ctx.on('tools/pre-execute', async (execution: NativeExecution, next: () => Promise<unknown>) => {
    const identity = host.resolve(execution)
    if (!identity || READ_TOOLS.has(execution.name) || CONTROL_TOOLS.has(execution.name)) return next()
    // A child without its own admitted binding cannot borrow its parent's proof.
    let command: string | null = null
    const args = execution.arguments
    if (execution.parent === undefined && ['Bash', 'bash'].includes(execution.name)
      && typeof args?.command === 'string' && args.background !== true && args.run_in_background !== true) {
      try {
        const directories = ['cwd', 'workdir', 'workingDirectory', 'working_directory']
          .filter(key => args[key] !== undefined).map(key => args[key])
        if (directories.every(directory => typeof directory === 'string'
          && realpathSync(resolve(identity.repositoryRoot, directory)) === identity.repositoryRoot)) command = args.command
      } catch { /* a different/unavailable cwd cannot produce proof */ }
    }
    await host.runtime.withDatabase(db => {
      execution.signal.throwIfAborted()
      if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
      beginMemoryExecution(db, identity, execution.callId, command)
    })
    pending.set(execution, identity)
    return next()
  }, { prepend: true }))
  disposers.push(ctx.on('tools/result', (execution: NativeExecution, result: unknown) => {
    const identity = pending.get(execution)
    if (!identity) return
    pending.delete(execution)
    return host.runtime.withDatabase(db => {
      if (host.resolve(execution)?.runId !== identity.runId) return
      completeMemoryExecution(db, identity, execution.callId, result)
    })
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
