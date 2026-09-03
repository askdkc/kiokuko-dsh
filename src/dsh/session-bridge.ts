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
  readonly queueGeneration: number
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
  readonly header?: { readonly createdAt?: number; readonly cwd?: string }
}

export interface DshSessionBridgeContext {
  on(name: 'session/created' | 'session/disposed' | 'session/event', listener: (...args: any[]) => any, options?: { readonly prepend?: boolean }): () => void
}

export type DshSessionRunResolver = (session: DshNativeSession) => string | undefined

type DshRunStatus = 'completed' | 'failed' | 'cancelled'

export interface DshRunLifecycleOptions {
  readonly bridge: Pick<DshSessionBridge, 'flush' | 'close'> & {
    readonly flushRun?: (runId: string, target?: number) => Promise<void>
    readonly quiesceRun?: (runId: string) => number
    readonly sealRun?: (runId: string) => void
  }
  readonly closeRun: (input: { readonly runId: string; readonly status: DshRunStatus }) => void | PromiseLike<void>
}

interface DshCloseIntent {
  readonly runId: string
  readonly status: DshRunStatus
  readonly targetGeneration: number | undefined
}

/** Close a run only after the ordered dsh suffix is durably bridged. */
export class DshRunLifecycle {
  readonly #bridge: DshRunLifecycleOptions['bridge']
  readonly #closeRun: DshRunLifecycleOptions['closeRun']
  readonly #closeInFlight = new Map<string, Promise<void>>()
  readonly #closeIntents = new Map<string, DshCloseIntent>()
  readonly #sealedRuns = new Map<string, DshRunStatus>()

  constructor(options: DshRunLifecycleOptions) {
    this.#bridge = options.bridge
    this.#closeRun = options.closeRun
  }

  async closeTurn(input: { readonly runId: string; readonly status: DshRunStatus }): Promise<void> {
    const sealedStatus = this.#sealedRuns.get(input.runId)
    if (sealedStatus !== undefined) {
      if (sealedStatus !== input.status) throw new KiokukoError('CONFLICT', 'Run close status is immutable')
      return
    }
    const existingIntent = this.#closeIntents.get(input.runId)
    if (existingIntent !== undefined && existingIntent.status !== input.status) {
      throw new KiokukoError('CONFLICT', 'Run close status is immutable')
    }
    const existing = this.#closeInFlight.get(input.runId)
    if (existing !== undefined) return existing
    const intent = existingIntent ?? Object.freeze({
      runId: input.runId,
      status: input.status,
      targetGeneration: this.#bridge.quiesceRun?.(input.runId),
    })
    this.#closeIntents.set(input.runId, intent)
    const operation = (async () => {
      if (this.#bridge.flushRun === undefined) await this.#bridge.flush(intent.targetGeneration)
      else await this.#bridge.flushRun(intent.runId, intent.targetGeneration)
      await this.#closeRun({ runId: intent.runId, status: intent.status })
      this.#bridge.sealRun?.(intent.runId)
      this.#sealedRuns.set(intent.runId, intent.status)
    })().finally(() => {
      if (this.#closeInFlight.get(input.runId) === operation) this.#closeInFlight.delete(input.runId)
    })
    this.#closeInFlight.set(input.runId, operation)
    return operation
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const close of this.#closeInFlight.values()) {
      try { await close } catch (error) { failures.push(error) }
    }
    try { await this.#bridge.close() } catch (error) { failures.push(error) }
    this.#closeInFlight.clear()
    this.#closeIntents.clear()
    this.#sealedRuns.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh run lifecycle cleanup failed')
  }
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message)
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) validation(`${label} must be a bounded non-empty string`)
  return value
}

function validSourceEventSeqs(value: unknown, eventSequence: number): readonly number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) validation('SessionEvent source sequence list is invalid')
  const seen = new Set<number>()
  const sequences: number[] = []
  for (const sourceSequence of value) {
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0 || sourceSequence >= eventSequence || seen.has(sourceSequence)) {
      validation('SessionEvent source sequence list is invalid')
    }
    seen.add(sourceSequence)
    sequences.push(sourceSequence)
  }
  return Object.freeze(sequences)
}

function validEvent(value: unknown): DshSessionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation('SessionEvent must be a plain object')
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 256 || /[\p{Cc}\p{Cf}]/u.test(event.type)) validation('SessionEvent type is invalid')
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) validation('SessionEvent sequence is invalid')
  if (!Number.isFinite(event.time)) validation('SessionEvent time is invalid')
  const sourceEventSeqs = validSourceEventSeqs(event.sourceEventSeqs, event.seq as number)
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

/** Bridge committed dsh session events into Kiokuko's ordered ledger. */
export class DshSessionBridge {
  readonly #runtime: Pick<DshRuntime, 'withDatabase'>
  readonly #appendBatch: (runId: string, events: readonly LedgerEventInput[]) => unknown | PromiseLike<unknown>
  readonly #runs = new Map<string, { readonly runId: string; readonly incarnation: string }>()
  readonly #closingRuns = new Map<string, number>()
  /** Retain terminal run identities until bridge disposal. */
  readonly #sealedRuns = new Set<string>()
  readonly #pending = new Map<string, DshQueuedSessionEvent>()
  readonly #committed = new Map<string, string>()
  readonly #observerErrors: Array<{ readonly runId?: string; readonly error: unknown }> = []
  #flushTail: Promise<void> = Promise.resolve()
  #backgroundFlush: Promise<void> | undefined
  #closePromise: Promise<void> | undefined
  #nextGeneration = 0
  #closing = false
  #closed = false

  #recordObserverError(error: unknown, runId?: string): void {
    // Preserve the first failures for fail-closed reads without allowing a
    // malformed-event storm to grow this long-lived bridge without bound.
    if (this.#observerErrors.length < MAX_OBSERVER_ERRORS) this.#observerErrors.push({ ...(runId === undefined ? {} : { runId }), error })
  }

  #scheduleBackgroundFlush(): void {
    if (this.#backgroundFlush !== undefined || this.#closed || this.#closing) return
    const operation = this.flush()
    this.#backgroundFlush = operation
    void operation.then(
      () => {
        if (this.#backgroundFlush === operation) this.#backgroundFlush = undefined
        if (this.#pending.size >= MAX_BATCH_EVENTS) this.#scheduleBackgroundFlush()
      },
      () => {
        // Keep the failed suffix queued. The next awaited durability barrier
        // retries it and surfaces a persistent storage failure synchronously.
        if (this.#backgroundFlush === operation) this.#backgroundFlush = undefined
      },
    )
  }

  constructor(options: DshSessionBridgeOptions) {
    this.#runtime = options.runtime
    this.#appendBatch = options.appendBatch ?? ((runId, events) => this.#runtime.withDatabase((database) => new LedgerStore(database).appendBatch(runId, { events })))
  }

  bindSession(sessionId: string, runId: string, incarnation = runId): void {
    if (this.#closed || this.#closing) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh session bridge is closed')
    const session = validId(sessionId, 'sessionId')
    const run = validId(runId, 'runId')
    if (this.#sealedRuns.has(run)) throw new KiokukoError('CONFLICT', 'dsh run is sealed')
    if (this.#closingRuns.has(run)) throw new KiokukoError('CONFLICT', 'dsh run is closing')
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
  quiesceRun(runId: string): number {
    const run = validId(runId, 'runId')
    if (this.#sealedRuns.has(run)) throw new KiokukoError('CONFLICT', 'dsh run is sealed')
    const existing = this.#closingRuns.get(run)
    if (existing !== undefined) return existing
    const target = this.#nextGeneration
    this.#closingRuns.set(run, target)
    return target
  }

  /** Reject late native events after the owning run has been terminalized. */
  sealRun(runId: string): void {
    const run = validId(runId, 'runId')
    this.#closingRuns.delete(run)
    this.#sealedRuns.add(run)
    for (const [sessionId, binding] of this.#runs) {
      if (binding.runId === run) this.#runs.delete(sessionId)
    }
  }

  /** Replace an intentional turn-scoped binding without reattributing queued events. */
  rebindSession(sessionId: string, runId: string, incarnation = runId): void {
    const session = validId(sessionId, 'sessionId')
    const run = validId(runId, 'runId')
    const identity = validId(incarnation, 'incarnation')
    if (this.#closed || this.#closing || this.#closingRuns.has(run) || this.#sealedRuns.has(run)) return
    this.#runs.set(session, { runId: run, incarnation: identity })
  }

  bindingOf(sessionId: string): string | undefined {
    return this.#runs.get(validId(sessionId, 'sessionId'))?.runId
  }

  /** Record a post-commit observer failure without throwing from the host event emitter. */
  reportObserverError(error: unknown, runId?: string): void {
    if (this.#closed) return
    this.#recordObserverError(error, runId)
  }

  /** Post-commit observer: malformed events are recorded and never veto the session append. */
  observe(input: DshSessionEventInput): void {
    if (this.#closed || this.#closing) return
    let authoritativeRunId: string | undefined
    try {
      const sessionId = validId(input.sessionId, 'sessionId')
      const binding = this.#runs.get(sessionId)
      if (binding === undefined || binding.runId !== input.runId) validation('dsh session has no matching run binding')
      authoritativeRunId = binding.runId
      if (this.#sealedRuns.has(binding.runId)) validation('dsh run is sealed')
      if (this.#closingRuns.has(binding.runId)) validation('dsh run is closing')
      const event = validEvent(input.event)
      const sourceEventId = dshSessionEventSourceId(sessionId, event.seq, binding.incarnation)
      const data = cloneBoundaryJson(event.data ?? null, { maximumDepth: 32, maximumNodes: 2_000, maximumStringBytes: 64 * 1024, failure: () => new KiokukoError('VALIDATION_ERROR', 'SessionEvent data is not JSON-safe') })
      const surfaceOp = event.surfaceOp === undefined
        ? undefined
        : cloneBoundaryJson(event.surfaceOp, { maximumDepth: 16, maximumNodes: 500, maximumStringBytes: 8 * 1024, failure: () => new KiokukoError('VALIDATION_ERROR', 'SessionEvent surface operation is not JSON-safe') })
      const queued = Object.freeze({
        runId: binding.runId,
        sessionId,
        queueGeneration: ++this.#nextGeneration,
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
        if (queuedFingerprint(existing) !== fingerprint) this.#recordObserverError(new KiokukoError('CONFLICT', 'Duplicate dsh session event identity has different content'), binding.runId)
        return
      }
      if (committed !== undefined) {
        if (committed !== fingerprint) this.#recordObserverError(new KiokukoError('CONFLICT', 'Committed dsh session event identity has different content'), binding.runId)
        return
      }
      if (this.#pending.size >= MAX_PENDING_EVENTS) {
        this.#recordObserverError(new KiokukoError('SERVICE_UNAVAILABLE', 'dsh session event bridge capacity is exhausted'), binding.runId)
        return
      }
      this.#pending.set(sourceEventId, queued)
      if (this.#pending.size >= MAX_BATCH_EVENTS) this.#scheduleBackgroundFlush()
    } catch (error) {
      this.#recordObserverError(error, authoritativeRunId)
    }
  }

  get pendingCount(): number { return this.#pending.size }
  get observerErrors(): readonly unknown[] { return this.#observerErrors.map((item) => item.error) }

  async flush(target = this.#nextGeneration): Promise<void> {
    const operation = this.#flushTail.then(() => this.#flushPending(target))
    this.#flushTail = operation.catch(() => undefined)
    return operation
  }

  /** Flush only the exact run crossing a DSH durability or close boundary. */
  async flushRun(runId: string, target = this.#nextGeneration): Promise<void> {
    const run = validId(runId, 'runId')
    const operation = this.#flushTail.then(() => this.#flushPending(target, run))
    this.#flushTail = operation.catch(() => undefined)
    return operation
  }

  async #flushPending(target: number, onlyRunId?: string): Promise<void> {
    const selected = (item: DshQueuedSessionEvent): boolean => item.queueGeneration <= target
      && (onlyRunId === undefined || item.runId === onlyRunId)
    while ([...this.#pending.values()].some(selected)) {
      const grouped = new Map<string, DshQueuedSessionEvent[]>()
      for (const item of this.#pending.values()) {
        if (!selected(item)) continue
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
    const observerError = this.#observerErrors.find((item) => item.runId === undefined || onlyRunId === undefined || item.runId === onlyRunId)
    if (observerError !== undefined) throw observerError.error
  }

  async close(): Promise<void> {
    if (this.#closed) return
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closing = true
    const target = this.#nextGeneration
    this.#closePromise = this.#flushTail
      .then(() => this.#flushPending(target))
      .then(() => {
        this.#closed = true
        this.#runs.clear()
        this.#closingRuns.clear()
        this.#sealedRuns.clear()
        this.#pending.clear()
        this.#committed.clear()
        this.#observerErrors.length = 0
      })
      .finally(() => {
        this.#closePromise = undefined
        if (!this.#closed) this.#closing = false
      })
    this.#flushTail = this.#closePromise.catch(() => undefined)
    return this.#closePromise
  }
}

/** Install prepend durability barriers around the four model/session boundaries. */
export function mountDshDurabilityBarriers(ctx: DshDurabilityContext, bridge: DshSessionBridge): () => void {
  const sessionIdFromAgent = (payload: unknown): string | undefined => {
    if (typeof payload !== 'object' || payload === null) return undefined
    const agent = (payload as { agent?: unknown }).agent
    if (typeof agent !== 'object' || agent === null) return undefined
    const session = (agent as { session?: unknown }).session
    if (typeof session === 'object' && session !== null && typeof (session as { id?: unknown }).id === 'string') return (session as { id: string }).id
    return typeof (agent as { sessionId?: unknown }).sessionId === 'string' ? (agent as { sessionId: string }).sessionId : undefined
  }
  const flushSession = async (sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const runId = bridge.bindingOf(sessionId)
    if (runId !== undefined) await bridge.flushRun(runId)
  }
  const disposers = [
    ctx.on('session/flush', async (session: unknown) => {
      await flushSession(typeof session === 'object' && session !== null ? (session as { id?: unknown }).id : undefined)
    }),
    ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => { await flushSession(sessionIdFromAgent(payload)); return next() }, { prepend: true }),
    ctx.on('tools/execute', async (payload: { readonly parent?: unknown }, next: () => Promise<unknown>) => {
      if (payload.parent === undefined) await flushSession(sessionIdFromAgent(payload))
      return next()
    }, { prepend: true }),
    ctx.on('llm/stream', (payload: unknown, next: () => AsyncIterable<unknown>) => (async function* (): AsyncIterable<unknown> {
      const sessionId = typeof payload === 'object' && payload !== null ? (payload as { sessionId?: unknown }).sessionId : undefined
      await flushSession(sessionId)
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
  const unbound = new Map<string, { readonly session: DshNativeSession; readonly events: DshSessionEvent[] }>()
  let unboundEventCount = 0
  const incarnationFor = (session: DshNativeSession, runId: string): string => {
    const createdAt = session.header?.createdAt
    return Number.isSafeInteger(createdAt) && (createdAt as number) >= 0 ? `${runId}@${createdAt}` : runId
  }
  const bind = (session: DshNativeSession, allowDisposed = false): string | undefined => {
    if (!allowDisposed && disposed.has(session.id)) throw new KiokukoError('CONFLICT', 'dsh session emitted an event after disposal')
    const runId = resolveRunId(session)
    if (runId === undefined) {
      if (bound.has(session.id)) {
        // A lifecycle close seals the run and releases the bridge binding
        // before a persistent native session receives its next user turn.
        // Retire the observer's matching stale bookkeeping as well. If the
        // bridge still considers the session bound, the resolver disappeared
        // unexpectedly and must continue to fail closed.
        if (bridge.bindingOf(session.id) !== undefined) {
          throw new KiokukoError('CONFLICT', 'dsh session no longer has an active run binding')
        }
        bound.delete(session.id)
      }
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
    const prefix = unbound.get(session.id)
    if (prefix !== undefined) {
      if (prefix.session !== session) throw new KiokukoError('CONFLICT', 'dsh deferred session identity changed before run binding')
      unbound.delete(session.id)
      unboundEventCount -= prefix.events.length
      for (const event of prefix.events) bridge.observe({ sessionId: session.id, runId, event })
    }
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
        if (runId !== undefined) {
          bridge.observe({ sessionId: session.id, runId, event })
        } else {
          const prefix = unbound.get(session.id)
          if (prefix !== undefined && prefix.session !== session) {
            throw new KiokukoError('CONFLICT', 'dsh deferred session identity changed before run binding')
          }
          const events = prefix?.events ?? []
          if (unboundEventCount >= MAX_PENDING_EVENTS) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh deferred session event capacity is exhausted')
          events.push(event)
          unboundEventCount += 1
          if (prefix === undefined) unbound.set(session.id, { session, events })
        }
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
        const prefix = unbound.get(session.id)
        if (prefix?.session === session) {
          unbound.delete(session.id)
          unboundEventCount -= prefix.events.length
        }
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
    unbound.clear()
    unboundEventCount = 0
  }
}

export interface DshIdleLifecycleContext {
  on(name: 'agent/status', listener: (event: {
    readonly agent: { readonly id: string; readonly session?: { readonly id: string }; readonly sessionId?: string }
    readonly status: string
  }) => unknown): () => void
}

export interface DshSessionLifecycleContext {
  on(name: 'session/disposed', listener: (session: DshNativeSession) => unknown): () => void
}

/** Flush and close a bound run after dsh reports the agent's true idle state. */
export function mountDshIdleLifecycle(
  ctx: DshIdleLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object) => { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | PromiseLike<{ readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined> | undefined,
  flushNativeSession?: (session: DshNativeSession) => void | PromiseLike<void>,
): () => void {
  return ctx.on('agent/status', async (event) => {
    try {
      if (event.status !== 'idle') return
      const sessionId = event.agent.session?.id ?? event.agent.sessionId
      if (flushNativeSession !== undefined) {
        if (event.agent.session === undefined) throw new KiokukoError('CONFLICT', 'dsh idle checkpoint requires the exact live native session')
        await flushNativeSession(event.agent.session)
      }
      const close = await resolveClose(event.agent.id, sessionId, event.agent.session as object | undefined, event.agent as object)
      if (close !== undefined) await lifecycle.closeTurn(close)
    } catch {
      // Cordis `emit` does not await async listeners. Contain state-read,
      // durability, and close failures here so an ordinary idle event never
      // becomes an unhandled rejection or a false terminal transition.
    }
  })
}

/** Flush and close the last run when the owning conversation is disposed. */
export function mountDshSessionLifecycle(
  ctx: DshSessionLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (sessionId: string, nativeSession: object) => { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | PromiseLike<{ readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined> | undefined,
): () => void {
  return ctx.on('session/disposed', async (session) => {
    try {
      const close = await resolveClose(session.id, session)
      if (close !== undefined) await lifecycle.closeTurn(close)
    } catch {
      // Session disposal is post-commit host cleanup. Contain failures here;
      // the lifecycle retains its close intent so adapter disposal can retry.
    }
  })
}
