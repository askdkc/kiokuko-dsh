import type { SqliteDatabase } from '../db/adapter.js'
import { abortable } from './http-json.js'

/** Bound optional synchronous DB work, including delayed resource acquisition. */
export async function auxiliaryDatabase<T>(
  runtime: { withDatabase<R>(operation: (db: SqliteDatabase) => R | Promise<R>): Promise<R> },
  operation: (db: SqliteDatabase) => T,
  current: () => boolean,
): Promise<T> {
  const signal = AbortSignal.timeout(250)
  return abortable(runtime.withDatabase(db => {
    signal.throwIfAborted()
    if (!current()) throw new Error('Auxiliary database source expired')
    const timeout = Number(db.prepare('PRAGMA busy_timeout').get()!.timeout)
    db.exec('PRAGMA busy_timeout=25')
    try { return operation(db) } finally { db.exec(`PRAGMA busy_timeout=${timeout}`) }
  }), signal)
}
