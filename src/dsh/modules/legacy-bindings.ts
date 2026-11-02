import type { SqliteDatabase } from '../../db/adapter.js'

/** Compatibility ownership for pre-module state. No transitions, lease changes or replay.
 * Legacy `enno` owner rows belong to a retired run: they require no module and
 * admission refuses the owner mode when the run is reopened. */
export function legacyModuleRequirements(db: SqliteDatabase, sessionId: string): readonly string[] {
  const required = new Set<string>()
  const owner = db.prepare('SELECT mode FROM dsh_execution_owners WHERE dsh_session_id=?').get<{ mode: string }>(sessionId)
  if (owner && owner.mode === 'deep-thinker') required.add('deep-thinker')
  if (db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(sessionId)) required.add('lisp')
  return [...required]
}
