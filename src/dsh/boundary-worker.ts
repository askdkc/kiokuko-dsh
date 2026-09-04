import { randomUUID } from 'node:crypto'
import { withImmediateTransaction } from '../db/transaction.js'
import type { DshRuntime } from './runtime.js'
import {
  claimBoundaryJobInTransaction,
  completeBoundaryJobInTransaction,
  failBoundaryJobInTransaction,
  markOutboxDispatchedInTransaction,
  readPendingOutbox,
  nextBoundaryWakeAt,
  type DshBoundaryCompletion,
  type DshBoundaryJob,
  type DshContinuationOutboxItem,
} from './turn-process.js'

export interface DshBoundaryWorkerOptions {
  readonly runtime: Pick<DshRuntime, 'withDatabase'>
  /** One bounded job stage. It must be idempotent under lease recovery. */
  readonly process: (job: DshBoundaryJob, signal: AbortSignal) => DshBoundaryCompletion | PromiseLike<DshBoundaryCompletion>
  /** Native durability barrier. Failure is fail-closed for delivery only. */
  readonly flush: (job: DshBoundaryJob) => void | PromiseLike<void>
  /** Enqueue one deterministic plugin-owned message into the native Agent. */
  readonly dispatch: (job: DshBoundaryJob, item: DshContinuationOutboxItem) => void | PromiseLike<void>
  /** Last durable gate before native delivery. */
  readonly beforeDelivery?: (
    job: DshBoundaryJob,
    item: DshContinuationOutboxItem,
    signal: AbortSignal,
  ) => 'deliver' | 'waiting_user' | 'superseded' | PromiseLike<'deliver' | 'waiting_user' | 'superseded'>
  /** Best-effort notification after retries are durably exhausted. Never retried by this worker. */
  readonly onWaitingUser?: (job: DshBoundaryJob, error: unknown, signal: AbortSignal) => boolean | PromiseLike<boolean>
  readonly bindNativeAgent?: (sessionId: string, nativeAgent: object) => void
  readonly now?: () => string
}

/**
 * Durable, no-idle outbox driver. `agent/turn-stopping` only calls `kick`;
 * confirmation, verification, advisory, context, and delivery run as separate
 * leased stages outside that callback.
 */
export class DshBoundaryWorker {
  readonly #runtime: DshBoundaryWorkerOptions['runtime']
  readonly #process: DshBoundaryWorkerOptions['process']
  readonly #flush: DshBoundaryWorkerOptions['flush']
  readonly #dispatch: DshBoundaryWorkerOptions['dispatch']
  readonly #beforeDelivery: DshBoundaryWorkerOptions['beforeDelivery']
  readonly #onWaitingUser: DshBoundaryWorkerOptions['onWaitingUser']
  readonly #now: () => string
  readonly #bindNativeAgent: DshBoundaryWorkerOptions['bindNativeAgent']
  readonly #tails = new Map<string, Promise<void>>()
  readonly #controllers = new Map<string, AbortController>()
  #disposed = false
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: DshBoundaryWorkerOptions) {
    this.#runtime = options.runtime
    this.#process = options.process
    this.#flush = options.flush
    this.#dispatch = options.dispatch
    this.#beforeDelivery = options.beforeDelivery
    this.#onWaitingUser = options.onWaitingUser
    this.#bindNativeAgent = options.bindNativeAgent
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  kick(sessionId?: string, nativeAgent?: object): void {
    if (this.#disposed) return
    if (sessionId !== undefined && nativeAgent !== undefined) this.#bindNativeAgent?.(sessionId, nativeAgent)
    if (sessionId === undefined) return
    const tail = (this.#tails.get(sessionId) ?? Promise.resolve())
      .then(() => this.#drain(sessionId)).catch(() => {
        // A failed claim must not permanently lose the durable wake-up.
        this.#scheduleRetry(sessionId, new Date(Date.parse(this.#now()) + 1_000).toISOString())
      })
    this.#tails.set(sessionId, tail)
    void tail.finally(() => { if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId) })
  }

  cancelSession(sessionId: string): void {
    this.#controllers.get(sessionId)?.abort(new Error('Boundary superseded or disposed'))
  }

  #scheduleRetry(sessionId: string, retryAt: string): void {
    if (this.#disposed) return
    const delay = Math.max(0, Date.parse(retryAt) - Date.parse(this.#now()))
    const existing = this.#retryTimers.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#retryTimers.delete(sessionId)
      this.kick(sessionId)
    }, Math.min(delay, 60_000))
    timer.unref?.()
    this.#retryTimers.set(sessionId, timer)
  }

  async #drain(sessionId: string): Promise<void> {
    while (!this.#disposed) {
      const ownerNonce = randomUUID()
      const job = await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => (
        claimBoundaryJobInTransaction(database, ownerNonce, this.#now(), sessionId)
      )))
      // Disposal can race the asynchronous claim before a controller exists.
      // Leave the durable lease recoverable; never start new work after shutdown.
      if (this.#disposed) return
      if (job === undefined) {
        const next = await this.#runtime.withDatabase(database => nextBoundaryWakeAt(database, sessionId))
        if (next !== undefined) this.#scheduleRetry(sessionId, next)
        return
      }
      const controller = new AbortController()
      const { signal } = controller
      this.#controllers.set(sessionId, controller)
      // User questions can outlive a job lease. Renew only while we own it.
      const heartbeat = setInterval(() => {
        void this.#runtime.withDatabase(database => {
          const changed = database.prepare(`UPDATE dsh_boundary_jobs SET lease_expires_at = ?
            WHERE job_id = ? AND status = 'processing' AND owner_nonce = ? RETURNING job_id`)
            .get(new Date(Date.parse(this.#now()) + 60_000).toISOString(), job.jobId, job.ownerNonce)
          if (changed === undefined) controller.abort(new Error('Boundary lease lost'))
        }).catch(error => controller.abort(error))
      }, 20_000)
      heartbeat.unref?.()
      try {
        let completion: DshBoundaryCompletion
        if (job.kind === 'delivery') {
          const outbox = await this.#runtime.withDatabase((database) => readPendingOutbox(database, job.dshSessionId)
            .find((item) => item.receiptId === job.receiptId))
          if (outbox === undefined || outbox.status === 'observed' || outbox.status === 'superseded') {
            completion = { kind: 'superseded' }
          } else {
            const gate = await abortable(this.#beforeDelivery?.(job, outbox, signal) ?? 'deliver', signal)
            if (gate !== 'deliver') {
              completion = { kind: gate }
            } else {
              await this.#flush(job)
              signal.throwIfAborted()
              const delivered = await this.#runtime.withDatabase(async database => {
                const owned = database.prepare(`SELECT job_id FROM dsh_boundary_jobs
                  WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?`).get(job.jobId, job.ownerNonce)
                const fresh = readPendingOutbox(database, job.dshSessionId).find(item => item.receiptId === job.receiptId)
                if (!owned || !fresh || signal.aborted) return false
                // No await between the last authoritative check and native enqueue.
                await this.#dispatch(job, fresh)
                markOutboxDispatchedInTransaction(database, fresh.continuationId, this.#now())
                return true
              })
              completion = { kind: delivered ? 'completed' : 'superseded' }
            }
          }
        } else {
          completion = await abortable(this.#process(job, signal), signal)
        }
        await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          completeBoundaryJobInTransaction(database, job, completion, this.#now())
        }))
      } catch (error) {
        if (signal.aborted) return
        let failure: ReturnType<typeof failBoundaryJobInTransaction> | undefined
        try {
          await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
            failure = failBoundaryJobInTransaction(database, job, error, this.#now())
          }))
        } catch {
          // A Core DB failure cannot be repaired in-memory. The expired lease
          // is the recovery mechanism on the next kick/startup.
        }
        if (failure?.kind === 'retry') this.#scheduleRetry(job.dshSessionId, failure.retryAt)
        if (failure?.kind === 'waiting_user') {
          clearInterval(heartbeat)
          try {
            if (await abortable(this.#onWaitingUser?.(job, error, signal) ?? false, signal)) this.kick(job.dshSessionId)
          } catch { /* durable wait is authoritative */ }
        }
        return
      } finally {
        clearInterval(heartbeat)
        if (this.#controllers.get(sessionId) === controller) this.#controllers.delete(sessionId)
      }
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()])
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const controller of this.#controllers.values()) controller.abort(new Error('Boundary worker disposed'))
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
    await this.whenIdle()
  }
}

/** Uncooperative question adapters cannot hold shutdown or a newer user turn. */
export function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
