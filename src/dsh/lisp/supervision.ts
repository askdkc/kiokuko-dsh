import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompiledLispCache, type CompilationStatus } from './compiled-cache.js'
import { LispError, type LispConfiguration, type WorkerResult } from './contracts.js'
import { prepareLayout } from './sandbox.js'
import { LispWorker } from './worker.js'
import { installedLispRuntime } from './installed-runtime.js'

interface WorkerAssignment {
  signal: AbortSignal
  assertCurrent(): void
  workspace?: string
  executionMode: LispConfiguration['executionMode']
  compilation?(status: CompilationStatus): void
  assigned(worker: LispWorker): void
  failed?(worker: LispWorker, error: Error): void
  inspect(worker: LispWorker, code: string): Promise<WorkerResult>
  hostCall?: ConstructorParameters<typeof LispWorker>[2]
  rpcAllowed?: ConstructorParameters<typeof LispWorker>[3]
  beforeJob?: ConstructorParameters<typeof LispWorker>[4]
  auditJob?: ConstructorParameters<typeof LispWorker>[5]
}

/** One host owns admission, startup and confirmed release for every Lisp child.
 * The operation journals remain in LispManager; this supervisor never replays work. */
export class LispSupervisor {
  readonly #children = new Map<object, LispWorker | undefined>()
  readonly #restarts = new WeakMap<object, number[]>()
  readonly #compiled: CompiledLispCache
  constructor(readonly config: LispConfiguration, readonly dataRoot: string, readonly library: string) {
    this.#compiled = new CompiledLispCache(join(dataRoot, 'compiled'), library, config)
  }

  async start(owner: object, assignment: WorkerAssignment): Promise<LispWorker> {
    assignment.assertCurrent()
    // Reserve synchronously, before compilation or filesystem awaits. A broken
    // child retains its slot until the OS confirms it and its jobs have stopped.
    for (const [key, child] of this.#children) if (child?.stopped) this.#children.delete(key)
    if (this.#children.has(owner)) throw new LispError('BUSY', 'この所有者の Lisp は起動中または実行中です。')
    if (this.#children.size >= this.config.maxWorkers)
      throw new LispError('WORKER_LIMIT', 'Lisp の起動枠はすべて使用中です。既存の worker と状態は保持します。')
    this.#children.set(owner, undefined)
    let worker: LispWorker | undefined
    try {
      const installed = await installedLispRuntime(this.library)
      const compiled = installed ?? await this.#compiled.ensure(assignment.signal, status => assignment.compilation?.(status))
      if (installed) assignment.compilation?.({ state: 'ready', key: installed.key, reused: true, prepareMs: installed.prepareMs })
      assignment.assertCurrent()
      const base = await mkdtemp(join(this.dataRoot, 'w-'))
      const layout = await prepareLayout(base, this.library)
      layout.compiled = compiled.path
      if (installed) layout.runtimeExecutable = installed.executable
      if (assignment.workspace) layout.workspace = assignment.workspace
      layout.protected = true
      assignment.assertCurrent()
      worker = new LispWorker(layout, { ...this.config, executionMode: assignment.executionMode },
        assignment.hostCall, assignment.rpcAllowed, assignment.beforeJob, assignment.auditJob,
        error => { if (worker) assignment.failed?.(worker, error) })
      assignment.assigned(worker)
      await worker.start()
      this.#children.set(owner, worker)
      assignment.assertCurrent()
      const canary = join(base, 'host-canary')
      await writeFile(canary, 'protected', { mode: 0o600 })
      const path = JSON.stringify(canary)
      const probe = await assignment.inspect(worker, `(let ((read-denied (handler-case (progn (with-open-file (s ${path}) (read-char s)) nil) (file-error () t))) (delete-denied (handler-case (progn (delete-file ${path}) nil) (file-error () t)))) (unless (and read-denied delete-denied) (error "ISOLATION_FAILED")) (kioku.files:write-text (merge-pathnames "probe" (kioku.files:scratch)) "ok") :protected)`)
      if (!probe.ok || await readFile(canary, 'utf8') !== 'protected')
        throw new LispError('ISOLATION_FAILED', 'OS によるファイル保護を確認できません。')
      assignment.assertCurrent()
      return worker
    } catch (error) {
      if (worker) {
        // Keep the exact child even when startup or termination is unconfirmed.
        this.#children.set(owner, worker)
        await this.stop(worker)
      } else this.#children.delete(owner)
      throw error
    }
  }

  async stop(worker: LispWorker | undefined): Promise<void> {
    if (!worker) return
    await worker.stop()
    for (const [owner, child] of this.#children) if (child === worker) this.#children.delete(owner)
  }

  /** Bound fault replacements, not ordinary idle/cold starts. No retry timer or queue. */
  admitRestart(owner: object): boolean {
    const now = Date.now(), recent = (this.#restarts.get(owner) ?? []).filter(at => now - at < 60_000)
    if (recent.length >= 2) return false
    this.#restarts.set(owner, [...recent, now])
    return true
  }

  assertCompilationStopped(): void { this.#compiled.assertStopped() }
}
