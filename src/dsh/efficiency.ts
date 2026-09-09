import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { findSecret } from '../memory/secrets.js'

/** Prevent the finalizer's own observation from being counted again by the global hook. */
export const finalizationObservationScope = new AsyncLocalStorage<boolean>()
export type FinalizationInputMode = 'prefix_reuse' | 'bounded_evidence'
export type EfficiencyTask = 'main' | 'child' | 'auxiliary' | 'memory-finalization'
export interface EfficiencyBinding {
  readonly sessionId: string
  readonly runId?: string
  readonly parentSessionId?: string
  readonly task: EfficiencyTask
}
export interface RequestSize {
  readonly systemBytes: number
  readonly toolsBytes: number
  readonly messagesBytes: number
  readonly totalBytes: number
}
export interface DshUsageSnapshot {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly logicalInputTokens: number | null
  readonly reasoningTokens: number | null
}
export interface EfficiencyObservation extends EfficiencyBinding {
  readonly callId: string
  readonly attempt?: number
  readonly provider: string | null
  readonly model: string | null
  readonly request: RequestSize | null
  readonly usage: DshUsageSnapshot
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly inputMode?: FinalizationInputMode
  readonly fallback?: 'empty_evidence' | 'request_not_smaller' | 'context_budget_unknown'
  readonly durationMs: number
}
export function efficiencyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function requestSize(request: Record<string, unknown>): RequestSize {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  const systemBytes = bytes(request.system ?? '')
  const toolsBytes = bytes(request.tools ?? [])
  const messagesBytes = bytes(request.messages ?? [])
  return Object.freeze({ systemBytes, toolsBytes, messagesBytes,
    totalBytes: bytes({ system: request.system ?? '', tools: request.tools ?? [], messages: request.messages ?? [] }) })
}
/** DSH counters are disjoint; missing cache counters remain unknown, not zero. */
export function normalizeDshUsage(value: unknown): DshUsageSnapshot {
  const usage = efficiencyRecord(value)
  const number = (key: string) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : null
  const inputTokens = number('inputTokens'), outputTokens = number('outputTokens')
  const cacheReadTokens = number('cacheReadTokens'), cacheWriteTokens = number('cacheWriteTokens')
  const sum = inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null
    ? null : inputTokens + cacheReadTokens + cacheWriteTokens
  return Object.freeze({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    logicalInputTokens: sum !== null && Number.isSafeInteger(sum) ? sum : null, reasoningTokens: number('reasoningTokens') })
}
export function modelLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 256 && /^[\w./:@+-]+$/u.test(value) && findSecret(value) === undefined ? value : null
}

/** Evaluation-only, bounded numeric observations. No prompts, files, timers or DB writes. */
export class DshEfficiencyObserver {
  readonly #records: EfficiencyObservation[] = []
  #evicted = 0
  #unattributed = 0
  #errors = 0
  #started = 0
  #active = 0
  #discardedAfterClose = 0
  #closed = false
  constructor(readonly capacity = 2048) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16384) throw new RangeError('Invalid observation capacity')
  }
  record(observation: EfficiencyObservation): void {
    if (this.#closed) { this.#discardedAfterClose++; return }
    if (this.#records.length === this.capacity) { this.#records.shift(); this.#evicted++ }
    this.#records.push(Object.freeze({ ...observation, usage: Object.freeze({ ...observation.usage }),
      request: observation.request === null ? null : Object.freeze({ ...observation.request }) }))
  }
  snapshot() {
    return { format: 'dsh.efficiency.v1', coverage: 'observed_only', providerInternalRetries: 'unknown',
      wirePayloadConfirmed: false, tokenizer: null, evicted: this.#evicted, unattributed: this.#unattributed,
      observationErrors: this.#errors, streamCallsStarted: this.#started, activeStreams: this.#active,
      discardedAfterClose: this.#discardedAfterClose, observations: [...this.#records] } as const
  }
  close(): void { this.#closed = true }
  unavailable(): void { this.#errors++; this.close() }
  stream<T>(options: Record<string, unknown>, binding: EfficiencyBinding | undefined, next: () => AsyncIterable<T>): AsyncIterable<T> {
    if (this.#closed || finalizationObservationScope.getStore()) return next()
    if (!binding) { this.#unattributed++; return next() }
    const observer = this
    return (async function* () {
      if (observer.#closed) { yield* next(); return }
      observer.#started++; observer.#active++
      const started = performance.now()
      let size: RequestSize | null = null
      try { size = requestSize(options) } catch { observer.#errors++ }
      let usage = normalizeDshUsage(undefined)
      let status: EfficiencyObservation['status'] = 'unknown'
      try {
        for await (const chunk of next()) {
          try {
            const item = efficiencyRecord(chunk)
            if (item.type === 'usage') usage = normalizeDshUsage(item.usage)
            if (item.type === 'finish') {
              const kind = efficiencyRecord(item.reason).kind
              status = kind === 'aborted' ? 'cancelled' : kind === 'stop' || kind === 'max-tokens' || kind === 'tool-calls' ? 'completed' : 'failed'
            }
          } catch { observer.#errors++ }
          yield chunk
        }
      } catch (error) { status = 'failed'; throw error }
      finally {
        observer.#active--
        try {
          if ((options.signal as AbortSignal | undefined)?.aborted) status = 'cancelled'
          observer.record({ ...binding, callId: randomUUID(), provider: modelLabel(options.provider), model: modelLabel(options.model),
            request: size, usage, status, durationMs: performance.now() - started })
        } catch { observer.#errors++ }
      }
    })()
  }
}

/** Mount on the existing stream waterfall; authority is resolved by the owning host. */
export function mountDshEfficiencyObserver(ctx: { on: (...args: any[]) => () => void }, observer: DshEfficiencyObserver,
  resolve: (sessionId: string, options: Record<string, unknown>) => EfficiencyBinding | undefined): () => void {
  return ctx.on('llm/stream', (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => {
    let binding: EfficiencyBinding | undefined
    try { if (typeof options.sessionId === 'string') binding = resolve(options.sessionId, options) } catch { /* unknown attribution */ }
    return observer.stream(options, binding, next)
  }, { global: true })
}
