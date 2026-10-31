import { ManagedOperationJournal } from '../managed-operation-journal.js'
import { runManagedOperation, observeManagedResult, managedAdmissionDenied, isManagedAdmissionDenied, type ManagedScope } from '../managed-operation-runner.js'
import { LispRecoverySession } from './recovery.js'
import type { LispNativeCommands } from '../lisp-tool-identity.js'
import { CodeIntelligenceAdapterV1 } from './code-intelligence.js'
import { CODE_METHODS } from './code-intelligence-contracts.js'
import type { ApprovalQuestions } from './approval.js'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { DshUserQuestions } from '../user-interaction.js'
import { EvalInput, LispError, digest, fail, failure, identifier, type LispConfiguration, type LispOwner, type LispState, type LispTool } from './contracts.js'
import { LispStore } from './store.js'
import { sessionCodingWorkflow } from '../coding-workflow/store.js'
import { LispWorker, type LispRpcContext, type Job } from './worker.js'
import { prepareLayout } from './sandbox.js'
import { verifyLispVendor } from './integrity.js'
import { CompiledLispCache, type CompilationStatus } from './compiled-cache.js'
import { backupUsage, checkedBytes, snapshot, under, type FrozenChange } from './files.js'
import { describeVerifiers, type LispCiRequest } from './ci.js'
import { PackageRequest, type PackageResult } from './packages.js'
import { LispProposalBatch } from './proposal-batch.js'
import { inspectSavedResult } from './inspection.js'
import { recordedResult } from './recorded-result.js'
import { detectRepositoryRoot } from '../../repository/detect-root.js'
import { HotToolRuntime, type HotMutation } from './hot-tools.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { AttachmentInput } from './attachment-input.js'
import { CallInput, DefineInput, TaskToolCatalog, selectFields, validateValue } from './task-tools.js'
import { ApplyInput, CompareInput, StageInput, VerifyInput, candidateFromResult, compareCandidates, loadCandidate, loadVerification, materializeCandidate, stageCandidate } from './candidate.js'
import { LispTaskAuthority, type LispTaskExecution } from './task-authority.js'
import type { TaskLease } from '../task-state.js'
import { processIdentity } from '../../../lisp/process-identity.mjs'

interface AgentState { owner: LispOwner; state: LispState; worker?: LispWorker; error?: ReturnType<typeof failure>; active: Set<AbortController>; admission?: Promise<LispWorker>; inputBytes?: number; compilation?: CompilationStatus
  execution?: LispTaskExecution | undefined;
  managedScope?: ManagedScope;
  recovery?: LispRecoverySession;
  taskSettlement?: Promise<void>;
  codeLease?: { evaluationId: string; adapter: CodeIntelligenceAdapterV1 };
  ownedJobs?:Set<string>; ownedCalls?:Set<Promise<unknown>>; ownedDispatches?:Set<AbortController>; ownedStop?:Promise<void>;
  slotReserved?: boolean; hostBusy?: boolean; idleSince?: number; idleTimer?: ReturnType<typeof setTimeout>; suspension?: Promise<void>; resumed?: boolean; disposed?: boolean;
  packageBase?: NonNullable<PackageResult['base']>;
  currentVerification?: { operationId: string; generation: string; results: Array<{ request: LispCiRequest; result: unknown }> } }
export interface ManagerOptions {
  codeSession?: (owner: LispOwner, context: LispRpcContext) => CodeIntelligenceAdapterV1
  skillPrompts?: DshSkillPrompts
  store: LispStore; config: LispConfiguration; dataRoot: string; library?: string; protectedRoots?: string[]; questions?: DshUserQuestions
  notify?: (owner: LispOwner, message: string) => void
  toolCall?: (owner: LispOwner, name: string, args: Record<string, unknown>, signal?:AbortSignal,callId?:string, taskLease?:TaskLease) => Promise<unknown>
  toolCatalog?: (owner:LispOwner)=>{name:string;parameters:unknown;adapterVersion:number}[]
  packagesCall?: (owner: LispOwner, request: PackageRequest, signal: AbortSignal) => Promise<PackageResult>
  ciCall?: (owner: LispOwner, request: LispCiRequest, signal: AbortSignal, scratchRoot?: string) => Promise<unknown>
  verifiedCall?: (owner: LispOwner, operationId: string, generation: string, request: LispCiRequest, result: unknown) => Promise<void>
  attachmentInput?: (owner: LispOwner, path: string, signal: AbortSignal) => AttachmentInput
  decisionCall?: (owner: LispOwner, method: 'decisions-status' | 'decisions-evaluate', args: unknown, context: LispRpcContext) => Promise<unknown>
  typesafeCall?: (owner: LispOwner, method: 'typesafe-status' | 'typesafe-evaluate', args: unknown, context: LispRpcContext) => Promise<unknown>
}
/** Confirm the exact owned operation stopped; an abort acknowledgement is not completion. */
export async function confirmOwnedJobStop(operationId: string, read: (cancel: boolean, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const abort = new AbortController()
  const unconfirmed = () => new LispError('STOP_UNCONFIRMED', '管理中のプロセスの停止をまだ確認できません。記録を確認してから再開してください。')
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(unconfirmed()) }, 5000)
  })
  let identity: string | undefined
  try {
    for (let first = true; ; first = false) {
      const result = await Promise.race([read(first, abort.signal), deadline]) as { receipt?: { state?: string; processStopped?: boolean; operationId?: string; runId?: string; sessionId?: string; generation?: string } } | undefined
      const receipt = result?.receipt
      if (receipt?.operationId !== operationId) throw unconfirmed()
      const current = JSON.stringify([receipt.runId, receipt.sessionId, receipt.generation])
      if (identity !== undefined && current !== identity) throw unconfirmed()
      identity = current
      if ((receipt.state === 'completed' || receipt.state === 'cancelled') && receipt.processStopped === true) return
      if (receipt.state !== 'started') throw unconfirmed()
      await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 25)), deadline])
    }
  } finally { clearTimeout(timer) }
}

/** Host-owned authority. Worker frames never grant permissions or choose identities. */
export class LispManager {
  readonly taskAuthority: LispTaskAuthority
  readonly enabled = new Map<string, string>()
  readonly #agents = new Map<string, AgentState>()
  readonly #proposals: LispProposalBatch
  readonly #executions = new Map<Promise<unknown>, string>()
  readonly #config: LispConfiguration
  readonly #store: LispStore
  readonly #library: string
  readonly #compiled: CompiledLispCache
  readonly #taskTools: TaskToolCatalog
  readonly #hot: HotToolRuntime
  #closed = false
  readonly #hostId = `${processIdentity(process.pid) ?? 'unknown'}:${randomUUID()}`
  readonly #claims = new Set<Promise<void>>()
  #ownsSessions = false
  #artifactReserved = 0
  #admissionQueue: Promise<void> = Promise.resolve()
  readonly #inflight = new Map<string, string>()
  constructor(readonly options: ManagerOptions) {
    this.#config = options.config
    this.taskAuthority = new LispTaskAuthority(options.store.database)
    this.#store = new LispStore(options.store.database, (db, owner) => this.taskAuthority.authorizePublication(db, owner))
    this.#proposals = new LispProposalBatch({ store: this.#store, backupRoot: join(options.dataRoot, 'backups'), protectedRoots: () => this.protectedRoots(), ...(options.questions ? { questions: options.questions } : {}), stopped: () => this.#closed,
      authorizeEffect: async owner => { await this.taskAuthority.authorizeEffect(owner) },
      ...(options.config.executionMode==='development'&&options.toolCall?{execute:async (owner, name, args, signal, callId) => options.toolCall!(owner, name, args, signal, callId, await this.taskAuthority.authorizeEffect(owner, 'owned'))}:{}) })
    this.#library = options.library ?? fileURLToPath(new URL('../../../lisp/', import.meta.url))
    this.#compiled = new CompiledLispCache(join(options.dataRoot, 'compiled'), this.#library, this.#config)
    this.#taskTools = new TaskToolCatalog(this.#store)
    this.#hot = new HotToolRuntime({ store: this.#store, ...(options.questions ? { questions: options.questions } : {}),
      authorizeEffect: async owner => { await this.taskAuthority.authorizeEffect(owner) },
      projectRoot: async owner => detectRepositoryRoot({ cwd: owner.root, allowDirectory: true }).root,
      authorize: async owner => {
        const state = this.entry(owner)
        if (this.#closed || state.disposed) fail('HOST_STOPPED', 'Lisp のホストまたはセッションが停止しています。')
        // A resident worker is reusable only by its exact session/agent owner.
      },
      run: (owner, source, input, signal, mode) => this.runTask(owner, source, input, signal, mode),
      input: (owner, ref) => this.taskResult(owner, ref),
    })
  }
  async start(): Promise<void> {
    await verifyLispVendor(this.#library)
    await mkdir(this.options.dataRoot, { recursive: true, mode: 0o700 })
    // Older versions hold an exclusive lock and cannot safely coexist with this
    // session-scoped protocol. Preserve their lock; never steal a live host.
    try {
      const saved = JSON.parse(await readFile(join(this.options.dataRoot, 'host.lock'), 'utf8')) as {pid: number}
      if (!Number.isInteger(saved.pid) || saved.pid < 1) fail('HOST_LOCK', 'Lisp のホストロックが破損しています。')
      try { process.kill(saved.pid, 0); fail('HOST_LOCK', '旧形式の Lisp ロックの所有者は PID だけでは確認できません。稼働物とロックを照合してから再開してください。ロックは自動削除しません。') }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await this.#store.expireResults()
    for (const session of await this.#store.start()) this.enabled.set(session.session_id, session.root_path)
    await this.#hot.catalog.expire()
  }
  private async claimSession(owner: LispOwner): Promise<void> {
    if (this.#closed) fail('HOST_STOPPED', 'プラグインが停止しています。')
    const claim = this.#store.claimSession(owner, this.#hostId)
    this.#claims.add(claim)
    try {
      await claim
      this.#ownsSessions = true
      if (this.#closed) fail('HOST_STOPPED', 'プラグインが停止しています。')
    } finally { this.#claims.delete(claim) }
  }
  private entry(owner: LispOwner): AgentState {
    const root = this.enabled.get(owner.sessionId)
    if (!root || root !== owner.root) fail('LISP_DISABLED', 'このセッションでは Lisp を有効にしていません。/kioku-lisp enable を実行してください。')
    const key = JSON.stringify([owner.sessionId, owner.agentId])
    let state = this.#agents.get(key)
    if (!state) { state = { owner, state: 'RECOVERY_REQUIRED', active: new Set(), error: failure(new LispError('WORKER_NOT_RESUMED', '保存されたセッションに実行中の Lisp はありません。前のコードは再実行せず、操作履歴を確認して再開してください。', '/kioku-lisp recover または画面の復旧ボタンで確認できます。')) }; this.#agents.set(key, state) }
    return state
  }
  private protectedRoots(): string[] { return [this.options.dataRoot, dirname(this.#library), ...this.options.protectedRoots ?? []] }
  private async authorizeCodingTask(owner:LispOwner):Promise<void> {
    const workflow=await this.#store.database(db=>sessionCodingWorkflow(db,owner.sessionId))
    if(workflow?.protocol && this.#config.executionMode !== 'protected') fail('PROTOCOL_PROTECTED_REQUIRED','This bounded protocol requires protected Lisp computation. Disable the existing Lisp session before binding, then select protected mode; use owned file/test tools for effects.')
    const native = this.taskAuthority.current()?.nativeCommands
    if (native && !workflow?.protocol) native.assertCurrent()
    else if(workflow&&(workflow.repositoryRoot!==owner.root||workflow.choice.state!=='yes'||!workflow.definition||['cancelled','superseded','completed'].includes(workflow.state)))
      fail('CODING_CHOICE_PENDING','このタスクの Goal と条件を定め、Lisp の選択に回答してから実行してください。')
    await this.claimSession(owner)
  }
  async enable(owner: LispOwner, hostBusy = false, signal?: AbortSignal): Promise<unknown> {
    await this.authorizeCodingTask(owner)
    signal?.throwIfAborted()
    if (await this.isTaskMode(owner)) fail('TASK_MODE_ACTIVE', 'このセッションは作業用ツール形態です。Lisp worker 形態へ切り替えるには一度 disable してください。')
    if (!this.#config.enabled) fail('LISP_DISABLED', '設定の lisp.enabled を true にしてプラグインを再読み込みしてください。')
    if (this.#closed) fail('HOST_STOPPED', 'プラグインが停止しています。')
    if (this.enabled.has(owner.sessionId)) { this.setAgentBusy(owner, hostBusy); return this.prepare(owner) }
    if (await realpath(owner.root) !== owner.root) fail('SCOPE_CONFLICT', '作業ディレクトリを確認できません。')
    // Persist the fence before starting any worker. A failed startup stays protected.
    await this.#store.enable(owner); this.enabled.set(owner.sessionId, owner.root)
    signal?.throwIfAborted()
    const state = this.entry(owner)
    state.hostBusy = hostBusy
    await this.startWorker(state)
    return this.status(owner)
  }
  async enableTask(owner: LispOwner, signal?: AbortSignal): Promise<unknown> {
    await this.authorizeCodingTask(owner)
    signal?.throwIfAborted()
    if (!this.#config.enabled || this.#closed) fail('LISP_DISABLED', 'Lisp の設定と状態を確認してください。')
    if (await realpath(owner.root) !== owner.root) fail('SCOPE_CONFLICT', '作業ディレクトリを確認できません。')
    if ([...this.#agents.values()].some(s => s.owner.sessionId === owner.sessionId && s.worker && !s.worker.stopped))
      fail('TASK_MODE_BUSY', '稼働中の Lisp worker があるため実行形態を切り替えられません。')
    await this.#store.enable(owner); this.enabled.set(owner.sessionId, owner.root)
    const epoch = (await this.#store.session(owner.sessionId))?.epoch
    if (!epoch) fail('TASK_MODE_CONFLICT', 'セッション世代を確認できません。')
    const modeId = `task-mode-${epoch}`
    const modeOwner = { ...owner, agentId: '__session__' }
    const old = await this.#store.get(modeOwner, modeId)
    if (!old) {
      await this.#store.reserve(modeOwner, modeId, 'task_mode', digest({ root: owner.root, epoch }), 'host', { root: owner.root, epoch })
      await this.#store.transition(modeOwner, modeId, ['RUNNING'], 'SUCCEEDED', { mode: 'task' })
    } else if (old.kind !== 'task_mode' || old.digest !== digest({ root: owner.root, epoch }) || old.state !== 'SUCCEEDED')
      fail('TASK_MODE_CONFLICT', '実行形態を確認できません。')
    return { ok: true, state: 'TASK_READY' }
  }
  async isTaskMode(owner: LispOwner): Promise<boolean> {
    const epoch = (await this.#store.session(owner.sessionId))?.epoch
    if (!epoch) return false
    const record = await this.#store.get({ ...owner, agentId: '__session__' }, `task-mode-${epoch}`)
    return record?.kind === 'task_mode' && record.state === 'SUCCEEDED' && record.digest === digest({ root: owner.root, epoch })
  }
  private async stopTaskWorkers(sessionId: string): Promise<void> {
    this.#hot.cancel(sessionId)
    const active = [...this.#agents].filter(([key, state]) => state.owner.sessionId === sessionId && (JSON.parse(key) as string[])[2] === 'task')
    const stopped = await Promise.allSettled(active.map(async ([key, state]) => {
      state.state = 'STOPPING'
      for (const abort of state.active) abort.abort(new LispError('CANCELLED', '作業用 Lisp の処理を取り消しました。'))
      try {
        await state.worker?.stop()
        // A task can still be preparing its compiled runtime without a worker.
        // Keep its admission visible until its own cleanup has settled.
        await state.taskSettlement
        await this.stopOwned(state)
        if (state.error?.code === 'STOP_UNCONFIRMED') fail('STOP_UNCONFIRMED', '作業用 Lisp の停止を確認できません。')
        this.#agents.delete(key)
      }
      catch (error) { state.state = 'STOP_UNCONFIRMED'; state.error = failure(error); throw error }
    }))
    const failed = stopped.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  /** A managed call uses the same admission queue and OS sandbox as legacy Lisp. */
  private async runTask(owner: LispOwner, code: string, input: unknown, signal?: AbortSignal, mode: 'call' | 'compile' | 'eval' = 'call'): Promise<{ value: unknown; output: unknown; generation: string }> {
    await this.authorizeCodingTask(owner)
    const repositoryRoot=detectRepositoryRoot({cwd:owner.root,allowDirectory:true}).root
    const resident=[...this.#agents.values()].find(s=>s.worker&&!s.worker.stopped&&s.worker.repositoryRoot===repositoryRoot)
    if(resident){
      if(mode==='eval'||resident!==this.#agents.get(JSON.stringify([owner.sessionId,owner.agentId]))||resident.owner.root!==owner.root)
        fail('REPOSITORY_IN_USE','このリポジトリの Lisp は別の owner が使用中です。状態は保持し、別 SBCL を起動しません。')
      return this.runResidentTask(resident,code,input,signal,mode)
    }
    if ([...this.#agents.values()].some(s => s.owner.sessionId === owner.sessionId && s.state === 'STOP_UNCONFIRMED'))
      fail('STOP_UNCONFIRMED', '停止未確認の Lisp worker があります。新しい実行を開始できません。')
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const state: AgentState = { owner, state: 'PREFLIGHT', active: new Set([abort]), hostBusy: true, execution: this.taskAuthority.current() }
    let settled!: () => void
    state.taskSettlement = new Promise<void>(resolve => { settled = resolve })
    const key = JSON.stringify([owner.sessionId, owner.agentId, 'task', randomUUID()])
    this.#agents.set(key, state)
    const assertCurrent = () => {
      combined.throwIfAborted()
      if (this.#closed || state.disposed || this.#agents.get(key) !== state || !['PREFLIGHT', 'EVALUATING'].includes(state.state))
        fail('CANCELLED', '作業用 Lisp の実行は取り消されています。')
    }
    let worker: LispWorker | undefined
    try {
      assertCurrent()
      await this.reserveSlot(state)
      const compiled = await this.#compiled.ensure(combined, () => {})
      assertCurrent()
      const base = await mkdtemp(join(this.options.dataRoot, 'w-'))
      const layout = await prepareLayout(base, this.#library)
      layout.compiled = compiled.path
      layout.workspace = owner.root
      layout.protected = this.#config.executionMode === 'protected'
      worker = this.#config.executionMode==='protected' ? new LispWorker(layout,this.#config,undefined,()=>false) : new LispWorker(layout, this.#config, (method,args,context)=>this.bridge(state,method,args,context))
      state.worker = worker
      assertCurrent()
      await worker.start()
      assertCurrent()
      if(this.#config.executionMode==='protected'){
      const canary = join(base, 'host-canary')
      await writeFile(canary, 'protected', { mode: 0o600 })
      const probe = await this.journalRequest(state, worker, 'eval', { inputs: [], code: `(let ((read-denied (handler-case (progn (with-open-file (s ${JSON.stringify(canary)}) (read-char s)) nil) (file-error () t))) (delete-denied (handler-case (progn (delete-file ${JSON.stringify(canary)}) nil) (file-error () t)))) (unless (and read-denied delete-denied) (error "ISOLATION_FAILED")) :protected)` }, this.#config.startupTimeoutMs, combined)
      if (!probe.ok || await readFile(canary, 'utf8') !== 'protected') fail('ISOLATION_FAILED', 'OS によるファイル保護を確認できません。')
      }
      assertCurrent()
      state.state='EVALUATING'
      if (mode === 'compile') {
        const checked = await this.journalRequest(state, worker, 'task-compile', { code }, this.#config.timeoutMs, combined)
        assertCurrent()
        if (!checked.ok || checked.proposals.length) fail('TASK_COMPILE_FAILED', String(checked.value).slice(0, 1000))
        return { value: null, output: worker.output(), generation: worker.generation }
      }
      if (mode === 'eval') {
        const evaluated = await this.journalRequest(state, worker, 'eval', { code, inputs: [] }, this.#config.timeoutMs, combined)
        assertCurrent()
        if (!evaluated.ok || evaluated.proposals.length) fail('TASK_EVAL_FAILED', String(evaluated.value).slice(0, 1000))
        const value = evaluated.value as { printed?: string; json?: unknown }
        return { value: { printed: value.printed, json: value.json }, output: worker.output(), generation: worker.generation }
      }
      const encoded = JSON.stringify(input)
      if (!encoded || Buffer.byteLength(encoded) > 64 * 1024 * 1024) fail('TASK_INPUT_LIMIT', 'Task input is too large.')
      const inputPath = join(layout.inputs, randomUUID())
      await writeFile(inputPath, encoded, { flag: 'wx', mode: 0o400 })
      assertCurrent()
      state.state = 'EVALUATING'
      const response = await this.journalRequest(state, worker, 'task', { code, input: inputPath }, this.#config.timeoutMs, combined)
      if (!response.ok || response.proposals.length) fail('TASK_EXECUTION_FAILED', String(response.value).slice(0, 1000))
      const result = await snapshot(layout.scratch, 'task-result.json', [])
      if (!result.exists) fail('TASK_RESULT_MISSING', 'Task result was not saved.')
      const bytes = await checkedBytes(result)
      assertCurrent()
      return { value: JSON.parse(bytes.toString('utf8')) as unknown, output: worker.output(), generation: worker.generation }
    } finally {
      try {
        if (worker) {
          try { await worker.stop() }
          catch (error) { state.state = 'STOP_UNCONFIRMED'; state.error = failure(error); throw error }
        }
        await this.stopOwned(state)
        this.#agents.delete(key)
      } catch (error) {
        state.state='STOP_UNCONFIRMED';state.error=failure(error);throw error
      } finally {
        state.active.delete(abort)
        settled()
      }
    }
  }
  /** Reuse the exact owner's evaluation slot, never another owner's process or heap. */
  private async runResidentTask(state: AgentState, code: string, input: unknown, signal: AbortSignal | undefined, mode: 'call' | 'compile'): Promise<{ value: unknown; output: unknown; generation: string }> {
    const worker=state.worker!
    if(state.state!=='READY'||!worker.healthy||worker.busy)
      fail(state.state==='EVALUATING'?'BUSY':'RECOVERY_REQUIRED','常駐 Lisp の状態を確認してください。新しい worker は起動しません。')
    signal?.throwIfAborted()
    clearTimeout(state.idleTimer)
    state.state='EVALUATING' // Reserve before awaiting scratch or input I/O.
    state.execution=this.taskAuthority.current()
    const abort=new AbortController();state.active.add(abort)
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal
    const current=()=>{
      combined.throwIfAborted()
      if(this.#closed||state.disposed||state.state!=='EVALUATING'||!worker.healthy||state.worker!==worker)
        fail('CANCELLED','常駐 Lisp の実行は取り消されています。')
    }
    try{
      current()
      if(mode==='compile'){
        const checked=await this.journalRequest(state,worker,'task-compile',{code},this.#config.timeoutMs,combined,false)
        current()
        if(!checked.ok||checked.proposals.length)fail('TASK_COMPILE_FAILED',String(checked.value).slice(0,1000))
        return{value:null,output:worker.output(),generation:worker.generation}
      }
      const encoded=JSON.stringify(input)
      if(!encoded||Buffer.byteLength(encoded)>64*1024*1024)fail('TASK_INPUT_LIMIT','Task input is too large.')
      const scratch=await mkdtemp(join(worker.layout.scratch,'hot-'))
      const inputPath=join(worker.layout.inputs,randomUUID())
      await writeFile(inputPath,encoded,{flag:'wx',mode:0o400})
      current()
      const response=await this.journalRequest(state,worker,'task',{code,input:inputPath,scratch},this.#config.timeoutMs,combined,false)
      current()
      if(!response.ok||response.proposals.length)fail('TASK_EXECUTION_FAILED',String(response.value).slice(0,1000))
      const result=await snapshot(scratch,'task-result.json',[])
      if(!result.exists)fail('TASK_RESULT_MISSING','Task result was not saved.')
      const bytes=await checkedBytes(result)
      current()
      return{value:JSON.parse(bytes.toString('utf8')) as unknown,output:worker.output(),generation:worker.generation}
    }catch(error){
      if(!worker.healthy)this.halted(state,error)
      throw error
    }finally{
      state.active.delete(abort)
      if(state.state==='EVALUATING'&&worker.healthy)state.state='READY'
    }
  }
  private async startWorker(state: AgentState): Promise<LispWorker> {
    await this.authorizeCodingTask(state.owner)
    if (state.admission) return state.admission
    if (this.#closed || state.disposed) fail('HOST_STOPPED', 'Lisp のセッションが停止しています。')
    clearTimeout(state.idleTimer)
    state.state = 'PREFLIGHT'
    state.compilation = { state: 'checking' }
    const abort = new AbortController(); state.active.add(abort)
    const admission = (async () => {
      let worker: LispWorker | undefined
      try {
        await this.reserveSlot(state)
        const compiled = await this.#compiled.ensure(abort.signal, status => { state.compilation = status })
        if (this.#closed || state.state !== 'PREFLIGHT' || abort.signal.aborted) fail('CANCELLED', '起動は取り消されています。')
        const base = await mkdtemp(join(this.options.dataRoot, 'w-'))
        const layout = await prepareLayout(base, this.#library)
        layout.compiled = compiled.path
        layout.workspace = state.owner.root
        layout.protected = this.#config.executionMode === 'protected'
        worker = new LispWorker(layout, this.#config, (method, args, context) => this.bridge(state, method, args, context), undefined,
          () => this.taskAuthority.bound(state.execution, async () => { await this.taskAuthority.authorizeEffect(state.owner, this.#config.executionMode === 'protected' ? 'protected' : 'direct') }),
          (input, launch) => this.journalProtectedJob(state, input, launch))
        state.worker = worker
        if (this.#closed || state.state !== 'PREFLIGHT' || abort.signal.aborted) fail('CANCELLED', '起動は取り消されています。')
        await worker.start()
        if(this.#config.executionMode==='protected'){
        // Real runtime probe: private host file is outside every granted read/write root.
        const canary = join(base, 'host-canary')
        await writeFile(canary, 'protected', { mode: 0o600 })
        const quote = (value: string) => JSON.stringify(value)
        const probe = await this.journalRequest(state, worker, 'eval', { inputs: [], code: `(let ((read-denied (handler-case (progn (with-open-file (s ${quote(canary)}) (read-char s)) nil) (file-error () t))) (delete-denied (handler-case (progn (delete-file ${quote(canary)}) nil) (file-error () t)))) (unless (and read-denied delete-denied) (error "ISOLATION_FAILED")) (kioku.files:write-text (merge-pathnames "probe" (kioku.files:scratch)) "ok") :protected)` }, this.#config.startupTimeoutMs)
        if (!probe.ok || await readFile(canary, 'utf8') !== 'protected') fail('ISOLATION_FAILED', 'OS によるファイル保護を確認できません。')
        }
        if (this.#closed || state.state !== 'PREFLIGHT') { await worker.stop(); fail('CANCELLED', '起動を取り消しました。') }
        state.state = 'READY'; state.inputBytes = 0; delete state.error
        return worker
      } catch (error) {
        try { await worker?.stop() } catch (stop) { error = stop }
        if (error instanceof LispError && error.code === 'WORKER_LIMIT') { state.state = 'SUSPENDED'; delete state.error }
        else this.halted(state, error)
        throw error
      }
    })()
    state.admission = admission
    try { return await admission } finally { delete state.admission; delete state.slotReserved; state.active.delete(abort); this.scheduleIdle(state) }
  }
  /** Serialize only slot allocation/eviction; compilation remains concurrent. */
  private reserveSlot(state: AgentState): Promise<void> {
    const allocation = this.#admissionQueue.then(async () => {
      if (this.#closed || state.disposed || state.state !== 'PREFLIGHT') fail('CANCELLED', 'Lisp の起動を取り消しました。')
      const occupied = () => [...this.#agents.values()].filter(a => a.slotReserved || (a.worker && !a.worker.stopped)).length
      if (occupied() >= this.#config.maxWorkers) throw new LispError('WORKER_LIMIT', 'Lisp の起動枠はすべて使用中です。既存リポジトリの worker と状態は保持します。', '使い終わったセッションを明示的に disable するか、maxWorkers の設定を確認して再試行してください。')
      if (this.#closed || state.disposed || state.state !== 'PREFLIGHT') fail('CANCELLED', 'Lisp の起動を取り消しました。')
      state.slotReserved = true
    })
    this.#admissionQueue = allocation.catch(() => {})
    return allocation
  }
  private canSuspend(state: AgentState): boolean {
    return !this.#closed && !state.disposed && state.state === 'READY' && !state.hostBusy && !state.admission && state.active.size === 0
      && !state.ownedJobs?.size && !state.ownedCalls?.size && Boolean(state.worker?.healthy) && !state.worker?.hasRunningJobs
  }
  private scheduleIdle(state: AgentState): void {
    clearTimeout(state.idleTimer)
    if (this.#closed || state.disposed || state.state !== 'READY' || state.hostBusy || state.admission || state.active.size) return
    state.idleSince = Date.now()
    if(this.#config.idleTimeoutMs===0)return
    state.idleTimer = setTimeout(() => {
      void this.suspend(state).then(() => {
        // A background job can outlive the last evaluation. Recheck after it ends.
        if (state.state === 'READY') this.scheduleIdle(state)
      }).catch(error => this.halted(state, error))
    }, this.#config.idleTimeoutMs)
    state.idleTimer.unref()
  }
  private async suspend(state: AgentState): Promise<void> {
    if (!this.canSuspend(state)) return
    clearTimeout(state.idleTimer)
    state.state = 'STOPPING' // claim before awaiting the journal or process exit
    const suspension = (async () => {
      try {
        const pending = await this.#store.hasPending(state.owner.sessionId)
        if (pending) { state.state = 'READY'; return }
        await state.worker!.stop()
        state.state = 'SUSPENDED'; delete state.error; delete state.worker
      } catch (error) { this.halted(state, error); throw error }
    })()
    state.suspension = suspension
    try { await suspension } finally { delete state.suspension }
  }
  /** Normal suspension is resumable; crashes and explicit cancellation are not. */
  async prepare(owner: LispOwner): Promise<unknown> {
    await this.authorizeCodingTask(owner)
    const state = this.entry(owner)
    if (state.suspension) await state.suspension
    if (state.state === 'SUSPENDED') { await this.startWorker(state); state.resumed = true }
    else if (state.admission) await state.admission
    return this.status(owner)
  }
  setAgentBusy(owner: LispOwner, busy: boolean): void {
    if (!this.enabled.has(owner.sessionId)) return
    const state = this.entry(owner)
    if (state.hostBusy === busy) return
    state.hostBusy = busy
    if (busy) clearTimeout(state.idleTimer)
    else this.scheduleIdle(state)
  }
  /** Disposed sessions retain their fence/journal but cannot admit new work. */
  async disposeSession(sessionId: string): Promise<void> {
    await this.stopTaskWorkers(sessionId)
    const states = [...this.#agents.values()].filter(state => state.owner.sessionId === sessionId)
    const resumable = states.filter(state => state.state === 'READY' || state.state === 'SUSPENDED')
    for (const state of states) { state.disposed = true; clearTimeout(state.idleTimer) }
    const stopped = await Promise.allSettled(states.map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === sessionId).map(([promise]) => promise))
    const pending = await this.#store.hasPending(sessionId)
    for (const state of states) {
      state.hostBusy = false; state.disposed = false
      if (!pending && resumable.includes(state) && state.state === 'RECOVERY_REQUIRED' && state.worker?.stopped !== false) {
        state.state = 'SUSPENDED'; delete state.worker; delete state.error
      }
    }
    const failed = stopped.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  private halted(state: AgentState, error: unknown): void {
    state.error = failure(error)
    state.state = state.error.code === 'STOP_UNCONFIRMED' ? 'STOP_UNCONFIRMED' : 'RECOVERY_REQUIRED'
    try { this.options.notify?.(state.owner, `${state.error.message}\n${state.error.recovery}`) } catch { /* independent status/commands still expose the durable recovery state */ }
  }
  private retainOwned(state: AgentState, value: unknown): void {
    const receipt=(value as {receipt?:{operationId?:string;state?:string;processStopped?:boolean;processStarted?:boolean}}|undefined)?.receipt
    if(receipt && typeof receipt.operationId==='string' && !(receipt.processStopped===true && ['completed','cancelled'].includes(receipt.state??'') || receipt.state==='denied' && receipt.processStarted===false))
      (state.ownedJobs??=new Set()).add(receipt.operationId)
  }
  private async ownedDispatch<T>(state: AgentState, action:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const abort=new AbortController();(state.ownedDispatches??=new Set()).add(abort)
    try{return await action(abort.signal)}finally{state.ownedDispatches?.delete(abort)}
  }
  private stopOwned(state: AgentState):Promise<void> {
    if(state.ownedStop)return state.ownedStop
    const stopping=(async()=>{
      for(const abort of state.ownedDispatches??[])abort.abort()
      let timer:ReturnType<typeof setTimeout>|undefined
      try{await Promise.race([Promise.allSettled([...state.ownedCalls??[]]),new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new LispError('STOP_UNCONFIRMED','Owned process admission is unresolved; reconcile before resuming.')),5000)
      })])}finally{clearTimeout(timer)}
      let failure:unknown
      for(const operationId of state.ownedJobs??[]){
        try{await confirmOwnedJobStop(operationId,async(cancel,signal)=>this.options.toolCall?.(state.owner,'kioku_result',{operationId,cancel},signal));state.ownedJobs?.delete(operationId)}
        catch(error){failure??=error}
      }
      if(failure)throw failure
    })()
    state.ownedStop=stopping.finally(()=>{delete state.ownedStop})
    return state.ownedStop
  }
  private async journalProtectedJob(state: AgentState, input: unknown, launch: () => Promise<Job>): Promise<Job> {
    const scope = state.managedScope
    if (!scope) fail('JOURNAL_SCOPE_MISSING', 'Managed evaluation collection is unavailable.')
    await scope.database(db => {
      if (db.prepare(`SELECT 1 FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
        WHERE json_extract(s.scope_json,'$.sessionId')=? AND json_extract(o.operation_json,'$.route')='native' AND o.state='unknown' LIMIT 1`).get(state.owner.sessionId)) {
        new ManagedOperationJournal(db).markIncomplete(scope.scopeId)
        fail('JOURNAL_RECONCILE_REQUIRED', 'A previous native operation is unresolved; inspect it before another effect.')
      }
    })
    const operation = await scope.database(db => new ManagedOperationJournal(db).prepare(scope.scopeId, {route:'native',kind:'process',request:{input,environment:{...process.env},cwd:state.worker?.layout.scratch,runtime:process.version}}))
    if (!await scope.database(db => new ManagedOperationJournal(db).claim(operation.operationId))) fail('JOURNAL_REPLAY', 'Process already dispatched.')
    let job: Job
    try { job = await launch() }
    catch (error) { await scope.database(db => new ManagedOperationJournal(db).transition(operation.operationId,{state:isManagedAdmissionDenied(error)?'denied':'unknown'})); throw error }
    await scope.database(db => new ManagedOperationJournal(db).transition(operation.operationId,{state:'running'}))
    const done = job.done
    job.done = done.then(async () => {
      await observeManagedResult({...scope, operationId:operation.operationId,kind:'process'}, {
        code:job.result?.code,receipt:{route:'native',processStopped:job.settled===true},
      })
      await scope.database(db => new ManagedOperationJournal(db).setDelivery(operation.operationId,'delivered'))
    })
    // Background completion persists independently of Lisp's final return value.
    void job.done.catch(() => {})
    return job
  }
  private async journalRequest(state: AgentState, worker: LispWorker, ...args: Parameters<LispWorker['request']>): ReturnType<LispWorker['request']> {
    const lease = state.execution?.lease ?? this.taskAuthority.current()?.lease
    const scope = await this.#store.database(db => new ManagedOperationJournal(db).createScope({
      ...(lease ? {binding:{taskId:lease.taskId,workerGeneration:worker.generation,leaseAuthorityGeneration:lease.generation,leaseRevision:lease.revision}} : {}),
      sessionId: state.owner.sessionId, parentId: randomUUID(), runtimeIdentity: `sbcl:${worker.generation}`,
    }))
    const managedScope = { database: this.#store.database, scopeId: scope.scopeId }
    state.managedScope = managedScope
    try { return await worker.request(...args) }
    finally {
      if (state.managedScope === managedScope) delete state.managedScope
      await this.#store.database(db => new ManagedOperationJournal(db).seal(scope.scopeId))
    }
  }
  private bridge(state: AgentState, method: string, args: unknown, context: LispRpcContext): Promise<unknown> {
    const pending=this.taskAuthority.bound(state.execution, () => {
      const parsed = args as { name?: string }
      const processEffect = ['run', 'start-job', 'ci-verify'].includes(method) || method === 'tool-call' && parsed?.name === 'kioku_exec'
      const file = method === 'tool-call' && ['kioku_write', 'kioku_edit', 'kioku_remove'].includes(parsed?.name ?? '')
      if (!processEffect && !file) return this.bridgeBound(state, method, args, context)
      if (!state.managedScope) fail('JOURNAL_SCOPE_MISSING', 'Managed evaluation collection is unavailable; no operation was dispatched.')
      const route = method === 'run' && this.taskAuthority.current()?.nativeCommands && this.#config.executionMode === 'development' ? 'native' : 'owned'
      return runManagedOperation(state.managedScope, { route, kind: file ? 'file' : 'process',
        request: { method, args, cwd: state.owner.root, workerGeneration: context.generation, evaluationId: context.evaluationId, rpcId: context.rpcId,environment:{...process.env},runtime:process.version } },
        () => this.bridgeBound(state, method, args, context))
    })
    if(['run','start-job','tool-call','ci-verify'].includes(method)){
      (state.ownedCalls??=new Set()).add(pending)
      const settled=()=>{state.ownedCalls?.delete(pending)}
      void pending.then(settled,settled)
    }
    return pending
  }
  private async bridgeBound(state: AgentState, method: string, args: unknown, context: LispRpcContext): Promise<unknown> {
    if (state.state !== 'EVALUATING' || !state.worker?.healthy || this.#closed) fail('STALE_RPC', '現在の評価に属さない要求です。')
    if (context.generation !== state.worker.generation || context.signal.aborted) fail('STALE_RPC', '現在の評価に属さない要求です。')
    if ((CODE_METHODS as readonly string[]).includes(method)) {
      if (state.codeLease && state.codeLease.evaluationId !== context.evaluationId) fail('CODE_STALE_SCOPE', 'Code lease belongs to an earlier evaluation.')
      if (!state.codeLease) {
        const adapter = this.options.codeSession?.(state.owner, context) ?? new CodeIntelligenceAdapterV1({ owner: state.owner, workspaceRoot: state.owner.root, scope: state, context: { get: () => undefined }, assertCurrent: () => {
          if (this.#closed || state.disposed || context.signal.aborted) fail('CODE_STALE_SCOPE', 'Code evaluation ended.')
        } }, () => undefined)
        state.codeLease = { evaluationId: context.evaluationId, adapter }
        context.signal.addEventListener('abort', () => { void adapter.dispose().catch(() => {}) }, { once: true })
      }
      const value = await state.codeLease.adapter.request(method, args, context.signal)
      if (this.#closed || state.state !== 'EVALUATING' || state.worker.generation !== context.generation || context.signal.aborted) fail('STALE_RPC', 'Code evaluation is no longer current.')
      return value
    }
    if (method === 'recovery-select') {
      if (!this.options.decisionCall) fail('DECISION_UNAVAILABLE', 'Typed decision host is unavailable.')
      if (state.recovery?.evaluationId !== context.evaluationId || state.recovery.generation !== context.generation)
        state.recovery = new LispRecoverySession(context.generation, context.evaluationId)
      return state.recovery.select(args, context,
        (batch, scoped) => this.options.decisionCall!(state.owner, 'decisions-evaluate', batch, scoped), async () => {
          if (this.#closed || state.state !== 'EVALUATING' || !state.worker?.healthy || state.worker.generation !== context.generation || context.signal.aborted)
            fail('RECOVERY_STALE', 'Recovery evaluation ended.')
          const authority = await this.taskAuthority.authorizeEffect(state.owner)
          const uncertain = state.ownedJobs?.size || state.worker?.hasRunningJobs || await this.#store.database(db =>
            db.prepare("SELECT 1 FROM dsh_lisp_operations WHERE session_id=? AND state IN ('UNKNOWN','APPLYING','AWAITING_APPROVAL') LIMIT 1").get(state.owner.sessionId)
            || db.prepare("SELECT 1 FROM dsh_owned_operations WHERE run_id=? AND session_id=? AND state IN ('unknown','started') LIMIT 1").get(authority.taskId, state.owner.sessionId))
          if (uncertain) fail('RECOVERY_UNCERTAIN', 'Unresolved effects require receipt inspection; no restart was selected.')
        })
    }
    if (method === 'decisions-status' || method === 'decisions-evaluate') {
      if (!this.options.decisionCall) fail('DECISION_UNAVAILABLE', 'Typed decision host is unavailable.')
      if (method === 'decisions-status' && !z.object({}).strict().safeParse(args).success) fail('DECISION_INVALID_INPUT', 'Status takes no arguments.')
      const result = await this.options.decisionCall(state.owner, method, args, context)
      if (this.#closed || state.state !== 'EVALUATING' || state.worker.generation !== context.generation || context.signal.aborted) fail('STALE_RPC', 'Decision evaluation is no longer current.')
      return result
    }
    if (method === 'packages') {
      if (!this.options.packagesCall) fail('PACKAGES_UNAVAILABLE', 'Package host adapter is unavailable.')
      const request = PackageRequest.parse(args)
      if (request.kind === 'update') await this.taskAuthority.authorizeEffect(state.owner)
      if (request.kind === 'update' && (!state.currentVerification || state.packageBase))
        fail('PACKAGES_UPDATE_SCOPE', 'Use exactly one update-lockfiles call in a persistent lisp_eval; task calls cannot propose workspace updates.')
      const result = await this.options.packagesCall(state.owner, request, context.signal)
      if (request.kind === 'update') await this.taskAuthority.authorizeEffect(state.owner)
      if (this.#closed || state.state !== 'EVALUATING' || state.worker.generation !== context.generation || context.signal.aborted)
        fail('STALE_RPC', 'Package operation is no longer current.')
      if (result.base) state.packageBase = result.base
      return result.value
    }
    if (method === 'typesafe-status' || method === 'typesafe-evaluate') {
      if (!this.options.typesafeCall) fail('TYPESAFE_UNAVAILABLE', 'TypeSafe host adapter is unavailable.')
      if (method === 'typesafe-status' && !z.object({}).strict().safeParse(args).success) fail('TYPESAFE_INVALID_REQUEST', 'TypeSafe status takes no arguments.')
      const result = await this.options.typesafeCall(state.owner, method, args, context)
      if (this.#closed || state.state !== 'EVALUATING' || state.worker.generation !== context.generation || context.signal.aborted) fail('STALE_RPC', '現在の評価に属さない要求です。')
      return result
    }
    if (['run','start-job','job-status','cancel-job'].includes(method)) {
      if(!this.options.toolCall)fail('HOST_ADAPTER_UNAVAILABLE','Owned execution is unavailable.')
      if(method==='job-status'||method==='cancel-job') {
        const request=z.object({id:z.string().min(1)}).strict().parse(args)
        const value=await this.options.toolCall(state.owner,'kioku_result',{operationId:request.id,cancel:method==='cancel-job'},context.signal) as any
        if(value.receipt?.processStopped===true && ['completed','cancelled'].includes(value.receipt.state))state.ownedJobs?.delete(request.id)
        return value
      }
      const input=z.object({program:z.string().min(1),argv:z.array(z.string()),timeoutMs:z.number().int().positive(),directory:z.string().optional()}).strict().parse(args)
      const quote=(value:string)=>"'" + value.replaceAll("'", "'\\''") + "'"
      const directory=input.directory??'.'
      const native = this.taskAuthority.current()?.nativeCommands
      if (method === 'run' && native && this.#config.executionMode === 'development') {
        native.assertCurrent()
        return this.ownedDispatch(state, signal => native.run(input, AbortSignal.any([signal, context.signal])))
      }
      const lease = await this.taskAuthority.authorizeEffect(state.owner, 'owned')
      context.signal.throwIfAborted()
      const value=await this.ownedDispatch(state,signal=>this.options.toolCall!(state.owner,'kioku_exec',{command:[input.program,...input.argv].map(quote).join(' '),cwd:isAbsolute(directory)?directory:join(state.owner.root,directory),timeoutMs:input.timeoutMs,background:method==='start-job'},method==='start-job'?signal:AbortSignal.any([signal,context.signal]),`lisp-rpc:${context.generation}:${context.evaluationId}:${context.rpcId}`,lease)) as any
      // A launched job must remain cancellable even if task authority changed
      // while its start acknowledgement was in flight.
      this.retainOwned(state,value)
      await this.taskAuthority.authorizeEffect(state.owner, 'owned')
      if(method==='start-job')return value.receipt.operationId
      return {code:value.exitCode,stdout:value.output??'',stderr:'',receipt:value.receipt}
    }
    if (method === 'tools-list') return this.options.toolCatalog?.(state.owner)??[]
    if (method === 'tool-call') {
      const parsed = z.object({ name: z.enum(['lisp_status','kioku_read','kioku_write','kioku_edit','kioku_remove','kioku_exec','kioku_result']), args: z.record(z.string(),z.unknown()) }).strict().parse(args)
      if (!this.options.toolCall) fail('HOST_ADAPTER_UNAVAILABLE', 'このホストには監査済みアダプターがありません。')
      const lease = ['kioku_write','kioku_edit','kioku_remove','kioku_exec'].includes(parsed.name)
        ? await this.taskAuthority.authorizeEffect(state.owner, 'owned') : undefined
      context.signal.throwIfAborted()
      const result = await this.ownedDispatch(state,signal=>this.options.toolCall!(state.owner, parsed.name, parsed.args,parsed.name==='kioku_exec'&&parsed.args.background===true?signal:AbortSignal.any([signal,context.signal]),`lisp-rpc:${context.generation}:${context.evaluationId}:${context.rpcId}`,lease))
      if(parsed.name==='kioku_exec')this.retainOwned(state,result)
      if (lease) await this.taskAuthority.authorizeEffect(state.owner, 'owned')
      return result
    }
    if (method === 'ci-list-runs' || method === 'ci-failed-log' || method === 'ci-verify') {
      if (!this.options.ciCall) fail('HOST_ADAPTER_UNAVAILABLE', 'このホストには CI アダプターがありません。')
      const request: LispCiRequest = method === 'ci-list-runs'
        ? { kind: 'list-runs', ...z.object({ limit: z.number().int().min(1).max(20) }).strict().parse(args) }
        : method === 'ci-failed-log'
          ? { kind: 'failed-log', ...z.object({ runId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().parse(args) }
          : { kind: 'verify', ...z.object({ target: z.enum(['typecheck', 'lisp', 'test', 'build', 'package', 'vendor']), script: z.string().min(1).max(256).optional(),
            directory: z.string().min(1).max(4096).optional(), location: z.enum(['workspace', 'scratch']).optional() }).strict().parse(args) }
      const active = [...state.active]
      if (active.length !== 1) fail('HOST_STATE', 'CI 呼び出しの実行主体を一意に確認できません。')
      // This authority check precedes the CI adapter; a refusal proves no dispatch.
      if (request.kind === 'verify') await this.taskAuthority.authorizeEffect(state.owner).catch(managedAdmissionDenied)
      context.signal.throwIfAborted()
      const result = await this.options.ciCall(state.owner, request, active[0]!.signal, state.worker.layout.scratch)
      if(request.kind==='verify')this.retainOwned(state,result)
      if (request.kind === 'verify') await this.taskAuthority.authorizeEffect(state.owner)
      if (request.kind === 'verify' && state.currentVerification?.generation === context.generation) {
        state.currentVerification.results.push({ request, result })
      }
      return result
    }
    if (method === 'artifact') {
      const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(args)
      const root = join(this.options.dataRoot, 'artifacts')
      const source = await snapshot(state.worker.layout.scratch, path, [])
      if (!source.exists) fail('ARTIFACT_MISSING', '成果物がありません。')
      const reservation = source.size ?? 0
      this.#artifactReserved += reservation
      try {
      if (await backupUsage(root) + this.#artifactReserved > 1024 ** 3) fail('ARTIFACT_LIMIT', '成果物の保存上限です。')
      if (await this.#store.countByKind(state.owner.sessionId, 'artifact') >= 1000) fail('ARTIFACT_LIMIT', 'このセッションの成果物数が上限です。')
      const id = `artifact-${randomUUID()}`, target = join(root, id)
      await this.taskAuthority.authorizeEffect(state.owner)
      await this.#store.reserve(state.owner, id, 'artifact', digest(source), state.worker.generation, { source, target })
      const bytes = await checkedBytes(source)
      await this.taskAuthority.authorizeEffect(state.owner)
      const file = await open(target, 'wx', 0o600)
      try { await this.taskAuthority.authorizeEffect(state.owner); await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      const result = { id, size: source.size, hash: source.hash, path: target, appliedToProject: false }
      await this.#store.transition(state.owner, id, ['RUNNING'], 'SUCCEEDED', result)
      return result
      } finally { this.#artifactReserved -= reservation }
    }
    fail('UNKNOWN_ADAPTER', 'このホスト要求には対応していません。')
  }
  /** Session-local process evidence only; observing it never creates or wakes a worker. */
  taskJobsIdle(owner: LispOwner): boolean {
    if (this.#closed) return false
    const root = this.enabled.get(owner.sessionId)
    if (root !== undefined && root !== owner.root) return false
    for (const state of this.#agents.values()) {
      if (state.owner.sessionId !== owner.sessionId) continue
      if (state.owner.root !== owner.root || state.state === 'STOPPING' || state.state === 'STOP_UNCONFIRMED') return false
      if (state.ownedJobs?.size || state.ownedCalls?.size) return false
      if (state.worker && (!state.worker.jobsIdle || (!state.worker.healthy && !state.worker.stopped))) return false
    }
    return true
  }
  private managedUnresolved(owner: LispOwner): Promise<{operations:Array<{id:string;scopeId:string;route:string;kind:string;state:string;originalRef?:string}>;total:number;unknownCount:number;unknownOperations:Array<{id:string;scopeId:string;route:string;kind:string;state:string;originalRef?:string}>;truncated:boolean}> {
    return this.#store.database(db => {
      // Safety decisions use the full set, never the bounded diagnostic page.
      const counts = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN o.state='unknown' THEN 1 ELSE 0 END),0) AS unknown_count
        FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
        WHERE json_extract(s.scope_json,'$.sessionId')=? AND o.state IN ('unknown','dispatching','running','prepared')`)
        .get<{total:number;unknown_count:number}>(owner.sessionId)!
      const project = (row: {operation_json:string}) => {
        const value=JSON.parse(row.operation_json)
        return {id:value.operationId,scopeId:value.scopeId,route:value.route,kind:value.kind,state:value.state,...(value.originalRef?{originalRef:value.originalRef}:{})}
      }
      const operations = db.prepare(`SELECT o.operation_json FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
        WHERE json_extract(s.scope_json,'$.sessionId')=? AND o.state IN ('unknown','dispatching','running','prepared') ORDER BY o.rowid DESC LIMIT 100`)
        .all<{operation_json:string}>(owner.sessionId).map(project)
      // A compact human view must still identify an old unknown pushed off the diagnostic page.
      const unknownOperations = counts.unknown_count ? db.prepare(`SELECT o.operation_json FROM dsh_managed_operations o
        JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
        WHERE json_extract(s.scope_json,'$.sessionId')=? AND o.state='unknown' ORDER BY o.rowid DESC LIMIT 3`)
        .all<{operation_json:string}>(owner.sessionId).map(project) : []
      return {operations,total:counts.total,unknownCount:counts.unknown_count,unknownOperations,truncated:counts.total>operations.length}
    })
  }
  async status(owner: LispOwner, offset?: number): Promise<unknown> {
    const policy = (this.options.questions as ApprovalQuestions | undefined)?.approvalPolicy
    const approval = { mode: policy?.mode() ?? this.#config.approvalMode, scope: 'profile', writable: policy?.writable() ?? false }
    if (!this.enabled.has(owner.sessionId)) return { approval, enabled: false, state: 'DISABLED', recovery: '/kioku-lisp enable' }
    const state = this.entry(owner)
    const taskMode = await this.isTaskMode(owner)
    const managed = await this.managedUnresolved(owner)
    const managedOperations = managed.operations
    const managedReconciliation = managed.unknownCount > 0
    const unconfirmed = [...this.#agents.values()].find(s => s.owner.sessionId === owner.sessionId && s.state === 'STOP_UNCONFIRMED')
    if (state.state === 'READY' && !state.worker?.healthy) this.halted(state, new LispError('WORKER_EXITED', 'Lisp が終了しています。新しい Lisp の起動前に状態を確認してください。'))
    const summary = await this.#store.operationSummaries(owner.sessionId, offset)
    const taskSummary = taskMode ? await this.#store.taskSummary(owner) : undefined
    const operations = summary.operations.map(o => ({ id: o.operation_id, agent: o.agent_id, kind: o.kind, state: o.state, updatedAt: o.updated_at }))
    return { approval, enabled: true, managedOperations, managedUnknownOperations:managed.unknownOperations, managedOperationCount:managed.total, managedOperationsTruncated:managed.truncated, managedReconciliationRequired:managedReconciliation, state: managedReconciliation ? 'RECONCILIATION_REQUIRED' : unconfirmed ? 'STOP_UNCONFIRMED' : taskMode && state.state === 'RECOVERY_REQUIRED' && !state.worker ? 'TASK_READY' : state.state,
      generation: state.worker?.generation ?? null, supervisorPid: state.worker?.supervisorPid ?? null,
      runtimePid: state.worker?.runtimePid ?? null, repositoryRoot:state.worker?.repositoryRoot ?? null,
      owner:{hostPid:process.pid,sessionId:owner.sessionId,agentId:owner.agentId},
      error: unconfirmed?.error ?? (taskMode && !state.worker ? null : state.error ?? null),
      jobs: [...(state.worker?.jobStatus() ?? []),...[...state.ownedJobs??[]].map(operationId=>({operationId,owner:'kiokuko-execution'}))],
      executionMode:this.#config.executionMode,
      compilation: state.compilation ?? null, resumed: state.resumed ?? false,
      limits: { timeoutMs: this.#config.timeoutMs, maxOutputBytes: this.#config.maxOutputBytes, maxWorkers: this.#config.maxWorkers, idleTimeoutMs: this.#config.idleTimeoutMs,
        aggregateMemory: 'unavailable', aggregateCpu: 'unavailable', scratchQuota: 'unavailable', termination: 'supervised', fileBoundary: this.#config.executionMode==='development'?'normal-user-environment':process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap' },
      operations, operationCount: summary.count, pendingCount: Object.values(summary.pendingStates).reduce((a,b) => a+b,0), pendingStates: summary.pendingStates,
      ...(taskSummary ? { task: taskSummary } : {}),
      hot: await this.#hot.status(owner),
      ...(offset === undefined ? {} : { offset, nextOffset: offset + 10 < summary.count ? offset + 10 : null }),
      recovery: managedReconciliation ? 'Managed operations remain unresolved. Inspect the listed operation IDs and original receipts; restarting or abandoning Lisp does not reconcile external effects.' : unconfirmed ? '停止と操作記録を照合してください。自動再実行しません。' : taskMode && !state.worker ? null : state.state === 'SUSPENDED' ? 'Lisp は休止中です。次の利用時に自動起動します。変数・関数定義は保持されません。' : state.state === 'READY' ? null : '停止理由と操作履歴を確認し、/kioku-lisp recover を実行してください。' }
  }
  async diagnostics(owner: LispOwner, id?: string): Promise<unknown> {
    this.entry(owner)
    if (id) {
      const operation = await this.#store.get(owner, identifier.parse(id))
      if (!operation) {
        const managed = await this.#store.database(db => db.prepare(`SELECT o.operation_json FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
          WHERE o.operation_id=? AND json_extract(s.scope_json,'$.sessionId')=?`).get<{operation_json:string}>(id,owner.sessionId))
        if (managed) { const value=JSON.parse(managed.operation_json);return {operationId:value.operationId,scopeId:value.scopeId,parentId:value.parentId,route:value.route,kind:value.kind,state:value.state,originalRef:value.originalRef??null,cause:value.cause??null,delivery:value.delivery} }
        fail('UNKNOWN_OPERATION', 'この主体の操作記録がありません。')
      }
      return { ...operation, payload: JSON.parse(operation.payload), result: operation.result ? JSON.parse(operation.result) : null }
    }
    const operations = await this.#store.operations(owner.sessionId)
    return { ...await this.status(owner) as object,
      changes: operations.filter(o => o.kind === 'proposal').slice(0, 100).map(o => ({ id: o.operation_id, state: o.state, details: JSON.parse(o.payload), result: o.result ? JSON.parse(o.result) : null })),
      inspect: '/kioku-lisp diagnostics OPERATION_ID で各操作の全内容を確認できます。' }
  }
  execute(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal, nativeCommands?: LispNativeCommands): Promise<unknown> {
    const key = typeof input.operationId === 'string' ? JSON.stringify([owner.sessionId, owner.agentId, input.operationId]) : undefined
    const hash = digest({ tool, input }), pending = key ? this.#inflight.get(key) : undefined
    if (pending) return Promise.resolve(pending === hash ? { replay: true, code: 'IN_PROGRESS', state: 'RUNNING' } : failure(new LispError('ID_CONFLICT', '実行中の操作 ID に異なる入力があります。')))
    if (key) this.#inflight.set(key, hash)
    const result = this.taskAuthority.run(owner, () => this.dispatch(owner, tool, input, signal), nativeCommands).catch(error => failure(error))
    this.#executions.set(result, owner.sessionId)
    const finished = () => {
      this.#executions.delete(result); if (key) this.#inflight.delete(key)
      const state = this.#agents.get(JSON.stringify([owner.sessionId, owner.agentId]))
      if (tool !== 'lisp_status' && state && state.owner.root === owner.root && this.enabled.get(owner.sessionId) === owner.root) this.scheduleIdle(state)
    }
    void result.then(finished, finished)
    return result
  }
  private async dispatch(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      if (tool === 'lisp_status') return await this.status(owner, z.number().int().nonnegative().parse(input.offset ?? 0))
      const state = this.entry(owner)
      if(!['lisp_hot_status','lisp_inspect','lisp_cancel'].includes(tool))await this.authorizeCodingTask(owner)
      if (tool === 'lisp_cancel') await this.claimSession(owner)
      if (tool === 'lisp_inspect') {
        try { await this.claimSession(owner) }
        catch (error) { if (!(error instanceof LispError) || error.code !== 'SESSION_IN_USE') throw error }
      }
      if (tool === 'lisp_hot_status') return await this.#hot.status(owner, input)
      if (tool === 'lisp_describe' && typeof input.toolRef === 'string') {
        const { source: _source, ...manifest } = await this.#taskTools.get(owner, input.toolRef)
        return { ok: true, manifest }
      }
      if (tool === 'lisp_describe' && !input.symbol && await this.isTaskMode(owner)) return {
        ok: true, state: 'TASK_READY', api: {
          define: 'lisp_define saves one lambda, exact dependency refs and bounded JSON schemas.',
          call: 'lisp_call accepts JSON input or a saved resultRef; fields selects bounded JSON pointers.',
          observe: 'lisp_observe copies explicit workspace paths to a saved inputRef without returning bodies.',
          stage: 'lisp_stage freezes a generated proposal against an observed baseRef without writing the workspace.',
          verify: 'lisp_verify materializes exact observed bytes and one candidate in private scratch before approved host verification. testStatus stays unknown without a reporter.',
          apply: 'lisp_apply uses the existing approval path, rechecks the read set and rejects a verificationRef for another candidate.',
          compare: 'lisp_compare reports two candidates\' common base and per-path intent hashes without executing them.',
          inspect: 'lisp_inspect pages saved results without re-executing them.',
          eval: 'lisp_eval is a disposable scratch experiment; inputs and proposals are unavailable.',
          hot: 'lisp_hot_contract authorizes schemas through the current profile approval policy and finite input/expected cases. lisp_hot_install validates and atomically selects immutable code by name for this project. lisp_hot_call pins the active version. lisp_hot_status reads revisions; lisp_hot_deactivate uses the current profile approval policy to stop new calls. Results remain session/agent-local.',
        } }
      if (tool === 'lisp_describe' && !input.symbol) return { ok: true, source: 'bundled', state: state.state,
        packages: ['kioku.tools', 'kioku.process', 'kioku.files', 'kioku.data', 'kioku.objects', 'kioku.environment', 'kioku.ci', 'kioku.packages', 'kioku.typesafe', 'kioku.decisions', 'kioku.recovery', 'kioku.code'],
        api: { recovery: 'In an explicit handler-bind, call kioku.recovery:select-restart with the condition, selected JSON state and 1-8 (restart-symbol description) pairs. The configured decision provider selects one zero-argument restart on the live stack, at most 4 times per evaluation and 30 seconds per choice. Working task required; abstention/errors abort; no expression replay. Protected disposable task workers deny RPC.', code: 'kioku.code:capabilities, open, outline, enclosing, query, span, semantic, release, with-snapshot. Read-only disk snapshots; handles expire at evaluation end. Check status before using data.', packages: 'kioku.packages:metadata, audit and update-lockfiles use an approval-gated public npm broker. Updates generate in protected scratch and propose frozen files, never install dependencies or write the repository directly.', scratch: '(kioku.files:scratch) takes no arguments', splitLines: 'kioku.process:split-lines returns a vector; use loop across',
          decisions: '(kioku.decisions:status), evaluate, assess-relevance, classify-failure, assess-change. Consume selected/abstained results; ordinary reasoning on fallback, cancellation is terminal.',
          typesafe: '(kioku.typesafe:status); (kioku.typesafe:evaluate state questions :model "jev-latest" :timeout-ms 30000). Explicit semantic decisions via the host; consume answers with gethash. Strings/hash tables/vectors use JSON conventions. Catch kioku.typesafe:service-error; no retries or approval bypass. Configure with /kioku-typesafe-key.',
          describe: 'symbol="kioku.files" lists bundled exports; symbol="kioku.user" lists your task functions; an exact function name returns arguments/docs.',
          workflow: 'Define task-specific defun helpers once, compose them into one useful operation, and call that function in later evaluations. Batch known reads and checks; return a compact result. Definitions last for this worker generation. Stop before decisions requiring new evidence or approval.',
          hot: 'Use lisp_hot_contract, lisp_hot_install and lisp_hot_call for approved project-shared functions. The exact owner reuses this worker with a fresh package, private result scratch and no host RPC. Other owners cannot borrow it. This is not heap security isolation; write pure functions with explicit dependencies. No mode switch is needed. lisp_hot_status reads active versions.',
          run: '(kioku.process:run "node" (list "--test" "--experimental-test-isolation=none" "test/public.test.mjs") :directory "project") uses a project-relative directory in development mode (scratch-relative in protected mode). Check final receipts and result-code.',
          inspect: 'lisp_inspect accepts ref, or resultOperationId with section/offset/limit (Unicode characters). Never rerun to retrieve output.',
          reads: 'Use native read/glob/grep/skill for repository exploration; lisp_eval.inputs for read-only workspace or session-attachment copies.',
          verify: '(kioku.ci:verify :test :script "test:unit") runs a focused npm script. For an extracted project: (kioku.ci:verify :test :location :scratch :directory "extract/project"). Uses the current profile approval policy and runs the actual npm command.' },
        verifiers: await describeVerifiers(owner) }
      if (tool === 'lisp_inspect' && input.resultOperationId !== undefined) {
        if (input.ref !== undefined) throw new LispError('INVALID_INSPECTION', 'ref と resultOperationId は同時に指定できません。', 'どちらか一つを指定してください。')
        return await inspectSavedResult(this.#store, owner, { resultOperationId: identifier.parse(input.resultOperationId),
          ...(input.section === undefined ? {} : { section: input.section as 'result' }),
          ...(input.pointer === undefined ? {} : { pointer: input.pointer as string }),
          ...(input.offset === undefined ? {} : { offset: input.offset as number }), ...(input.limit === undefined ? {} : { limit: input.limit as number }) })
      }
      if (tool === 'lisp_inspect' && [input.pointer, input.section, input.offset, input.limit].some(value => value !== undefined)) {
        throw new LispError('INVALID_INSPECTION', '範囲や項目の指定には resultOperationId が必要です。', 'ref による取得とは分けて指定してください。')
      }
      if (tool === 'lisp_cancel') {
        if (await this.isTaskMode(owner)) {
          await this.stopTaskWorkers(owner.sessionId)
          return { ok: true, state: 'TASK_READY' }
        }
        if (input.operationId !== undefined) {
          const id = identifier.parse(input.operationId), hash = digest(input), old = await this.#store.get(owner, id)
          if (old) { if (old.kind !== tool || old.digest !== hash) fail('ID_CONFLICT', '取消 ID の内容が異なります。'); return await this.replay(owner, old) }
          if (input.generation !== state.worker?.generation) fail('STALE_GENERATION', '取消対象の Lisp 世代は現在のものではありません。')
          await this.#store.reserve(owner, id, tool, hash, state.worker!.generation, input)
          await this.stopTaskWorkers(owner.sessionId)
          await this.cancel(state)
          const result = { ok: true, state: state.state }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        }
        await this.stopTaskWorkers(owner.sessionId)
        await this.cancel(state); return { ok: true, state: state.state }
      }
      if (this.#closed || state.disposed) fail('HOST_STOPPED', 'Lisp のホストまたはセッションが停止しています。')
      const id = identifier.parse(input.operationId)
      const hash = digest({ tool, input })
      const old = await this.#store.get(owner, id)
      if (old) {
        if (old.digest !== hash || old.kind !== tool) fail('ID_CONFLICT', '同じ操作 ID の内容を変えることはできません。')
        return await this.replay(owner, old)
      }
      if (tool.startsWith('lisp_hot_')) return await this.#hot.execute(owner, tool as HotMutation, id, hash,
        Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')), signal)
      if (tool === 'lisp_define' || tool === 'lisp_call' || tool === 'lisp_observe') {
        if (!await this.isTaskMode(owner)) fail('TASK_MODE_REQUIRED', '作業用ツールには /kioku-lisp enable-task を使用してください。')
        if (tool === 'lisp_observe') {
          const request = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(100), format: z.enum(['text', 'json']).default('text') }).strict()
            .parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
          if (new Set(request.paths).size !== request.paths.length) fail('INPUT_DUPLICATE', '同じ入力pathが複数あります。')
          const items: Array<{ path: string; digest: string; content: unknown }> = []
          const frozenBytes: Array<{ path: string; digest: string; base64: string }> = []
          const snapshots = []
          let totalBytes = 0
          for (const path of request.paths) {
            signal?.throwIfAborted()
            const source = await snapshot(owner.root, path, this.protectedRoots())
            if (!source.exists) fail('INPUT_MISSING', `入力ファイルがありません: ${path}`)
            snapshots.push(source)
            const bytes = await checkedBytes(source)
            totalBytes += bytes.length
            if (totalBytes > 64 * 1024 * 1024) fail('INPUT_LIMIT', '観測する入力が 64 MiB を超えます。')
            let decoded: string
            try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
            catch { fail('INPUT_ENCODING', '観測入力は正しい UTF-8 テキストである必要があります。') }
            const content: unknown = request.format === 'json' ? JSON.parse(decoded) : decoded
            const bytesDigest = createHash('sha256').update(bytes).digest('hex')
            items.push({ path, digest: bytesDigest, content })
            frozenBytes.push({ path, digest: bytesDigest, base64: bytes.toString('base64') })
          }
          const value = { items, coverage: { complete: true, returned: items.length, total: items.length }, consistency: 'checked' }
          const ref = randomUUID()
          await this.#store.reserve(owner, id, tool, hash, 'host', { request, policyVersion: 3 })
          await this.#store.reserve(owner, ref, 'task_result', digest(value), 'host', { source: 'workspace.observe', operationId: id,
            sourceRefs: [ref], snapshots, frozenBytes })
          await this.#store.transition(owner, ref, ['RUNNING'], 'SUCCEEDED', { value })
          const result = { ok: true, operationId: id, resultRef: ref, coverage: value.coverage, consistency: value.consistency,
            items: items.map(({ path, digest: bytesDigest }) => ({ path, digest: bytesDigest })) }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        }
        if (tool === 'lisp_define') {
          const definition = DefineInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
          const code = await this.#taskTools.executable(owner, definition)
          await this.#store.reserve(owner, id, tool, hash, 'host', { name: definition.name, sourceDigest: digest(definition.source), policyVersion: 3 })
          try {
            await this.runTask(owner, code, null, signal, 'compile')
            for (const example of definition.examples) {
              validateValue(definition.inputSchema, example.input)
              const checked = await this.runTask(owner, code, example.input, signal)
              validateValue(definition.outputSchema, checked.value)
              if (digest(checked.value) !== digest(example.expected)) fail('TASK_EXAMPLE_FAILED', 'Generated tool failed a declared example.')
            }
            let firstResult: unknown
            if (definition.firstInput !== undefined) {
              validateValue(definition.inputSchema, definition.firstInput)
              const first = await this.runTask(owner, code, definition.firstInput, signal)
              validateValue(definition.outputSchema, first.value)
              firstResult = first.value
            }
            const artifact = await this.#taskTools.save(owner, definition)
            const response: Record<string, unknown> = { ok: true, toolRef: artifact.toolRef, checks: artifact.checks }
            if (definition.firstInput !== undefined) {
              const ref = randomUUID()
              await this.#store.reserve(owner, ref, 'task_result', digest(firstResult), 'host', { toolRef: artifact.toolRef, operationId: id })
              await this.#store.transition(owner, ref, ['RUNNING'], 'SUCCEEDED', { value: firstResult })
              response.firstResultRef = ref
              response.firstResult = Buffer.byteLength(JSON.stringify(firstResult)) <= 8192 ? firstResult : { omitted: true, resultRef: ref }
            }
            await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', response)
            return response
          } catch (error) {
            const problem = failure(error)
            await this.#store.transition(owner, id, ['RUNNING'], problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : 'FAILED', problem)
            return problem
          }
        }
        const call = CallInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
        const artifact = await this.#taskTools.get(owner, call.toolRef)
        const data = call.inputRef ? await this.taskResult(owner, call.inputRef) : call.input
        validateValue(artifact.inputSchema, data)
        const code = await this.#taskTools.executable(owner, artifact)
        await this.#store.reserve(owner, id, tool, hash, 'host', { toolRef: artifact.toolRef, inputDigest: digest(data), policyVersion: 3 })
        try {
          const executed = await this.runTask(owner, code, data, signal)
          validateValue(artifact.outputSchema, executed.value)
          const ref = randomUUID()
          const source = call.inputRef ? await this.#store.get(owner, call.inputRef) : undefined
          const lineage = source ? JSON.parse(source.payload) as { sourceRefs?: string[] } : undefined
          await this.#store.reserve(owner, ref, 'task_result', digest(executed.value), 'host', { toolRef: artifact.toolRef, operationId: id,
            sourceRefs: call.inputRef ? [...new Set([call.inputRef, ...(lineage?.sourceRefs ?? [])])] : [] })
          await this.#store.transition(owner, ref, ['RUNNING'], 'SUCCEEDED', { value: executed.value })
          const response = { ok: true, operationId: id, resultRef: ref,
            value: call.fields?.length ? selectFields(executed.value, call.fields, ref) : executed.value,
            output: executed.output, generation: executed.generation }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', response)
          return response
        } catch (error) {
          const problem = failure(error)
          await this.#store.transition(owner, id, ['RUNNING'], problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : 'FAILED', problem)
          return problem
        }
      }
      if (tool === 'lisp_stage' || tool === 'lisp_verify' || tool === 'lisp_apply' || tool === 'lisp_compare') {
        if (!await this.isTaskMode(owner)) fail('TASK_MODE_REQUIRED', '候補操作には作業用ツール形態が必要です。')
        if (tool === 'lisp_compare') {
          const request = CompareInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
          const result = { ok: true, ...await compareCandidates(owner, this.#store, request.leftRef, request.rightRef) }
          await this.#store.reserve(owner, id, tool, hash, 'host', request)
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        }
        if (tool === 'lisp_stage') {
          const request = StageInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
          const candidate = await candidateFromResult(owner, this.#store, request.resultRef, request.baseRef, this.protectedRoots())
          await this.#store.reserve(owner, id, tool, hash, 'host', { resultRef: request.resultRef, baseRef: request.baseRef })
          try {
            const staged = await stageCandidate(owner, this.#store, candidate)
            const result = { ok: true, ...staged, verification: 'not-run' }
            await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
            return result
          } catch (error) {
            const problem = failure(error)
            await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', problem)
            return problem
          }
        }
        if (tool === 'lisp_verify') {
          const request = VerifyInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
          const candidate = await loadCandidate(owner, this.#store, request.candidateRef)
          if (!this.options.ciCall) fail('HOST_ADAPTER_UNAVAILABLE', 'このホストには検証アダプターがありません。')
          await this.#store.reserve(owner, id, tool, hash, 'host', { ...request, candidateDigest: digest(candidate) })
          let scratchRoot: string | undefined
          try {
            await this.taskAuthority.authorizeEffect(owner)
            scratchRoot = await materializeCandidate(owner, this.#store, candidate, this.options.dataRoot)
            await this.taskAuthority.authorizeEffect(owner)
            const execution = await this.options.ciCall(owner, { kind: 'verify', target: request.target,
              ...(request.script ? { script: request.script } : {}), location: 'scratch', directory: '.' },
              signal ?? new AbortController().signal, scratchRoot)
            const recorded = { candidateRef: request.candidateRef, candidateDigest: digest(candidate), execution,
              testStatus: 'unknown', independent: true }
            await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', recorded)
            const command = execution && typeof execution === 'object' ? execution as { state?: string; code?: number; reason?: string } : {}
            return { ok: command.state === 'SUCCEEDED' && command.code === 0, operationId: id,
              candidateRef: request.candidateRef, commandState: command.state ?? 'unknown', exitCode: command.code ?? null,
              reason: command.reason ?? null, testStatus: 'unknown', logOperationId: id }
          } catch (error) {
            const problem = failure(error)
            await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', problem)
            return problem
          } finally { if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }) }
        }
        const request = ApplyInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')))
        const candidate = await loadCandidate(owner, this.#store, request.candidateRef)
        const verification = request.verificationRef ? await loadVerification(owner, this.#store, request.verificationRef, request.candidateRef, candidate)
          : { commandState: 'not-run', testStatus: 'not-run' }
        await this.#store.reserve(owner, id, tool, hash, 'host', { candidateRef: request.candidateRef })
        let claimed = false
        try {
          await this.#store.transition(owner, request.candidateRef, ['STAGED'], 'APPLYING', { applyOperationId: id }); claimed = true
          const outcomes = await this.#proposals.apply(owner, id, 'task', candidate.changes, signal ?? new AbortController().signal,
            undefined, { readSet: candidate.readSet, targets: candidate.targets })
          const applied = outcomes.every(change => ['APPLIED', 'UNCHANGED'].includes(change.state))
          const untouched = outcomes.every(change => ['NOT_APPLIED', 'UNCHANGED'].includes(change.state))
          const candidateState = applied ? 'APPLIED' : untouched ? 'STAGED' : 'UNKNOWN'
          const result = { ok: applied, candidateRef: request.candidateRef, state: candidateState, verification, changes: outcomes }
          await this.#store.transition(owner, request.candidateRef, ['APPLYING'], candidateState, result)
          await this.#store.transition(owner, id, ['RUNNING'], candidateState === 'UNKNOWN' ? 'UNKNOWN' : applied ? 'SUCCEEDED' : 'FAILED', result)
          return result
        } catch (error) {
          const problem = failure(error)
          if (claimed) {
            try { await this.#store.transition(owner, request.candidateRef, ['APPLYING'], 'UNKNOWN', problem) } catch { /* Keep existing journal state for recovery. */ }
          }
          try { await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', problem) } catch { /* Existing RUNNING is still not success. */ }
          return problem
        }
      }
      if (await this.isTaskMode(owner)) {
        if (tool !== 'lisp_eval') fail('TASK_MODE_UNSUPPORTED', 'この実行形態では lisp_define、lisp_call、lisp_observe、保存結果の参照を使用してください。')
        const evaluation = EvalInput.parse({ code: input.code, timeoutMs: input.timeoutMs, inputs: input.inputs ?? [] })
        if (evaluation.inputs.length) fail('TASK_MODE_INPUT', '作業用ツール形態の一回限り評価では lisp_observe と inputRef を使用してください。')
        await this.#store.reserve(owner, id, tool, hash, 'host', { codeDigest: digest(evaluation.code), policyVersion: 3 })
        try {
          const executed = await this.runTask(owner, evaluation.code, null, signal, 'eval')
          const result = { ok: true, operationId: id, value: executed.value, output: executed.output, generation: executed.generation }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        } catch (error) {
          const problem = failure(error)
          await this.#store.transition(owner, id, ['RUNNING'], problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : 'FAILED', problem)
          return problem
        }
      }
      if (state.suspension || state.state === 'SUSPENDED') {
        const prepared = await this.prepare(owner) as { state: string }
        if (prepared.state !== 'READY') fail('RECOVERY_REQUIRED', 'Lisp の停止状態を確認してください。')
        return { ok: false, code: 'WORKER_RESUMED', generation: state.worker?.generation, executed: false,
          message: '休止中の Lisp を自動起動しました。以前の変数・関数・参照は失われています。必要な定義を作り直してから実行してください。この要求のコードは実行していません。過去の副作用を再実行しないでください。' }
      }
      if (tool === 'lisp_reset') {
        await this.taskAuthority.authorizeEffect(owner)
        if (state.state !== 'READY') fail('RECOVERY_REQUIRED', '異常停止からの再開には /kioku-lisp recover を使ってください。')
        await this.#store.reserve(owner, id, tool, hash, state.worker?.generation ?? '', input)
        try {
          await this.cancel(state); await this.startWorker(state)
          const result = { ok: true, generation: state.worker!.generation }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        } catch (error) { await this.cancel(state); this.halted(state, error); throw error }
      }
      if (state.state !== 'READY') fail(state.state === 'EVALUATING' ? 'BUSY' : 'RECOVERY_REQUIRED', 'Lisp は実行可能な状態ではありません。/kioku-lisp status で確認してください。')
      const worker = state.worker!
      state.state = 'EVALUATING' // reserve the slot before the first await
      state.execution = this.taskAuthority.current()
      const abort = new AbortController(); state.active.add(abort)
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
      let reserved = false
      let evidence: Record<string, unknown> | undefined
      try {
        let args: Record<string, unknown>, timeout = this.#config.timeoutMs
        const payload: Record<string, unknown> = { request: input, policyVersion: 2 }
        if (tool === 'lisp_eval') {
          const parsed = EvalInput.parse({ code: input.code, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), inputs: input.inputs ?? [] })
          timeout = parsed.timeoutMs ?? timeout
          const inputs: string[] = []
          const snapshots = []
          const sources = []
          for (const path of parsed.inputs) {
            if (isAbsolute(path) && this.options.attachmentInput) {
              sources.push(this.options.attachmentInput(owner, path, combined))
              continue
            }
            const before = await snapshot(owner.root, path, this.protectedRoots())
            if (!before.exists) throw new LispError('INPUT_MISSING', `入力ファイルがありません: ${path}`, 'read/glob で対象パスを確認し、inputs を修正してください。Lisp の復旧は不要です。')
            sources.push({ source: before, size: before.size!, read: () => checkedBytes(before) })
          }
          if ((state.inputBytes ?? 0) + sources.reduce((sum, input) => sum + input.size, 0) > 256 * 1024 ** 2) fail('INPUT_LIMIT', 'この Lisp 世代の入力コピーが 256 MiB を超えます。状態を確認して reset してください。')
          for (const source of sources) {
            combined.throwIfAborted()
            const bytes = await source.read()
            combined.throwIfAborted()
            state.inputBytes = (state.inputBytes ?? 0) + source.size
            const target = join(worker.layout.inputs, randomUUID())
            await writeFile(target, bytes, { flag: 'wx', mode: 0o400 }); inputs.push(target)
            snapshots.push({ source: source.source, input: target })
          }
          payload.snapshots = snapshots
          args = { code: parsed.code, inputs }
        } else args = tool === 'lisp_describe' ? { symbol: typeof input.symbol === 'string' ? input.symbol : '' } : { ref: identifier.parse(input.ref) }
        await this.#store.reserve(owner, id, tool, hash, worker.generation, payload); reserved = true
        if (tool === 'lisp_eval') state.currentVerification = { operationId: id, generation: worker.generation, results: [] }
        const response = await this.journalRequest(state, worker, tool === 'lisp_eval' ? 'eval' : tool === 'lisp_describe' ? 'describe' : 'inspect', args, timeout, combined)
        const result = { ok: response.ok, operationId: id, value: response.value, output: worker.output(), generation: worker.generation, proposals: response.proposals }
        evidence = { ...result, state: response.ok ? 'RUNNING' : 'FAILED' }
        await this.#store.transition(owner, id, ['RUNNING'], response.ok ? 'RUNNING' : 'FAILED', evidence)
        if (!response.ok) { state.state = 'READY'; return result }
        const applied = await this.#proposals.apply(owner, id, worker.generation, response.proposals, combined, undefined, state.packageBase)
        const uncertain = applied.some(change => change.state === 'UNKNOWN')
        if (uncertain) { await worker.stop(); this.halted(state, new LispError('RECONCILIATION_REQUIRED', '変更結果が未確定です。記録とバックアップを照合してください。')) }
        else if (state.state === 'EVALUATING') state.state = 'READY'
        const complete = applied.every(change => change.state === 'APPLIED' || change.state === 'UNCHANGED')
        const finished = { ...result, ok: complete, state: uncertain ? 'UNKNOWN' : complete ? 'SUCCEEDED' : 'FAILED', changes: applied }
        evidence = finished
        await this.#store.transition(owner, id, ['RUNNING'], finished.state, finished)
        if (finished.state === 'SUCCEEDED' && response.proposals.length === 0 && this.options.verifiedCall
          && state.currentVerification?.operationId === id && state.currentVerification.generation === worker.generation) {
          for (const verified of state.currentVerification.results) {
            try { await this.options.verifiedCall(owner, id, worker.generation, verified.request, verified.result) }
            catch { /* Proof is optional; a failed observation cannot change the Lisp operation's durable result. */ }
          }
        }
        return finished
      } catch (error) {
        let outcome: Record<string, unknown> = { ...(reserved ? { output: worker.output(), generation: worker.generation } : {}), ...evidence, ...failure(error), operationId: id, state: reserved ? 'UNKNOWN' : 'FAILED' }
        if (reserved) {
          // Close admission before attempting a potentially failing journal write.
          state.state = 'STOPPING'
          try { await worker.stop() } catch (stop) { outcome = { ...outcome, stopFailure: failure(stop) }; error = stop }
          this.halted(state, error)
          try {
            const current = await this.#store.get(owner, id)
            if (current?.state === 'RUNNING') await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', outcome)
          } catch (journal) { outcome = { ...outcome, journalFailure: failure(journal) }; this.halted(state, journal) }
        } else if (!worker.healthy) { try { await worker.stop() } catch (stop) { error = stop }; this.halted(state, error) }
        else if (state.state === 'EVALUATING') state.state = 'READY'
        return outcome
      } finally { await state.codeLease?.adapter.dispose(); delete state.codeLease; state.active.delete(abort); delete state.packageBase; if (state.currentVerification?.operationId === id) delete state.currentVerification }
    } catch (error) { return failure(error) }
  }
  private async taskResult(owner: LispOwner, ref: string): Promise<unknown> {
    const row = await this.#store.get(owner, ref)
    if (!row || row.kind !== 'task_result' || row.state !== 'SUCCEEDED' || !row.result) fail('TASK_RESULT_MISSING', '保存結果がありません。')
    if (Date.now() - Date.parse(row.updated_at) > 30 * 86400_000) fail('TASK_RESULT_EXPIRED', '保存結果の期限が切れました。')
    const value = (JSON.parse(row.result) as { value: unknown }).value
    if (digest(value) !== row.digest) fail('TASK_RESULT_CORRUPT', '保存結果が変化しました。')
    return value
  }
  private async replay(owner: LispOwner, old: import('./store.js').Operation): Promise<unknown> {
    return { replay: true, operationId: old.operation_id, state: old.state,
      code: old.state === 'RUNNING' ? 'IN_PROGRESS' : !old.result && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(old.state) ? 'RESULT_EXPIRED' : old.state,
      result: await recordedResult(this.#store, owner, old), recovery: ['RUNNING', 'UNKNOWN'].includes(old.state) ? '/kioku-lisp status で確認してください。自動再実行はしません。' : null }
  }
  private async cancel(state: AgentState): Promise<void> {
    clearTimeout(state.idleTimer)
    if (state.suspension) await state.suspension
    state.state = 'STOPPING'
    for (const abort of state.active) abort.abort(new LispError('CANCELLED', 'Lisp の処理を取り消しました。'))
    try {
      let ownedStopFailure: unknown
      try { await this.stopOwned(state) }
      catch(error){ownedStopFailure=new LispError('STOP_UNCONFIRMED', `管理中のプロセスの停止を確認できません。${failure(error).message}`)}
      await state.worker?.stop()
      if (state.admission) {
        try { await state.admission } catch (error) { if (error instanceof LispError && error.code === 'STOP_UNCONFIRMED') throw error }
      }
      this.#compiled.assertStopped()
      if (ownedStopFailure) throw ownedStopFailure
      state.state = 'RECOVERY_REQUIRED'
    }
    catch (error) { this.halted(state, error); throw error }
  }
  async canRecoverWorkerWithoutTask(owner: LispOwner): Promise<boolean> {
    if (this.#config.executionMode !== 'development' || await this.isTaskMode(owner)) return false
    const workflow = await this.#store.database(db => sessionCodingWorkflow(db, owner.sessionId))
    return !workflow?.definition && !workflow?.protocol
  }
  /** Human conversation recovery only restarts a worker; it cannot grant effects. */
  private async authorizeRecovery(owner: LispOwner): Promise<void> {
    const native = this.taskAuthority.current()?.nativeCommands
    if (native && await this.canRecoverWorkerWithoutTask(owner)) {
      await this.authorizeCodingTask(owner)
      native.assertCurrent()
      return
    }
    await this.taskAuthority.authorizeEffect(owner)
  }
  recover(owner: LispOwner, signal?: AbortSignal): Promise<unknown> {
    return this.taskAuthority.run(owner, async () => {
      this.entry(owner)
      await this.authorizeRecovery(owner)
      return this.recoverBound(owner, signal)
    })
  }
  private async recoverBound(owner: LispOwner, signal?: AbortSignal): Promise<unknown> {
    await this.claimSession(owner)
    const managed = await this.managedUnresolved(owner)
    if (managed.unknownCount > 0) return {ok:false,code:'RECONCILIATION_REQUIRED',
      message:'外部処理の結果が未確定です。対象と元のホスト証跡を確認し、影響が無いと確認できた操作だけを /kioku-lisp abandon-managed 操作ID で終了してください。Lisp の再起動では外部処理を確定できず、コマンドは自動再実行しません。',
      managedOperations:managed.operations,managedUnknownOperations:managed.unknownOperations,
      managedOperationCount:managed.total,managedOperationsTruncated:managed.truncated,
      recovery:'/kioku-lisp diagnostics 操作ID で記録を確認し、/kioku-lisp abandon-managed 操作ID で終了します。' }

    if (await this.isTaskMode(owner)) {
      await this.stopTaskWorkers(owner.sessionId)
      await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
      const pending = (await this.#store.operations(owner.sessionId)).filter(o => ['RUNNING', 'UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL'].includes(o.state))
      if (pending.some(o => o.kind === 'proposal')) fail('RECONCILIATION_REQUIRED', '未確定のファイル変更を先に照合してください。')
      for (const op of pending) await this.#store.transition({ ...owner, agentId: op.agent_id }, op.operation_id, [op.state], 'ABANDONED',
        { ok: false, state: 'ABANDONED', reexecuted: false })
      signal?.throwIfAborted()
      return this.status(owner)
    }
    const state = this.entry(owner)
    await this.stopTaskWorkers(owner.sessionId)
    await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    const pending = (await this.#store.operations(owner.sessionId)).filter(o => ['RUNNING', 'UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL'].includes(o.state))
    if (pending.some(o => o.kind === 'proposal')) {
      return { ok: false, code: 'RECONCILIATION_REQUIRED', message: 'ファイル変更の結果が未確定です。以下の対象とバックアップを確認し、/kioku-lisp abandon <操作ID> で自動再適用せず確定してください。', operations: pending.map(o => ({ id: o.operation_id, state: o.state, details: JSON.parse(o.payload) })) }
    }
    for (const op of pending) {
      const boundOwner = { ...owner, agentId: op.agent_id }
      await this.#store.transition(boundOwner, op.operation_id, [op.state], 'ABANDONED', { ...await recordedResult(this.#store, boundOwner, op), ok: false, state: 'ABANDONED', humanRecovery: true })
    }
    signal?.throwIfAborted()
    await this.authorizeRecovery(owner)
    await this.startWorker(state)
    return this.status(owner)
  }
  /** Human reconciliation of one unknown external operation. It records the
   * inspected evidence, performs no dispatch and grants no replay. Restarting
   * Lisp cannot clear these, so this is the only supported exit. */
  abandonManaged(owner: LispOwner, id: string, evidence: string): Promise<unknown> {
    return this.taskAuthority.run(owner, async () => {
      this.claimSession(owner)
      await this.taskAuthority.authorizeEffect(owner)
      const operationId = identifier.parse(id)
      const note = evidence.trim()
      if (!note) fail('INVALID_INPUT', '照合した内容を evidence として指定してください。確認していない操作を終了することはできません。')
      const result = await this.#store.database(db => new ManagedOperationJournal(db).abandon(operationId, note))
      return { ok: true, operation: { id: result.operationId, route: result.route, kind: result.kind, state: result.state, receiptRef: result.receiptRef ?? null },
        reconciliation: { recorded: true, reexecuted: false, effectsReverted: false },
        recovery: '/kioku-lisp recover で新しい Lisp を起動できます。元の外部処理は自動再実行も復元もしません。' }
    })
  }
  async abandon(owner: LispOwner, id: string): Promise<unknown> {
    await this.claimSession(owner)
    await this.stopTaskWorkers(owner.sessionId)
    const state = this.entry(owner); await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    const op = await this.#store.get(owner, identifier.parse(id))
    if (!op || !['UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL', 'RUNNING'].includes(op.state)) fail('STATE_CONFLICT', 'この操作は未確定ではありません。')
    await this.#store.transition(owner, id, [op.state], 'ABANDONED', { ...await recordedResult(this.#store, owner, op), ok: false, state: 'ABANDONED', humanAbandoned: true, reapply: false })
    return { ok: true, recovery: '/kioku-lisp recover で新しい Lisp を起動できます。ファイルを自動復元・再適用しません。' }
  }
  restore(owner: LispOwner, id: string, signal: AbortSignal): Promise<unknown> {
    return this.taskAuthority.run(owner, async () => {
      this.entry(owner)
      await this.taskAuthority.authorizeEffect(owner)
      return this.restoreBound(owner, id, signal)
    })
  }
  private async restoreBound(owner: LispOwner, id: string, signal: AbortSignal): Promise<unknown> {
    await this.claimSession(owner)
    const state = this.entry(owner)
    await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    const op = await this.#store.get(owner, identifier.parse(id))
    if (!op || op.kind !== 'proposal' || !['APPLIED', 'ABANDONED'].includes(op.state)) fail('RECOVERY_REQUIRED', '適用済み、または照合して終了した操作を指定してください。')
    const original = JSON.parse(op.payload) as FrozenChange
    if (!original.backup || !under(join(this.options.dataRoot, 'backups'), original.backup) || !original.before.hash || original.before.size === undefined) fail('BACKUP_MISSING', '復元可能なバックアップがありません。')
    const abort = new AbortController(); state.active.add(abort)
    const result = this.#proposals.apply(owner, `restore:${id}`, state.worker?.generation ?? 'human-recovery', [{ operation: 'write', path: original.request.path, content: '' }], AbortSignal.any([signal, abort.signal]),
      { path: original.backup, hash: original.before.hash, size: original.before.size }).then(changes => changes[0])
    this.#executions.set(result, owner.sessionId)
    try { return await result } finally { this.#executions.delete(result); state.active.delete(abort) }
  }
  async disable(owner: LispOwner): Promise<unknown> {
    await this.claimSession(owner)
    await this.stopTaskWorkers(owner.sessionId)
    if (await this.isTaskMode(owner)) {
      await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
      if (await this.#store.hasPending(owner.sessionId)) fail('RECOVERY_REQUIRED', '未確定の処理を照合してから解除してください。')
      await this.#store.disable(owner.sessionId); this.enabled.delete(owner.sessionId)
      for (const [key, state] of this.#agents) if (state.owner.sessionId === owner.sessionId) this.#agents.delete(key)
      return { ok: true, state: 'DISABLED' }
    }
    for (const state of this.#agents.values()) if (state.owner.sessionId === owner.sessionId) await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    if (await this.#store.hasPending(owner.sessionId)) fail('RECOVERY_REQUIRED', '未確定の処理を /kioku-lisp recover で確認してから解除してください。')
    await this.#store.disable(owner.sessionId); this.enabled.delete(owner.sessionId)
    for (const [key, state] of this.#agents) if (state.owner.sessionId === owner.sessionId) this.#agents.delete(key)
    return { ok: true, state: 'DISABLED' }
  }
  async dispose(): Promise<void> {
    this.#closed = true
    this.#hot.cancel()
    for (const sessionId of new Set([...this.#agents.values()].map(state => state.owner.sessionId))) await this.stopTaskWorkers(sessionId)
    await Promise.all([...this.#agents.values()].map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions.keys(), ...[...this.#agents.values()].map(state => state.admission)])
    await Promise.allSettled([...this.#claims])
    if (this.#ownsSessions) { await this.#store.releaseHost(this.#hostId); this.#ownsSessions = false }
  }
}
