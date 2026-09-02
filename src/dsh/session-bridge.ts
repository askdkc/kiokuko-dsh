import { cloneBoundaryJson, type BoundaryJsonValue } from '../serialization/boundary-json.js'
import { KiokukoError } from '../errors.js'
import { LedgerStore } from '../ledger/store.js'
import { MAX_BATCH_EVENTS, type LedgerEventInput } from '../ledger/types.js'
import type { DshRuntime } from './runtime.js'
import { dshSessionEventSourceId } from './agent-state.js'

export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
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
  readonly event: Readonly<{ type: string; seq: number; time: number; data: BoundaryJsonValue; surfaceOp?: BoundaryJsonValue; sourceEventSeqs?: readonly number[]; ignorable?: true }>
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
  readonly header?: { readonly createdAt?: number }
}

export interface DshSessionBridgeContext {
  on(name: 'session/created' | 'session/disposed' | 'session/event', listener: (...args: any[]) => any, options?: { readonly prepend?: boolean }): () => void
}

export type DshSessionRunResolver = (session: DshNativeSession) => string | undefined

export interface DshRunLifecycleOptions {
  readonly bridge: Pick<DshSessionBridge, 'flush' | 'close'> & { readonly sealRun?: (runId: string) => void }
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
    this.#bridge.sealRun?.(input.runId)
  }

  async dispose(): Promise<void> {
    await this.#bridge.close()
  }
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message)
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) validation(`${label} must be a bounded non-empty string`)
  return value
}

function validEvent(value: unknown): DshSessionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation('SessionEvent must be a plain object')
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 256 || /[\p{Cc}\p{Cf}]/u.test(event.type)) validation('SessionEvent type is invalid')
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) validation('SessionEvent sequence is invalid')
  if (!Number.isFinite(event.time)) validation('SessionEvent time is invalid')
  const sourceEventSeqs = event.sourceEventSeqs === undefined
    ? undefined
    : Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length <= MAX_SOURCE_EVENT_SEQS && event.sourceEventSeqs.every((value) => Number.isSafeInteger(value) && value >= 0)
      ? Object.freeze([...event.sourceEventSeqs] as number[])
      : (() => { validation('SessionEvent source sequence list is invalid') })()
  return {
    type: event.type,
    seq: event.seq as number,
    time: event.time as number,
    data: event.data,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(event.ignorable === true ? { ignorable: true as const } : {}),
  }
}

function queuedFingerprint(item: DshQueuedSessionEvent): string {
  return JSON.stringify(item.event)
}

function ledgerEvent(item: DshQueuedSessionEvent): LedgerEventInput {
  const event = {
    type: item.event.type,
    seq: item.event.seq,
    time: item.event.time,
    data: item.event.data,
    ...(item.event.surfaceOp === undefined ? {} : { surfaceOp: item.event.surfaceOp }),
    ...(item.event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...item.event.sourceEventSeqs] }),
    ...(item.event.ignorable === true ? { ignorable: true as const } : {}),
  }
  return {
    sourceEventId: item.sourceEventId,
    sourceSequence: item.sourceSequence,
    eventType: 'source.event',
    sourceType: 'dsh-session',
    actor: 'dsh',
    occurredAt: new Date(item.event.time).toISOString(),
    payload: { sessionId: item.sessionId, event },
  }
}

const MAX_COMMITTED_EVENTS = 4_096
const MAX_PENDING_EVENTS = 4_096
const MAX_OBSERVER_ERRORS = 64
const MAX_SOURCE_EVENT_SEQS = 2_048

/** Bridge committed dsh session events into Kiokuko's ordered ledger. */
export class DshSessionBridge {
  readonly #runtime: Pick<DshRuntime, 'withDatabase'>
  readonly #appendBatch: (runId: string, events: readonly LedgerEventInput[]) => unknown | PromiseLike<unknown>
  readonly #runs = new Map<string, { readonly runId: string; readonly incarnation: string }>()
  readonly #pending = new Map<string, DshQueuedSessionEvent>()
  readonly #committed = new Map<string, string>()
  readonly #observerErrors: unknown[] = []
  #flushPromise: Promise<void> | undefined
  #closed = false

  #recordObserverError(error: unknown): void {
    // Preserve the first failures for fail-closed reads without allowing a
    // malformed-event storm to grow this long-lived bridge without bound.
    if (this.#observerErrors.length < MAX_OBSERVER_ERRORS) this.#observerErrors.push(error)
  }

  constructor(options: DshSessionBridgeOptions) {
    this.#runtime = options.runtime
    this.#appendBatch = options.appendBatch ?? ((runId, events) => this.#runtime.withDatabase((database) => new LedgerStore(database).appendBatch(runId, { events })))
  }

  bindSession(sessionId: string, runId: string, incarnation = runId): void {
    if (this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh session bridge is closed')
    const session = validId(sessionId, 'sessionId')
    const run = validId(runId, 'runId')
    const identity = validId(incarnation, 'incarnation')
    const existing = this.#runs.get(session)
    if (existing !== undefined && existing.runId !== run) throw new KiokukoError('CONFLICT', 'dsh session is already bound to another run')
    if (existing !== undefined && existing.incarnation !== identity) throw new KiokukoError('CONFLICT', 'dsh session incarnation changed while it was active')
    if (existing === undefined) this.#runs.set(session, { runId: run, incarnation: identity })
  }

  /** Remove a disposed native session binding while retaining queued events. */
  unbindSession(sessionId: string): void {
    const session = validId(sessionId, 'sessionId')
    this.#runs.delete(session)
  }

  /** Reject late native events after the owning run has been terminalized. */
  sealRun(runId: string): void {
    const run = validId(runId, 'runId')
    for (const [sessionId, binding] of this.#runs) {
      if (binding.runId === run) this.#runs.delete(sessionId)
    }
  }

  /** Replace an intentional turn-scoped binding without reattributing queued events. */
  rebindSession(sessionId: string, runId: string, incarnation = runId): void {
    const session = validId(sessionId, 'sessionId')
    const run = validId(runId, 'runId')
    const identity = validId(incarnation, 'incarnation')
    if (this.#closed) return
    this.#runs.set(session, { runId: run, incarnation: identity })
  }

  bindingOf(sessionId: string): string | undefined {
    return this.#runs.get(validId(sessionId, 'sessionId'))?.runId
  }

  /** Record a post-commit observer failure without throwing from the host event emitter. */
  reportObserverError(error: unknown): void {
    if (this.#closed) return
    this.#recordObserverError(error)
  }

  /** Post-commit observer: malformed events are recorded and never veto the session append. */
  observe(input: DshSessionEventInput): void {
    if (this.#closed) return
    try {
      const sessionId = validId(input.sessionId, 'sessionId')
      const binding = this.#runs.get(sessionId)
      if (binding === undefined || binding.runId !== input.runId) validation('dsh session has no matching run binding')
      const event = validEvent(input.event)
      const sourceEventId = dshSessionEventSourceId(sessionId, event.seq, binding.incarnation)
      const data = cloneBoundaryJson(event.data ?? null, { maximumDepth: 32, maximumNodes: 2_000, maximumStringBytes: 64 * 1024, failure: () => new KiokukoError('VALIDATION_ERROR', 'SessionEvent data is not JSON-safe') })
      const surfaceOp = event.surfaceOp === undefined
        ? undefined
        : cloneBoundaryJson(event.surfaceOp, { maximumDepth: 16, maximumNodes: 500, maximumStringBytes: 8 * 1024, failure: () => new KiokukoError('VALIDATION_ERROR', 'SessionEvent surface operation is not JSON-safe') })
      const queued = Object.freeze({
        runId: binding.runId,
        sessionId,
        sourceEventId,
        sourceSequence: event.seq,
        event: Object.freeze({
          type: event.type,
          seq: event.seq,
          time: event.time,
          data,
          ...(surfaceOp === undefined ? {} : { surfaceOp: surfaceOp as BoundaryJsonValue }),
          ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: Object.freeze([...event.sourceEventSeqs]) }),
          ...(event.ignorable === true ? { ignorable: true as const } : {}),
        }),
      })
      const existing = this.#pending.get(sourceEventId)
      const committed = this.#committed.get(sourceEventId)
      const fingerprint = queuedFingerprint(queued)
      if (existing !== undefined) {
        if (queuedFingerprint(existing) !== fingerprint) this.#recordObserverError(new KiokukoError('CONFLICT', 'Duplicate dsh session event identity has different content'))
        return
      }
      if (committed !== undefined) {
        if (committed !== fingerprint) this.#recordObserverError(new KiokukoError('CONFLICT', 'Committed dsh session event identity has different content'))
        return
      }
      if (this.#pending.size >= MAX_PENDING_EVENTS) {
        this.#recordObserverError(new KiokukoError('SERVICE_UNAVAILABLE', 'dsh session event bridge capacity is exhausted'))
        return
      }
      this.#pending.set(sourceEventId, queued)
    } catch (error) {
      this.#recordObserverError(error)
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
    while (this.#pending.size > 0) {
      const grouped = new Map<string, DshQueuedSessionEvent[]>()
      for (const item of this.#pending.values()) {
        const group = grouped.get(item.runId) ?? []
        group.push(item)
        grouped.set(item.runId, group)
      }
      const markCommitted = (items: readonly DshQueuedSessionEvent[]): void => {
        for (const item of items) {
          if (this.#pending.get(item.sourceEventId) === item) {
            this.#pending.delete(item.sourceEventId)
            this.#committed.set(item.sourceEventId, queuedFingerprint(item))
            while (this.#committed.size > MAX_COMMITTED_EVENTS) {
              const oldest = this.#committed.keys().next().value as string | undefined
              if (oldest === undefined) break
              this.#committed.delete(oldest)
            }
          }
        }
      }
      const batches = [...grouped.entries()].map(async ([runId, items]) => {
        items.sort((left, right) => left.sourceSequence - right.sourceSequence)
        for (let offset = 0; offset < items.length; offset += MAX_BATCH_EVENTS) {
          const chunk = items.slice(offset, offset + MAX_BATCH_EVENTS)
          await this.#appendBatch(runId, chunk.map(ledgerEvent))
          // Commit each successful chunk immediately. If a later chunk fails,
          // only the uncommitted suffix remains for retry; an exact retry of a
          // completed prefix cannot duplicate its ledger evidence.
          markCommitted(chunk)
        }
      })
      await Promise.all(batches)
    }
    const observerError = this.#observerErrors[0]
    if (observerError !== undefined) throw observerError
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
    this.#runs.clear()
    this.#pending.clear()
    this.#committed.clear()
    this.#observerErrors.length = 0
  }
}

/** Install prepend durability barriers around the four model/session boundaries. */
export function mountDshDurabilityBarriers(ctx: DshDurabilityContext, bridge: DshSessionBridge): () => void {
  const disposers = [
    ctx.on('session/flush', async (_session: unknown) => { await bridge.flush() }),
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
  const bound = new Map<string, { readonly runId: string; readonly incarnation: string; readonly session: DshNativeSession }>()
  const disposed = new Map<string, DshNativeSession>()
  const incarnationFor = (session: DshNativeSession, runId: string): string => {
    const createdAt = session.header?.createdAt
    return Number.isSafeInteger(createdAt) && (createdAt as number) >= 0 ? `${runId}@${createdAt}` : runId
  }
  const bind = (session: DshNativeSession, allowDisposed = false): string | undefined => {
    if (!allowDisposed && disposed.has(session.id)) throw new KiokukoError('CONFLICT', 'dsh session emitted an event after disposal')
    const runId = resolveRunId(session)
    if (runId === undefined) {
      if (bound.has(session.id)) throw new KiokukoError('CONFLICT', 'dsh session no longer has an active run binding')
      return undefined
    }
    const incarnation = incarnationFor(session, runId)
    const existing = bound.get(session.id)
    if (existing === undefined) {
      bridge.bindSession(session.id, runId, incarnation)
    } else if (existing.runId !== runId) {
      bridge.rebindSession(session.id, runId, incarnation)
    } else if (existing.session !== session || existing.incarnation !== incarnation) {
      // Same ID/run with a different native object or creation incarnation is
      // not safe to reattribute. Wait for disposal to establish a new session.
      throw new KiokukoError('CONFLICT', 'dsh session identity changed while it was active')
    }
    bound.set(session.id, { runId, incarnation, session })
    return runId
  }
  const disposers = [
    ctx.on('session/created', (session: DshNativeSession) => {
      try {
        if (disposed.get(session.id) === session) throw new KiokukoError('CONFLICT', 'dsh disposed session was recreated without a new native object')
        const runId = bind(session, true)
        if (runId !== undefined) disposed.delete(session.id)
      } catch (error) { bridge.reportObserverError(error) }
    }),
    ctx.on('session/event', (session: DshNativeSession, event: DshSessionEvent) => {
      try {
        const runId = bind(session)
        if (runId !== undefined) bridge.observe({ sessionId: session.id, runId, event })
      } catch (error) {
        bridge.reportObserverError(error)
      }
    }),
    ctx.on('session/disposed', (session: DshNativeSession) => {
      try {
        const current = bound.get(session.id)
        // Disposal is object-specific. A late notification for an older
        // object must not tear down a newer session that reused the same ID.
        if (current !== undefined && current.session !== session) {
          throw new KiokukoError('CONFLICT', 'dsh stale session disposal ignored')
        }
        bound.delete(session.id)
        bridge.unbindSession(session.id)
        disposed.set(session.id, session)
      } catch (error) {
        bridge.reportObserverError(error)
      }
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    bound.clear()
    disposed.clear()
  }
}

export interface DshIdleLifecycleContext {
  on(name: 'agent/status', listener: (event: {
    readonly agent: { readonly id: string; readonly session?: { readonly id: string }; readonly sessionId?: string }
    readonly status: string
  }) => unknown): () => void
}

/** Flush and close a bound run after dsh reports the agent's true idle state. */
export function mountDshIdleLifecycle(
  ctx: DshIdleLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object) => { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | PromiseLike<{ readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined> | undefined,
): () => void {
  return ctx.on('agent/status', async (event) => {
    try {
      if (event.status !== 'idle') return
      const sessionId = event.agent.session?.id ?? event.agent.sessionId
      const close = await resolveClose(event.agent.id, sessionId, event.agent.session as object | undefined, event.agent as object)
      if (close !== undefined) await lifecycle.closeTurn(close)
    } catch {
      // Cordis `emit` does not await async listeners. Contain state-read,
      // durability, and close failures here so an ordinary idle event never
      // becomes an unhandled rejection or a false terminal transition.
    }
  })
}
