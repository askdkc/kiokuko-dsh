import { z } from 'zod'
import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { memoryExecutionEvidence } from '../dsh/owned-evidence.js'

const source = z.object({
  evidenceId: z.string().min(1), sessionId: z.string().min(1), sourceGeneration: z.string().min(1), kind: z.enum(['native_user_message', 'native_tool_result']),
  role: z.enum(['user_assertion', 'tool_observation']), sourceSeqs: z.array(z.number().int().nonnegative()).min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), supportingText: z.string().min(1).max(2000),
}).strict()
export const RevisionEvidence = z.object({
  version: z.literal(1), sessionId: z.string().min(1), sourceGeneration: z.string().min(1),
  claims: z.array(z.object({ id: z.string().min(1).max(128), text: z.string().min(1).max(2000), sources: z.array(source).min(1),
    inherits: z.object({ revision: z.number().int().positive(), claimId: z.string().min(1).max(128) }).strict().optional(),
    supersedes: z.object({ revision: z.number().int().positive(), claimId: z.string().min(1).max(128) }).strict().optional(),
  }).strict()).min(1).max(16),
}).strict()
export type RevisionEvidence = z.infer<typeof RevisionEvidence>
export interface EvidenceIdentity {
  status: 'source_attached' | 'details_unavailable'
  entryId: string
  revision: number
  claimIds: string[]
  execution?:ReturnType<typeof memoryExecutionEvidence>
}

/** Old revisions have no detailed manifest; never reconstruct one from prose. */
export function readRevisionEvidence(db: SqliteDatabase, entryId: string, revision: number, workspace: string): RevisionEvidence | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_revision_evidence'").get()) return null
  const row = db.prepare('SELECT manifest_json,manifest_digest FROM memory_revision_evidence WHERE entry_id=? AND revision=? AND workspace=?')
    .get<{ manifest_json: string; manifest_digest: string }>(entryId, revision, workspace)
  if (!row) return null
  try {
    const raw: unknown = JSON.parse(row.manifest_json)
    if (canonicalContentHash(raw) !== row.manifest_digest) throw new Error('digest mismatch')
    const value = RevisionEvidence.parse(raw)
    if (new Set(value.claims.map(claim => claim.id)).size !== value.claims.length) throw new Error('duplicate claim identity')
    return value
  } catch { throw new KiokukoError('INTEGRITY_ERROR', 'Memory evidence manifest is invalid') }
}

export function evidenceIdentity(db: SqliteDatabase, entry: { id: string; revision: number; workspace: string }): EvidenceIdentity {
  const manifest = readRevisionEvidence(db, entry.id, entry.revision, entry.workspace)
  const execution=memoryExecutionEvidence(db,entry.id,entry.revision)
  return { status: manifest ? 'source_attached' : 'details_unavailable', entryId: entry.id, revision: entry.revision,
    claimIds: manifest?.claims.map(claim => claim.id) ?? [],...(execution.length?{execution}:{}) }
}
