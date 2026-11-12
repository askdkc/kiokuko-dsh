import { abortable } from './http-json.js'
/** Only failures minted before provider dispatch can enter this bounded native retry. */
export class MemorySnapshotStale extends Error {
  constructor() { super('Memory changed after request assembly; rebuild the request') }
}
/** The last synchronous check runs after validator awaits, before dispatch. */
export interface MemoryDispatchGuard {
  check(): void
  rebuild(signal?: AbortSignal): Promise<unknown>
}
export class MemoryRequestFence {
  turn = 0
  step = 0
  private deadline: number | undefined
  constructor(private readonly budgetMs = 1500) {}
  private retries = 0
  private pendingFailure: string | undefined
  private omitted = false
  get withoutMemory(): boolean { return this.omitted }
  omitMemory(): void { this.omitted = true }
  begin(event: { turn: number; step: number; signal?: AbortSignal }): void {
    if (event.turn !== this.turn || event.step !== this.step) { this.deadline = undefined; this.retries = 0; this.pendingFailure = undefined; this.omitted = false }
    this.turn = event.turn; this.step = event.step
  }
  async *stream<T>(validate: (signal: AbortSignal) => Promise<void | MemoryDispatchGuard>, next: () => AsyncIterable<T>, omitMemory?: () => Promise<void>, signal?: AbortSignal): AsyncIterable<T | { type: 'finish'; reason: { kind: 'error'; failure: { code: string; message: string; requestId: string } } }> {
    signal?.throwIfAborted()
    this.deadline ??= performance.now() + this.budgetMs
    const remaining = Math.ceil(this.deadline - performance.now())
    if (remaining <= 0) throw new Error('Memory recovery deadline exceeded')
    const budgetSignal = AbortSignal.timeout(remaining)
    const recoverySignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal
    let guard: MemoryDispatchGuard | void = undefined
    try { guard = await abortable(validate(recoverySignal), recoverySignal); recoverySignal.throwIfAborted(); guard?.check() } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof MemorySnapshotStale)) throw error
      if (guard) {
        // A change during validator waits must take the same projection repair
        // path as an earlier change. No provider or tool has run at this point.
        try { await abortable(guard.rebuild(recoverySignal), recoverySignal) } catch (rebuildError) { if (!(rebuildError instanceof MemorySnapshotStale)) throw rebuildError }
        signal?.throwIfAborted()
      }
      // This is a different recovery operation, not another identical retry.
      // The caller retires optional memory from the native surface; the next
      // immutable request must still pass identity, Stop and explanation checks.
      if (this.retries === 1 && !this.omitted && omitMemory) { await abortable(omitMemory(), recoverySignal); recoverySignal.throwIfAborted(); this.omitted = true }
      const fallback = this.retries === 1 && this.omitted
      const failure = { code: this.retries === 0 ? 'DSH_MEMORY_SNAPSHOT_STALE' : fallback ? 'DSH_MEMORY_CONTEXT_OMITTED' : 'DSH_MEMORY_REBUILD_EXHAUSTED',
        message: this.retries === 0 ? error.message : fallback ? 'Rebuild without optional memory after concurrent changes' : 'Memory-free request could not be validated', requestId: randomUUID() }
      // Native stream settlement clones chunks. Bind the retry to an opaque,
      // one-use ID carried by the SDK's serializable failure contract.
      this.pendingFailure = failure.requestId
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    recoverySignal.throwIfAborted()
    // Provider retries are a separate operation and must not inherit this recovery budget.
    this.deadline = undefined
    yield* next()
  }
  retry(event: { turn: number; step: number; failure?: { code?: unknown; requestId?: unknown }; signal: AbortSignal }): { kind: 'retry' } | null | undefined {
    event.signal.throwIfAborted()
    if (!this.pendingFailure || event.failure?.requestId !== this.pendingFailure) return undefined
    this.pendingFailure = undefined
    if (event.turn !== this.turn || event.step !== this.step
      || !(this.retries === 0 && event.failure.code === 'DSH_MEMORY_SNAPSHOT_STALE'
        || this.retries === 1 && this.omitted && event.failure.code === 'DSH_MEMORY_CONTEXT_OMITTED')) return null // Owned failure: stop; do not delegate to generic provider retries.
    this.retries++
    return { kind: 'retry' }
  }
}
import { randomUUID } from 'node:crypto'
