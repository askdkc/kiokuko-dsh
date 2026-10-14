import type { SqliteDatabase } from './adapter.js';
import { withSqliteLockRetry } from './sqlite-retry.js';

/**
 * COMMIT threw and the subsequent ROLLBACK also threw. The caller must treat
 * the transaction as possibly committed: compensating durable side effects
 * could otherwise turn an uncertain outcome into split-brain state.
 */
export class TransactionCommitUncertainError extends AggregateError {
  readonly commitError: unknown;
  readonly rollbackError: unknown;

  constructor(commitError: unknown, rollbackError: unknown) {
    super(
      [commitError, rollbackError],
      'Transaction commit outcome is uncertain because commit and rollback both failed',
    );
    this.name = 'TransactionCommitUncertainError';
    this.commitError = commitError;
    this.rollbackError = rollbackError;
  }
}

export function rollbackFailedTransaction(database: SqliteDatabase, operationError: unknown): never {
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    throw new AggregateError(
      [operationError, rollbackError],
      'Transaction operation failed and rollback also failed',
    );
  }
  throw operationError;
}

function commitOrRollback(database: SqliteDatabase): void {
  try {
    database.exec('COMMIT');
  } catch (commitError) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new TransactionCommitUncertainError(commitError, rollbackError);
    }
    throw commitError;
  }
}

// Track only transactions opened by this utility. A caller using raw BEGIN
// remains responsible for its own composition; do not infer ownership from errors.
const managedTransactions = new WeakMap<SqliteDatabase, number>();
let savepointSequence = 0;
function nestedTransaction<T>(database: SqliteDatabase, operation: () => T, depth: number): T {
  const name = `kiokuko_nested_${++savepointSequence}`;
  database.exec(`SAVEPOINT ${name}`);
  managedTransactions.set(database, depth + 1);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { database.exec(`ROLLBACK TO SAVEPOINT ${name}`); database.exec(`RELEASE SAVEPOINT ${name}`); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Nested transaction and savepoint rollback failed'); }
    throw error;
  } finally { managedTransactions.set(database, depth); }
}

/** Run a synchronous write transaction with bounded retry for SQLite lock errors only.
 * Calls nested within this utility use savepoints and retain the outer writer lock. */
export function withImmediateTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  const depth = managedTransactions.get(database);
  if (depth !== undefined) return nestedTransaction(database, operation, depth);
  return withSqliteLockRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    managedTransactions.set(database, 1);
    try {
      let result: T;
      try { result = operation(); }
      catch (error) { rollbackFailedTransaction(database, error); }
      commitOrRollback(database);
      return result;
    } finally { managedTransactions.delete(database); }
  });
}

/** Run synchronous reads against one SQLite snapshot without reserving a writer lock. */
export function withDeferredReadTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec('BEGIN DEFERRED');
  let result: T;
  try {
    result = operation();
  } catch (error) {
    rollbackFailedTransaction(database, error);
  }
  commitOrRollback(database);
  return result;
}
