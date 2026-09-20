import { DecisionError } from './contracts.js'

/** Shared by probes and memory batches across concurrent logical requests. */
export class MemoryDecisionConcurrency {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DecisionError('CANCELLED'))
    if (this.active < 2) { this.active++; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', abort); this.active++; resolve() }
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(new DecisionError('CANCELLED'))
      }
      this.waiting.push(start)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      if (signal.aborted) throw new DecisionError('CANCELLED')
      return await operation()
    } finally { this.active--; this.waiting.shift()?.() }
  }
}
