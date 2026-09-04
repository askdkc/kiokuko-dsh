import { randomUUID } from 'node:crypto'
import { withImmediateTransaction } from '../db/transaction.js'
import type { DshRuntime } from './runtime.js'
import {
  claimBoundaryJobInTransaction,
  completeBoundaryJobInTransaction,
  failBoundaryJobInTransaction,
  markOutboxDispatchedInTransaction,
  readPendingOutbox,
  type DshBoundaryCompletion,
  type DshBoundaryJob,
  type DshContinuationOutboxItem,
} from './turn-process.js'

export interface DshBoundaryWorkerOptions {
  readonly runtime: Pick<DshRuntime, 'withDatabase'>
  /** One bounded job stage. It must be idempotent under lease recovery. */
  readonly process: (job: DshBoundaryJob) => DshBoundaryCompletion | PromiseLike<DshBoundaryCompletion>
  /** Native durability barrier. Failure is fail-closed for delivery only. */
  readonly flush: (job: DshBoundaryJob) => void | PromiseLike<void>
  /** Enqueue one deterministic plugin-owned message into the native Agent. */
  readonly dispatch: (job: DshBoundaryJob, item: DshContinuationOutboxItem) => void | PromiseLike<void>
  /** Last durable gate before native delivery. */
  readonly beforeDelivery?: (
    job: DshBoundaryJob,
    item: DshContinuationOutboxItem,
  ) => 'deliver' | 'waiting_user' | 'superseded' | PromiseLike<'deliver' | 'waiting_user' | 'superseded'>
  /** Best-effort notification after retries are durably exhausted. Never retried by this worker. */
  readonly onWaitingUser?: (job: DshBoundaryJob, error: unknown) => boolean | PromiseLike<boolean>
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
  #tail: Promise<void> = Promise.resolve()
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
    const timer = this.#retryTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#retryTimers.delete(sessionId)
    }
    this.#tail = this.#tail.then(() => this.#drain(sessionId)).catch(() => undefined)
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

  async #drain(sessionId?: string): Promise<void> {
    while (!this.#disposed) {
      const ownerNonce = randomUUID()
      const job = await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => (
        claimBoundaryJobInTransaction(database, ownerNonce, this.#now(), sessionId)
      )))
      if (job === undefined) return
      try {
        let completion: DshBoundaryCompletion
        if (job.kind === 'delivery') {
          const outbox = await this.#runtime.withDatabase((database) => readPendingOutbox(database, job.dshSessionId)
            .find((item) => item.receiptId === job.receiptId))
          if (outbox === undefined || outbox.status === 'observed' || outbox.status === 'superseded') {
            completion = { kind: 'superseded' }
          } else {
            const gate = await this.#beforeDelivery?.(job, outbox) ?? 'deliver'
            if (gate !== 'deliver') {
              completion = { kind: gate }
            } else {
              const deliveryItem = await this.#runtime.withDatabase((database) => readPendingOutbox(database, job.dshSessionId)
                .find((item) => item.receiptId === job.receiptId))
              if (deliveryItem === undefined) {
                completion = { kind: 'superseded' }
                await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
                  completeBoundaryJobInTransaction(database, job, completion, this.#now())
                }))
                continue
              }
              await this.#flush(job)
              await this.#dispatch(job, deliveryItem)
              await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
                markOutboxDispatchedInTransaction(database, deliveryItem.continuationId, this.#now())
              }))
              completion = { kind: 'completed' }
            }
          }
        } else {
          completion = await this.#process(job)
        }
        await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          completeBoundaryJobInTransaction(database, job, completion, this.#now())
        }))
      } catch (error) {
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
          try {
            if (await this.#onWaitingUser?.(job, error)) this.kick(job.dshSessionId)
          } catch { /* durable wait is authoritative */ }
        }
        return
      }
    }
  }

  async whenIdle(): Promise<void> { await this.#tail }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
    await this.#tail
  }
}
