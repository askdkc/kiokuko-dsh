import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { FRAME_BYTES, LispError, WorkerFrame, failure, type LispConfiguration, type WorkerResult } from './contracts.js'
import { sandboxLaunch, type SandboxLayout } from './sandbox.js'

const Rpc = z.object({ version: z.literal(1), type: z.literal('rpc'), id: z.string().max(256), request: z.string(), method: z.enum(['run', 'start-job', 'job-status', 'cancel-job', 'tools-list', 'tool-call', 'artifact', 'ci-list-runs', 'ci-failed-log', 'ci-verify']), arguments: z.unknown() }).strict()
const Program = z.object({ program: z.string().min(1).max(4096), argv: z.array(z.string().max(262144)).max(128), timeoutMs: z.number().int().min(100).max(600000), directory: z.string().min(1).max(4096).optional() }).strict()
interface Job { child: ChildProcess; done: Promise<void>; settled?: boolean; result?: { code: number | null; signal: string | null; stdout: string; stderr: string }; error?: string }
interface Pending { id: string; resolve: (r: WorkerResult) => void; reject: (e: unknown) => void }
/** A worker has one evaluation slot; cancellation never waits for that slot. */
export class LispWorker {
  readonly generation = randomUUID()
  readonly jobs = new Map<string, Job>()
  #child: ChildProcess | undefined
  #wire: Duplex | undefined
  #pending: Pending | undefined
  #buffer = Buffer.alloc(0)
  #bytes = 0
  #closed = false
  #stopped = false
  #exit: Promise<void> | undefined
  #fatal: Error | undefined
  #ready: (() => void) | undefined
  #startupReject: ((e: unknown) => void) | undefined
  #rpcActive = false
  #stdout: Buffer[] = []
  #stderr: Buffer[] = []
  constructor(readonly layout: SandboxLayout, readonly config: LispConfiguration,
    readonly hostCall?: (method: string, args: unknown) => Promise<unknown>) {}
  get busy(): boolean { return this.#pending !== undefined }
  get healthy(): boolean { return !this.#closed && !this.#fatal && this.#child !== undefined }
  get hasRunningJobs(): boolean { return [...this.jobs.values()].some(job => !job.settled) }
  get stopped(): boolean { return (!this.#child || this.#stopped) && !this.hasRunningJobs }
  output(): unknown { return { stdout: Buffer.concat(this.#stdout).toString('utf8'), stderr: Buffer.concat(this.#stderr).toString('utf8'), bytes: this.#bytes, truncated: this.#bytes > this.config.maxOutputBytes } }
  jobStatus(): unknown[] { return [...this.jobs].map(([id, job]) => ({ id, state: job.error ? 'FAILED' : job.result ? 'FINISHED' : 'RUNNING', code: job.result?.code ?? null, error: job.error ?? null })) }
  async start(): Promise<void> {
    const launch = await sandboxLaunch(this.layout, this.config.sbclPath, ['--noinform', '--disable-debugger', '--no-sysinit', '--no-userinit', '--script', join(this.layout.library, 'bootstrap.lisp')], this.generation, true)
    const ready = new Promise<void>((resolve, reject) => { this.#ready = resolve; this.#startupReject = reject })
    const child = this.#child = spawn(process.execPath, [join(this.layout.library, 'supervisor.mjs'), JSON.stringify({ ...launch, protocol: true })], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    this.#exit = new Promise(resolve => {
      child.once('error', error => { this.#stopped = true; this.break(error); resolve() })
      child.once('exit', () => { this.#stopped = true; this.break(new LispError('WORKER_EXITED', 'Lisp が終了しました。')); resolve() })
    })
    this.#wire = child.stdio[3] as Duplex
    this.#wire.on('data', (data: Buffer) => this.receive(data))
    this.#wire.on('error', error => this.break(error))
    let diagnostics = ''
    for (const output of [child.stdout, child.stderr]) output?.on('data', (chunk: Buffer) => {
      this.#bytes += chunk.length
      if (this.#bytes <= this.config.maxOutputBytes) {
        if (output === child.stdout) this.#stdout.push(chunk)
        else this.#stderr.push(chunk)
      }
      diagnostics = (diagnostics + chunk.toString()).slice(-6000)
      if (this.#bytes > this.config.maxOutputBytes) this.break(new LispError('OUTPUT_LIMIT', 'Lisp の出力量が上限を超えました。'))
    })
    const timer = setTimeout(() => this.break(new LispError('STARTUP_TIMEOUT', 'Lisp の起動が時間内に完了しませんでした。')), this.config.startupTimeoutMs)
    try { await ready } catch (error) { await this.stop(); throw new LispError('STARTUP_FAILED', `${failure(error).message}\n${diagnostics}`) }
    finally { clearTimeout(timer); this.#startupReject = undefined }
  }
  private break(error: Error): void {
    this.#fatal ??= error
    this.#startupReject?.(error)
    this.#pending?.reject(error)
    this.#pending = undefined
    this.#child?.kill('SIGTERM')
    for (const job of this.jobs.values()) job.child.kill('SIGTERM')
  }
  private receive(data: Buffer): void {
    try {
      this.#buffer = Buffer.concat([this.#buffer, data])
      if (this.#buffer.length > FRAME_BYTES) throw new LispError('FRAME_LIMIT', 'Lisp の応答が上限を超えました。')
      for (let newline; (newline = this.#buffer.indexOf(10)) >= 0;) {
        const frame: unknown = JSON.parse(this.#buffer.subarray(0, newline).toString('utf8'))
        this.#buffer = this.#buffer.subarray(newline + 1)
        const rpc = Rpc.safeParse(frame)
        if (rpc.success) {
          if (this.#rpcActive) throw new Error('Concurrent RPC frames')
          this.#rpcActive = true
          void this.rpc(rpc.data).finally(() => { this.#rpcActive = false })
          continue
        }
        const message = WorkerFrame.parse(frame)
        if (message.type === 'ready') {
          if (!this.#ready) throw new Error('Duplicate ready frame')
          this.#ready(); this.#ready = undefined
        } else {
          const pending = this.#pending
          if (!pending || pending.id !== message.id) throw new Error('Mismatched worker response')
          this.#pending = undefined; pending.resolve(message)
        }
      }
    } catch (error) { this.break(new LispError('PROTOCOL_ERROR', `Lisp 通信が壊れました: ${failure(error).message}`)) }
  }
  private send(value: unknown): void {
    const frame = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(frame) > FRAME_BYTES) throw new LispError('FRAME_LIMIT', 'Lisp の入力が上限を超えました。')
    if (this.#closed || this.#fatal) throw this.#fatal ?? new Error('Worker closed')
    this.#wire!.write(frame)
  }
  async request(method: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.#pending) throw new LispError('BUSY', 'この Lisp は別の評価を実行中です。')
    if (signal?.aborted) throw new LispError('CANCELLED', '評価を取り消しました。')
    this.#bytes = 0; this.#stdout = []; this.#stderr = []
    const id = randomUUID()
    const promise = new Promise<WorkerResult>((resolve, reject) => { this.#pending = { id, resolve, reject } })
    const abort = () => this.break(new LispError('CANCELLED', '評価を取り消しました。'))
    const timer = setTimeout(() => this.break(new LispError('TIMEOUT', 'Lisp の評価時間が上限を超えました。')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      try { this.send({ version: 1, id, method, ...args }) } catch (error) { this.break(new Error(failure(error).message)) }
      const result = await promise
      await new Promise<void>(resolve => setImmediate(resolve))
      return result
    }
    catch (error) { await this.stop(); throw error }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#pending = undefined }
  }
  private async rpc(rpc: z.infer<typeof Rpc>): Promise<void> {
    try {
      if (!this.#pending || this.#pending.id !== rpc.request) throw new Error('RPC outside evaluation')
      let value: unknown
      if (['tools-list', 'tool-call', 'artifact', 'ci-list-runs', 'ci-failed-log', 'ci-verify'].includes(rpc.method)) {
        if (!this.hostCall) throw new Error('HOST_ADAPTER_UNAVAILABLE')
        value = await this.hostCall(rpc.method, rpc.arguments)
      } else if (rpc.method === 'run' || rpc.method === 'start-job') {
        const input = Program.parse(rpc.arguments)
        if ([...this.jobs.values()].filter(j => !j.result && !j.error).length >= 4 || this.jobs.size >= 100) throw new Error('JOB_LIMIT')
        const id = randomUUID()
        const job = await this.launchJob(input)
        this.jobs.set(id, job)
        if (rpc.method === 'run') { await job.done; if (job.error) throw new Error(job.error); value = job.result }
        else value = id
      } else {
        const { id } = z.object({ id: z.string().max(256) }).strict().parse(rpc.arguments)
        const job = this.jobs.get(id)
        if (!job) throw new Error('UNKNOWN_JOB')
        if (rpc.method === 'cancel-job') { job.child.kill('SIGTERM'); await job.done }
        value = job.result ?? { state: job.error ? 'FAILED' : 'RUNNING', error: job.error ?? null }
      }
      if (this.#pending?.id === rpc.request) this.send({ id: rpc.id, ok: true, value })
    } catch (error) {
      if (!this.#closed && !this.#fatal && this.#pending?.id === rpc.request) {
        try { this.send({ id: rpc.id, ok: false, error: failure(error).message }) } catch (sendError) { this.break(new Error(failure(sendError).message)) }
      }
    }
  }
  private async launchJob(input: z.infer<typeof Program>): Promise<Job> {
    const launch = await sandboxLaunch(this.layout, input.program, input.argv, this.generation, false, input.directory)
    if (this.#closed || this.#fatal || !this.#pending) throw new Error('Worker stopped before job launch')
    const child = spawn(process.execPath, [join(this.layout.library, 'supervisor.mjs'), JSON.stringify({ ...launch, protocol: false })], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const job: Job = { child, done: Promise.resolve() }
    let bytes = 0, stdout = '', stderr = ''
    for (const [stream, target] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 262144) { job.error = 'JOB_OUTPUT_LIMIT'; child.kill('SIGTERM'); return }
      if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString()
    })
    const timer = setTimeout(() => { job.error = 'JOB_TIMEOUT'; child.kill('SIGTERM') }, input.timeoutMs)
    job.done = new Promise(resolve => {
      child.once('error', error => { job.error = error.message; job.settled = true; clearTimeout(timer); resolve() })
      child.once('close', (code, signal) => { job.result = { code, signal, stdout, stderr }; job.settled = true; clearTimeout(timer); resolve() })
    })
    return job
  }
  async stop(): Promise<void> {
    this.#closed = true
    this.break(new LispError('CANCELLED', 'Lisp を停止しました。'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.all([this.#exit, ...[...this.jobs.values()].map(j => j.done)]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LispError('STOP_UNCONFIRMED', 'Lisp の停止を確認できません。再開せずプロセスを確認してください。')), 5000)
      })])
      if (this.#child && !this.#stopped) throw new LispError('STOP_UNCONFIRMED', 'Lisp の終了を確認できません。')
    } finally { clearTimeout(timer) }
  }
}
