import type { SqliteDatabase } from '../db/adapter.js'
import { abortable } from './http-json.js'

export const AUXILIARY_DATABASE_LIMIT = 4
const pending = new WeakMap<object, number>()
export function auxiliaryDatabasePending(runtime: object): number { return pending.get(runtime) ?? 0 }

/** Bound optional synchronous DB work, including delayed resource acquisition. */
export async function auxiliaryDatabase<T>(
  runtime: { withDatabase<R>(operation: (db: SqliteDatabase) => R | Promise<R>): Promise<R> },
  operation: (db: SqliteDatabase) => T,
  current: () => boolean,
  sourceSignal?: AbortSignal,
): Promise<T> {
  if (auxiliaryDatabasePending(runtime) >= AUXILIARY_DATABASE_LIMIT) throw new Error('Auxiliary database capacity reached')
  pending.set(runtime, auxiliaryDatabasePending(runtime) + 1)
  const timeoutSignal = AbortSignal.timeout(250)
  const signal = sourceSignal ? AbortSignal.any([sourceSignal, timeoutSignal]) : timeoutSignal
  return abortable(Promise.resolve().then(() => runtime.withDatabase(db => {
    signal.throwIfAborted()
    if (!current()) throw new Error('Auxiliary database source expired')
    const timeout = Number(db.prepare('PRAGMA busy_timeout').get()!.timeout)
    db.exec('PRAGMA busy_timeout=25')
    try { return operation(db) } finally { db.exec(`PRAGMA busy_timeout=${timeout}`) }
  })).finally(() => {
    pending.set(runtime, auxiliaryDatabasePending(runtime) - 1)
  }), signal)
}
