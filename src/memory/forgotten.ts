import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'

export interface RetiredSource { sessionId?: string; generation?: string; hash?: string; provenanceHash?: string }
function installed(db: SqliteDatabase): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_forget_tombstones'").get()
}
export function memoryForgotten(db: SqliteDatabase, id: string): boolean {
  return installed(db) && !!db.prepare('SELECT 1 FROM memory_forget_tombstones WHERE entry_id=?').get(id)
}
function retiredSources(db: SqliteDatabase, workspace: string): RetiredSource[] {
  if (!installed(db)) return []
  return db.prepare('SELECT sources_json FROM memory_forget_tombstones WHERE workspace=?')
    .all<{ sources_json: string }>(workspace).flatMap(row => JSON.parse(row.sources_json) as RetiredSource[])
}
export function assertEvidenceNotForgotten(db: SqliteDatabase, workspace: string, sessionId: string, _generation: string, hashes: string[]): void {
  // A changed processing generation cannot make the identical native event new.
  if (retiredSources(db, workspace).some(source => source.sessionId === sessionId && source.hash && hashes.includes(source.hash))) throw new Error('source_retired')
}
/** Bind legacy captures to their explicit source, without banning similar new speech. */
export function provenanceSourceHash(provenance: JsonObject): string | null {
  if (typeof provenance.type !== 'string' || typeof provenance.reference !== 'string') return null
  if (provenance.type === 'agent_checkpoint' && !provenance.runId) return null
  return canonicalContentHash({ type: provenance.type, reference: provenance.reference,
    ...(provenance.type === 'agent_checkpoint' ? { runId: provenance.runId, evidenceIds: provenance.evidenceIds ?? [] } : {}) })
}
export function assertProvenanceNotForgotten(db: SqliteDatabase, workspace: string, provenance: JsonObject): void {
  const hash = provenanceSourceHash(provenance)
  if (hash && retiredSources(db, workspace).some(source => source.provenanceHash === hash)) throw new KiokukoError('CONFLICT', 'Memory source has been forgotten')
}

export function deliveryForgotten(db: SqliteDatabase, deliveryId: string): boolean {
  return installed(db) && !!db.prepare('SELECT 1 FROM memory_forget_deliveries WHERE delivery_id=?').get(deliveryId)
}
