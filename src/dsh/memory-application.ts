import { z } from 'zod'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DshCoreRuntime } from './core-runtime.js'
import type { DshNativeCommandDefinition } from './commands.js'
import { beginMemoryExecution, completeMemoryExecution, memoryApplicationReviewSchema,
  memoryApplicationStatus, recordMemoryApplicationReview, recordMemoryApplicationReviewBatch, type MemoryApplicationIdentity } from '../memory/application.js'
import { autoGlobalizationStatus } from '../memory/auto-globalization.js'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('review'), review: memoryApplicationReviewSchema }).strict(),
  z.object({ action: z.literal('review_batch'), reviews: z.array(memoryApplicationReviewSchema).min(1).max(32) }).strict(),
  z.object({ action: z.literal('refresh'), query: z.string().trim().min(1).max(4000) }).strict(),
])
// Model providers require an object at the root of every tool schema. Keep
// action-specific validation in inputSchema after the native tool call arrives.
const transportSchema = z.object({
  action: z.enum(['status', 'review', 'review_batch', 'refresh']),
  review: memoryApplicationReviewSchema.optional(),
  reviews: z.array(memoryApplicationReviewSchema).min(1).max(32).optional(),
  query: z.string().trim().min(1).max(4000).optional(),
}).strict()
export const MEMORY_APPLICATION_GUIDANCE = 'Use task_memory_review(action=status) once, then submit independent pending decisions with action=review_batch (up to 32); action=review remains available for one. Adoption and contradiction require relevant source paths. Adoption also needs an invariant, counterexample, method and command: an exact foreground Bash command at repository-root cwd, or an approved Enno verifier expressed as executable and arguments joined by single spaces. For topic-based non-applicability, use paths:[]; supply paths when the judgment depends on current source. Refresh retains decisions when delivered entry revisions and mode stay unchanged; a revised entry or mode change starts a new review generation. New entries need decisions, and changed delivery invalidates execution proof. Only a typed successful foreground result on unchanged declared sources counts as observed proof. Use action=refresh for a concrete new error or target; it keeps the run. Missing proof cannot complete successfully. Judgments are model-reported.'

interface NativeExecution { callId: string; rootCallId?: string; name: string; arguments: any; parent?: unknown; agent?: any; signal: AbortSignal }
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
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Skill', 'read', 'read_file', 'glob', 'grep', 'skill', 'observation_read', 'lisp_status'])
const CONTROL_TOOLS = new Set(['task_memory_review', 'memory_checkpoint', 'curator_check', 'enno_finish', 'enno_work_report', 'enno_plan_review', 'enno_plan_submit', 'enno_ideal_submit', 'enno_meditation_submit'])

function isPtcSubcall(execution: NativeExecution): boolean {
  return execution.parent !== undefined && typeof execution.rootCallId === 'string'
    && execution.callId.startsWith(`${execution.rootCallId}:ptc:`)
    && /^[1-9]\d*$/u.test(execution.callId.slice(execution.rootCallId.length + 5))
}

/** Only saved-result paging is a read; ref inspection can run a live worker. */
export function isSavedLispResultRead(execution: Pick<NativeExecution, 'name' | 'arguments' | 'parent'>): boolean {
  return execution.name === 'lisp_inspect' && execution.parent === undefined
    && typeof execution.arguments?.resultOperationId === 'string' && execution.arguments.ref === undefined
}

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
        const application = row ? memoryApplicationStatus(db, row.run_id) : { supported: false as const, ready: false, verification: 'unobserved' as const }
        const globalization = application.supported && 'items' in application
          ? application.items.map(item => ({ entryId: item.entryId, revision: item.revision,
            ...autoGlobalizationStatus(db, item.entryId, item.revision) })) : []
        return { integration: 'native_active', ...application, globalization }
      })
      if (invocation.rawInput.includes('--json')) return { kind: 'success', text: JSON.stringify(status, null, 2) }
      return { kind: 'success', text: !status.supported ? '記憶適用の連携は稼働中です。この会話で準備済みの依頼はありません。'
        : `記憶適用: ${status.ready ? '未処理なし' : '確認が必要'}\n取得: ${'retrieval' in status ? status.retrieval : 'unavailable'}\n検証: ${status.verification}\n未処理: ${'pending' in status ? status.pending.length : 0}\n実行中・終了未確認: ${'running' in status ? status.running : 0}\n自動Global化: ${status.globalization.map(item => `${item.entryId}@${item.revision}: ${'successfulRuns' in item ? item.successfulRuns : 0}/3, ${'reason' in item ? item.reason ?? item.state : '未対応'}, ${'globalEntryId' in item ? item.globalEntryId ?? '未生成' : '未生成'}`).join(' / ') || '対象なし'}\n詳細は status --json で確認できます。` }
    } }))
  disposers.push(ctx.tools.register({ name: 'task_memory_review', modelFacing: true,
    description: MEMORY_APPLICATION_GUIDANCE,
    // Zod attaches non-enumerable ~standard metadata; DSH requires plain JSON.
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(transportSchema))), output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, execution: NativeExecution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.parent !== undefined && !isPtcSubcall(execution) || execution.name !== 'task_memory_review') throw new Error('No active native task for memory application')
      execution.signal.throwIfAborted()
      const input = inputSchema.parse(args)
      if (input.action === 'refresh') return host.refresh(execution, input.query)
      return host.runtime.withDatabase(db => {
        execution.signal.throwIfAborted()
        if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
        if (input.action === 'review') recordMemoryApplicationReview(db, identity, execution.callId, input.review)
        if (input.action === 'review_batch') return recordMemoryApplicationReviewBatch(db, identity, execution.callId, input.reviews)
        return memoryApplicationStatus(db, identity.runId)
      })
    } }))
  disposers.push(ctx.on('tools/pre-execute', async (execution: NativeExecution, next: () => Promise<unknown>) => {
    const identity = host.resolve(execution)
    if (!identity || READ_TOOLS.has(execution.name) || CONTROL_TOOLS.has(execution.name) || isSavedLispResultRead(execution)) return next()
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
    const tracked = await host.runtime.withDatabase(db => {
      execution.signal.throwIfAborted()
      if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
      return beginMemoryExecution(db, identity, execution.callId, command)
    })
    if (tracked) pending.set(execution, identity)
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
