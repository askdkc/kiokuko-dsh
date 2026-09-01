import { cloneBoundaryJson, type BoundaryJsonValue } from '../serialization/boundary-json.js'
import { KiokukoError } from '../errors.js'
import { LedgerStore } from '../ledger/store.js'
import type { LedgerEventInput } from '../ledger/types.js'
import type { DshRuntime } from './runtime.js'
import { dshSessionEventSourceId } from './agent-state.js'

export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
  readonly ignorable?: true
}

export interface DshSessionEventInput {
  readonly sessionId: string
  readonly runId: string
  readonly event: DshSessionEvent
}

export interface DshQueuedSessionEvent {
  readonly runId: string
  readonly sessionId: string
  readonly sourceEventId: string
  readonly sourceSequence: number
  readonly event: Readonly<{ type: string; seq: number; time: number; data: BoundaryJsonValue; ignorable?: true }>
}

export interface DshSessionBridgeOptions {
  readonly runtime: Pick<DshRuntime, 'withDatabase'>
  readonly appendBatch?: (runId: string, events: readonly LedgerEventInput[]) => unknown | PromiseLike<unknown>
}

export interface DshDurabilityContext {
  on(name: 'session/flush' | 'llm/stream' | 'tools/execute' | 'agent/pre-step', listener: (...args: any[]) => any, options?: { readonly prepend?: boolean }): () => void
}

/** Minimal native dsh session surface used by the post-commit bridge. */
export interface DshNativeSession {
  readonly id: string
}

export interface DshSessionBridgeContext {
  on(name: 'session/created' | 'session/disposed' | 'session/event', listener: (...args: any[]) => any, options?: { readonly prepend?: boolean }): () => void
}

export type DshSessionRunResolver = (session: DshNativeSession) => string | undefined

export interface DshRunLifecycleOptions {
  readonly bridge: Pick<DshSessionBridge, 'flush' | 'close'>
  readonly closeRun: (input: { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' }) => void | PromiseLike<void>
}

/** Close a run only after the ordered dsh suffix is durably bridged. */
export class DshRunLifecycle {
  readonly #bridge: DshRunLifecycleOptions['bridge']
  readonly #closeRun: DshRunLifecycleOptions['closeRun']

  constructor(options: DshRunLifecycleOptions) {
    this.#bridge = options.bridge
    this.#closeRun = options.closeRun
  }

  async closeTurn(input: { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' }): Promise<void> {
    await this.#bridge.flush()
    await this.#closeRun(input)
  }

  async dispose(): Promise<void> {
    await this.#bridge.close()
  }
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message)
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}]/u.test(value)) validation(`${label} must be a bounded non-empty string`)
  return value
}

function validEvent(value: unknown): DshSessionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation('SessionEvent must be a plain object')
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 256 || /[\p{Cc}]/u.test(event.type)) validation('SessionEvent type is invalid')
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) validation('SessionEvent sequence is invalid')
  if (!Number.isFinite(event.time)) validation('SessionEvent time is invalid')
  return { type: event.type, seq: event.seq as number, time: event.time as number, data: event.data, ...(event.ignorable === true ? { ignorable: true as const } : {}) }
}

function queuedFingerprint(item: DshQueuedSessionEvent): string {
  return JSON.stringify(item.event)
}

function ledgerEvent(item: DshQueuedSessionEvent): LedgerEventInput {
  return {
    sourceEventId: item.sourceEventId,
    sourceSequence: item.sourceSequence,
    eventType: 'source.event',
    sourceType: 'dsh-session',
    actor: 'dsh',
    occurredAt: new Date(item.event.time).toISOString(),
    payload: { sessionId: item.sessionId, event: item.event },
  }
}

/** Bridge committed dsh session events into Kiokuko's ordered ledger. */
export class DshSessionBridge {
  readonly #runtime: Pick<DshRuntime, 'withDatabase'>
  readonly #appendBatch: (runId: string, events: readonly LedgerEventInput[]) => unknown | PromiseLike<unknown>
  readonly #runs = new Map<string, string>()
  readonly #pending = new Map<string, DshQueuedSessionEvent>()
  readonly #committed = new Map<string, string>()
  readonly #observerErrors: unknown[] = []
  #flushPromise: Promise<void> | undefined
  #closed = false

  constructor(options: DshSessionBridgeOptions) {
    this.#runtime = options.runtime
    this.#appendBatch = options.appendBatch ?? ((runId, events) => this.#runtime.withDatabase((database) => new LedgerStore(database).appendBatch(runId, { events })))
  }

  bindSession(sessionId: string, runId: string): void {
    const session = validId(sessionId, 'sessionId')
    const run = validId(runId, 'runId')
    const existing = this.#runs.get(session)
    if (existing !== undefined && existing !== run) throw new KiokukoError('CONFLICT', 'dsh session is already bound to another run')
    this.#runs.set(session, run)
  }

  /** Post-commit observer: malformed events are recorded and never veto the session append. */
  observe(input: DshSessionEventInput): void {
    if (this.#closed) return
    try {
      const sessionId = validId(input.sessionId, 'sessionId')
      const runId = this.#runs.get(sessionId)
      if (runId === undefined || runId !== input.runId) validation('dsh session has no matching run binding')
      const event = validEvent(input.event)
      const sourceEventId = dshSessionEventSourceId(sessionId, event.seq)
      const data = cloneBoundaryJson(event.data ?? null, { maximumDepth: 32, maximumNodes: 2_000, maximumStringBytes: 64 * 1024, failure: () => new KiokukoError('VALIDATION_ERROR', 'SessionEvent data is not JSON-safe') })
      const queued = Object.freeze({ runId, sessionId, sourceEventId, sourceSequence: event.seq, event: Object.freeze({ ...event, data }) })
      const existing = this.#pending.get(sourceEventId)
      const committed = this.#committed.get(sourceEventId)
      const fingerprint = queuedFingerprint(queued)
      if (existing !== undefined) {
        if (queuedFingerprint(existing) !== fingerprint) this.#observerErrors.push(new KiokukoError('CONFLICT', 'Duplicate dsh session event identity has different content'))
        return
      }
      if (committed !== undefined) {
        if (committed !== fingerprint) this.#observerErrors.push(new KiokukoError('CONFLICT', 'Committed dsh session event identity has different content'))
        return
      }
      this.#pending.set(sourceEventId, queued)
    } catch (error) {
      this.#observerErrors.push(error)
    }
  }

  get pendingCount(): number { return this.#pending.size }
  get observerErrors(): readonly unknown[] { return [...this.#observerErrors] }

  async flush(): Promise<void> {
    if (this.#flushPromise !== undefined) return this.#flushPromise
    this.#flushPromise = this.#flushPending().finally(() => { this.#flushPromise = undefined })
    return this.#flushPromise
  }

  async #flushPending(): Promise<void> {
    const grouped = new Map<string, DshQueuedSessionEvent[]>()
    for (const item of this.#pending.values()) {
      const group = grouped.get(item.runId) ?? []
      group.push(item)
      grouped.set(item.runId, group)
    }
    const batches = [...grouped.entries()].map(async ([runId, items]) => {
      items.sort((left, right) => left.sourceSequence - right.sourceSequence)
      await this.#appendBatch(runId, items.map(ledgerEvent))
      return items
    })
    const completed = await Promise.all(batches)
    for (const items of completed) {
      for (const item of items) {
        if (this.#pending.get(item.sourceEventId) === item) {
          this.#pending.delete(item.sourceEventId)
          this.#committed.set(item.sourceEventId, queuedFingerprint(item))
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
    this.#runs.clear()
  }
}

/** Install prepend durability barriers around the four model/session boundaries. */
export function mountDshDurabilityBarriers(ctx: DshDurabilityContext, bridge: DshSessionBridge): () => void {
  const disposers = [
    ctx.on('session/flush', async (_payload: { readonly sessionId?: string }, next: () => Promise<unknown>) => { await bridge.flush(); return next() }, { prepend: true }),
    ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<unknown>) => { await bridge.flush(); return next() }, { prepend: true }),
    ctx.on('tools/execute', async (_payload: { readonly parent?: unknown }, next: () => Promise<unknown>) => { await bridge.flush(); return next() }, { prepend: true }),
    ctx.on('llm/stream', (payload: unknown, next: () => AsyncIterable<unknown>) => (async function* (): AsyncIterable<unknown> {
      await bridge.flush()
      yield* next()
    })(), { prepend: true }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * Attach the bridge to dsh's real session event contract. `session/event` is
 * deliberately an observer: errors are captured by DshSessionBridge and can
 * only surface at the awaited flush boundary.
 */
export function mountDshSessionBridge(
  ctx: DshSessionBridgeContext,
  bridge: DshSessionBridge,
  resolveRunId: DshSessionRunResolver,
): () => void {
  const bound = new Map<string, string>()
  const bind = (session: DshNativeSession): string | undefined => {
    const existing = bound.get(session.id)
    if (existing !== undefined) return existing
    const runId = resolveRunId(session)
    if (runId !== undefined) {
      bridge.bindSession(session.id, runId)
      bound.set(session.id, runId)
    }
    return runId
  }
  const disposers = [
    ctx.on('session/created', (session: DshNativeSession) => { bind(session) }),
    ctx.on('session/event', (session: DshNativeSession, event: DshSessionEvent) => {
      const runId = bind(session)
      if (runId !== undefined) bridge.observe({ sessionId: session.id, runId, event })
    }),
    ctx.on('session/disposed', (session: DshNativeSession) => { bound.delete(session.id) }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    bound.clear()
  }
}

export interface DshIdleLifecycleContext {
  on(name: 'agent/status', listener: (event: { readonly agent: { readonly id: string }; readonly status: string }) => unknown): () => void
}

/** Flush and close a bound run after dsh reports the agent's true idle state. */
export function mountDshIdleLifecycle(
  ctx: DshIdleLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (agentId: string) => { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined,
): () => void {
  return ctx.on('agent/status', (event) => {
    if (event.status !== 'idle') return
    const close = resolveClose(event.agent.id)
    if (close !== undefined) void lifecycle.closeTurn(close)
  })
}
