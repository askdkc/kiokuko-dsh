import { canonicalContentHash } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import type { EnnoRunSnapshot } from './types.js'

export interface PlanDraft { availableSkills: string[]; candidate: Record<string, unknown>; digest: string; catalogDigest: string; revision: number; status: 'reviewing' | 'reviewed' | 'failed' | 'submitted'; reviewDigest: string | null }
/** Transport identities and dispositions do not alter the candidate being reviewed. */
export function planCandidate(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'idempotencyKey', 'advisoryRoundDigest', 'advisoryDisposition', 'capabilities', 'recoveryAction'].includes(key)))
}
export function readPlanDraft(db: SqliteDatabase, snapshot: Pick<EnnoRunSnapshot, 'runId' | 'revision' | 'mutationRevision'>): PlanDraft | undefined {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enno_plan_drafts'").get()) return undefined
  const row = db.prepare('SELECT * FROM enno_plan_drafts WHERE run_id=? AND contract_revision=? AND mutation_revision=?').get(snapshot.runId, snapshot.revision, snapshot.mutationRevision)
  if (!row) return undefined
  const candidate = JSON.parse(String(row.candidate_json)) as Record<string, unknown>
  const availableSkills: unknown = JSON.parse(String(row.catalog_json))
  if (!Array.isArray(availableSkills) || availableSkills.some(name => typeof name !== 'string' || name.length > 300)) throw new Error('Plan catalog integrity mismatch')
  if (canonicalContentHash(candidate) !== row.draft_digest) throw new Error('Plan draft integrity mismatch')
  return { availableSkills: availableSkills as string[], candidate, digest: String(row.draft_digest), catalogDigest: String(row.catalog_digest), revision: Number(row.draft_revision), status: row.status as PlanDraft['status'], reviewDigest: row.review_digest as string | null }
}
