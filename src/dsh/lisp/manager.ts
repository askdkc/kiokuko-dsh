import { ManagedOperationJournal } from '../managed-operation-journal.js'
import { runManagedOperation, observeManagedResult, managedAdmissionDenied, isManagedAdmissionDenied, type ManagedScope } from '../managed-operation-runner.js'
import { resetStoppedSessionRecords, stopBeforeReset } from './session-reset.js'
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
import { EvalInput, RecoverInput, LispError, digest, fail, failure, identifier, type LispConfiguration, type LispOwner, type LispState, type LispTool, type WorkerResult } from './contracts.js'
import { LispStore } from './store.js'
import { sessionCodingWorkflow } from '../coding-workflow/store.js'
import { LispWorker, type LispRpcContext, type Job, type AwaitingRestart } from './worker.js'
import { LispSupervisor } from './supervision.js'
import { verifyLispVendor } from './integrity.js'
import type { CompilationStatus } from './compiled-cache.js'
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
import { OperationSpecSchema } from '../operation-spec.js'

interface AgentState { owner: LispOwner; state: LispState; worker?: LispWorker; error?: ReturnType<typeof failure>; active: Set<AbortController>; admission?: Promise<LispWorker>; inputBytes?: number; compilation?: CompilationStatus
  execution?: LispTaskExecution | undefined;
  managedScope?: ManagedScope;
  recovery?: LispRecoverySession;
  taskSettlement?: Promise<void>;
  codeLease?: { evaluationId: string; adapter: CodeIntelligenceAdapterV1 };
  ownedJobs?:Set<string>; ownedCalls?:Set<Promise<unknown>>; ownedDispatches?:Set<AbortController>; ownedStop?:Promise<void>;
  hostBusy?: boolean; resumed?: boolean; disposed?: boolean;
  packageBase?: NonNullable<PackageResult['base']>;
  currentVerification?: { operationId: string; generation: string; results: Array<{ request: LispCiRequest; result: unknown }> };
  awaiting?: { operationId: string; generation: string; ticket: string } }
const MODEL_RECOVERY_CAUSES = new Set(['TIMEOUT', 'OUTPUT_LIMIT', 'WORKER_EXITED', 'PROTOCOL_ERROR', 'WORKER_NOT_RESUMED', 'CACHE_INVALID', 'COMPILE_TIMEOUT', 'WORKER_RESTART_LIMIT'])
class DisposableEvalError extends LispError {
  constructor(readonly evaluation: WorkerResult, readonly output: unknown, readonly generation: string) {
    super('TASK_EVAL_FAILED', String(evaluation.value).slice(0, 1000), 'Inspect the failed operation, correct the code, then use a new operation ID.')
  }
}
export interface ManagerOptions {
  codeSession?: (owner: LispOwner, context: LispRpcContext) => CodeIntelligenceAdapterV1
  skillPrompts?: DshSkillPrompts
  store: LispStore; config: LispConfiguration; dataRoot: string; library?: string; protectedRoots?: string[]; questions?: DshUserQuestions
  notify?: (owner: LispOwner, message: string) => void
  toolCall?: (owner: LispOwner, name: string, args: Record<string, unknown>, signal?:AbortSignal,callId?:string, taskLease?:TaskLease, argv?: readonly string[], operation?: import('../operation-spec.js').OperationSpec) => Promise<unknown>
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
  readonly #executions = new Map<Promise<unknown>, { sessionId: string; blocksRecovery: boolean }>()
  readonly #config: LispConfiguration
  readonly #store: LispStore
  readonly #library: string
  readonly #supervisor: LispSupervisor
  readonly #taskTools: TaskToolCatalog
  readonly #hot: HotToolRuntime
  #closed = false
  readonly #hostId = `${processIdentity(process.pid) ?? 'unknown'}:${randomUUID()}`
  readonly #claims = new Set<Promise<void>>()
  readonly #recovering = new Set<string>()
  #ownsSessions = false
  #artifactReserved = 0
  readonly #inflight = new Map<string, string>()
  readonly #sessionWorkerAdmissions = new Map<string, Promise<unknown>>()
  readonly #disabling = new Set<string>()
  constructor(readonly options: ManagerOptions) {
    this.#config = options.config
    this.taskAuthority = new LispTaskAuthority(options.store.database)
    this.#store = new LispStore(options.store.database, (db, owner) => this.taskAuthority.authorizePublication(db, owner))
    this.#proposals = new LispProposalBatch({ store: this.#store, backupRoot: join(options.dataRoot, 'backups'), protectedRoots: () => this.protectedRoots(), ...(options.questions ? { questions: options.questions } : {}), stopped: () => this.#closed,
      authorizeEffect: async owner => { await this.taskAuthority.authorizeEffect(owner) },
      ...(options.config.executionMode==='development'&&options.toolCall?{execute:async (owner, name, args, signal, callId) => options.toolCall!(owner, name, args, signal, callId, await this.taskAuthority.authorizeEffect(owner, 'owned'))}:{}) })
    this.#library = options.library ?? fileURLToPath(new URL('../../../lisp/', import.meta.url))
    this.#supervisor = new LispSupervisor(this.#config, options.dataRoot, this.#library)
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
    if (this.#disabling.has(owner.sessionId)) fail('BUSY', 'Lisp を停止中です。disable の完了後に enable してください。')
    const workflow=await this.#store.database(db=>sessionCodingWorkflow(db,owner.sessionId))
    if(workflow?.protocol && this.#config.executionMode !== 'protected') fail('PROTOCOL_PROTECTED_REQUIRED','This bounded protocol requires protected Lisp computation. Disable the existing Lisp session before binding, then select protected mode; use owned file/test tools for effects.')
    const native = this.taskAuthority.current()?.nativeCommands
    if (native && !workflow?.protocol) native.assertCurrent()
    else if(workflow&&(workflow.repositoryRoot!==owner.root||workflow.choice.state!=='yes'||['cancelled','superseded'].includes(workflow.state)))
      fail('CODING_CHOICE_PENDING','このタスクで Lisp を使う選択が必要です。')
    await this.claimSession(owner)
    if (this.#disabling.has(owner.sessionId)) fail('BUSY', 'Lisp を停止中です。disable の完了後に enable してください。')
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
    await this.startWorker(state, signal)
    return this.status(owner)
  }
  /** A routed session keeps its own heap. Project effects still cross the host
   * boundary; its scratch runtime never takes the standalone repository lease. */
  enableSessionWorker(owner: LispOwner, hostBusy = false, signal?: AbortSignal): Promise<unknown> {
    const key = JSON.stringify([owner.sessionId, owner.agentId, owner.root])
    const pending = this.#sessionWorkerAdmissions.get(key)
    if (pending) return pending
    const admission = this.admitSessionWorker(owner, hostBusy, signal)
      .finally(() => this.#sessionWorkerAdmissions.delete(key))
    this.#sessionWorkerAdmissions.set(key, admission)
    return admission
  }
  private async admitSessionWorker(owner: LispOwner, hostBusy: boolean, signal?: AbortSignal): Promise<unknown> {
    await this.authorizeCodingTask(owner)
    signal?.throwIfAborted()
    if (!this.#config.enabled || this.#closed) fail('LISP_DISABLED', 'Lisp is unavailable for this worker session.')
    if (await realpath(owner.root) !== owner.root) fail('SCOPE_CONFLICT', 'Worker workspace identity changed.')
    if (!await this.isSessionWorker(owner)) {
      if ([...this.#agents.values()].some(state => state.owner.sessionId === owner.sessionId
        && (state.admission || state.active.size || state.worker && !state.worker.stopped))
        || await this.#store.hasPending(owner.sessionId))
        fail('WORKER_MODE_BUSY', 'Settle the current Lisp operations before admitting a session worker.')
      await this.#store.enable(owner)
      this.enabled.set(owner.sessionId, owner.root)
      const epoch = (await this.#store.session(owner.sessionId))!.epoch
      const modeOwner = { ...owner, agentId: '__session__' }, id = `session-worker-${epoch}`
      await this.#store.reserve(modeOwner, id, 'session_worker', digest({ root: owner.root, epoch }), 'host', { root: owner.root, epoch })
      await this.#store.transition(modeOwner, id, ['RUNNING'], 'SUCCEEDED', { mode: 'session-worker' })
    }
    signal?.throwIfAborted()
    this.setAgentBusy(owner, hostBusy)
    return this.prepare(owner, signal)
  }
  async isSessionWorker(owner: LispOwner): Promise<boolean> {
    const session = await this.#store.session(owner.sessionId)
    if (!session?.enabled || session.root_path !== owner.root) return false
    const record = await this.#store.get({ ...owner, agentId: '__session__' }, `session-worker-${session.epoch}`)
    return record?.kind === 'session_worker' && record.state === 'SUCCEEDED'
      && record.digest === digest({ root: owner.root, epoch: session.epoch })
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
    if (await this.isSessionWorker(owner)) return false
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
        await this.#supervisor.stop(state.worker)
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
    await this.claimSession(owner)
    const resident=this.#agents.get(JSON.stringify([owner.sessionId,owner.agentId]))
    // Schemas do not make arbitrary Lisp pure. Only reuse this caller's already
    // protected heap; other callers and development heaps get private scratch.
    if(mode!=='eval'&&resident?.owner.root===owner.root&&resident.worker?.layout.protected&&resident.worker.config.executionMode==='protected'&&!resident.worker.stopped){
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
      // Disposable computations share the master's admission and startup path,
      // but receive neither a repository mount nor host RPC authority.
      worker = await this.#supervisor.start(state, {
        signal: combined, assertCurrent, executionMode: 'protected', rpcAllowed: () => false,
        assigned: child => { state.worker = child; worker = child },
        inspect: (child, code) => this.journalRequest(state, child, 'eval', { inputs: [], code }, this.#config.startupTimeoutMs, combined, false),
      })
      const layout = worker.layout
      state.state='EVALUATING'
      if (mode === 'compile') {
        const checked = await this.journalRequest(state, worker, 'task-compile', { code }, this.#config.timeoutMs, combined,false)
        assertCurrent()
        if (!checked.ok || checked.proposals.length) fail('TASK_COMPILE_FAILED', String(checked.value).slice(0, 1000))
        return { value: null, output: worker.output(), generation: worker.generation }
      }
      if (mode === 'eval') {
        const evaluated = await this.journalRequest(state, worker, 'eval', { code, inputs: [] }, this.#config.timeoutMs, combined,false)
        assertCurrent()
        if (!evaluated.ok || evaluated.proposals.length) throw new DisposableEvalError(evaluated, worker.output(), worker.generation)
        const value = evaluated.value as { printed?: string; json?: unknown }
        return { value: { printed: value.printed, json: value.json }, output: worker.output(), generation: worker.generation }
      }
      const encoded = JSON.stringify(input)
      if (!encoded || Buffer.byteLength(encoded) > 64 * 1024 * 1024) fail('TASK_INPUT_LIMIT', 'Task input is too large.')
      const inputPath = join(layout.inputs, randomUUID())
      await writeFile(inputPath, encoded, { flag: 'wx', mode: 0o400 })
      assertCurrent()
      state.state = 'EVALUATING'
      const response = await this.journalRequest(state, worker, 'task', { code, input: inputPath }, this.#config.timeoutMs, combined,false)
      if (!response.ok || response.proposals.length) fail('TASK_EXECUTION_FAILED', String(response.value).slice(0, 1000))
      const result = await snapshot(layout.scratch, 'task-result.json', [])
      if (!result.exists) fail('TASK_RESULT_MISSING', 'Task result was not saved.')
      const bytes = await checkedBytes(result)
      assertCurrent()
      return { value: JSON.parse(bytes.toString('utf8')) as unknown, output: worker.output(), generation: worker.generation }
    } finally {
      try {
        if (worker) {
          try { await this.#supervisor.stop(worker) }
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
  private async startWorker(state: AgentState, signal?: AbortSignal): Promise<LispWorker> {
    await this.authorizeCodingTask(state.owner)
    signal?.throwIfAborted()
    if (state.admission) return state.admission
    if (this.#closed || state.disposed) fail('HOST_STOPPED', 'Lisp のセッションが停止しています。')
    state.state = 'PREFLIGHT'
    state.compilation = { state: 'checking' }
    const abort = new AbortController(); state.active.add(abort)
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const admission = (async () => {
      let worker: LispWorker | undefined
      try {
        const sessionWorker = await this.isSessionWorker(state.owner)
        worker = await this.#supervisor.start(state, {
          signal: combined, ...(!sessionWorker ? { workspace: state.owner.root } : {}), executionMode: this.#config.executionMode,
          assertCurrent: () => { if (this.#closed || this.#disabling.has(state.owner.sessionId) || state.disposed || state.state !== 'PREFLIGHT' || combined.aborted) fail('CANCELLED', '起動は取り消されています。') },
          compilation: status => { state.compilation = status },
          assigned: child => { state.worker = child },
          failed: (child, error) => {
            // Process events, not UI polling, report an idle child's failure.
            // Active operations settle through their journal-aware catch path.
            if (state.worker === child && state.state === 'READY') this.halted(state, error)
          },
          hostCall: (method, args, context) => this.bridge(state, method, args, context),
          beforeJob: () => this.taskAuthority.bound(state.execution, async () => { await this.taskAuthority.authorizeEffect(state.owner, this.#config.executionMode === 'protected' ? 'protected' : 'direct') }),
          auditJob: (input, launch) => this.journalProtectedJob(state, input, launch),
          inspect: (child, code) => this.journalRequest(state, child, 'eval', { inputs: [], code }, this.#config.startupTimeoutMs, combined, false),
        })
        state.state = 'READY'; state.inputBytes = 0; delete state.error
        return worker
      } catch (error) {
        if (error instanceof LispError && error.code === 'WORKER_LIMIT') { state.state = 'SUSPENDED'; delete state.error }
        else this.halted(state, error)
        throw error
      }
    })()
    state.admission = admission
    try { return await admission } finally { delete state.admission; state.active.delete(abort) }
  }
  /** Admit a fresh generation only after the master has reconciled its old child and journals. */
  async prepare(owner: LispOwner, signal?: AbortSignal, allowStartupDiagnostics = false): Promise<unknown> {
    await this.authorizeCodingTask(owner)
    const state = this.entry(owner)
    if (this.#recovering.has(owner.sessionId)) return this.status(owner)
    if (state.state === 'READY' && !state.worker?.healthy)
      this.halted(state, new LispError('WORKER_EXITED', 'Lisp の子プロセスが終了しています。'))
    const cold = state.error?.code === 'WORKER_NOT_RESUMED' && !state.worker
    const exited = state.error?.code === 'WORKER_EXITED' && state.active.size === 0 && !state.admission
    if (cold || exited) {
      const previous = state.worker
      if (exited) {
        try { await this.#supervisor.stop(previous) }
        catch (error) { this.halted(state, error); return this.status(owner) }
      }
      const pending = await this.#store.hasPending(owner.sessionId)
      const managed = await this.managedUnresolved(owner)
      // A cancel, another admission, or a late callback can win while we read.
      if (!pending && managed.total === 0 && !this.#recovering.has(owner.sessionId) && state.worker === previous &&
          state.state === 'RECOVERY_REQUIRED' && state.error?.code === (cold ? 'WORKER_NOT_RESUMED' : 'WORKER_EXITED')) {
        if (exited && !this.#supervisor.admitRestart(state)) {
          this.halted(state, new LispError('WORKER_RESTART_LIMIT', 'Lisp の異常終了が続いたため自動再起動を停止しました。', '停止理由を確認してから /kioku-lisp recover を実行してください。'))
          return this.status(owner)
        }
        state.state = 'SUSPENDED'; delete state.error; delete state.worker
      }
    }
    if (state.state === 'SUSPENDED') {
      const previousError = state.error
      try { await this.startWorker(state, signal); state.resumed = true }
      catch (error) {
        // Only an observed worker startup failure can open the diagnosis path.
        if (!allowStartupDiagnostics || signal?.aborted || !state.error || state.error === previousError) throw error
      }
    }
    else if (state.admission) await state.admission
    return this.status(owner)
  }
  setAgentBusy(owner: LispOwner, busy: boolean): void {
    if (!this.enabled.has(owner.sessionId)) return
    const state = this.entry(owner)
    if (state.hostBusy === busy) return
    state.hostBusy = busy
  }
  /** Detach a turn/task without destroying an idle session heap. Active work
   * still drains through cancellation; no background effect survives Stop. */
  async stopSessionWork(sessionId: string): Promise<void> {
    await this.stopTaskWorkers(sessionId)
    const states = [...this.#agents.values()].filter(state => state.owner.sessionId === sessionId)
    if (states.every(state => state.state === 'READY' && state.worker?.healthy && !state.worker.busy
      && !state.admission && state.active.size === 0 && !state.ownedJobs?.size && !state.ownedCalls?.size
      && !state.worker.hasRunningJobs)) {
      for (const state of states) state.hostBusy = false
      return
    }
    await this.disposeSession(sessionId)
  }
  /** Disposed sessions retain their fence/journal but cannot admit new work. */
  async disposeSession(sessionId: string): Promise<void> {
    await this.stopTaskWorkers(sessionId)
    const states = [...this.#agents.values()].filter(state => state.owner.sessionId === sessionId)
    const resumable = states.filter(state => state.state === 'READY' || state.state === 'SUSPENDED')
    for (const state of states) { state.disposed = true }
    const stopped = await Promise.allSettled(states.map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === sessionId).map(([promise]) => promise))
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
      const native = this.taskAuthority.current()?.nativeCommands
      const route = method === 'run' && native && native.processRoute !== 'owned' && this.#config.executionMode === 'development' ? 'native' : 'owned'
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
    if (method === 'session-save') {
      const request = z.object({ name: z.string().min(1).max(256), kind: z.enum(['json','definition','result_ref']), value: z.unknown() }).strict().parse(args)
      await this.taskAuthority.authorizeEffect(state.owner)
      context.signal.throwIfAborted()
      const saved = await this.#store.saveState(state.owner, request.name, request.kind, request.value)
      await this.taskAuthority.authorizeEffect(state.owner)
      return saved
    }
    if (method === 'session-restore') {
      const request = z.object({ name: z.string().min(1).max(256) }).strict().parse(args)
      return await this.#store.restoreState(state.owner, request.name) ?? null
    }
    if (method === 'session-list') {
      z.object({}).strict().parse(args)
      return this.#store.listState(state.owner)
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
      const input=z.object({program:z.string().min(1),argv:z.array(z.string()),timeoutMs:z.number().int().positive(),directory:z.string().optional(),operation:OperationSpecSchema.optional()}).strict().parse(args)
      const quote=(value:string)=>"'" + value.replaceAll("'", "'\\''") + "'"
      const directory=input.directory??'.'
      const native = this.taskAuthority.current()?.nativeCommands
      if (method === 'run' && native && native.processRoute !== 'owned' && this.#config.executionMode === 'development') {
        native.assertCurrent()
        const nativeInput = { program: input.program, argv: input.argv, timeoutMs: input.timeoutMs,
          ...(input.directory === undefined ? {} : { directory: input.directory }),
          ...(input.operation === undefined ? {} : { operation: input.operation }) }
        return this.ownedDispatch(state, signal => native.run(nativeInput, AbortSignal.any([signal, context.signal])))
      }
      // No adapter has been entered yet. Preserve this host-observed boundary
      // so an authority/Stop rejection cannot become an unknown process effect.
      const lease = await this.taskAuthority.authorizeEffect(state.owner, 'owned').catch(managedAdmissionDenied)
      if (context.signal.aborted) managedAdmissionDenied(new LispError('CANCELLED', 'Process dispatch was cancelled before it began.'))
      const argv = [input.program, ...input.argv]
      const value=await this.ownedDispatch(state,signal=>this.options.toolCall!(state.owner,'kioku_exec',{command:argv.map(quote).join(' '),cwd:isAbsolute(directory)?directory:join(state.owner.root,directory),timeoutMs:input.timeoutMs,background:method==='start-job'},method==='start-job'?signal:AbortSignal.any([signal,context.signal]),`lisp-rpc:${context.generation}:${context.evaluationId}:${context.rpcId}`,lease,argv,input.operation)) as any
      // A launched job must remain cancellable even if task authority changed
      // while its start acknowledgement was in flight.
      this.retainOwned(state,value)
      await this.taskAuthority.authorizeEffect(state.owner, 'owned')
      if(method==='start-job')return value.receipt.operationId
      return {code:value.exitCode,stdout:value.output??'',stderr:'',receipt:value.receipt}
    }
    if (method === 'tools-list') return this.taskAuthority.current()?.nativeCommands?.toolCatalog() ?? this.options.toolCatalog?.(state.owner)??[]
    if (method === 'tool-call') {
      const parsed = z.object({ name: z.string().min(1).max(256), definitionId: z.string().min(1).max(256).optional(), args: z.record(z.string(),z.unknown()) }).strict().parse(args)
      const native = this.taskAuthority.current()?.nativeCommands
      if (native) {
        const definitionId = parsed.definitionId ?? native.toolCatalog().find(item => item.name === parsed.name)?.definitionId
        if (!definitionId) fail('TOOL_DEFINITION_REQUIRED', 'Call AVAILABLE-TOOLS and use its current definitionId.')
        return native.callTool(parsed.name, definitionId, parsed.args, context.signal)
      }
      if (!['lisp_status','kioku_read','kioku_write','kioku_edit','kioku_remove','kioku_exec','kioku_result'].includes(parsed.name))
        fail('CAPABILITY_DENIED', 'This tool is not available through the protected compatibility bridge.')
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
      runtimeHealthy: state.worker?.healthy ?? false,
      owner:{hostPid:process.pid,sessionId:owner.sessionId,agentId:owner.agentId},
      error: unconfirmed?.error ?? (taskMode && !state.worker ? null : state.error ?? null),
      ...(managedReconciliation && managed.unknownOperations[0] ? { nextInspection: { tool: 'lisp_inspect', managedOperationId: managed.unknownOperations[0].id } } : {}),
      jobs: [...(state.worker?.jobStatus() ?? []),...[...state.ownedJobs??[]].map(operationId=>({operationId,owner:'kiokuko-execution'}))],
      executionMode:this.#config.executionMode,
      compilation: state.compilation ?? null, resumed: state.resumed ?? false,
      limits: { timeoutMs: this.#config.timeoutMs, maxOutputBytes: this.#config.maxOutputBytes, maxWorkers: this.#config.maxWorkers, idleTimeoutMs: 0,
        aggregateMemory: 'unavailable', aggregateCpu: 'unavailable', scratchQuota: 'unavailable', termination: 'supervised', fileBoundary: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap' },
      operations, operationCount: summary.count, pendingCount: Object.values(summary.pendingStates).reduce((a,b) => a+b,0), pendingStates: summary.pendingStates,
      ...(taskSummary ? { task: taskSummary } : {}),
      hot: await this.#hot.status(owner),
      ...(offset === undefined ? {} : { offset, nextOffset: offset + 10 < summary.count ? offset + 10 : null }),
      recovery: managedReconciliation ? 'Managed operations remain unresolved. Inspect the listed operation IDs and original receipts; restarting or abandoning Lisp does not reconcile external effects.' : unconfirmed ? '停止と操作記録を照合してください。自動再実行しません。' : taskMode && !state.worker ? null : state.state === 'SUSPENDED' ? 'Lisp は休止中です。次の利用時に自動起動します。変数・関数定義は保持されません。' : state.state === 'READY' ? null : '停止理由と操作履歴を確認し、/kioku-lisp recover を実行してください。' }
  }
  async diagnostics(owner: LispOwner, id?: string): Promise<unknown> {
    const session = await this.#store.session(owner.sessionId)
    if (session && session.root_path !== owner.root) fail('SCOPE_CONFLICT', '診断対象のセッションとリポジトリが一致しません。')
    const parse = (value: string) => {
      try { return JSON.parse(value) } catch { return { unreadable: true, reason: 'CORRUPT_JSON', bytes: Buffer.byteLength(value) } }
    }
    if (id) {
      const operation = await this.#store.get(owner, identifier.parse(id))
      if (!operation) {
        return this.managedDiagnostics(owner, id)
      }
      return { ...operation, payload: parse(operation.payload), result: operation.result ? parse(operation.result) : null }
    }
    const operations = await this.#store.operations(owner.sessionId, 100)
    let status: object
    try { status = await this.status(owner) as object }
    catch (error) { status = { enabled: this.enabled.has(owner.sessionId), state: 'DIAGNOSTICS_PARTIAL', statusError: failure(error) } }
    return { ...status, operationPageLimit: 100,
      changes: operations.filter(o => o.kind === 'proposal').map(o => ({ id: o.operation_id, state: o.state, details: parse(o.payload), result: o.result ? parse(o.result) : null })),
      reset: '/kioku-lisp reset は対象セッションの SBCL と実行状態を初期化します。ツール登録・保存済み定義・操作履歴は保持し、元の処理は再実行しません。',
      inspect: '/kioku-lisp diagnostics OPERATION_ID で各操作の全内容を確認できます。' }
  }
  private async managedDiagnostics(owner: LispOwner, id: string): Promise<unknown> {
    const row = await this.#store.database(db => db.prepare(`SELECT o.operation_json FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
      WHERE o.operation_id=? AND json_extract(s.scope_json,'$.sessionId')=?`).get<{operation_json:string}>(id,owner.sessionId))
    if (!row) fail('UNKNOWN_OPERATION', 'このセッションの外部処理記録がありません。')
    const value = JSON.parse(row.operation_json)
    return { operationId: value.operationId, scopeId: value.scopeId, parentId: value.parentId, route: value.route, kind: value.kind,
      state: value.state, originalRef: value.originalRef ?? null, cause: value.cause ?? null, delivery: value.delivery }
  }
  execute(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal, nativeCommands?: LispNativeCommands): Promise<unknown> {
    const key = typeof input.operationId === 'string' ? JSON.stringify([owner.sessionId, owner.agentId, input.operationId]) : undefined
    const hash = digest({ tool, input }), pending = key ? this.#inflight.get(key) : undefined
    if (pending) return Promise.resolve(pending === hash ? { replay: true, code: 'IN_PROGRESS', state: 'RUNNING' } : failure(new LispError('ID_CONFLICT', '実行中の操作 ID に異なる入力があります。')))
    if (key) this.#inflight.set(key, hash)
    const result = this.taskAuthority.run(owner, () => this.dispatch(owner, tool, input, signal), nativeCommands).catch(error => failure(error))
    this.#executions.set(result, { sessionId: owner.sessionId, blocksRecovery: !(
      tool === 'lisp_recover' || tool === 'lisp_status' || tool === 'lisp_hot_status' ||
      tool === 'lisp_inspect' && (input.resultOperationId !== undefined || input.managedOperationId !== undefined)) })
    const finished = () => {
      this.#executions.delete(result); if (key) this.#inflight.delete(key)
    }
    void result.then(finished, finished)
    return result
  }
  private async dispatch(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      if (tool === 'lisp_status') return await this.status(owner, z.number().int().nonnegative().parse(input.offset ?? 0))
      if (this.#disabling.has(owner.sessionId)) fail('BUSY', 'Lisp を停止中です。')
      const state = this.entry(owner)
      if (tool === 'lisp_recover') return await this.recoverFromTool(owner, RecoverInput.parse(input), signal)
      if (tool === 'lisp_resume') {
        await this.authorizeCodingTask(owner)
        await this.claimSession(owner)
        const request = z.object({ operationId: identifier, targetOperationId: identifier, generation: identifier,
          ticket: identifier, restartId: identifier, arguments: z.array(z.unknown()).max(16).default([]) }).strict().parse(input)
        const id = request.operationId, hash = digest({ tool, input }), old = await this.#store.get(owner, id)
        if (old) { if (old.kind !== tool || old.digest !== hash) fail('ID_CONFLICT', '同じ再開 ID の内容が異なります。'); return this.replay(owner, old) }
        const worker = state.worker, awaiting = state.awaiting
        if (state.state !== 'AWAITING_RESTART' || !worker?.healthy || !awaiting || awaiting.operationId !== request.targetOperationId
          || awaiting.generation !== request.generation || awaiting.ticket !== request.ticket)
          fail('RESTART_STALE', 'この Restart は現在の Lisp 評価には属していません。')
        await this.#store.reserve(owner, id, tool, hash, worker.generation, request)
        state.state = 'EVALUATING'; state.execution = this.taskAuthority.current()
        const abort = new AbortController(); state.active.add(abort)
        const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
        try {
          const response = await worker.resume(request.ticket, request.restartId, request.arguments, combined)
          const waiting = response as unknown as AwaitingRestart
          if (waiting.type === 'awaiting_restart') {
            state.state = 'AWAITING_RESTART'; state.awaiting = { operationId: request.targetOperationId, generation: worker.generation, ticket: waiting.ticket }
            const result = { ok: false, code: 'AWAITING_RESTART', operationId: request.targetOperationId, generation: worker.generation,
              awaitingRestart: { ticket: waiting.ticket, condition: waiting.condition, restarts: waiting.restarts, expiresAt: waiting.expiresAt } }
            await this.#store.transition(owner, request.targetOperationId, ['AWAITING_RESTART'], 'AWAITING_RESTART', result)
            await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
            return result
          }
          delete state.awaiting
          const base = { ok: response.ok, operationId: request.targetOperationId, resumedBy: id, value: response.value,
            output: worker.output(), generation: worker.generation, proposals: response.proposals }
          if (!response.ok) {
            state.state = 'READY'
            await this.#store.transition(owner, request.targetOperationId, ['AWAITING_RESTART'], 'FAILED', base)
            await this.#store.transition(owner, id, ['RUNNING'], 'FAILED', base)
            if (state.currentVerification?.operationId === request.targetOperationId) delete state.currentVerification
            return base
          }
          const applied = await this.#proposals.apply(owner, request.targetOperationId, worker.generation, response.proposals, combined)
          const uncertain = applied.some(change => change.state === 'UNKNOWN')
          if (uncertain) { await this.#supervisor.stop(worker); this.halted(state, new LispError('RECONCILIATION_REQUIRED', '変更結果が未確定です。記録とバックアップを照合してください。')) }
          else state.state = 'READY'
          const complete = applied.every(change => change.state === 'APPLIED' || change.state === 'UNCHANGED')
          const result = { ...base, ok: complete, state: uncertain ? 'UNKNOWN' : complete ? 'SUCCEEDED' : 'FAILED', changes: applied }
          await this.#store.transition(owner, request.targetOperationId, ['AWAITING_RESTART'], result.state, result)
          await this.#store.transition(owner, id, ['RUNNING'], result.state === 'UNKNOWN' ? 'UNKNOWN' : complete ? 'SUCCEEDED' : 'FAILED', result)
          if (result.state === 'SUCCEEDED' && response.proposals.length === 0 && this.options.verifiedCall
            && state.currentVerification?.operationId === request.targetOperationId
            && state.currentVerification.generation === worker.generation) {
            for (const verified of state.currentVerification.results) {
              try { await this.options.verifiedCall(owner, request.targetOperationId, worker.generation, verified.request, verified.result) }
              catch { /* Optional host proof cannot change the durable Lisp result. */ }
            }
          }
          if (state.currentVerification?.operationId === request.targetOperationId) delete state.currentVerification
          return result
        } catch (error) {
          delete state.awaiting
          try { await this.#supervisor.stop(worker) } catch { /* retain primary resume failure */ }
          this.halted(state, error)
          const result = { ...failure(error), operationId: request.targetOperationId, generation: worker.generation, state: 'UNKNOWN' }
          try { await this.#store.transition(owner, request.targetOperationId, ['AWAITING_RESTART'], 'UNKNOWN', result) } catch { /* journal remains non-success */ }
          try { await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', result) } catch { /* journal remains non-success */ }
          if (state.currentVerification?.operationId === request.targetOperationId) delete state.currentVerification
          return result
        } finally { state.active.delete(abort) }
      }
      if (tool === 'lisp_inspect' && input.managedOperationId !== undefined) {
        if ([input.ref, input.resultOperationId, input.section, input.pointer, input.offset, input.limit].some(v => v !== undefined))
          fail('INVALID_INSPECTION', 'managedOperationId は他の参照や範囲と同時に指定できません。')
        return await this.managedDiagnostics(owner, identifier.parse(input.managedOperationId))
      }
      if (this.#recovering.has(owner.sessionId) && !(tool === 'lisp_hot_status' || tool === 'lisp_cancel' || tool === 'lisp_inspect' && input.resultOperationId !== undefined))
        fail('BUSY', 'Lisp worker recovery is in progress.')
      if(['lisp_define','lisp_call','lisp_observe','lisp_hot_call'].includes(tool))await this.claimSession(owner)
      else if(!['lisp_hot_status','lisp_inspect','lisp_cancel'].includes(tool))await this.authorizeCodingTask(owner)
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
        packages: ['kioku.tools', 'kioku.workspace', 'kioku.jobs', 'kioku.process', 'kioku.test', 'kioku.verify', 'kioku.session', 'kioku.functions', 'kioku.files', 'kioku.data', 'kioku.objects', 'kioku.environment', 'kioku.ci', 'kioku.packages', 'kioku.typesafe', 'kioku.decisions', 'kioku.recovery', 'kioku.code'],
        api: { recovery: 'Use kioku.recovery:await-restart inside a live handler to return the condition and active restarts to the main model; lisp_resume invokes exactly one restart on that same stack. Stop, expiry, generation changes and duplicate tickets cannot resume it. Existing kioku.recovery:select-restart remains available for Lisp-local decisions. After an observed unrecoverable runtime/API failure, lisp_fallback durably hands the same task to standard DSH tools.', code: 'kioku.code:capabilities, open, outline, enclosing, query, span, semantic, release, with-snapshot. Read-only disk snapshots; handles expire at evaluation end. Check status before using data.', packages: 'kioku.packages:metadata, audit and update-lockfiles use an approval-gated public npm broker. Updates generate in protected scratch and propose frozen files, never install dependencies or write the repository directly.', scratch: '(kioku.files:scratch) takes no arguments and names private Lisp I/O storage, not native Bash write authority. Development process outputs belong in authorized workspace paths; EPERM is a failure.', splitLines: 'kioku.process:split-lines returns a vector; use loop across',
          decisions: '(kioku.decisions:status), evaluate, assess-relevance, classify-failure, assess-change. Consume selected/abstained results; ordinary reasoning on fallback, cancellation is terminal.',
          typesafe: '(kioku.typesafe:status); (kioku.typesafe:evaluate state questions :model "jev-latest" :timeout-ms 30000). Explicit semantic decisions via the host; consume answers with gethash. Strings/hash tables/vectors use JSON conventions. Catch kioku.typesafe:service-error; no retries or approval bypass. Configure with /kioku-typesafe-key.',
          describe: 'symbol="kioku.files" lists bundled exports; symbol="kioku.user" lists your task functions; an exact function name returns arguments/docs.',
          workflow: 'Define task-specific defun helpers once, compose them into one useful operation, and call that function in later evaluations. Batch known reads and checks; return a compact result. Definitions last for this worker generation. Stop before decisions requiring new evidence or approval.',
          hot: 'Use lisp_hot_contract, lisp_hot_install and lisp_hot_call for approved project-shared functions. Reuse only your own protected worker with a fresh package and no host RPC; otherwise use private protected scratch without a repository mount. Schemas do not establish purity. No mode switch is needed. lisp_hot_status reads active versions.',
          run: '(kioku.process:run "node" (list "--test" "--experimental-test-isolation=none" "test/public.test.mjs") :directory "project") uses a project-relative directory in development mode (scratch-relative in protected mode). Check final receipts and result-code.',
          tests: '(kioku.test:spec :framework :node-test :files (list "test/example.test.mjs") :directory ".") creates a typed operation. Bind it with kioku.verify:bind and run the bound definition with kioku.verify:run. passed-p/failures consume the structured result. node/vitest remain compatibility entry points.',
          tools: 'kioku.tools:list/describe/call exposes only the current model step toolset and pins each definition identity. Calls traverse the existing DSH pipeline; stale, disconnected or replaced definitions are rejected.',
          state: 'kioku.session:save/restore stores JSON data and result references explicitly. kioku.functions:save-definition/restore-definition stores one defun/defmacro source without evaluating it automatically on startup.',
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
          const problem = { ...failure(error), operationId: id, nextInspection: { tool: 'lisp_inspect', resultOperationId: id },
            ...(error instanceof DisposableEvalError ? { generation: error.generation, ...(error.evaluation.condition ? { condition: error.evaluation.condition } : {}),
              output: error.output, workerState: 'TASK_READY' } : {}) }
          await this.#store.transition(owner, id, ['RUNNING'], problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : 'FAILED', problem)
          return problem
        }
      }
      if (state.state === 'SUSPENDED') {
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
      if (state.state !== 'READY') fail(['EVALUATING','AWAITING_RESTART'].includes(state.state) ? 'BUSY' : 'RECOVERY_REQUIRED', 'Lisp は実行可能な状態ではありません。/kioku-lisp status で確認してください。')
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
        const response = await this.journalRequest(state, worker, tool === 'lisp_eval' ? 'eval' : tool === 'lisp_describe' ? 'describe' : 'inspect', args, timeout, combined, true, tool === 'lisp_eval' && input.timeoutMs === undefined)
        const waiting = response as unknown as AwaitingRestart
        if (waiting.type === 'awaiting_restart') {
          state.state = 'AWAITING_RESTART'; state.awaiting = { operationId: id, generation: worker.generation, ticket: waiting.ticket }
          const result = { ok: false, code: 'AWAITING_RESTART', operationId: id, generation: worker.generation,
            awaitingRestart: { ticket: waiting.ticket, condition: waiting.condition, restarts: waiting.restarts, expiresAt: waiting.expiresAt } }
          evidence = result
          await this.#store.transition(owner, id, ['RUNNING'], 'AWAITING_RESTART', result)
          return result
        }
        const result = { ok: response.ok, operationId: id, value: response.value, output: worker.output(), generation: worker.generation, proposals: response.proposals,
          ...(!response.ok ? { ...(response.condition ? { condition: response.condition } : {}), workerState: 'READY',
            nextInspection: { tool: 'lisp_inspect', resultOperationId: id } } : {}) }
        evidence = { ...result, state: response.ok ? 'RUNNING' : 'FAILED' }
        await this.#store.transition(owner, id, ['RUNNING'], response.ok ? 'RUNNING' : 'FAILED', evidence)
        if (!response.ok) { state.state = 'READY'; return result }
        const applied = await this.#proposals.apply(owner, id, worker.generation, response.proposals, combined, undefined, state.packageBase)
        const uncertain = applied.some(change => change.state === 'UNKNOWN')
        if (uncertain) { await this.#supervisor.stop(worker); this.halted(state, new LispError('RECONCILIATION_REQUIRED', '変更結果が未確定です。記録とバックアップを照合してください。')) }
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
          try {
            await this.#supervisor.stop(worker)
            if (tool === 'lisp_eval' && !evidence && MODEL_RECOVERY_CAUSES.has(failure(error).code)) outcome.interruptedBeforeResult = true
          } catch (stop) { outcome = { ...outcome, stopFailure: failure(stop) }; error = stop }
          this.halted(state, error)
          outcome = { ...outcome, workerState: state.state, nextInspection: { tool: 'lisp_inspect', resultOperationId: id } }
          try {
            const current = await this.#store.get(owner, id)
            if (current?.state === 'RUNNING') await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', outcome)
          } catch (journal) { outcome = { ...outcome, journalFailure: failure(journal) }; this.halted(state, journal) }
        } else if (!worker.healthy) { try { await this.#supervisor.stop(worker) } catch (stop) { error = stop }; this.halted(state, error) }
        else if (state.state === 'EVALUATING') state.state = 'READY'
        return outcome
      } finally { await state.codeLease?.adapter.dispose(); delete state.codeLease; state.active.delete(abort); delete state.packageBase; if (state.currentVerification?.operationId === id && state.state !== 'AWAITING_RESTART') delete state.currentVerification }
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
    state.state = 'STOPPING'
    for (const abort of state.active) abort.abort(new LispError('CANCELLED', 'Lisp の処理を取り消しました。'))
    try {
      let ownedStopFailure: unknown
      try { await this.stopOwned(state) }
      catch(error){ownedStopFailure=new LispError('STOP_UNCONFIRMED', `管理中のプロセスの停止を確認できません。${failure(error).message}`)}
      await this.#supervisor.stop(state.worker)
      if (state.admission) {
        try { await state.admission } catch (error) { if (error instanceof LispError && error.code === 'STOP_UNCONFIRMED') throw error }
      }
      this.#supervisor.assertCompilationStopped()
      if (ownedStopFailure) throw ownedStopFailure
      state.state = 'RECOVERY_REQUIRED'
      state.error = failure(new LispError('CANCELLED', 'Lisp の処理を取り消しました。'))
    }
    catch (error) { this.halted(state, error); throw error }
  }
  async canRecoverWorkerWithoutTask(owner: LispOwner): Promise<boolean> {
    if (this.#config.executionMode !== 'development' || await this.isTaskMode(owner)) return false
    const workflow = await this.#store.database(db => sessionCodingWorkflow(db, owner.sessionId))
    return !workflow?.protocol
  }
  /** Development mode control only restarts a worker; it cannot grant effects. */
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
    return this.taskAuthority.run(owner, () => this.withRecoverySlot(owner, async () => {
      this.entry(owner)
      await this.authorizeRecovery(owner)
      return this.recoverBound(owner, signal)
    }))
  }
  /** Explicit human reset, never exposed as an autonomous model tool. The
   * session and tool registrations survive; only execution state is replaced. */
  restart(owner: LispOwner, signal?: AbortSignal): Promise<unknown> {
    return this.taskAuthority.run(owner, () => this.withRecoverySlot(owner, async () => {
      const state = this.entry(owner)
      signal?.throwIfAborted()
      await this.claimSession(owner)
      // No new worker or bookkeeping reset while any owned stop is unconfirmed.
      await stopBeforeReset(() => this.disposeSession(owner.sessionId))
      signal?.throwIfAborted()
      const reset = await this.#store.database(db => resetStoppedSessionRecords(db, owner))
      for (const current of this.#agents.values()) if (current.owner.sessionId === owner.sessionId) {
        delete current.awaiting; delete current.recovery; delete current.execution; delete current.managedScope
        delete current.currentVerification; delete current.packageBase; delete current.codeLease
      }
      if (!await this.isTaskMode(owner)) await this.startWorker(state, signal)
      return { ...await this.status(owner) as object, reset, definitionsLost: true, toolsPreserved: true }
    }))
  }
  private async withRecoverySlot<T>(owner: LispOwner, action: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#disabling.has(owner.sessionId) || this.#recovering.has(owner.sessionId))
      fail('BUSY', 'Lisp の復旧または停止処理が進行中です。')
    this.#recovering.add(owner.sessionId)
    try { return await action() } finally { this.#recovering.delete(owner.sessionId) }
  }
  private async recoverFromTool(owner: LispOwner, input: z.infer<typeof RecoverInput>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    await this.authorizeRecovery(owner)
    const id = input.operationId, hash = digest({ tool: 'lisp_recover', input })
    const old = await this.#store.get(owner, id)
    if (old) {
      if (old.kind !== 'lisp_recover' || old.digest !== hash) fail('ID_CONFLICT', '同じ操作 ID の内容を変えることはできません。')
      return this.replay(owner, old)
    }
    return this.withRecoverySlot(owner, () => this.recoverBound(owner, signal, { input, hash }))
  }
  private async recoverBound(owner: LispOwner, signal?: AbortSignal, model?: { input: z.infer<typeof RecoverInput>; hash: string }): Promise<unknown> {
    signal?.throwIfAborted()
    await this.claimSession(owner)
    const managed = await this.managedUnresolved(owner)
    if (managed.unknownCount > 0) return {ok:false,code:'RECONCILIATION_REQUIRED',
      message:'外部処理の結果が未確定です。停止と実行結果を確認した操作は /kioku-lisp abandon-managed 操作ID 確認した内容 で確認待ちを解除できます。タスク終了後も利用できます。コマンドの再実行や変更の復元は行いません。',
      managedOperations:managed.operations,managedUnknownOperations:managed.unknownOperations,
      managedOperationCount:managed.total,managedOperationsTruncated:managed.truncated,
      ...(model && managed.unknownOperations[0] ? { nextInspection: { tool: 'lisp_inspect', managedOperationId: managed.unknownOperations[0].id } } : {}),
      recovery:'/kioku-lisp diagnostics 操作ID で記録を確認し、/kioku-lisp abandon-managed 操作ID で終了します。' }

    if (model) {
      if (managed.total > 0) fail('BUSY', '外部処理が完了していません。記録を確認してください。')
      return this.restartStoppedWorker(owner, model, signal)
    }

    if (await this.isTaskMode(owner)) {
      await this.stopTaskWorkers(owner.sessionId)
      await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === owner.sessionId).map(([promise]) => promise))
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
    await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === owner.sessionId).map(([promise]) => promise))
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
  /** Tool recovery has no permission to cancel other work or reconcile receipts. */
  private async restartStoppedWorker(owner: LispOwner, model: { input: z.infer<typeof RecoverInput>; hash: string }, signal?: AbortSignal): Promise<unknown> {
    const { operationId, expectedGeneration } = model.input
    const state = this.entry(owner), previous = state.worker, cause = state.error
    const assertUnchanged = () => {
      signal?.throwIfAborted()
      if (this.#closed || this.#disabling.has(owner.sessionId) || state.disposed || this.enabled.get(owner.sessionId) !== owner.root)
        fail('HOST_STOPPED', '復旧中にセッションが停止しました。')
      if ((state.worker?.generation ?? null) !== expectedGeneration) fail('STALE_GENERATION', 'lisp_status で現在の Lisp 世代を確認してください。')
      if (state.state === 'STOP_UNCONFIRMED') fail('STOP_UNCONFIRMED', 'Lisp の停止を確認できません。')
      if (state.state === 'READY' || state.state === 'SUSPENDED') fail('RECOVERY_NOT_REQUIRED', '現在の Lisp は復旧を必要としていません。')
      if (state.state !== 'RECOVERY_REQUIRED' || state.error !== cause || !this.taskJobsIdle(owner)) fail('BUSY', 'Lisp の状態が変わりました。状態を確認してください。')
      if (!cause || !MODEL_RECOVERY_CAUSES.has(cause.code)) fail('RECOVERY_REQUIRES_USER', '停止理由を確認し、必要なら利用者が Lisp の復旧を選んでください。')
    }
    assertUnchanged()
    if (await this.isTaskMode(owner)) fail('RECOVERY_NOT_REQUIRED', 'このモードでは評価ごとに作業用 worker を起動します。')
    if (await this.#store.hasBlockingRecoveryOperation(owner)) fail('RECONCILIATION_REQUIRED', '未確定の操作記録を先に照合してください。')
    if ([...this.#executions.values()].some(execution => execution.sessionId === owner.sessionId && execution.blocksRecovery))
      fail('BUSY', 'このセッションには実行中の Lisp 呼び出しがあります。')
    assertUnchanged()
    const abort = new AbortController(); state.active.add(abort)
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    try {
      const old = await this.#store.reserve(owner, operationId, 'lisp_recover', model.hash, expectedGeneration ?? 'host', model.input)
      if (old) return this.replay(owner, old)
      try {
        combined.throwIfAborted(); assertUnchanged()
        if (!this.#supervisor.admitRestart(state)) fail('WORKER_RESTART_LIMIT', 'Lisp の自動復旧は1分間に2回までです。停止理由を調べてください。')
        await this.#supervisor.stop(previous)
        this.#supervisor.assertCompilationStopped()
        await this.authorizeRecovery(owner)
        combined.throwIfAborted(); assertUnchanged()
        const worker = await this.startWorker(state, combined)
        if (combined.aborted) {
          await this.#supervisor.stop(worker)
          this.halted(state, new LispError('CANCELLED', 'Lisp の復旧を取り消しました。'))
          combined.throwIfAborted()
        }
        const result = { ok: true, state: 'READY', operationId, generation: worker.generation, reexecuted: false, definitionsLost: true }
        await this.#store.transition(owner, operationId, ['RUNNING'], 'SUCCEEDED', result)
        return result
      } catch (error) {
        const observed = failure(error)
        const problem = { ...(combined.aborted && observed.code !== 'STOP_UNCONFIRMED'
          ? failure(new LispError('CANCELLED', 'Lisp の復旧を取り消しました。')) : observed), operationId, reexecuted: false }
        if (problem.code === 'STOP_UNCONFIRMED') this.halted(state, error)
        await this.#store.transition(owner, operationId, ['RUNNING'], problem.code === 'STOP_UNCONFIRMED' ? 'UNKNOWN' : 'FAILED', problem)
        return problem
      }
    } finally { state.active.delete(abort) }
  }
  /** Human reconciliation of one unknown external operation. It records the
   * inspected evidence, performs no dispatch and grants no replay. Restarting
   * Lisp cannot clear these, so this is the only supported exit. */
  abandonManaged(owner: LispOwner, id: string, evidence: string): Promise<unknown> {
    return this.taskAuthority.run(owner, async () => {
      this.entry(owner)
      await this.claimSession(owner)
      const operationId = identifier.parse(id)
      const note = evidence.trim()
      if (!note) fail('INVALID_INPUT', '照合した内容を evidence として指定してください。確認していない操作を終了することはできません。')
      const result = await this.#store.database(db => {
        const journal = new ManagedOperationJournal(db), operation = journal.readOperation(operationId)
        if (journal.readScope(operation.scopeId).sessionId !== owner.sessionId)
          fail('UNKNOWN_OPERATION', 'このセッションの操作記録ではありません。')
        // Human bookkeeping only: no process, file mutation, replay or task
        // execution authority. It must remain possible after the task stops.
        return journal.abandon(operationId, note)
      })
      return { ok: true, operation: { id: result.operationId, route: result.route, kind: result.kind, state: result.state, receiptRef: result.receiptRef ?? null },
        reconciliation: { recorded: true, reexecuted: false, effectsReverted: false },
        recovery: '/kioku-lisp recover で新しい Lisp を起動できます。元の外部処理は自動再実行も復元もしません。' }
    })
  }
  async abandon(owner: LispOwner, id: string): Promise<unknown> {
    await this.claimSession(owner)
    await this.stopTaskWorkers(owner.sessionId)
    const state = this.entry(owner); await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === owner.sessionId).map(([promise]) => promise))
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
    await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === owner.sessionId).map(([promise]) => promise))
    const op = await this.#store.get(owner, identifier.parse(id))
    if (!op || op.kind !== 'proposal' || !['APPLIED', 'ABANDONED'].includes(op.state)) fail('RECOVERY_REQUIRED', '適用済み、または照合して終了した操作を指定してください。')
    const original = JSON.parse(op.payload) as FrozenChange
    if (!original.backup || !under(join(this.options.dataRoot, 'backups'), original.backup) || !original.before.hash || original.before.size === undefined) fail('BACKUP_MISSING', '復元可能なバックアップがありません。')
    const abort = new AbortController(); state.active.add(abort)
    const result = this.#proposals.apply(owner, `restore:${id}`, state.worker?.generation ?? 'human-recovery', [{ operation: 'write', path: original.request.path, content: '' }], AbortSignal.any([signal, abort.signal]),
      { path: original.backup, hash: original.before.hash, size: original.before.size }).then(changes => changes[0])
    this.#executions.set(result, { sessionId: owner.sessionId, blocksRecovery: true })
    try { return await result } finally { this.#executions.delete(result); state.active.delete(abort) }
  }
  async disable(owner: LispOwner): Promise<unknown> {
    if (this.#disabling.has(owner.sessionId)) fail('BUSY', 'Lisp を停止中です。')
    this.#disabling.add(owner.sessionId)
    const states = [...this.#agents.values()].filter(state => state.owner.sessionId === owner.sessionId)
    try {
      await this.claimSession(owner)
      // Fence admissions before awaiting termination. Attempt every owned stop,
      // even when one child cannot be confirmed; never affect another session.
      for (const state of states) state.disposed = true
      const stopped = await Promise.allSettled([this.stopTaskWorkers(owner.sessionId), ...states.map(state => this.cancel(state))])
      const failed = stopped.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      await Promise.allSettled([...this.#executions].filter(([, execution]) => execution.sessionId === owner.sessionId).map(([promise]) => promise))
      // Disabling is process termination, not a declaration about past effects.
      // Keep UNKNOWN records, backups and target locks intact across re-enable.
      const pending = await this.#store.hasPending(owner.sessionId), managed = await this.managedUnresolved(owner)
      await this.#store.disable(owner.sessionId); this.enabled.delete(owner.sessionId)
      for (const [key, state] of this.#agents) if (state.owner.sessionId === owner.sessionId) this.#agents.delete(key)
      return { ok: true, state: 'DISABLED', processesStopped: true,
        reconciliationRequired: pending || managed.unknownCount > 0,
        recovery: '/kioku-lisp enable で新しい Lisp を起動できます。未確定の操作記録は保持し、自動再実行・復元はしません。' }
    } finally {
      for (const state of states) state.disposed = false
      this.#disabling.delete(owner.sessionId)
    }
  }
  async fallback(owner: LispOwner, input: { fallbackId: string; reasonCode: string; handoff: Record<string, unknown> }): Promise<unknown> {
    const forbidden = new Set(['CANCELLED','STOP','CAPABILITY_DENIED','APPROVAL_DENIED','PERMISSION_DENIED'])
    if (forbidden.has(input.reasonCode)) fail('FALLBACK_FORBIDDEN', 'Stop、取消、権限拒否は Lisp フォールバックの理由にできません。')
    const state = this.#agents.get(JSON.stringify([owner.sessionId, owner.agentId]))
    if (!state || !['RECOVERY_REQUIRED','STOP_UNCONFIRMED'].includes(state.state) && state.error?.code !== input.reasonCode)
      fail('FALLBACK_NOT_REQUIRED', '現在の Lisp は復旧不能状態として確認されていません。')
    if (state.error?.code && state.error.code !== input.reasonCode)
      fail('FALLBACK_REASON_MISMATCH', '報告された理由がホストの Lisp 障害コードと一致しません。')
    const status = await this.status(owner)
    const saved = await this.#store.listState(owner)
    const operations = await this.#store.operationSummaries(owner.sessionId, 0)
    const handoff = { ...input.handoff, lisp: { status, saved, operations: operations.operations,
      lostState: ['live stack', 'streams', 'process handles', 'generation-scoped code handles'], evidenceRetainedByHost: true } }
    const prepared = await this.#store.createFallback(owner, input.fallbackId, input.reasonCode, handoff)
    try { await this.disable(owner) }
    catch (error) { await this.#store.updateFallback(prepared.fallbackId, 'failed', { outcome: 'stop_failed', error: failure(error) }); throw error }
    return { ok: true, state: 'FALLBACK_PREPARED', fallbackId: prepared.fallbackId, reasonCode: input.reasonCode,
      handoff, compaction: { outcome: 'pending', note: 'The host will attempt compaction immediately before the next model step.' },
      continuation: 'DSH standard tools' }
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
