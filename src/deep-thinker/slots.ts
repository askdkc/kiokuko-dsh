interface Waiter { runId: string; route: string; local: boolean; limit: number; signal: AbortSignal; resolve(release: () => void): void; reject(reason: unknown): void; abort(): void }
/** Round-robin among waiting runs; a queued local route cannot block another route. */
export class DeepSlots {
  readonly #queue: Waiter[] = []
  readonly #active = new Map<string, number>()
  readonly #limits = new Map<number, number>()
  #count = 0
  #previous = ''
  acquire(runId: string, route: string, local: boolean, limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { runId, route, local, limit, signal, resolve, reject, abort: () => {
        const index = this.#queue.indexOf(waiter)
        if (index >= 0) this.#queue.splice(index, 1)
        reject(signal.reason); this.#drain()
      } }
      this.#queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); this.#drain()
    })
  }
  #drain(): void {
    while (this.#queue.length) {
      const available = (w: Waiter) => this.#count < Math.min(w.limit, ...this.#limits.keys()) && (!w.local || !this.#active.get(w.route))
      let index = this.#queue.findIndex(w => available(w) && w.runId !== this.#previous)
      if (index < 0) index = this.#queue.findIndex(available)
      if (index < 0) return
      const waiter = this.#queue.splice(index, 1)[0]!
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.#previous = waiter.runId; this.#count++; this.#active.set(waiter.route, (this.#active.get(waiter.route) ?? 0) + 1)
      this.#limits.set(waiter.limit, (this.#limits.get(waiter.limit) ?? 0) + 1)
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true; this.#count--
        const count = this.#active.get(waiter.route)! - 1, limits = this.#limits.get(waiter.limit)! - 1
        if (count) this.#active.set(waiter.route, count); else this.#active.delete(waiter.route)
        if (limits) this.#limits.set(waiter.limit, limits); else this.#limits.delete(waiter.limit)
        this.#drain()
      })
    }
  }
}
export const processDeepSlots = new DeepSlots()
