export type ErrorCode =
  | 'USAGE_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'BACKPRESSURE'
  | 'SERVICE_UNAVAILABLE'
  | 'SECURITY_REJECTION'
  | 'AUTHENTICATION_ERROR'
  | 'INTEGRITY_ERROR'
  | 'PARTIAL_FAILURE'
  | 'NOT_IMPLEMENTED';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE_ERROR: 2,
  VALIDATION_ERROR: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  DATABASE_ERROR: 6,
  BACKPRESSURE: 6,
  SERVICE_UNAVAILABLE: 6,
  SECURITY_REJECTION: 7,
  AUTHENTICATION_ERROR: 7,
  INTEGRITY_ERROR: 8,
  PARTIAL_FAILURE: 9,
  NOT_IMPLEMENTED: 2,
};

export class KiokukoError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'KiokukoError';
    this.exitCode = EXIT_CODES[code];
  }
}

export const STORED_MEMORY_RECOVERY_MESSAGE = [
  'Stored entry or revision is invalid.',
  'Kiokuko setup could not automatically recover existing saved memory.',
  'Recovery:',
  '1. Keep the latest verified SQLite backup; setup creates one automatically before a pending database upgrade.',
  '2. If the memory is needed, keep the backup and do not delete database rows manually.',
  '3. Restore the backup as one SQLite snapshot: move the current database and any -wal, -shm, or -journal sidecar files aside, copy the backup to the original database path, and rerun: kiokuko setup.',
  '   macOS database path: "$HOME/Library/Application Support/kiokuko/kiokuko.sqlite3"',
  '   Linux database path: "${XDG_DATA_HOME:-$HOME/.local/share}/kiokuko/kiokuko.sqlite3"',
  '   Example (replace <new-backup.sqlite3> and choose an unused <timestamp>):',
  '   DB="$HOME/Library/Application Support/kiokuko/kiokuko.sqlite3"; for SUFFIX in "" -wal -shm -journal; do [ -e "$DB$SUFFIX" ] && mv "$DB$SUFFIX" "$DB$SUFFIX.before-restore-<timestamp>"; done; cp "<new-backup.sqlite3>" "$DB"; kiokuko setup',
  '4. If the old memory is disposable, moving the database file aside and rerunning kiokuko setup creates a new database.',
  '5. Keep the .before-restore file until the restored memory has been verified. Do not delete database rows manually.',
].join('\n');

export function storedMemoryIntegrityError(): KiokukoError {
  return new KiokukoError('INTEGRITY_ERROR', STORED_MEMORY_RECOVERY_MESSAGE);
}

export const DATABASE_BACKUP_RECOVERY_MESSAGE = [
  'Database backup could not be created; the source database was not changed.',
  'Check that Node.js is version 24.16.0 or newer and that the backup destination is new and writable.',
  'Do not delete or replace the source database. If backup still fails, preserve the original file for repair or recovery.',
].join('\n');

export function databaseBackupIntegrityError(cause?: unknown): KiokukoError {
  const error = new KiokukoError('INTEGRITY_ERROR', DATABASE_BACKUP_RECOVERY_MESSAGE);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof KiokukoError) return error.exitCode;
  return EXIT_CODES.INTEGRITY_ERROR;
}
