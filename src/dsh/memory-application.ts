import { forgetMemory } from '../memory/forget.js'
import { explainMemory, renderMemoryExplanation } from '../memory/explain.js'
import { z } from 'zod'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DshCoreRuntime } from './core-runtime.js'
import type { DshNativeCommandDefinition } from './commands.js'
import { beginMemoryExecution, completeMemoryExecution, memoryApplicationReviewSchema,
  memoryApplicationStatus, recordMemoryApplicationReview, recordMemoryApplicationReviewBatch, type MemoryApplicationIdentity } from '../memory/application.js'
import { autoGlobalizationStatus } from '../memory/auto-globalization.js'
import { MemoryTimeConstraint } from '../memory/retrieval-contracts.js'
import { isOwnedExecutionCall } from './owned-execution.js'
import { authorizeTaskLease, type TaskLease, type TaskAuthorityExecution } from './task-state.js'
import { captureExecutionTaskLease } from './task-authority-context.js'
import { withImmediateTransaction } from '../db/transaction.js'
import {correctionDecisionSchema,checkCorrectionDecision,literalVersionGate,recordCorrectionObservation,type CorrectionDecision} from './correction-decision.js'
import type {CorrectionReceipt} from './correction-context.js'
import type {DshUserQuestions} from './intake-questions.js'
import {canonicalContentHash} from '../serialization/validate.js'
import {KiokukoError} from '../errors.js'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('review'), review: memoryApplicationReviewSchema }).strict(),
  z.object({ action: z.literal('review_batch'), reviews: z.array(memoryApplicationReviewSchema).min(1).max(32) }).strict(),
  z.object({ action: z.literal('refresh'), query: z.string().trim().min(1).max(4000), timeConstraint: MemoryTimeConstraint.optional() }).strict(),
])
// Model providers require an object at the root of every tool schema. Keep
// action-specific validation in inputSchema after the native tool call arrives.
const transportSchema = z.object({
  action: z.enum(['status', 'review', 'review_batch', 'refresh']),
  review: memoryApplicationReviewSchema.optional(),
  reviews: z.array(memoryApplicationReviewSchema).min(1).max(32).optional(),
  query: z.string().trim().min(1).max(4000).optional(),
  timeConstraint: MemoryTimeConstraint.optional(),
}).strict()
export const MEMORY_APPLICATION_GUIDANCE = 'Memory references and past application status are optional advisory data. Missing, stale or failed memory evidence never blocks tools or task completion. Native permissions, explicit Stop and actual task verification remain authoritative. correction_check checks compiler compatibility and completion judgments against host-delivered corrections and actual verification; self-reported use is not proof. A supported literal conflicting version-only write asks a scoped native question. New memory saving happens only after task completion, permission to organize, and approval of the exact shown revision.'

interface NativeExecution extends TaskAuthorityExecution { callId: string; rootCallId?: string; name: string; arguments: any; parent?: unknown; agent?: any; signal: AbortSignal }
interface SurfaceContext {
  tools: { register(tool: any): () => void }
  commands?: { register(command: DshNativeCommandDefinition): () => void }
  on(name: string, handler: (...args: any[]) => unknown, options?: { prepend: boolean }): () => void
}
export interface ApplicationHost {
  runtime: DshCoreRuntime
  /** Exact native Agent and Session matching is the caller's responsibility. */
  resolve(execution: NativeExecution): (MemoryApplicationIdentity & {corrections?:CorrectionReceipt}) | undefined
  questions?:DshUserQuestions
  session?(agent: unknown): { sessionId: string; repositoryRoot: string } | undefined
  /** Exact current preparation proof supplied by the owning on-demand host. */
  preparationOnly?(execution: NativeExecution): boolean
  refresh(execution: NativeExecution, query: string, timeConstraint?: import('../memory/retrieval-contracts.js').MemoryTimeConstraint): Promise<unknown>
}
// Exact native read tools only; never classify arbitrary shell strings as read-only.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Skill', 'read', 'read_file', 'glob', 'grep', 'skill', 'observation_read', 'memory_explain', 'lisp_status', 'lisp_hot_status'])
const CONTROL_TOOLS = new Set(['correction_check', 'task_memory_review', 'task_completion', 'memory_checkpoint', 'curator_check', 'enno_finish', 'enno_work_report', 'enno_plan_review', 'enno_plan_submit', 'enno_ideal_submit', 'enno_meditation_submit'])

/** Only an exact foreground native Bash invocation at the bound repository root is proof-eligible. */
export function foregroundNativeCommand(execution: Pick<NativeExecution, 'name' | 'arguments' | 'parent'>, repositoryRoot: string): string | null {
  const args = execution.arguments
  if (execution.parent !== undefined || !['Bash', 'bash'].includes(execution.name)
    || typeof args?.command !== 'string' || args.background === true || args.run_in_background === true) return null
  try {
    const directories = ['cwd', 'workdir', 'workingDirectory', 'working_directory']
      .filter(key => args[key] !== undefined).map(key => args[key])
    return directories.every(directory => typeof directory === 'string'
      && realpathSync(resolve(repositoryRoot, directory)) === repositoryRoot) ? args.command : null
  } catch { return null }
}

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
  const pending = new WeakMap<object, { identity: MemoryApplicationIdentity; lease: TaskLease }>()
  const disposers: (() => void)[] = []
  const answered=new Map<string,'revise'|'cancel'>()
  const checkDecision=async(execution:NativeExecution,decision:CorrectionDecision)=>{
    const identity=host.resolve(execution)
    if(!identity)throw new KiokukoError('CONFLICT','No exact native task for correction check')
    const receipt=identity.corrections
    if(receipt&&(receipt.runId!==identity.runId||receipt.workspace!==identity.workspace||receipt.repositoryRoot!==realpathSync(identity.repositoryRoot)))
      throw new KiokukoError('CONFLICT','Correction receipt belongs to another native task')
    const operationDigest=canonicalContentHash({name:execution.name,arguments:execution.arguments})
    let verdict:ReturnType<typeof checkCorrectionDecision>
    try {verdict=await host.runtime.withDatabase(db=>checkCorrectionDecision(db,receipt,decision))}
    catch(error){
      execution.signal.throwIfAborted()
      if(error instanceof KiokukoError&&['SECURITY_REJECTION','CONFLICT','VALIDATION_ERROR','INTEGRITY_ERROR'].includes(error.code))throw error
      return {state:'unavailable',reason:'correction_observer_unavailable',retrieval:receipt?.retrieval??'not_requested',delivery:receipt?.delivery??'not_delivered',verification:'unverified',allowed:true,authorizationGranted:false,recorded:false}
    }
    const knownGate=decision.kind==='compatibility'&&decision.basis==='version_only'&&receipt?.sources.some(source=>source.rule==='capability_compatibility')
    const conflict=verdict.state==='contradiction'||verdict.state==='handoff_missing'&&knownGate
    let confirmation:'not_needed'|'unavailable'|'approve'|'revise'|'cancel'='not_needed'
    if(conflict){
      const key=canonicalContentHash({runId:identity.runId,request:receipt?.requestDigest,sources:receipt?.sources,decision})
      const previous=answered.get(key)
      confirmation=previous??'unavailable'
      if(!previous&&host.questions&&execution.agent?.id){
        const result=await host.questions.ask({agent:execution.agent,signal:execution.signal,questions:[{id:`correction-${key.slice(0,24)}`,header:'訂正との矛盾',
          question:verdict.reason==='verified_work_marked_incomplete_for_version'
            ?'対象の試験は成功しています。版数だけを理由に未完了とする判断を見直しますか？'
            :'この操作は、能力で互換性を確認するという訂正と矛盾する完全一致チェックを含みます。どう扱いますか？',
          detail:`対象: ${decision.target}`,
          options:[{label:'見直す'},{label:'この操作だけ許可'},{label:'この操作を中止'}]}]})
        execution.signal.throwIfAborted()
        const current=host.resolve(execution)
        if(current?.runId!==identity.runId||canonicalContentHash(current.corrections??null)!==canonicalContentHash(receipt??null))throw new KiokukoError('CONFLICT','Correction request changed during confirmation')
        if(canonicalContentHash({name:execution.name,arguments:execution.arguments})!==operationDigest)throw new KiokukoError('CONFLICT','Correction operation changed during confirmation')
        const fresh=await host.runtime.withDatabase(db=>checkCorrectionDecision(db,receipt,decision))
        if(fresh.state==='stale')throw new KiokukoError('CONFLICT','Correction source changed during confirmation')
        if(fresh.targetDigest!==verdict.targetDigest||fresh.state!==verdict.state||fresh.verification!==verdict.verification)
          throw new KiokukoError('CONFLICT','Correction target or verification changed during confirmation')
        const answer=result.answers.find(answer=>answer.id===`correction-${key.slice(0,24)}`)?.selected[0]
        confirmation=answer==='この操作だけ許可'?'approve':answer==='見直す'?'revise':'cancel'
        if(confirmation!=='approve'){
          if(answered.size>=128)answered.delete(answered.keys().next().value!)
          answered.set(key,confirmation)
        }
      }
    }
    const result={...verdict,allowed:!conflict||confirmation==='approve',authorizationGranted:false,confirmation,operationDigest,decisionDigest:canonicalContentHash(decision)}
    let recorded=false
    if(receipt)try {recorded=await host.runtime.withDatabase(db=>recordCorrectionObservation(db,receipt,{decision:decision.kind,target:decision.target,...result}))}catch {execution.signal.throwIfAborted()}
    return {...result,recorded}
  }
  disposers.push(ctx.tools.register({name:'correction_check',modelFacing:true,
    description:'Check a compiler compatibility or completion judgment against host-retrieved corrections and actual current verification. A model claim never proves application. Only a concrete conflicting operation asks a scoped native question.',
    parameters:JSON.parse(JSON.stringify(z.toJSONSchema(z.object({decision:correctionDecisionSchema}).strict()))),
    output:{schema:{},render:(_:unknown,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args:unknown,execution:NativeExecution)=>{
      if(execution.name!=='correction_check'||execution.parent!==undefined)throw new KiokukoError('CONFLICT','Correction check requires a root native call')
      return checkDecision(execution,z.object({decision:correctionDecisionSchema}).strict().parse(args).decision)
    }}))
  // Existing authorization hooks still own the operation. This guard never grants
  // permission, executes a verifier, or blocks unrelated/missing-memory work.
  disposers.push(ctx.on('tools/pre-execute',async(execution:NativeExecution,next:()=>Promise<unknown>)=>{
    const identity=host.resolve(execution)
    if(!identity?.corrections?.sources.some(source=>source.rule==='capability_compatibility'))return next()
    const decision=literalVersionGate(execution.name,execution.arguments,identity.repositoryRoot)
    if(!decision)return next()
    const result=await checkDecision(execution,decision)
    if(!result.allowed)throw new KiokukoError('CONFLICT',`Correction conflict: ${result.reason}; only this operation is held`)
    return next()
  },{prepend:true}))
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
        const application = row ? memoryApplicationStatus(db, row.run_id) : { supported: false as const, ready: true, workMayContinue: true as const, verification: 'unobserved' as const }
        const globalization = application.supported && 'items' in application
          ? application.items.map(item => ({ entryId: item.entryId, revision: item.revision,
            ...autoGlobalizationStatus(db, item.entryId, item.revision) })) : []
        return { integration: 'native_active', ...application, globalization }
      })
      if (invocation.rawInput.includes('--json')) return { kind: 'success', text: JSON.stringify(status, null, 2) }
      return { kind: 'success', text: !status.supported ? '記憶適用の連携は稼働中です。この会話で準備済みの依頼はありません。'
        : `記憶適用: ${status.ready ? '未処理なし' : '確認が必要'}\n取得: ${'retrieval' in status ? status.retrieval : 'unavailable'}\n検証: ${status.verification}\n未処理: ${'pending' in status ? status.pending.length : 0}\n実行中・終了未確認: ${'running' in status ? status.running : 0}\n自動Global化: ${status.globalization.map(item => `${item.entryId}@${item.revision}: ${'successfulRuns' in item ? item.successfulRuns : 0}/3, ${'reason' in item ? item.reason ?? item.state : '未対応'}, ${'globalEntryId' in item ? item.globalEntryId ?? '未生成' : '未生成'}`).join(' / ') || '対象なし'}\n詳細は status --json で確認できます。` }
    } }))
  disposers.push(ctx.tools.register({ name: 'memory_explain', modelFacing: true,
    description: 'Inspect stored memory claims, source excerpts, revision history and current eligibility. Source attachment does not prove truth.',
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(z.object({entryId:z.string().min(1).max(256),revision:z.number().int().positive().optional()}).strict()))),
    output: {schema:{},render:(_:unknown,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
    execute: async (args:unknown,execution:NativeExecution) => {
      const identity=host.resolve(execution)
      if(!identity || execution.parent!==undefined || execution.name!=='memory_explain') throw new Error('No active native task')
      const input=z.object({entryId:z.string().min(1).max(256),revision:z.number().int().positive().optional()}).strict().parse(args)
      execution.signal.throwIfAborted()
      return host.runtime.withDatabase(db=>{
        if(host.resolve(execution)?.runId!==identity.runId)throw new Error('Native task changed')
        const value=explainMemory(db,{workspace:identity.workspace,runId:identity.runId,...input})
        db.prepare('INSERT OR IGNORE INTO memory_explain_receipts VALUES(?,?,?,?)').run(identity.sessionId,execution.callId,value.entryId,value.revision)
        return value
      })
    }
  }))
  if(ctx.commands && host.session) disposers.push(ctx.commands.register({name:'kioku-memory',description:'Explain memory evidence or forget all revisions and dependent memories. Native logs remain. explain ENTRY_ID [--revision N] [--json] | forget ENTRY_ID --revision N',input:{hint:'explain ENTRY_ID [--revision N] [--json] | forget ENTRY_ID --revision N'},
    handler:async invocation=>{
      try {
        const session=host.session!(invocation.agent)
        if(!session)throw new Error('Native session identity unavailable')
        const args=invocation.rawInput.trim().split(/\s+/u)
        if(!['explain','forget'].includes(args[0]!)||!args[1])throw new Error('Use explain ENTRY_ID [--revision N] [--json]')
        let revision:number|undefined
        for(let i=2;i<args.length;i++){
          if(args[i]==='--json')continue
          if(args[i]==='--revision' && revision===undefined && /^[1-9]\d*$/.test(args[i+1]??'')){revision=Number(args[++i]);if(!Number.isSafeInteger(revision))throw new Error('Invalid revision');continue}
          throw new Error('Invalid memory command arguments')
        }
        if(args[0]==='forget' && revision===undefined)throw new Error('forget requires --revision N; it erases all revisions and dependent memories')
        invocation.signal.throwIfAborted()
        const value=await host.runtime.withDatabase(db=>{
          const binding=db.prepare('SELECT workspace,run_id FROM task_memory_bindings WHERE session_id=? AND repository_root=? ORDER BY rowid DESC LIMIT 1').get<{workspace:string;run_id:string}>(session.sessionId,session.repositoryRoot)
          const project=db.prepare('SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?').get<{workspace:string}>(session.repositoryRoot)
          const workspace=binding?.workspace??project?.workspace
          if(!workspace)throw new Error('Current native project is unavailable')
          return args[0]==='forget' ? forgetMemory(db,{workspace,entryId:args[1]!,expectedRevision:revision!,operationId:`forget:${session.sessionId}:${invocation.commandId??args[1]+':'+revision}`}) : explainMemory(db,{workspace,entryId:args[1]!,revision,...(binding?{runId:binding.run_id}:{})})
        })
        return {kind:'success',text:args.includes('--json') ? JSON.stringify(value,null,2) : args[0]==='forget' ? `記憶 ${args[1]} と依存する記憶を忘却しました。native会話ログ、外部への送信済み情報、バックアップは対象外です。` : renderMemoryExplanation(value as ReturnType<typeof explainMemory>)}
      }catch(error){return {kind:'error',text:error instanceof Error?error.message:'Memory inspection failed'}}
    }
  }))
  disposers.push(ctx.tools.register({ name: 'task_memory_review', modelFacing: true,
    description: MEMORY_APPLICATION_GUIDANCE,
    // Zod attaches non-enumerable ~standard metadata; DSH requires plain JSON.
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(transportSchema))), output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: unknown, execution: NativeExecution) => {
      const identity = host.resolve(execution)
      if (!identity || execution.parent !== undefined && !isPtcSubcall(execution) || execution.name !== 'task_memory_review') throw new Error('No active native task for memory application')
      execution.signal.throwIfAborted()
      const input = inputSchema.parse(args)
      if (input.action !== 'status') return { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' }
      return host.runtime.withDatabase(db => {
        execution.signal.throwIfAborted()
        if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
        return memoryApplicationStatus(db, identity.runId)
      })
    } }))
  disposers.push(ctx.on('tools/pre-execute', async (execution: NativeExecution, next: () => Promise<unknown>) => {
    const identity = host.resolve(execution)
    if (!identity || isOwnedExecutionCall(execution) || READ_TOOLS.has(execution.name) || CONTROL_TOOLS.has(execution.name) || isSavedLispResultRead(execution) || host.preparationOnly?.(execution) === true) return next()
    // A child without its own admitted binding cannot borrow its parent's proof.
    const command = foregroundNativeCommand(execution, identity.repositoryRoot)
    const tracked = await host.runtime.withDatabase(db => {
      // Empty memory applications remain observational and take no writer lock.
      if (!memoryApplicationStatus(db,identity.runId).items?.length) return undefined
      return withImmediateTransaction(db, () => {
      execution.signal.throwIfAborted()
      if (host.resolve(execution)?.runId !== identity.runId) throw new Error('Native task changed')
      const lease = captureExecutionTaskLease(db, {taskId:identity.runId,sessionId:identity.sessionId,repositoryRoot:identity.repositoryRoot}, execution)
      return beginMemoryExecution(db, identity, execution.callId, command) ? lease : undefined
      })
    }).catch(() => undefined)
    if (tracked) pending.set(execution, { identity: Object.freeze({...identity}), lease: tracked })
    return next()
  }, { prepend: true }))
  disposers.push(ctx.on('tools/result', (execution: NativeExecution, result: unknown) => {
    const tracked = pending.get(execution)
    if (!tracked) return
    const { identity, lease } = tracked
    pending.delete(execution)
    return host.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      if (host.resolve(execution)?.runId !== identity.runId) return
      authorizeTaskLease(db, lease)
      completeMemoryExecution(db, identity, execution.callId, result)
    })).catch(() => { /* Stale completion cannot adopt evidence into a resumed task. */ })
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
