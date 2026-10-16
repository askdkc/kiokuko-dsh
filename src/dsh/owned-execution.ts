import { renameSync, openSync, closeSync, writeFileSync, fsyncSync, fchmodSync, rmSync, statSync } from 'node:fs'
import { readProtocol, assertProtocolRoute, reserveProtocolFile, applyProtocolFile, withProtocolEffect, reserveProtocolTest, authorizeProtocolTest, finishProtocolTest } from './guardrail/service.js'
import { runProtocolTests } from './guardrail/engine.js'
import { retainProtocolResult, protocolReceiptUncertain } from './guardrail/evidence.js'
import { recordOwnedCompletionObservation } from './owned-completion-evidence.js'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, open, rename, mkdir, rm, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import { tmpdir } from 'node:os'
import * as z from 'zod/v4'
import type { DshCoreRuntime } from './core-runtime.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { findSecret } from '../memory/secrets.js'
import { KiokukoError } from '../errors.js'
import { applicationSourceDigest, beginMemoryExecution, completeMemoryExecution, type MemoryApplicationIdentity } from '../memory/application.js'
import { beginTaskCompletionExecution, finishTaskCompletionExecution, saveTaskCompletionReceipt, completionSourceDigest } from './task-completion.js'
import { observeProcessResult } from './execution-result.js'
import { parseTestSummary, type TapSummary } from './node-tap-summary.js'
import {ExecutionJournal} from './execution-journal.js'
import {shellArguments} from './execution-command.js'
import { assertCodingDispatch, assertCodingCommandRetry } from './coding-workflow/service.js'
import { readCodingWorkflow } from './coding-workflow/store.js'
import { executionRequestAction } from './coding-workflow/intent.js'
import type { RequestIntentDecision, RequestIntentContext } from './decisions/request-intent.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { TASK_AUTHORITY, authorizeTaskLease, readTaskSnapshot, type TaskLease, type TaskAuthorityExecution } from './task-state.js'
import { captureExecutionTaskLease, withTaskAuthority, currentTaskAuthority, hasNoTaskAuthority, withNoTaskAuthority } from './task-authority-context.js'

export interface ExecutionIdentity extends MemoryApplicationIdentity { generation: string; agent: any; workflowSessionId?: string;
  requestIntent?: RequestIntentDecision | undefined; requestIntentContext?: RequestIntentContext | undefined }
export interface ExecutionReceipt {
  version: 1; operationId: string; runId: string; sessionId: string; generation: string
  kind: string; repositoryRoot:string; cwd: string; command?: string; commandDigest?: string
  targets: { path: string; before: string | null; after: string | null }[]
  state: 'started' | 'completed' | 'unknown'; exitCode?: number | null; signal?: string | null
  processStarted?:boolean; processStopped?:boolean; cancelled?: boolean; timedOut?: boolean; outputComplete?: boolean; observedBytes?: number; displayedBytes?: number
  outputDigest?: string; summary?: TapSummary | undefined; verification?: 'passed' | 'failed' | 'unknown'
  evidenceRef: string; persistence: 'saved' | 'pending'; persistenceError?:string; error?: string
  authority?: 'current' | 'stale'
  taskAuthority?: TaskLease
  checks?:{sourcePaths:string[];sourceDigest:string;postSourceDigest?:string;outcome:string;assertion:string}[]
}
interface NativeExecution extends TaskAuthorityExecution { agent?: any; callId: string; signal: AbortSignal; name: string; arguments?: any }
export interface OwnedHost {
  runtime: DshCoreRuntime
  resolve(execution: NativeExecution): ExecutionIdentity | undefined
  resolveRead?(execution: NativeExecution): Promise<ExecutionIdentity | undefined>
  planActive?(agent: any): boolean
  confirm?(identity: ExecutionIdentity, detail: string, signal: AbortSignal): Promise<boolean>
  isTaskControl?(execution: NativeExecution): boolean
  unownedNative?(execution: NativeExecution): boolean
  nativeCommand?(execution: NativeExecution): boolean
  nativeLisp?(execution: NativeExecution): boolean
}
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const within = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }
const safeText = (text: string) => findSecret(text) ? '[redacted secret-bearing text]' : text
const ownedCalls = new WeakSet<object>()
export const isOwnedExecutionCall = (execution: object) => ownedCalls.has(execution)
/** Known effect surfaces. Composite Lisp/PTC programs guard their inner calls;
 * reading, cancellation and pure evaluation do not acquire execution authority. */
export function taskEffectTool(name: string, args: unknown): boolean {
  if (name === 'str_replace_editor') return (args as {command?:unknown}|null)?.command !== 'view'
  return ['kioku_write','kioku_edit','kioku_remove','kioku_exec','write','edit','bash','spawn','fork','subagent','enno_delegate','task_operation'].includes(name)
}
const fileInput = z.object({path:z.string().min(1),content:z.string().optional(),expectedHash:z.string().nullable().optional(),oldText:z.string().optional(),newText:z.string().optional()}).strict()
const commandInput = z.object({command:z.string().min(1),cwd:z.string().optional(),shell:z.enum(['bash','zsh']).default('bash'),background:z.boolean().default(false),timeoutMs:z.number().int().min(1).max(3600000).default(300000),destructiveTargets:z.array(z.string()).optional()}).strict()
const resultInput = z.object({operationId:z.string().min(1),cancel:z.boolean().default(false)}).strict()
const runtimeServices = new WeakMap<DshCoreRuntime, Set<OwnedExecutionService>>()

/** Host-only stop observation. A crash receipt is not proof of a stopped child. */
export async function stopTaskOwnedExecutions(runtime: DshCoreRuntime, identity: { taskId: string; repositoryRoot: string }, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  await Promise.all([...runtimeServices.get(runtime) ?? []].map(service => service.stopTask(identity, signal)))
  signal?.throwIfAborted()
  try {
    return await runtime.withDatabase(db => db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE run_id=?')
      .all<{receipt_json:string}>(identity.taskId).every(row => {
        const receipt = JSON.parse(row.receipt_json) as ExecutionReceipt
        if (receipt.repositoryRoot !== identity.repositoryRoot || receipt.state === 'started') return false
        return receipt.kind !== 'kioku_exec' || receipt.state === 'completed' && receipt.processStopped === true
      }))
  } catch { return false }
}

/** One owner for effects and observed evidence. Saved-result reads never execute an effect. */
export class OwnedExecutionService {
  readonly #operations = new Map<string, { digest:string; receipt:ExecutionReceipt; value?:unknown; controller:AbortController; done?:Promise<unknown> }>()
  readonly #legacyRuns = new Set<string>()
  constructor(private readonly host: OwnedHost) {
    const services = runtimeServices.get(host.runtime) ?? new Set()
    services.add(this); runtimeServices.set(host.runtime, services)
  }
  private current(execution: NativeExecution): ExecutionIdentity {
    execution.signal.throwIfAborted()
    const identity = this.host.resolve(execution)
    if (!identity) throw new Error('No current admitted execution owner')
    return Object.freeze({ ...identity })
  }
  private assertAuthority(identity: ExecutionIdentity, lease: TaskLease, database: SqliteDatabase): void {
    const current = this.host.resolve({agent:identity.agent,callId:'task-authority',name:'kioku_exec',signal:new AbortController().signal})
    if (!current || current.runId !== identity.runId || current.sessionId !== identity.sessionId
      || current.repositoryRoot !== identity.repositoryRoot || current.generation !== identity.generation
      || lease.taskId !== identity.runId || lease.sessionId !== (identity.workflowSessionId ?? identity.sessionId)
      || lease.repositoryRoot !== identity.repositoryRoot) throw new KiokukoError('CONFLICT', 'Task execution owner changed')
    authorizeTaskLease(database, lease)
  }
  private async checkAuthority(identity: ExecutionIdentity, lease: TaskLease): Promise<void> {
    await this.host.runtime.withDatabase(db => this.assertAuthority(identity, lease, db))
  }
  /** The caller may carry an earlier lease (for example an asynchronous Lisp job).
   * Never replace it with the current task after a stop/resume or owner change. */
  async captureAuthority(execution: NativeExecution, identity = this.current(execution)): Promise<TaskLease> {
    return this.host.runtime.withDatabase(db => {
      const lease = captureExecutionTaskLease(db, {
        taskId: identity.runId, sessionId: identity.workflowSessionId ?? identity.sessionId, repositoryRoot: identity.repositoryRoot,
      }, execution)
      this.assertAuthority(identity, lease, db)
      execution[TASK_AUTHORITY] = lease
      return lease
    })
  }
  /** A pure composite may run in any state, but its later inner effects must
   * retain the task (or absence of one) observed when the composite began. */
  async composite<T>(execution: NativeExecution, next: () => Promise<T>): Promise<T> {
    if (hasNoTaskAuthority()) return withNoTaskAuthority(next)
    const inherited = execution[TASK_AUTHORITY] ?? currentTaskAuthority()
    if (inherited) return withTaskAuthority(inherited, next)
    let lease: TaskLease | undefined
    try {
      const identity = this.host.resolve(execution) ?? await this.host.resolveRead?.(execution)
      if (execution[TASK_AUTHORITY]) return withTaskAuthority(execution[TASK_AUTHORITY], next)
      if (identity) lease = await this.host.runtime.withDatabase(db => {
        const task = readTaskSnapshot(db, {taskId:identity.runId,sessionId:identity.workflowSessionId??identity.sessionId,repositoryRoot:identity.repositoryRoot})
        return {taskId:task.taskId,sessionId:task.sessionId,repositoryRoot:task.repositoryRoot,revision:task.revision,generation:task.generation}
      })
    } catch { /* Pure calculations remain available; inner effects fail closed. */ }
    return lease ? withTaskAuthority(lease, next) : withNoTaskAuthority(next)
  }
  private async persist(receipt: ExecutionReceipt, digest: string): Promise<void> {
    const journal=this.journal(receipt.repositoryRoot)
    try{await journal.save({digest,receipt})}catch{receipt.persistence='pending'}
    try {
      await this.host.runtime.withDatabase(db => {
        const saved = db.prepare('SELECT request_digest FROM dsh_owned_operations WHERE operation_id=?').get<{request_digest:string}>(receipt.operationId)
        if (saved && saved.request_digest !== digest) throw new Error('Operation identity conflict')
        db.prepare(`INSERT INTO dsh_owned_operations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET
          state=excluded.state,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`)
          .run(receipt.operationId,receipt.runId,receipt.sessionId,receipt.generation,digest,receipt.state,JSON.stringify({...receipt,persistence:'saved'}),new Date().toISOString())
      })
      receipt.persistence = 'saved'
    } catch { receipt.persistence = 'pending' }
  }
  private journal(root:string):ExecutionJournal {
    return new ExecutionJournal(this.host.runtime.executionJournalDirectory ?? path.join(root,'.kioku','execution-journal'))
  }
  private async snapshot(target: string): Promise<string | null> {
    try { return hash(await readFile(target)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async unknownEffects(execution:NativeExecution):Promise<void> {
    const identity=this.host.resolve(execution)
    if(!identity)return
    try{await this.host.runtime.withDatabase(db=>{
      const lease = captureExecutionTaskLease(db, {taskId:identity.runId,sessionId:identity.workflowSessionId??identity.sessionId,repositoryRoot:identity.repositoryRoot}, execution)
      this.assertAuthority(identity,lease,db)
      // Coding checks carry source/config/artifact dependencies. Assessment
      // invalidates the affected checks instead of discarding unrelated items.
      if (readCodingWorkflow(db, identity.runId)) { saveTaskCompletionReceipt(db, identity.runId); return }
      db.prepare("UPDATE dsh_completion_executions SET outcome='unknown' WHERE run_id=? AND outcome='passed'").run(identity.runId)
      saveTaskCompletionReceipt(db,identity.runId)
    })}catch{/* Missing auxiliary evidence never rejects development. */}
  }
  private async evidence(identity: ExecutionIdentity, receipt: ExecutionReceipt, command: string, lease: TaskLease, execute: () => Promise<unknown>): Promise<unknown> {
    let completion = false, memory = false
    let sourcePaths:string[]=[]
    await this.checkAuthority(identity, lease)
    try { await this.host.runtime.withDatabase(db => {
      this.assertAuthority(identity, lease, db)
      completion = beginTaskCompletionExecution(db,{runId:identity.runId,callId:receipt.operationId,command,repositoryRoot:identity.repositoryRoot,cwd:receipt.cwd})
      if(completion){const method=db.prepare(`SELECT b.method_json FROM dsh_completion_executions e JOIN dsh_completion_bindings b
        ON b.run_id=e.run_id AND b.method_digest=e.method_digest WHERE e.run_id=? AND e.call_id=? LIMIT 1`).get<{method_json:string}>(identity.runId,receipt.operationId)
        if(method)sourcePaths=JSON.parse(method.method_json).sourcePaths}
    }) } catch { /* Evidence failure is exposed as unknown; effects continue. */ }
    try{memory=await this.host.runtime.withDatabase(db=>{this.assertAuthority(identity,lease,db);return beginMemoryExecution(db,identity,receipt.operationId,command,receipt.cwd)})}catch{/* Memory bookkeeping cannot suppress completion observations. */}
    for(const source of sourcePaths){try{const target=path.resolve(identity.repositoryRoot,source)
      let before:string|null
      try{before=await this.snapshot(target)}catch{before=applicationSourceDigest(identity.repositoryRoot,[source])}
      receipt.targets.push({path:target,before,after:before})
    }catch{/* Unavailable source observations remain unverified. */}}
    const argv=shellArguments(command)
    const readOnly=argv && ['cat','head','tail','ls','pwd','wc','stat','readlink'].includes(path.basename(argv[0]??''))
    if(!completion&&!readOnly)await this.unknownEffects({agent:identity.agent,callId:receipt.operationId,name:'kioku_exec',signal:new AbortController().signal,[TASK_AUTHORITY]:lease})
    await this.checkAuthority(identity, lease)
    const result = await execute()
    for(const target of receipt.targets){try{target.after=await this.snapshot(target.path)}catch{try{target.after=applicationSourceDigest(identity.repositoryRoot,[path.relative(identity.repositoryRoot,target.path)])}catch{target.after=null}}}
      try { await this.host.runtime.withDatabase(db => withImmediateTransaction(db, () => {
        this.assertAuthority(identity, lease, db)
        if (completion) {
          finishTaskCompletionExecution(db,{runId:identity.runId,callId:receipt.operationId,result}); saveTaskCompletionReceipt(db,identity.runId)
          const row=db.prepare(`SELECT e.source_digest,e.outcome,b.method_json FROM dsh_completion_executions e
            JOIN dsh_completion_bindings b ON b.run_id=e.run_id AND b.method_digest=e.method_digest WHERE e.run_id=? AND e.call_id=? LIMIT 1`)
            .get<{source_digest:string;outcome:string;method_json:string}>(identity.runId,receipt.operationId)
          if(row){const method=JSON.parse(row.method_json);let postSourceDigest:string|undefined
            try{postSourceDigest=completionSourceDigest(db,identity.runId,identity.repositoryRoot,method.sourcePaths)}catch{/* Missing inputs remain unknown. */}
            receipt.checks=[{sourcePaths:method.sourcePaths,sourceDigest:row.source_digest,...(postSourceDigest?{postSourceDigest}:{}),outcome:row.outcome,assertion:method.assertion}];receipt.verification=row.outcome==='passed'?'passed':row.outcome==='failed'?'failed':'unknown'}
        }
        if (memory) completeMemoryExecution(db,identity,receipt.operationId,result)
      })); receipt.authority = 'current' } catch (error) {
        receipt.verification = 'unknown'
        try { await this.checkAuthority(identity, lease) } catch {
          receipt.authority = 'stale'
          receipt.error = safeText(error instanceof Error ? error.message : String(error))
        }
      }
    return result
  }
  private async approve(identity: ExecutionIdentity, detail: string, signal: AbortSignal): Promise<void> {
    if (!await this.host.confirm?.(identity,detail,signal)) throw new Error('Destructive operation was not approved')
    signal.throwIfAborted()
  }
  private async reply(receipt:ExecutionReceipt,value:unknown={},replayed=false):Promise<unknown> {
    let memoryStorage='unknown'
    try{memoryStorage=await this.host.runtime.withDatabase(db=>db.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id=?').get<{status:string}>(receipt.runId)?.status??'not_scheduled')}catch{/* Development result is still returned. */}
    return {...value as object,receipt,...(replayed?{replayed:true}:{}),status:{work:receipt.state,verification:receipt.verification??'unknown',receiptPersistence:receipt.persistence,memoryStorage}}
  }
  async execute(name: string, raw: unknown, execution: NativeExecution): Promise<unknown> {
    const identity = (name === 'kioku_read' || name === 'kioku_result') && this.host.resolveRead
      ? await this.host.resolveRead(execution).then(value => {
        execution.signal.throwIfAborted()
        if (!value) throw new Error('No current execution result owner')
        return Object.freeze({...value})
      }) : this.current(execution)
    const action = executionRequestAction(identity.requestIntent, identity.requestIntentContext, name)
    ownedCalls.add(execution)
    if (name === 'kioku_read' || name === 'kioku_result') {
      await this.host.runtime.withDatabase(db => {
        if (!readCodingWorkflow(db,identity.runId)) this.#legacyRuns.add(identity.runId)
        else this.#legacyRuns.delete(identity.runId)
      }).catch(()=>{})
    }
    if (name === 'kioku_result') return this.result(identity,resultInput.parse(raw))
    const input = name === 'kioku_exec' ? commandInput.parse(raw) : fileInput.parse(raw)
    const lease = name === 'kioku_read' ? await this.captureAuthority(execution, identity).catch(()=>undefined) : await this.captureAuthority(execution, identity)
    if(name!=='kioku_read') {
      try {
        await this.host.runtime.withDatabase(db=>{
          const workflowIdentity = { ...identity, sessionId: identity.workflowSessionId ?? identity.sessionId }
          if (action === 'verify' && name === 'kioku_exec') {
            if (readCodingWorkflow(db, identity.runId)?.pendingScopeChange) throw new KiokukoError('CONFLICT', 'Revise the pending Goal scope before execution.')
            return
          }
          if (!assertCodingDispatch(db,workflowIdentity,name)) this.#legacyRuns.add(identity.runId)
          else this.#legacyRuns.delete(identity.runId)
          if (name === 'kioku_exec') assertCodingCommandRetry(db, workflowIdentity, (input as z.infer<typeof commandInput>).command)
        })
      } catch (error) { if (error instanceof KiokukoError || !this.#legacyRuns.has(identity.runId)) throw error }
    }
    if (name !== 'kioku_read' && this.host.planActive?.(identity.agent)) throw new Error('Plan is active. An explicit human implementation instruction or plan approval must exit it first.')
    // Native call identity survives a generation change. Rebinding a replay to
    // a new run/generation must conflict rather than repeat its side effects.
    const operationId = canonicalContentHash({session:identity.sessionId,call:execution.callId})
    const digest = canonicalContentHash({name,input,identity:{runId:identity.runId,sessionId:identity.sessionId,generation:identity.generation}})
    const previous = this.#operations.get(operationId)
    if (previous) { if (previous.digest !== digest) throw new Error('Operation ID reused with changed input'); return previous.done ?? previous.value ?? {receipt:previous.receipt} }
    const saved = await this.host.runtime.withDatabase(db => db.prepare('SELECT request_digest,receipt_json FROM dsh_owned_operations WHERE operation_id=?')
      .get<{request_digest:string;receipt_json:string}>(operationId)).catch(() => undefined)
    let outbox
    try{outbox=await this.journal(identity.repositoryRoot).read(operationId)}catch(error){
      // Corruption is an identity conflict; an unavailable auxiliary directory
      // may use the database reservation instead.
      if(error instanceof SyntaxError)throw error
      if(!saved && !['EACCES','EPERM','ENOTDIR','EIO'].includes((error as NodeJS.ErrnoException).code??''))throw error
    }
    if (saved||outbox) {
      if (saved&&saved.request_digest!==digest || outbox&&outbox.digest!==digest) throw new Error('Operation ID reused with changed input')
      const prior=outbox?.receipt??JSON.parse(saved!.receipt_json) as ExecutionReceipt
      if(prior.state==='started'){prior.state='unknown';prior.error='Host stopped before final receipt; effects will not be replayed.'}
      await this.persist(prior,digest)
      return this.reply(prior,{},true)
    }
    const receipt: ExecutionReceipt = {version:1,operationId,runId:identity.runId,sessionId:identity.sessionId,generation:identity.generation,kind:name,repositoryRoot:identity.repositoryRoot,cwd:identity.repositoryRoot,targets:[],state:'started',evidenceRef:`owned:${operationId}`,persistence:'pending',...(lease?{taskAuthority:Object.freeze({...lease})}:{})}
    const controller = new AbortController()
    const operation = {digest,receipt,controller} as {digest:string;receipt:ExecutionReceipt;controller:AbortController;value?:unknown;done?:Promise<unknown>}
    // A second concurrent call may have completed the database lookup too.
    const concurrent=this.#operations.get(operationId)
    if(concurrent){if(concurrent.digest!==digest)throw new Error('Operation ID reused with changed input');return concurrent.done??{receipt:concurrent.receipt}}
    this.#operations.set(operationId,operation)
    const signal = AbortSignal.any([execution.signal,controller.signal])
    const journal=this.journal(identity.repositoryRoot)
    try{
      if(!await journal.reserve({digest,receipt})){
        const prior=await journal.read(operationId)
        if(!prior||prior.digest!==digest)throw new Error('Operation journal identity conflict')
        operation.receipt=prior.receipt
        if(prior.receipt.state==='started'){prior.receipt.state='unknown';prior.receipt.error='Host stopped before final receipt; effects will not be replayed.'}
        await this.persist(prior.receipt,digest)
        return this.reply(prior.receipt,{},true)
      }
    }catch(error){
      if(error instanceof SyntaxError || !(error instanceof Error) || !(error as NodeJS.ErrnoException).code){this.#operations.delete(operationId);throw error}
      // Storage is auxiliary. Reserve in SQLite when possible, and explicitly
      // expose pending persistence if both stores are unavailable. Never retry
      // an effect automatically to repair its storage.
      receipt.persistenceError='Execution outbox unavailable; durable replay protection depends on the database reservation.'
    }
    await this.persist(receipt,digest)
    const done = (async () => {
      try {
        operation.value = name === 'kioku_exec' ? await this.command(identity,receipt,input as z.infer<typeof commandInput>,signal,lease!)
          : await this.file(identity,receipt,name,input as z.infer<typeof fileInput>,signal,lease)
        receipt.state = 'completed'
      } catch (error) { receipt.state = 'unknown'; receipt.error = safeText(error instanceof Error ? error.message : String(error)); operation.value = {error:receipt.error}; receipt.verification = 'unknown' }
      await this.persist(receipt,digest)
      if (name === 'kioku_exec') {
        try { await finishProtocolTest(action => this.host.runtime.withDatabase(action), receipt); await this.host.runtime.withDatabase(db => saveTaskCompletionReceipt(db, identity.runId)) }
        catch (error) { receipt.verification='unknown';receipt.error=safeText(error instanceof Error?error.message:String(error));await this.persist(receipt,digest) }
      }
      await this.host.runtime.withDatabase(db=>withImmediateTransaction(db,()=>recordOwnedCompletionObservation(db,receipt))).catch(()=>{})
      return this.reply(receipt,operation.value)
    })()
    operation.done = done
    if (name === 'kioku_exec' && (input as z.infer<typeof commandInput>).background) return this.reply(receipt)
    return done
  }
  private async file(identity: ExecutionIdentity, receipt:ExecutionReceipt, name:string, input:z.infer<typeof fileInput>, signal:AbortSignal,lease:TaskLease|undefined):Promise<unknown> {
    const target = path.resolve(identity.repositoryRoot,input.path)
    // Resolve the parent as well as existing target to identify symlink exits.
    let actual: string
    try { actual = await realpath(target) } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      let parent=path.dirname(target),suffix=path.basename(target)
      for(;;){try{actual=path.join(await realpath(parent),suffix);break}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;suffix=path.join(path.basename(parent),suffix);parent=path.dirname(parent)}}
    }
    const before = await this.snapshot(actual)
    receipt.targets = [{path:actual,before,after:before}]
    await this.persist(receipt,this.#operations.get(receipt.operationId)!.digest)
    if (input.expectedHash !== undefined && input.expectedHash !== before) throw new Error('File changed before the operation')
    if (name === 'kioku_read') {
      const content=await readFile(actual,'utf8'),observedHash=hash(content)
      if(lease&&observedHash===before){
        try{await this.checkAuthority(identity,lease);receipt.authority='current';receipt.verification='passed'}
        catch{receipt.authority='stale'}
      }
      return {content,hash:observedHash}
    }
    const disposable = await this.disposable(identity,actual)
    const database=before!==null && (/\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$/iu.test(actual) || (await readFile(actual)).subarray(0,16).equals(Buffer.from('SQLite format 3\0')))
    if (!disposable && (!within(identity.repositoryRoot,actual) || name === 'kioku_remove' || database)) await this.approve(identity,`Operation: ${name}\nTarget: ${actual}\nCurrent SHA256: ${before}`,signal)
    signal.throwIfAborted()
    if (await this.snapshot(actual) !== before) throw new Error('File changed during operation approval')
    const protocol = await this.host.runtime.withDatabase(db => reserveProtocolFile(db,lease!,receipt.operationId,name,actual,this.#operations.get(receipt.operationId)!.digest))
    if (name === 'kioku_remove') { await this.checkAuthority(identity,lease!); await rm(actual,{recursive:false,force:false}) }
    else {
      const existing = before === null ? '' : await readFile(actual,'utf8')
      let content = input.content
      if (name === 'kioku_edit') {
        if (!input.oldText || input.newText === undefined || existing.split(input.oldText).length !== 2) throw new Error('Edit requires exactly one matching oldText')
        content = existing.replace(input.oldText,input.newText)
      }
      if (content === undefined) throw new Error('Write content is required')
      if (protocol && Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Protocol file byte limit')
      if(protocol) {
        // Existing parents were bound at enrollment. Stage and commit inside the same final
        // synchronous authority boundary; cancellation committed before it prevents all writes.
        await this.host.runtime.withDatabase(db=>applyProtocolFile(db,lease!,receipt.operationId,signal,()=>{
          const mode=before===null?0o644:statSync(actual).mode&0o7777
          const temporary=path.join(path.dirname(actual),`.kioku-${randomUUID()}.tmp`)
          try {
            const file=openSync(temporary,'wx',mode)
            try{fchmodSync(file,mode);writeFileSync(file,content!);fsyncSync(file)}finally{closeSync(file)}
            renameSync(temporary,actual)
          } finally {rmSync(temporary,{force:true})}
        }))
      } else {
      await this.checkAuthority(identity,lease!)
      await mkdir(path.dirname(actual),{recursive:true})
      const mode = before === null ? 0o644 : (await stat(actual)).mode
      const temporary = path.join(path.dirname(actual),`.kioku-${randomUUID()}.tmp`)
      try {
        const file=await open(temporary,'wx',mode)
        try{await file.chmod(mode & 0o7777);await file.writeFile(content);await file.sync()}finally{await file.close()}
        signal.throwIfAborted()
        await this.checkAuthority(identity,lease!); await rename(temporary,actual)
      } finally { await rm(temporary,{force:true}) }
      }
      if (await this.snapshot(actual) !== hash(content)) throw new Error('Written content differs from requested content')
    }
    receipt.targets[0]!.after = await this.snapshot(actual)
    await this.checkAuthority(identity,lease!)
    receipt.verification = 'passed'; receipt.authority = 'current'
    return {applied:true}
  }
  private async disposable(identity:ExecutionIdentity,target:string):Promise<boolean> {
    if(within(identity.repositoryRoot,target))return /^(?:dist|build|target|node_modules)(?:[/\\]|$)/u.test(path.relative(identity.repositoryRoot,target))
    return within(await realpath(tmpdir()),target)
  }
  private async command(identity:ExecutionIdentity,receipt:ExecutionReceipt,input:z.infer<typeof commandInput>,signal:AbortSignal,lease:TaskLease):Promise<unknown> {
    let launchAttempted = false
    try {
    receipt.cwd = await realpath(path.resolve(identity.repositoryRoot,input.cwd ?? '.'))
    receipt.command = safeText(input.command); receipt.commandDigest = hash(input.command)
    await this.persist(receipt,this.#operations.get(receipt.operationId)!.digest)
    // Known destructive intent gets a concrete review. Unknown arbitrary code
    // is executed without pretending that static analysis can prove its effects.
    const argv=shellArguments(input.command)
    const removals=argv&&path.basename(argv[0]??'')==='rm'?argv.slice(1).filter(arg=>arg!=='--'&&!arg.startsWith('-')):undefined
    const disposableRemoval=removals?.length&& (await Promise.all(removals.map(async target=>{
      const absolute=path.resolve(receipt.cwd,target)
      try{return this.disposable(identity,await realpath(absolute))}catch{return false}
    }))).every(Boolean)
    let durableSql=!!(argv&&['sqlite3','psql','mysql'].includes(path.basename(argv[0]??''))&&/\b(?:insert|update|delete|replace|drop|alter|truncate|create)\b/iu.test(argv.slice(1).join(' ')))
    if(durableSql&&path.basename(argv![0]!)==='sqlite3'&&argv![1]&&!argv![1]!.startsWith('-')){
      const database=path.resolve(receipt.cwd,argv![1]!)
      durableSql=argv![1]!==':memory:'&&await this.snapshot(database)!==null&&!await this.disposable(identity,database)
    }
    if (input.destructiveTargets?.length || durableSql || removals?.length&&!disposableRemoval || !disposableRemoval && /(?:^|[;&|]\s*)(?:rm\s|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)|(?:drop\s+(?:table|database)|truncate\s+table)\b)/iu.test(input.command))
      await this.approve(identity,`Command: ${safeText(input.command)}\nCwd: ${receipt.cwd}\nTargets: ${input.destructiveTargets?.join(', ') ?? 'see command'}`,signal)
    const protocol = await this.host.runtime.withDatabase(db => reserveProtocolTest(db,lease,receipt.operationId,input.command,receipt.cwd))
    return await this.evidence(identity,receipt,input.command,lease,async () => {
      signal.throwIfAborted()
      await this.checkAuthority(identity,lease)
      launchAttempted = true
      const result = protocol
        ? await this.host.runtime.withDatabase(db => { const current=authorizeProtocolTest(db,lease,receipt.operationId,signal);return runProtocolTests(current,receipt.operationId,signal,input.timeoutMs,()=>{receipt.processStarted=true},launch=>withProtocolEffect(db,()=>{authorizeProtocolTest(db,lease,receipt.operationId,signal);return launch()})) })
        : await runOwnedProcess(input.command,receipt.cwd,input.shell,signal,input.timeoutMs,()=>{receipt.processStarted=true})
      if(protocol)retainProtocolResult(receipt,result)
      const output = result.content[0]!.text
      receipt.exitCode = result.value.exitCode; receipt.signal = result.value.signal; receipt.cancelled = result.value.aborted; receipt.timedOut = result.value.timedOut
      receipt.processStarted=result.value.processStarted===true; receipt.processStopped=result.value.processStopped===true
      receipt.outputComplete = result.value.outputComplete === true
      receipt.observedBytes = Buffer.byteLength(output); receipt.outputDigest = hash(output)
      if(protocol&&protocolReceiptUncertain(receipt))throw Error('Protocol launch transaction outcome is uncertain; reconcile the pending operation before explicit resume/rebind')
      if(result.value.summary)receipt.summary=result.value.summary
      receipt.verification = result.isError ? 'failed' : 'unknown'
      const preview = safeText(output).slice(-24000); receipt.displayedBytes = Buffer.byteLength(preview)
      // Evidence consumes the full output here, before the public preview.
      return result
    }).then(result => ({exitCode:receipt.exitCode,output:safeText((result as ReturnType<typeof observeProcessResult>).content[0]!.text).slice(-24000)}))
    } catch (error) {
      // Before the only launch boundary, cancellation proves that no child ran.
      // Once launch was attempted, preserve unknown outcomes and reconcile them.
      if (!signal.aborted || launchAttempted) throw error
      receipt.processStarted=false; receipt.processStopped=true; receipt.cancelled=true
      receipt.exitCode=null; receipt.signal=null; receipt.outputComplete=false; receipt.verification='failed'
      return {exitCode:null,output:''}
    }
  }
  async result(identity:ExecutionIdentity,input:z.infer<typeof resultInput>):Promise<unknown> {
    const operation = this.#operations.get(input.operationId)
    if (operation) {
      if (operation.receipt.runId !== identity.runId || operation.receipt.sessionId !== identity.sessionId) throw new Error('Result owner mismatch')
      if (input.cancel) operation.controller.abort()
      if (operation.receipt.state === 'started') return this.reply(operation.receipt)
      await this.persist(operation.receipt,operation.digest)
      return this.reply(operation.receipt,operation.value)
    }
    const saved = await this.host.runtime.withDatabase(db => db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND session_id=?')
      .get<{receipt_json:string}>(input.operationId,identity.runId,identity.sessionId)).catch(()=>undefined)
    const journal=await this.journal(identity.repositoryRoot).read(input.operationId)
    const receipt = journal?.receipt ?? (saved?JSON.parse(saved.receipt_json) as ExecutionReceipt:undefined)
    if (!receipt || receipt.runId!==identity.runId || receipt.sessionId!==identity.sessionId) throw new Error('No result for this run/session')
    if(journal)await this.persist(receipt,journal.digest)
    return this.reply(receipt.state === 'started' ? {...receipt,state:'unknown',error:'Host restarted before final process result was saved; effects will not be replayed.'} : receipt)
  }
  async stopTask(identity: { taskId: string; repositoryRoot: string }, signal?: AbortSignal): Promise<void> {
    const operations = [...this.#operations.values()].filter(op => op.receipt.runId === identity.taskId && op.receipt.repositoryRoot === identity.repositoryRoot)
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map(operation => operation.done))
    signal?.throwIfAborted()
  }
  async close():Promise<void> {
    for (const op of this.#operations.values()) op.controller.abort()
    await Promise.allSettled([...this.#operations.values()].map(op => op.done))
    runtimeServices.get(this.host.runtime)?.delete(this)
  }
}

/** Normal user environment, process group cancellation, bounded complete output. */
export function runOwnedProcess(command:string,cwd:string,shell:'bash'|'zsh',signal:AbortSignal,timeoutMs:number,onStarted?:()=>void) {
  if(signal.aborted)return Promise.resolve(observeProcessResult({isError:true,value:{exitCode:null,signal:null,timedOut:false,aborted:true,processStarted:false,processStopped:true,outputComplete:false},content:[{type:'text',text:''}]}))
  return new Promise<ReturnType<typeof observeProcessResult>>(resolve => {
    const env = {...process.env}; delete env.NODE_TEST_CONTEXT
    const supervisor=fileURLToPath(new URL('../../lisp/supervisor.mjs',import.meta.url))
    // Closing the host's liveness pipe also kills the process group after a
    // crash. Environment is inherited, never serialized into launch arguments.
    const child = spawn(process.execPath,[supervisor,JSON.stringify({command:shell,args:['-c',command],cwd,group:process.platform!=='win32',report:true})],{cwd,env,stdio:['pipe','pipe','pipe','ignore','pipe']})
    let terminal='', processStarted=false
    child.stdio[4]?.on('data',(chunk:Buffer)=>{if(terminal.length<1024){terminal+=chunk.toString('utf8');
      if(!processStarted&&terminal.includes('"processStarted":true')){processStarted=true;onStarted?.()}}})
    const chunks:Buffer[] = []; let bytes = 0, timedOut = false, capped = false
    const stop = () => {try{child.kill('SIGTERM')}catch{/* already exited */}}
    const timer = setTimeout(() => {timedOut=true;stop()},timeoutMs)
    const abort = () => stop(); signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)stop()
    const collect = (chunk:Buffer) => { bytes += chunk.length; if(bytes <= 32 * 1024 * 1024)chunks.push(chunk); else {capped=true;stop()} }
    child.stdout!.on('data',collect); child.stderr!.on('data',collect)
    let error = ''
    child.on('error',cause => {error=cause.message})
    child.on('close',(exitCode,termSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort',abort)
      const output = Buffer.concat(chunks).toString('utf8') + (error ? `\n${error}` : '')
      let processStopped=false
      try{const reported=terminal.trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.kind==='completed'||item.kind===undefined);
        if(!reported||reported.processStarted!==true||!(reported.exitCode===null||Number.isInteger(reported.exitCode))||!(reported.signal===null||typeof reported.signal==='string'))throw new Error('Missing completion');exitCode=reported.exitCode;termSignal=reported.signal;processStopped=true}catch{error ||= 'Missing final process report'}
      const outputComplete=!capped&&!error&&!timedOut&&!signal.aborted&&!termSignal
      const summary=outputComplete?parseTestSummary(output,true):undefined
      resolve(observeProcessResult({isError:exitCode!==0 || !!termSignal || timedOut || signal.aborted || capped || !!error,
        value:{exitCode,signal:termSignal,timedOut,aborted:signal.aborted,processStarted,processStopped,outputComplete,...(summary?{summary}:{})},content:[{type:'text',text:output}]}))
    })
  })
}

export function mountOwnedExecution(ctx:{tools:{register(tool:any):()=>void;get?(name:string,agent?:any):any;presentAs?(mode:'native'):()=>void};on?(name:string,listener:(...args:any[])=>unknown,options?:any):()=>void},host:OwnedHost):()=>Promise<void> {
  const service = new OwnedExecutionService(host), disposers:(()=>void)[]=[]
  const implementations = new Set<unknown>()
  for(const name of ['kioku_read','kioku_write','kioku_edit','kioku_remove','kioku_exec','kioku_result']) {
    const execute = async(args:unknown,execution:NativeExecution)=>JSON.parse(JSON.stringify(await service.execute(name,args,execution)))
    implementations.add(execute)
    disposers.push(ctx.tools.register({name,modelFacing:true,
    description:name==='kioku_exec'?'Execute bash/zsh with the normal user environment and child processes. Project development is authorized. Declare destructiveTargets for source/data deletion or durable DB mutation. Background results must be collected with kioku_result. Host receipts are observations, not model verdicts.':name==='kioku_result'?'Read or cancel an owned process by operationId. Never re-executes the command; final receipts distinguish process, verification and persistence status.':`Kiokuko owned ${name.slice(6)}. Project reads/writes/edits require no extra approval. Source/data deletion and external writes require a concrete confirmation. expectedHash checks concurrent changes.`,
    parameters:JSON.parse(JSON.stringify(z.toJSONSchema(name==='kioku_exec'?commandInput:name==='kioku_result'?resultInput:fileInput))),
    output:{schema:{},render:(_:unknown,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},execute}))
  }
  if (ctx.on) disposers.push(ctx.on('tools/pre-execute',async(execution:NativeExecution,next:()=>Promise<unknown>)=>{
    if(implementations.has(ctx.tools.get?.(execution.name,execution.agent)?.execute)) ownedCalls.add(execution)
    const effect = taskEffectTool(execution.name, execution.arguments) && host.isTaskControl?.(execution) !== true
      && host.nativeCommand?.(execution) !== true
    // Pin an admitted owner before an approval can await a human. On-demand
    // admission without a task is allowed to finish before the first capture.
    if (effect && host.resolve(execution)) await service.captureAuthority(execution)
    const decision = await next()
    if ((decision as {kind?:unknown}|null)?.kind === 'deny') return decision
    if (effect && host.isTaskControl?.(execution) !== true && host.unownedNative?.(execution) !== true) await service.captureAuthority(execution)
    return decision
  },{prepend:true}))
  if (ctx.on) disposers.push(ctx.on('tools/execute',async(execution:NativeExecution,next:()=>Promise<unknown>)=>{
    if (host.isTaskControl?.(execution) === true) return next()
    if (host.nativeCommand?.(execution) === true || execution.name === 'bash' && host.unownedNative?.(execution) === true) return withNoTaskAuthority(next)
    if (execution.name === 'run_code') return service.composite(execution,next)
    if (!taskEffectTool(execution.name, execution.arguments)) return next()
    const lease = await service.captureAuthority(execution)
    await host.runtime.withDatabase(db => assertProtocolRoute(db,lease,execution.name,isOwnedExecutionCall(execution)))
    execution.signal.throwIfAborted()
    return withTaskAuthority(lease, next)
  }))
  if(ctx.on)disposers.push(ctx.on('tools/pre-execute',async(execution:NativeExecution,next:()=>Promise<unknown>)=>{
    if(host.nativeLisp?.(execution)!==true&&['lisp_eval','lisp_call','lisp_define','lisp_hot_install','lisp_hot_call'].includes(execution.name))await service.unknownEffects(execution)
    return next()
  },{prepend:true}))
  return async()=>{for(const dispose of disposers.reverse())dispose();await service.close()}
}
