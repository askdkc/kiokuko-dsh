import { readRevisionEvidence } from '../evidence.js'
import { z } from 'zod'
import type { SqliteDatabase } from '../../db/adapter.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { findSecretInValue } from '../secrets.js'
import { EvidenceClaim, type ReviewEvidence, type ReviewRange } from './contracts.js'

/** Validate source identity and excerpts, without claiming semantic entailment. */
export function citationManifest(db: SqliteDatabase, range: ReviewRange, evidence: ReviewEvidence[], operation: { body: string; evidenceIds: string[]; claims?: unknown; targetEntryId?: string; expectedRevision?: number }) {
  if (operation.claims === undefined) return undefined
  const claims = z.array(EvidenceClaim).min(1).max(16).parse(operation.claims)
  if (new Set(claims.map(c => c.id)).size !== claims.length || operation.body !== claims.map(c => c.text).join('\n\n')) throw new Error('claims_invalid')
  if (findSecretInValue(claims)) throw new Error('secret_detected')
  const used = new Set<string>()
  const bound = claims.map(claim => {
    const previousClaim = (target: {revision:number;claimId:string}) => {
      if (!operation.targetEntryId || target.revision !== operation.expectedRevision) throw new Error('ambiguous_target')
      const previous = readRevisionEvidence(db, operation.targetEntryId, target.revision, range.workspace)
      const found = previous?.claims.find(c => c.id === target.claimId)
      if (!found) throw new Error('ambiguous_target')
      return found
    }
    if (claim.inherits && (claim.supersedes || claim.evidence.length || previousClaim(claim.inherits).text !== claim.text)) throw new Error('ambiguous_target')
    if (!claim.inherits && !claim.evidence.length) throw new Error('evidence_invalid')
    const sources = claim.inherits ? previousClaim(claim.inherits).sources : claim.evidence.map(link => {
      const source = evidence.find(e => e.id === link.evidenceId)
      if (!source || !source.eligibleForNewMemory || !operation.evidenceIds.includes(source.id) || !source.text.includes(link.supportingText)
        || canonicalContentHash({role:source.role,sourceSeqs:source.sourceSeqs,text:source.text}) !== source.normalizedSourceHash) throw new Error('evidence_invalid')
      used.add(source.id)
      return { evidenceId: source.id, sessionId: range.sessionId, sourceGeneration: range.sourceGeneration, kind: source.role === 'user_assertion' ? 'native_user_message' as const : 'native_tool_result' as const, role: source.role, sourceSeqs: source.sourceSeqs, sourceHash: source.normalizedSourceHash, supportingText: link.supportingText }
    })
    if (claim.supersedes) previousClaim(claim.supersedes)
    return { id: claim.id, text: claim.text, sources, ...(claim.supersedes ? { supersedes: claim.supersedes } : {}), ...(claim.inherits ? { inherits: claim.inherits } : {}) }
  })
  if (used.size !== operation.evidenceIds.length) throw new Error('evidence_invalid')
  return { version: 1, sessionId: range.sessionId, sourceGeneration: range.sourceGeneration, claims: bound }
}

export function saveCitationManifest(db: SqliteDatabase, entry: {id:string;revision:number;workspace:string}, manifest: ReturnType<typeof citationManifest>): void {
  if (!manifest) return
  db.prepare('INSERT INTO memory_revision_evidence(entry_id,revision,workspace,manifest_json,manifest_digest) VALUES(?,?,?,?,?)')
    .run(entry.id,entry.revision,entry.workspace,JSON.stringify(manifest),canonicalContentHash(manifest))
}
