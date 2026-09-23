import type { SqliteDatabase } from '../db/adapter.js';

/** A projection from an older database cannot silently become an auto-global candidate. */
export function autoGlobalizationInstalled(db: SqliteDatabase): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_global_application_receipts'").get();
}

export function enqueueAutoGlobalRecheck(db: SqliteDatabase, entryId: string, revision: number, now = new Date().toISOString()): void {
  if (!autoGlobalizationInstalled(db)) return;
  db.prepare(`INSERT INTO auto_global_queue(entry_id,entry_revision,state,reason,updated_at)
    VALUES(?,?,'pending',NULL,?) ON CONFLICT(entry_id,entry_revision) DO UPDATE SET
    state='pending',reason=NULL,updated_at=excluded.updated_at`).run(entryId, revision, now);
}

