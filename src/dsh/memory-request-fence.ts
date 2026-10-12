/** Only failures minted before provider dispatch can enter this bounded native retry. */
export class MemorySnapshotStale extends Error {
  constructor() { super('Memory changed after request assembly; rebuild the request') }
}
export class MemoryRequestFence {
  turn = 0
  step = 0
  private retries = 0
  private pendingFailure: string | undefined
  begin(event: { turn: number; step: number }): void {
    if (event.turn !== this.turn || event.step !== this.step) { this.retries = 0; this.pendingFailure = undefined }
    this.turn = event.turn; this.step = event.step
  }
  async *stream<T>(validate: () => Promise<void>, next: () => AsyncIterable<T>): AsyncIterable<T | { type: 'finish'; reason: { kind: 'error'; failure: { code: string; message: string; requestId: string } } }> {
    try { await validate() } catch (error) {
      if (!(error instanceof MemorySnapshotStale)) throw error
      const failure = { code: this.retries === 0 ? 'DSH_MEMORY_SNAPSHOT_STALE' : 'DSH_MEMORY_REBUILD_EXHAUSTED',
        message: this.retries === 0 ? error.message : 'Memory changed again after one request rebuild', requestId: randomUUID() }
      // Native stream settlement clones chunks. Bind the retry to an opaque,
      // one-use ID carried by the SDK's serializable failure contract.
      this.pendingFailure = failure.requestId
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    yield* next()
  }
  retry(event: { turn: number; step: number; failure?: { code?: unknown; requestId?: unknown }; signal: AbortSignal }): { kind: 'retry' } | null | undefined {
    event.signal.throwIfAborted()
    if (!this.pendingFailure || event.failure?.requestId !== this.pendingFailure) return undefined
    this.pendingFailure = undefined
    if (event.turn !== this.turn || event.step !== this.step || this.retries !== 0
      || event.failure.code !== 'DSH_MEMORY_SNAPSHOT_STALE') return null // Owned failure: stop; do not delegate to generic provider retries.
    this.retries++
    return { kind: 'retry' }
  }
}
import { randomUUID } from 'node:crypto'
