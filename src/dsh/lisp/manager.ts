import { mkdir, mkdtemp, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
import { applyChange, backupUsage, checkedBytes, freezeChange, restoreBytes, snapshot, under, type FrozenChange } from './files.js'

interface AgentState { owner: LispOwner; state: LispState; worker?: LispWorker; error?: ReturnType<typeof failure>; active: Set<AbortController>; admission?: Promise<LispWorker>; inputBytes?: number; compilation?: CompilationStatus }
export interface ManagerOptions {
  store: LispStore; config: LispConfiguration; dataRoot: string; library?: string; protectedRoots?: string[]; questions?: DshUserQuestions
  notify?: (owner: LispOwner, message: string) => void
  toolCall?: (owner: LispOwner, name: string, args: Record<string, unknown>) => Promise<unknown>
}
/** Host-owned authority. Worker frames never grant permissions or choose identities. */
export class LispManager {
  readonly enabled = new Map<string, string>()
  readonly #agents = new Map<string, AgentState>()
  readonly #targets = new Set<string>()
  readonly #executions = new Map<Promise<unknown>, string>()
  readonly #config: LispConfiguration
  readonly #store: LispStore
  readonly #library: string
  readonly #compiled: CompiledLispCache
  #closed = false
  #lock = false
  #backupReserved = 0
  #artifactReserved = 0
  readonly #inflight = new Map<string, string>()
  constructor(readonly options: ManagerOptions) {
    this.#config = options.config; this.#store = options.store
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
  async enable(owner: LispOwner): Promise<unknown> {
    if (!this.#config.enabled) fail('LISP_DISABLED', '設定の lisp.enabled を true にしてプラグインを再読み込みしてください。')
    if (this.#closed) fail('HOST_STOPPED', 'プラグインが停止しています。')
    if (this.enabled.has(owner.sessionId)) return this.status(owner)
    if (await realpath(owner.root) !== owner.root) fail('SCOPE_CONFLICT', '作業ディレクトリを確認できません。')
    // Persist the fence before starting any worker. A failed startup stays protected.
    await this.#store.enable(owner); this.enabled.set(owner.sessionId, owner.root)
    const state = this.entry(owner)
    await this.startWorker(state)
    return this.status(owner)
  }
  private async startWorker(state: AgentState): Promise<LispWorker> {
    if (state.admission) return state.admission
    if ([...this.#agents.values()].filter(a => a.worker?.healthy || a.admission).length >= this.#config.maxWorkers) fail('WORKER_LIMIT', 'Lisp の同時起動数が上限です。別のセッションを停止してください。')
    state.state = 'PREFLIGHT'
    state.compilation = { state: 'checking' }
    const abort = new AbortController(); state.active.add(abort)
    const admission = (async () => {
      let worker: LispWorker | undefined
      try {
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
      } catch (error) { try { await worker?.stop() } catch (stop) { error = stop }; this.halted(state, error); throw error }
    })()
    state.admission = admission
    try { return await admission } finally { delete state.admission; state.active.delete(abort) }
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
  async status(owner: LispOwner): Promise<unknown> {
    if (!this.enabled.has(owner.sessionId)) return { enabled: false, state: 'DISABLED', recovery: '/kioku-lisp enable' }
    const state = this.entry(owner)
    if (state.state === 'READY' && !state.worker?.healthy) this.halted(state, new LispError('WORKER_EXITED', 'Lisp が終了しています。新しい Lisp の起動前に状態を確認してください。'))
    return { enabled: true, state: state.state, generation: state.worker?.generation ?? null, error: state.error ?? null,
      jobs: state.worker?.jobStatus() ?? [],
      compilation: state.compilation ?? null,
      limits: { timeoutMs: this.#config.timeoutMs, maxOutputBytes: this.#config.maxOutputBytes, maxWorkers: this.#config.maxWorkers,
        aggregateMemory: 'unavailable', aggregateCpu: 'unavailable', scratchQuota: 'unavailable', termination: 'supervised', fileBoundary: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap' },
      operations: (await this.#store.operations(owner.sessionId)).map(o => ({ id: o.operation_id, agent: o.agent_id, kind: o.kind, state: o.state, updatedAt: o.updated_at })),
      recovery: state.state === 'READY' ? null : '停止理由と操作履歴を確認し、/kioku-lisp recover を実行してください。' }
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
    const finished = () => { this.#executions.delete(result); if (key) this.#inflight.delete(key) }
    void result.then(finished, finished)
    return result
  }
  private async dispatch(owner: LispOwner, tool: LispTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      if (tool === 'lisp_status') return await this.status(owner)
      const state = this.entry(owner)
      if (tool === 'lisp_describe' && !input.symbol) return { ok: true, source: 'bundled', state: state.state,
        packages: ['kioku.tools', 'kioku.process', 'kioku.files', 'kioku.data', 'kioku.objects', 'kioku.environment'],
        guide: await readFile(fileURLToPath(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url)), 'utf8') }
      if (tool === 'lisp_cancel') {
        if (input.operationId !== undefined) {
          const id = identifier.parse(input.operationId), hash = digest(input), old = await this.#store.get(owner, id)
          if (old) { if (old.kind !== tool || old.digest !== hash) fail('ID_CONFLICT', '取消 ID の内容が異なります。'); return this.replay(old) }
          if (input.generation !== state.worker?.generation) fail('STALE_GENERATION', '取消対象の Lisp 世代は現在のものではありません。')
          await this.#store.reserve(owner, id, tool, hash, state.worker!.generation, input)
          await this.cancel(state)
          const result = { ok: true, state: state.state }
          await this.#store.transition(owner, id, ['RUNNING'], 'SUCCEEDED', result)
          return result
        }
        await this.cancel(state); return { ok: true, state: state.state }
      }
      if (this.#closed) fail('HOST_STOPPED', 'Lisp のホストが停止しています。')
      const id = identifier.parse(input.operationId)
      const hash = digest({ tool, input })
      const old = await this.#store.get(owner, id)
      if (old) {
        if (old.digest !== hash || old.kind !== tool) fail('ID_CONFLICT', '同じ操作 ID の内容を変えることはできません。')
        return this.replay(old)
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
      try {
        let args: Record<string, unknown>, timeout = this.#config.timeoutMs
        const payload: Record<string, unknown> = { request: input, policyVersion: 1 }
        if (tool === 'lisp_eval') {
          const parsed = EvalInput.parse({ code: input.code, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), inputs: input.inputs ?? [] })
          timeout = parsed.timeoutMs ?? timeout
          const inputs: string[] = []
          const snapshots = []
          for (const path of parsed.inputs) {
            const before = await snapshot(owner.root, path, this.protectedRoots())
            if (!before.exists) fail('INPUT_MISSING', '入力ファイルがありません。')
            if ((state.inputBytes ?? 0) + before.size! > 256 * 1024 ** 2) fail('INPUT_LIMIT', 'この Lisp 世代の入力コピーが 256 MiB を超えます。状態を確認して reset してください。')
            state.inputBytes = (state.inputBytes ?? 0) + before.size!
            const target = join(worker.layout.inputs, randomUUID())
            await writeFile(target, await checkedBytes(before), { flag: 'wx', mode: 0o400 }); inputs.push(target)
            snapshots.push({ source: before, input: target })
          }
          payload.snapshots = snapshots
          args = { code: parsed.code, inputs }
        } else args = tool === 'lisp_describe' ? { symbol: typeof input.symbol === 'string' ? input.symbol : '' } : { ref: identifier.parse(input.ref) }
        await this.#store.reserve(owner, id, tool, hash, worker.generation, payload); reserved = true
        const response = await worker.request(tool === 'lisp_eval' ? 'eval' : tool === 'lisp_describe' ? 'describe' : 'inspect', args, timeout, combined)
        const result = { ok: response.ok, operationId: id, value: response.value, output: worker.output(), generation: worker.generation, proposals: response.proposals }
        await this.#store.transition(owner, id, ['RUNNING'], response.ok ? 'SUCCEEDED' : 'FAILED', result)
        state.state = 'READY'
        if (!response.ok) return result
        const applied = []
        for (const proposal of response.proposals) {
          combined.throwIfAborted()
          applied.push(await this.proposal(state, id, proposal, combined))
        }
        const finished = { ...result, changes: applied }
        await this.#store.transition(owner, id, ['SUCCEEDED'], 'SUCCEEDED', finished)
        return finished
      } catch (error) {
        if (reserved) {
          // Close admission before attempting a potentially failing journal write.
          state.state = 'STOPPING'
          try { await worker.stop() } catch (stop) { error = stop }
          this.halted(state, error)
          try {
            const current = await this.#store.get(owner, id)
            if (current?.state === 'RUNNING') await this.#store.transition(owner, id, ['RUNNING'], 'UNKNOWN', failure(error))
          } catch (journal) { this.halted(state, journal) }
        } else if (!worker.healthy) { try { await worker.stop() } catch (stop) { error = stop }; this.halted(state, error) }
        else if (state.state === 'EVALUATING') state.state = 'READY'
        throw error
      } finally { state.active.delete(abort) }
    } catch (error) { return failure(error) }
  }
  private replay(old: import('./store.js').Operation): unknown {
    return { replay: true, operationId: old.operation_id, state: old.state,
      code: old.state === 'RUNNING' ? 'IN_PROGRESS' : !old.result && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(old.state) ? 'RESULT_EXPIRED' : old.state,
      result: old.result ? JSON.parse(old.result) : null, recovery: ['RUNNING', 'UNKNOWN'].includes(old.state) ? '/kioku-lisp status で確認してください。自動再実行はしません。' : null }
  }
  private async proposal(state: AgentState, evalId: string, request: FrozenChange['request'], signal: AbortSignal, restoration?: FrozenChange['restoration']): Promise<unknown> {
    const owner = state.owner
    const root = join(this.options.dataRoot, 'backups')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const change = await freezeChange(owner, request, root, this.protectedRoots())
    if (restoration) { await restoreBytes(restoration); change.restoration = restoration }
    const target = change.before.path
    if (this.#targets.has(target)) fail('TARGET_LOCKED', 'このファイルには処理中の変更があります。')
    this.#targets.add(target)
    const id = `proposal-${change.id}`
    let reservation = 0
    try {
      if ((await this.#store.pendingTargets()).some(o => (JSON.parse(o.payload) as FrozenChange).before.path === target)) fail('TARGET_LOCKED', 'このファイルには未確定の変更があります。先に照合してください。')
      await this.#store.reserve(owner, id, 'proposal', digest(change), state.worker?.generation ?? 'human-recovery', change)
      if (request.operation === 'delete' || change.before.exists || restoration) {
        await this.#store.transition(owner, id, ['RUNNING'], 'AWAITING_APPROVAL', { evalId })
        const approved = await this.approve(owner, id, change, signal)
        if (!approved || signal.aborted || this.#closed) {
          await this.#store.transition(owner, id, ['AWAITING_APPROVAL'], 'NOT_APPLIED', { reason: '許可されていないため実行しませんでした。' })
          return { id, state: 'NOT_APPLIED' }
        }
      }
      signal.throwIfAborted()
      // The cap includes every session. No pruning or silent removal of backups.
      reservation = change.before.size ?? 0; this.#backupReserved += reservation
      if (await backupUsage(root) + this.#backupReserved > 1024 ** 3) fail('BACKUP_LIMIT', 'バックアップが 1 GiB に達します。利用者が保存内容を確認するまで変更を停止します。')
      await this.#store.transition(owner, id, ['RUNNING', 'AWAITING_APPROVAL'], 'APPLYING', { evalId })
      await applyChange(owner, change, this.protectedRoots())
      await this.#store.transition(owner, id, ['APPLYING'], 'APPLIED', { path: request.path, operation: request.operation, backup: change.backup })
      return { id, state: 'APPLIED', path: request.path, backup: change.backup }
    } catch (error) {
      const old = await this.#store.get(owner, id)
      if (old && ['RUNNING', 'AWAITING_APPROVAL', 'APPLYING'].includes(old.state)) {
        await this.#store.transition(owner, id, [old.state], old.state === 'APPLYING' ? 'UNKNOWN' : 'NOT_APPLIED', failure(error))
        if (old.state === 'APPLYING') { await state.worker?.stop(); this.halted(state, error) }
      }
      throw error
    } finally { this.#targets.delete(target); this.#backupReserved -= reservation }
  }
  private async approve(owner: LispOwner, id: string, change: FrozenChange, signal: AbortSignal): Promise<boolean> {
    if (!this.options.questions || signal.aborted) return false
    const label = change.request.operation === 'delete' ? 'このファイルの削除を許可' : 'このファイルの置換を許可'
    const questionAbort = new AbortController()
    const combined = AbortSignal.any([signal, questionAbort.signal])
    const timer = setTimeout(() => questionAbort.abort(), 300000)
    let onAbort: (() => void) | undefined
    try {
      const answer = await Promise.race([this.options.questions.ask({ agent: { id: owner.agentId }, signal: combined,
        questions: [{ id, header: 'Lisp · ファイル変更の確認', question: `${change.request.operation === 'delete' ? '削除' : '置換'}を許可しますか？`,
          detail: `対象: ${change.before.path}\n現在の内容: SHA-256 ${change.before.hash ?? '(なし)'}\n容量: ${change.before.size ?? 0} bytes\n${change.restoration ? `復元元: ${change.restoration.path}\n復元内容 SHA-256: ${change.restoration.hash}\n容量: ${change.restoration.size} bytes\n` : change.request.operation === 'write' ? `新しい内容:\n${change.request.content.slice(0, 6000)}\n新内容 SHA-256: ${digest(change.request.content)}\n` : ''}変更前のファイルは ${change.backup ?? '(新規ファイルのため不要)'} に保存します。拒否・取消・無回答では実行しません。`,
          options: [{ label: '許可しない' }, { label }], intent: { kind: 'plan-review', approve: label } }] }),
        new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true }) })])
      return !!answer && !combined.aborted && answer.answers.length === 1 && answer.answers[0]?.id === id && !answer.answers[0].custom && answer.answers[0].selected.length === 1 && answer.answers[0].selected[0] === label
    } catch { return false }
    finally { clearTimeout(timer); if (onAbort) combined.removeEventListener('abort', onAbort) }
  }
  private async cancel(state: AgentState): Promise<void> {
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
    for (const op of pending) await this.#store.transition({ ...owner, agentId: op.agent_id }, op.operation_id, [op.state], 'ABANDONED', { humanRecovery: true })
    signal?.throwIfAborted()
    await this.startWorker(state)
    return this.status(owner)
  }
  async abandon(owner: LispOwner, id: string): Promise<unknown> {
    const state = this.entry(owner); await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    const op = await this.#store.get(owner, identifier.parse(id))
    if (!op || !['UNKNOWN', 'APPLYING', 'AWAITING_APPROVAL', 'RUNNING'].includes(op.state)) fail('STATE_CONFLICT', 'この操作は未確定ではありません。')
    await this.#store.transition(owner, id, [op.state], 'ABANDONED', { humanAbandoned: true, reapply: false })
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
    const result = this.proposal(state, `restore:${id}`, { operation: 'write', path: original.request.path, content: '' }, AbortSignal.any([signal, abort.signal]),
      { path: original.backup, hash: original.before.hash, size: original.before.size })
    this.#executions.set(result, owner.sessionId)
    try { return await result } finally { this.#executions.delete(result); state.active.delete(abort) }
  }
  async disable(owner: LispOwner): Promise<unknown> {
    for (const state of this.#agents.values()) if (state.owner.sessionId === owner.sessionId) await this.cancel(state)
    await Promise.allSettled([...this.#executions].filter(([, session]) => session === owner.sessionId).map(([promise]) => promise))
    if ((await this.#store.operations(owner.sessionId)).some(o => ['RUNNING', 'APPLYING', 'UNKNOWN', 'AWAITING_APPROVAL'].includes(o.state))) fail('RECOVERY_REQUIRED', '未確定の処理を /kioku-lisp recover で確認してから解除してください。')
    await this.#store.disable(owner.sessionId); this.enabled.delete(owner.sessionId)
    return { ok: true, state: 'DISABLED' }
  }
  async dispose(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#agents.values()].map(state => this.cancel(state)))
    await Promise.allSettled([...this.#executions.keys(), ...[...this.#agents.values()].map(state => state.admission)])
    if (this.#lock) { await unlink(join(this.options.dataRoot, 'host.lock')); this.#lock = false }
  }
}
