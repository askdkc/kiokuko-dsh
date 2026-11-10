import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export const INTAKE_PHASES = ['classification', 'auxiliary_assessment', 'authority', 'database', 'lisp_preparation', 'external_wait', 'user_wait', 'preparation'] as const
export type IntakePhase = typeof INTAKE_PHASES[number]
export interface IntakeTiming {
  id: string; phase: IntakePhase; elapsedMs: number
  outcome: 'completed' | 'failed' | 'cancelled' | 'timeout'
}
interface Scope { signal: AbortSignal; records: IntakeTiming[] }
const scopes = new AsyncLocalStorage<Scope>()

/** Timings are inclusive when nested. No arguments, results, paths or errors are retained. */
export async function withIntakeTiming<T>(signal: AbortSignal, report: (timing: IntakeTiming) => Promise<void>, operation: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) return operation()
  const scope: Scope = { signal, records: [] }
  try { return await scopes.run(scope, operation) }
  finally {
    // Outside the measured context: recording a DB timing must not recursively time its own write.
    for (const timing of scope.records) {
      try { await report(timing) } catch { /* Optional diagnostics never change admission. */ }
    }
  }
}

export async function measureIntakePhase<T>(phase: IntakePhase, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const scope = scopes.getStore()
  if (!scope) return operation()
  const started = performance.now()
  let outcome: IntakeTiming['outcome'] = 'completed'
  try { return await operation() }
  catch (error) {
    const stopped = signal?.aborted ? signal : scope.signal
    outcome = stopped.aborted ? stopped.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'
      : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed'
    throw error
  } finally {
    // Bounded per invocation, including nested provider/DB calls.
    if (scope.records.length < 256) scope.records.push({ id: randomUUID(), phase, outcome, elapsedMs: Math.max(0, Math.ceil(performance.now() - started)) })
  }
}
