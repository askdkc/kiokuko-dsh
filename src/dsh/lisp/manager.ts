import { mkdir, mkdtemp, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { DshUserQuestions } from '../user-interaction.js'
import { EvalInput, LispError, digest, fail, failure, identifier, type LispConfiguration, type LispOwner, type LispState, type LispTool } from './contracts.js'
import { LispStore } from './store.js'
import { LispWorker } from './worker.js'
import { prepareLayout } from './sandbox.js'
import { verifyLispVendor } from './integrity.js'
import { CompiledLispCache, type CompilationStatus } from './compiled-cache.js'
import { backupUsage, checkedBytes, snapshot, under, type FrozenChange } from './files.js'
import { describeVerifiers, type LispCiRequest } from './ci.js'
import { LispProposalBatch } from './proposal-batch.js'
import { inspectSavedResult } from './inspection.js'
import { recordedResult } from './recorded-result.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { AttachmentInput } from './attachment-input.js'

interface AgentState { owner: LispOwner; state: LispState; worker?: LispWorker; error?: ReturnType<typeof failure>; active: Set<AbortController>; admission?: Promise<LispWorker>; inputBytes?: number; compilation?: CompilationStatus
  slotReserved?: boolean; hostBusy?: boolean; idleSince?: number; idleTimer?: ReturnType<typeof setTimeout>; suspension?: Promise<void>; resumed?: boolean; disposed?: boolean }
export interface ManagerOptions {
  skillPrompts?: DshSkillPrompts
  store: LispStore; config: LispConfiguration; dataRoot: string; library?: string; protectedRoots?: string[]; questions?: DshUserQuestions
  notify?: (owner: LispOwner, message: string) => void
  toolCall?: (owner: LispOwner, name: string, args: Record<string, unknown>) => Promise<unknown>
  ciCall?: (owner: LispOwner, request: LispCiRequest, signal: AbortSignal) => Promise<unknown>
  attachmentInput?: (owner: LispOwner, path: string, signal: AbortSignal) => AttachmentInput
}
/** Host-owned authority. Worker frames never grant permissions or choose identities. */
export class LispManager {
  readonly enabled = new Map<string, string>()
  readonly #agents = new Map<string, AgentState>()
  readonly #proposals: LispProposalBatch
  readonly #executions = new Map<Promise<unknown>, string>()
  readonly #config: LispConfiguration
  readonly #store: LispStore
  readonly #library: string
  readonly #compiled: CompiledLispCache
  #closed = false
  #lock = false
  #artifactReserved = 0
  #admissionQueue: Promise<void> = Promise.resolve()
  readonly #inflight = new Map<string, string>()
  constructor(readonly options: ManagerOptions) {
    this.#config = options.config; this.#store = options.store
    this.#proposals = new LispProposalBatch({ store: options.store, backupRoot: join(options.dataRoot, 'backups'), protectedRoots: () => this.protectedRoots(), ...(options.questions ? { questions: options.questions } : {}), stopped: () => this.#closed })
    this.#library = options.library ?? fileURLToPath(new URL('../../../lisp/', import.meta.url))
    this.#compiled = new CompiledLispCache(join(options.dataRoot, 'compiled'), this.#library, this.#config)
  }
  async start(): Promise<void> {
    await verifyLispVendor(this.#library)
    await mkdir(this.options.dataRoot, { recursive: true, mode: 0o700 })
    const lockPath = join(this.options.dataRoot, 'host.lock')
    try {
      const lock = await open(lockPath, 'wx', 0o600)
      try { await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); this.#lock = true } finally { await lock.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const saved = JSON.parse(await readFile(lockPath, 'utf8')) as {pid: number}
      if (!Number.isInteger(saved.pid) || saved.pid < 1) fail('HOST_LOCK', 'Lisp のホストロックが破損しています。')
      try { process.kill(saved.pid, 0); fail('HOST_LOCK', '別のホストが Lisp の状態を使用中です。') }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check }
      await unlink(lockPath)
      const lock = await open(lockPath, 'wx', 0o600)
      try { await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); this.#lock = true } finally { await lock.close() }
    }
    try {
      await this.#store.expireResults()
      for (const session of await this.#store.start()) this.enabled.set(session.session_id, session.root_path)
    } catch (error) { await unlink(lockPath); this.#lock = false; throw error }
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
  async enable(owner: LispOwner, hostBusy = false, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
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
  private async startWorker(state: AgentState): Promise<LispWorker> {
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
        worker = new LispWorker(layout, this.#config, (method, args) => this.bridge(state, method, args))
        state.worker = worker
        if (this.#closed || state.state !== 'PREFLIGHT' || abort.signal.aborted) fail('CANCELLED', '起動は取り消されています。')
        await worker.start()
        // Real runtime probe: private host file is outside every granted read/write root.
        const canary = join(base, 'host-canary')
        await writeFile(canary, 'protected', { mode: 0o600 })
        const quote = (value: string) => JSON.stringify(value)
        const probe = await worker.request('eval', { inputs: [], code: `(let ((read-denied (handler-case (progn (with-open-file (s ${quote(canary)}) (read-char s)) nil) (file-error () t))) (delete-denied (handler-case (progn (delete-file ${quote(canary)}) nil) (file-error () t)))) (unless (and read-denied delete-denied) (error "ISOLATION_FAILED")) (kioku.files:write-text (merge-pathnames "probe" (kioku.files:scratch)) "ok") :protected)` }, this.#config.startupTimeoutMs)
        if (!probe.ok || await readFile(canary, 'utf8') !== 'protected') fail('ISOLATION_FAILED', 'OS によるファイル保護を確認できません。')
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
      if (occupied() >= this.#config.maxWorkers) {
        const candidates = [...this.#agents.values()].filter(a => a !== state && this.canSuspend(a)).sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))
        for (const candidate of candidates) {
          await this.suspend(candidate)
          if (occupied() < this.#config.maxWorkers) break
        }
      }
      if (occupied() >= this.#config.maxWorkers) throw new LispError('WORKER_LIMIT', 'Lisp の起動枠はすべて使用中です。待機中の Lisp は自動で停止します。', '実行中の処理が終わってから、もう一度依頼してください。')
      if (this.#closed || state.disposed || state.state !== 'PREFLIGHT') fail('CANCELLED', 'Lisp の起動を取り消しました。')
      state.slotReserved = true
    })
    this.#admissionQueue = allocation.catch(() => {})
    return allocation
  }
  private canSuspend(state: AgentState): boolean {
    return !this.#closed && !state.disposed && state.state === 'READY' && !state.hostBusy && !state.admission && state.active.size === 0
      && Boolean(state.worker?.healthy) && !state.worker?.hasRunningJobs
  }
  private scheduleIdle(state: AgentState): void {
    clearTimeout(state.idleTimer)
    if (this.#closed || state.disposed || state.state !== 'READY' || state.hostBusy || state.admission || state.active.size) return
    state.idleSince = Date.now()
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
        const pending = (await this.#store.operations(state.owner.sessionId)).some(o => ['RUNNING', 'APPLYING', 'UNKNOWN', 'AWAITING_APPROVAL'].includes(o.state))
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
    const states = [...this.#agents.values()].filter(state => state.owner.sessionId === sessionId)
    const resumable = states.filter(state => state.state === 'READY' || state.state === 'SUSPENDED')
    for (const state of states) { state.disposed = true; clearTimeout(state.idleTimer) }
    const stopped = await Promise.allSettled(states.map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === sessionId).map(([promise]) => promise))
    const pending = (await this.#store.operations(sessionId)).some(o => ['RUNNING', 'APPLYING', 'UNKNOWN', 'AWAITING_APPROVAL'].includes(o.state))
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
  private async bridge(state: AgentState, method: string, args: unknown): Promise<unknown> {
    if (state.state !== 'EVALUATING' || !state.worker?.healthy || this.#closed) fail('STALE_RPC', '現在の評価に属さない要求です。')
    if (method === 'tools-list') return this.options.toolCall ? [{ name: 'lisp_status', parameters: { type: 'object', additionalProperties: false }, effects: 'read-only', adapterVersion: 1 }] : []
    if (method === 'tool-call') {
      const parsed = z.object({ name: z.literal('lisp_status'), args: z.object({}).strict() }).strict().parse(args)
      if (!this.options.toolCall) fail('HOST_ADAPTER_UNAVAILABLE', 'このホストには監査済みアダプターがありません。')
      return this.options.toolCall(state.owner, parsed.name, parsed.args)
    }
    if (method === 'ci-list-runs' || method === 'ci-failed-log' || method === 'ci-verify') {
      if (!this.options.ciCall) fail('HOST_ADAPTER_UNAVAILABLE', 'このホストには CI アダプターがありません。')
      const request: LispCiRequest = method === 'ci-list-runs'
        ? { kind: 'list-runs', ...z.object({ limit: z.number().int().min(1).max(20) }).strict().parse(args) }
        : method === 'ci-failed-log'
          ? { kind: 'failed-log', ...z.object({ runId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().parse(args) }
          : { kind: 'verify', ...z.object({ target: z.enum(['typecheck', 'lisp', 'test', 'build', 'package', 'vendor']), script: z.string().min(1).max(256).optional() }).strict().parse(args) }
      const active = [...state.active]
      if (active.length !== 1) fail('HOST_STATE', 'CI 呼び出しの実行主体を一意に確認できません。')
      return this.options.ciCall(state.owner, request, active[0]!.signal)
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
      if ((await this.#store.operations(state.owner.sessionId)).filter(o => o.kind === 'artifact').length >= 1000) fail('ARTIFACT_LIMIT', 'このセッションの成果物数が上限です。')
      const id = `artifact-${randomUUID()}`, target = join(root, id)
      await this.#store.reserve(state.owner, id, 'artifact', digest(source), state.worker.generation, { source, target })
      const file = await open(target, 'wx', 0o600)
      try { await file.writeFile(await checkedBytes(source)); await file.sync() } finally { await file.close() }
      const result = { id, size: source.size, hash: source.hash, path: target, appliedToProject: false }
      await this.#store.transition(state.owner, id, ['RUNNING'], 'SUCCEEDED', result)
      return result
      } finally { this.#artifactReserved -= reservation }
    }
    fail('UNKNOWN_ADAPTER', 'このホスト要求には対応していません。')
  }
  async status(owner: LispOwner, offset?: number): Promise<unknown> {
    if (!this.enabled.has(owner.sessionId)) return { enabled: false, state: 'DISABLED', recovery: '/kioku-lisp enable' }
    const state = this.entry(owner)
    if (state.state === 'READY' && !state.worker?.healthy) this.halted(state, new LispError('WORKER_EXITED', 'Lisp が終了しています。新しい Lisp の起動前に状態を確認してください。'))
    const operations = (await this.#store.operations(owner.sessionId)).map(o => ({ id: o.operation_id, agent: o.agent_id, kind: o.kind, state: o.state, updatedAt: o.updated_at }))
    const pending = operations.filter(o => ['RUNNING', 'UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL'].includes(o.state))
    return { enabled: true, state: state.state, generation: state.worker?.generation ?? null, error: state.error ?? null,
      jobs: state.worker?.jobStatus() ?? [],
      compilation: state.compilation ?? null, resumed: state.resumed ?? false,
      limits: { timeoutMs: this.#config.timeoutMs, maxOutputBytes: this.#config.maxOutputBytes, maxWorkers: this.#config.maxWorkers, idleTimeoutMs: this.#config.idleTimeoutMs,
        aggregateMemory: 'unavailable', aggregateCpu: 'unavailable', scratchQuota: 'unavailable', termination: 'supervised', fileBoundary: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap' },
      operations: offset === undefined ? operations : operations.slice(offset, offset + 10),
      ...(offset === undefined ? {} : { operationCount: operations.length, pendingCount: pending.length, pendingStates: Object.fromEntries([...new Set(pending.map(o => o.state))].map(state => [state, pending.filter(o => o.state === state).length])), offset, nextOffset: offset + 10 < operations.length ? offset + 10 : null }),
      recovery: state.state === 'SUSPENDED' ? 'Lisp は休止中です。次の利用時に自動起動します。変数・関数定義は保持されません。' : state.state === 'READY' ? null : '停止理由と操作履歴を確認し、/kioku-lisp recover を実行してください。' }
  }
  async diagnostics(owner: LispOwner, id?: string): Promise<unknown> {
    this.entry(owner)
    if (id) {
      const operation = await this.#store.get(owner, identifier.parse(id))
      if (!operation) fail('UNKNOWN_OPERATION', 'この主体の操作記録がありません。')
      return { ...operation, payload: JSON.parse(operation.payload), result: operation.result ? JSON.parse(operation.result) : null }
    }
    const operations = await this.#store.operations(owner.sessionId)
    return { ...await this.status(owner) as object,
      changes: operations.filter(o => o.kind === 'proposal').slice(0, 100).map(o => ({ id: o.operation_id, state: o.state, details: JSON.parse(o.payload), result: o.result ? JSON.parse(o.result) : null })),
      inspect: '/kioku-lisp diagnostics OPERATION_ID で各操作の全内容を確認できます。' }
  }
  execute(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const key = typeof input.operationId === 'string' ? JSON.stringify([owner.sessionId, owner.agentId, input.operationId]) : undefined
    const hash = digest({ tool, input }), pending = key ? this.#inflight.get(key) : undefined
    if (pending) return Promise.resolve(pending === hash ? { replay: true, code: 'IN_PROGRESS', state: 'RUNNING' } : failure(new LispError('ID_CONFLICT', '実行中の操作 ID に異なる入力があります。')))
    if (key) this.#inflight.set(key, hash)
    const result = this.dispatch(owner, tool, input, signal)
    this.#executions.set(result, owner.sessionId)
    const finished = () => {
      this.#executions.delete(result); if (key) this.#inflight.delete(key)
      if (tool !== 'lisp_status' && this.enabled.has(owner.sessionId)) this.scheduleIdle(this.entry(owner))
    }
    void result.then(finished, finished)
    return result
  }
  private async dispatch(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      if (tool === 'lisp_status') return await this.status(owner, z.number().int().nonnegative().parse(input.offset ?? 0))
      const state = this.entry(owner)
      if (tool === 'lisp_describe' && !input.symbol) return { ok: true, source: 'bundled', state: state.state,
        packages: ['kioku.tools', 'kioku.process', 'kioku.files', 'kioku.data', 'kioku.objects', 'kioku.environment', 'kioku.ci'],
        api: { scratch: '(kioku.files:scratch) takes no arguments', splitLines: 'kioku.process:split-lines returns a vector; use loop across',
          inspect: 'lisp_inspect accepts ref, or resultOperationId with section/offset/limit (Unicode characters). Never rerun to retrieve output.',
          reads: 'Use native read/glob/grep/skill for repository exploration.', verify: '(kioku.ci:verify :test :script "test:unit") runs an existing focused npm script.' },
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
        if (input.operationId !== undefined) {
          const id = identifier.parse(input.operationId), hash = digest(input), old = await this.#store.get(owner, id)
          if (old) { if (old.kind !== tool || old.digest !== hash) fail('ID_CONFLICT', '取消 ID の内容が異なります。'); return await this.replay(owner, old) }
          if (input.generation !== state.worker?.generation) fail('STALE_GENERATION', '取消対象の Lisp 世代は現在のものではありません。')
          await this.#store.reserve(owner, id, tool, hash, state.worker!.generation, input)
          await this.cancel(state)
          const result = { ok: true, state: state.state }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        }
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
      if (state.suspension || state.state === 'SUSPENDED') {
        const prepared = await this.prepare(owner) as { state: string }
        if (prepared.state !== 'READY') fail('RECOVERY_REQUIRED', 'Lisp の停止状態を確認してください。')
        return { ok: false, code: 'WORKER_RESUMED', generation: state.worker?.generation, executed: false,
          message: '休止中の Lisp を自動起動しました。以前の変数・関数・参照は失われています。必要な定義を作り直してから実行してください。この要求のコードは実行していません。過去の副作用を再実行しないでください。' }
      }
      if (tool === 'lisp_reset') {
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
        const response = await worker.request(tool === 'lisp_eval' ? 'eval' : tool === 'lisp_describe' ? 'describe' : 'inspect', args, timeout, combined)
        const result = { ok: response.ok, operationId: id, value: response.value, output: worker.output(), generation: worker.generation, proposals: response.proposals }
        evidence = { ...result, state: response.ok ? 'RUNNING' : 'FAILED' }
        await this.#store.transition(owner, id, ['RUNNING'], response.ok ? 'RUNNING' : 'FAILED', evidence)
        if (!response.ok) { state.state = 'READY'; return result }
        const applied = await this.#proposals.apply(owner, id, worker.generation, response.proposals, combined)
        const uncertain = applied.some(change => change.state === 'UNKNOWN')
        if (uncertain) { await worker.stop(); this.halted(state, new LispError('RECONCILIATION_REQUIRED', '変更結果が未確定です。記録とバックアップを照合してください。')) }
        else if (state.state === 'EVALUATING') state.state = 'READY'
        const complete = applied.every(change => change.state === 'APPLIED' || change.state === 'UNCHANGED')
        const finished = { ...result, ok: complete, state: uncertain ? 'UNKNOWN' : complete ? 'SUCCEEDED' : 'FAILED', changes: applied }
        evidence = finished
        await this.#store.transition(owner, id, ['RUNNING'], finished.state, finished)
        return finished
      } catch (error) {
        let outcome: Record<string, unknown> = { ...evidence, ...failure(error), operationId: id, state: reserved ? 'UNKNOWN' : 'FAILED' }
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
      } finally { state.active.delete(abort) }
    } catch (error) { return failure(error) }
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
      await state.worker?.stop()
      if (state.admission) {
        try { await state.admission } catch (error) { if (error instanceof LispError && error.code === 'STOP_UNCONFIRMED') throw error }
      }
      this.#compiled.assertStopped()
      state.state = 'RECOVERY_REQUIRED'
    }
    catch (error) { this.halted(state, error); throw error }
  }
  async recover(owner: LispOwner, signal?: AbortSignal): Promise<unknown> {
    const state = this.entry(owner)
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
    await this.startWorker(state)
    return this.status(owner)
  }
  async abandon(owner: LispOwner, id: string): Promise<unknown> {
    const state = this.entry(owner); await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    const op = await this.#store.get(owner, identifier.parse(id))
    if (!op || !['UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL', 'RUNNING'].includes(op.state)) fail('STATE_CONFLICT', 'この操作は未確定ではありません。')
    await this.#store.transition(owner, id, [op.state], 'ABANDONED', { ...await recordedResult(this.#store, owner, op), ok: false, state: 'ABANDONED', humanAbandoned: true, reapply: false })
    return { ok: true, recovery: '/kioku-lisp recover で新しい Lisp を起動できます。ファイルを自動復元・再適用しません。' }
  }
  async restore(owner: LispOwner, id: string, signal: AbortSignal): Promise<unknown> {
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
    for (const state of this.#agents.values()) if (state.owner.sessionId === owner.sessionId) await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    if ((await this.#store.operations(owner.sessionId)).some(o => ['RUNNING', 'APPLYING', 'UNKNOWN', 'AWAITING_APPROVAL'].includes(o.state))) fail('RECOVERY_REQUIRED', '未確定の処理を /kioku-lisp recover で確認してから解除してください。')
    await this.#store.disable(owner.sessionId); this.enabled.delete(owner.sessionId)
    for (const [key, state] of this.#agents) if (state.owner.sessionId === owner.sessionId) this.#agents.delete(key)
    return { ok: true, state: 'DISABLED' }
  }
  async dispose(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#agents.values()].map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions.keys(), ...[...this.#agents.values()].map(state => state.admission)])
    if (this.#lock) { await unlink(join(this.options.dataRoot, 'host.lock')); this.#lock = false }
  }
}
