import type { SqliteDatabase, SqliteRow, SqliteValue } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';

const MAX_CACHED_BYTES = 32 * 1024 * 1024;
let nextSnapshot = 0;

/** Share identical reads only inside a synchronous, consistent SQLite snapshot.
 * Neither the adapter nor its cached rows may survive into external work. */
export function withContextReadSnapshot<T>(database: SqliteDatabase, operation: (snapshot: SqliteDatabase) => T): T {
  const savepoint = `context_read_${++nextSnapshot}`;
  const cache = new Map<string, unknown>();
  let bytes = 0, active = true;
  const reject = (): never => { throw new KiokukoError('INTEGRITY_ERROR', 'Context snapshot is read-only and request-local'); };
  const read = (sql: string, method: 'get' | 'all', args: SqliteValue[]) => {
    if (!active || !/^\s*SELECT\b/iu.test(sql)) reject();
    // Selection-state reads use scalar bindings. Bypass cache for uncommon
    // binary/bigint inputs instead of weakening SQLite parameter identity.
    const key = args.every(value => value === null || typeof value === 'string' || typeof value === 'number') ? JSON.stringify([sql, method, args]) : null;
    if (key !== null && cache.has(key)) return structuredClone(cache.get(key));
    const value = database.prepare(sql)[method](...args);
    if (key !== null && bytes < MAX_CACHED_BYTES) {
      const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value ?? null));
      if (bytes + size <= MAX_CACHED_BYTES) { cache.set(key, structuredClone(value)); bytes += size; }
    }
    return value;
  };
  const snapshot: SqliteDatabase = { filePath: database.filePath, close: reject, exec: reject,
    prepare: sql => ({ run: reject, get: <R extends SqliteRow>(...args: SqliteValue[]) => read(sql, 'get', args) as R | undefined,
      all: <R extends SqliteRow>(...args: SqliteValue[]) => read(sql, 'all', args) as R[] }) };
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation(snapshot);
    if (result !== null && typeof result === 'object' && 'then' in result) reject();
    return result;
  } finally {
    active = false; cache.clear();
    database.exec(`RELEASE ${savepoint}`);
  }
}
