import type { SqliteDatabase } from '../../db/adapter.js'

/** Compatibility ownership for pre-module state. No transitions, lease changes or replay. */
export function legacyModuleRequirements(db: SqliteDatabase, sessionId: string): readonly string[] {
  const required = new Set<string>()
  const owner = db.prepare('SELECT mode FROM dsh_execution_owners WHERE dsh_session_id=?').get<{ mode: string }>(sessionId)
  if (owner && owner.mode !== 'normal') required.add(owner.mode)
  if (db.prepare("SELECT 1 FROM enno_contracts WHERE dsh_session_id=? AND status NOT IN ('completed','cancelled') LIMIT 1").get(sessionId)) required.add('enno')
  if (db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(sessionId)) required.add('lisp')
  return [...required]
}
