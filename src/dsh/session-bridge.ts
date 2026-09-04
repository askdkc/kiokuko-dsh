import { KiokukoError } from '../errors.js'
import { dshTurnBoundarySeq, type DshSessionEventSource } from './session-memory-finalizer.js'

/** Minimal native DSH session identity used only at terminal checkpoints. */
export interface DshNativeSession {
  readonly id: string
  readonly header?: { readonly createdAt?: number; readonly cwd?: string }
  readonly snapshotEvents?: DshSessionEventSource['snapshotEvents']
}

type DshRunStatus = 'completed' | 'failed' | 'cancelled'

export interface DshRunClose {
  readonly runId: string
  readonly status: DshRunStatus
  readonly sourceEndSeq?: number
}

export interface DshRunLifecycleOptions {
  readonly closeRun: (input: DshRunClose) => void | PromiseLike<void>
}

export interface DshCloseIntent {
  readonly runId: string
  readonly status: DshRunStatus
  readonly terminalTurn?: number
  readonly sourceEndSeq?: number
}

function sameClose(left: DshCloseIntent, right: DshCloseIntent): boolean {
  return left.status === right.status
    && left.sourceEndSeq === right.sourceEndSeq
}

function checkpointedClose(close: DshCloseIntent, session: DshNativeSession): DshCloseIntent {
  if (close.status !== 'completed') return close
  if (close.terminalTurn === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Completed DSH close has no terminal turn boundary')
  }
  if (typeof session.snapshotEvents !== 'function') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Completed DSH close has no exact native event source')
  }
  return { ...close, sourceEndSeq: dshTurnBoundarySeq(session as DshSessionEventSource, close.terminalTurn, 'end') }
}

/**
 * Idempotent terminal run lifecycle. DSH owns event persistence; this class
 * deliberately has no event bridge or flush listener. The caller first awaits
 * the native DSH checkpoint, then commits the Kiokuko close/finalization job.
 */
export class DshRunLifecycle {
  readonly #closeRun: DshRunLifecycleOptions['closeRun']
  readonly #closeInFlight = new Map<string, Promise<void>>()
  readonly #closeIntents = new Map<string, DshCloseIntent>()
  readonly #sealedRuns = new Map<string, DshCloseIntent>()

  constructor(options: DshRunLifecycleOptions) {
    this.#closeRun = options.closeRun
  }

  async closeTurn(input: DshCloseIntent): Promise<void> {
    const sealed = this.#sealedRuns.get(input.runId)
    if (sealed !== undefined) {
      if (!sameClose(sealed, input)) throw new KiokukoError('CONFLICT', 'Run close status or log boundary is immutable')
      return
    }
    const intent = this.#closeIntents.get(input.runId)
    if (intent !== undefined && !sameClose(intent, input)) {
      throw new KiokukoError('CONFLICT', 'Run close status or log boundary is immutable')
    }
    const existing = this.#closeInFlight.get(input.runId)
    if (existing !== undefined) return existing
    const close = intent ?? Object.freeze({ ...input })
    this.#closeIntents.set(input.runId, close)
    const operation = Promise.resolve(this.#closeRun(close)).then(() => {
      this.#sealedRuns.set(close.runId, close)
      this.#closeIntents.delete(close.runId)
    }).finally(() => {
      if (this.#closeInFlight.get(close.runId) === operation) this.#closeInFlight.delete(close.runId)
    })
    this.#closeInFlight.set(close.runId, operation)
    return operation
  }

  /** Retry any retained close intent once during orderly adapter teardown. */
  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const close of [...this.#closeInFlight.values()]) {
      try { await close } catch { /* retried from the retained intent below */ }
    }
    for (const intent of [...this.#closeIntents.values()]) {
      try { await this.closeTurn(intent) } catch (error) { failures.push(error) }
    }
    this.#closeInFlight.clear()
    this.#closeIntents.clear()
    this.#sealedRuns.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'DSH run lifecycle cleanup failed')
  }
}

export interface DshIdleLifecycleContext {
  on(name: 'agent/status', listener: (event: {
    readonly agent: { readonly id: string; readonly session?: DshNativeSession; readonly sessionId?: string }
    readonly status: string
  }) => unknown): () => void
}

export interface DshSessionLifecycleContext {
  on(name: 'session/disposed', listener: (session: DshNativeSession) => unknown): () => void
}

/** Flush the exact DSH session only after Enno reports a terminal state. */
export function mountDshIdleLifecycle(
  ctx: DshIdleLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object) => DshCloseIntent | PromiseLike<DshCloseIntent | undefined> | undefined,
  flushNativeSession: (session: DshNativeSession) => void | PromiseLike<void>,
): () => void {
  return ctx.on('agent/status', async (event) => {
    try {
      if (event.status !== 'idle') return
      const sessionId = event.agent.session?.id ?? event.agent.sessionId
      const close = await resolveClose(event.agent.id, sessionId, event.agent.session, event.agent)
      if (close === undefined) return
      if (event.agent.session === undefined) throw new KiokukoError('CONFLICT', 'DSH terminal checkpoint requires the exact live native session')
      await flushNativeSession(event.agent.session)
      await lifecycle.closeTurn(checkpointedClose(close, event.agent.session))
    } catch {
      // DSH emit listeners are observe-only. A failed native checkpoint or
      // Kiokuko close remains retryable and never changes DSH's terminal state.
    }
  })
}

/** Flush and close the final conversation run when its DSH session is disposed. */
export function mountDshSessionLifecycle(
  ctx: DshSessionLifecycleContext,
  lifecycle: DshRunLifecycle,
  resolveClose: (sessionId: string, nativeSession: object) => DshCloseIntent | PromiseLike<DshCloseIntent | undefined> | undefined,
  flushNativeSession: (session: DshNativeSession) => void | PromiseLike<void>,
): () => void {
  return ctx.on('session/disposed', async (session) => {
    try {
      const close = await resolveClose(session.id, session)
      if (close === undefined) return
      await flushNativeSession(session)
      await lifecycle.closeTurn(checkpointedClose(close, session))
    } catch {
      // Session disposal is post-commit cleanup. The lifecycle retains a
      // failed close intent for orderly teardown; DSH disposal is never vetoed.
    }
  })
}
