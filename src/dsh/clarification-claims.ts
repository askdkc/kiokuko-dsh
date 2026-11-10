import { z } from 'zod'
import { canonicalContentHash } from '../serialization/validate.js'
import { clarificationReply, type ClarificationContext } from './clarification-context.js'
import { withImmediateTransaction } from '../db/transaction.js'
import type { DshCoreRuntime } from './core-runtime.js'

export const CLARIFICATION_REPLY_PREFIX = 'kiokuko-clarification-'

export interface ClarificationIdentity {
  sessionId: string
  agentId: string
  turn: number
  questionId: string
}

const text = z.string().max(131072)
const contextSchema = z.object({
  sources: z.array(z.object({ id: text, text }).strict()).max(128),
  answers: z.array(z.object({ id: text, questionId: text, question: text, value: z.string().max(8192),
    scope: text, sourceIds: z.array(text).max(128) }).strict()).max(128),
}).strict()

export function clarificationClaims(runtime: DshCoreRuntime) {
  return {
    claim: (identity: ClarificationIdentity) => runtime.withDatabase(db =>
      withImmediateTransaction(db, () => {
        db.prepare(`UPDATE dsh_clarification_claims SET status='unresolved'
          WHERE session_id=? AND native_turn<? AND status='waiting'`).run(identity.sessionId, identity.turn)
        return db.prepare(`INSERT OR IGNORE INTO dsh_clarification_claims
          (question_id,session_id,agent_id,native_turn,status,delivery_phase)
          SELECT ?,?,?,?,'waiting','waiting' WHERE NOT EXISTS (
            SELECT 1 FROM dsh_clarification_claims WHERE session_id=? AND native_turn>?
          )
          RETURNING question_id`).get(identity.questionId, identity.sessionId, identity.agentId, identity.turn,
            identity.sessionId, identity.turn) !== undefined
      })),
    invalidate: (sessionId: string, agentId: string, answerId: string) => runtime.withDatabase(db => {
      db.prepare(`UPDATE dsh_clarification_claims SET status='unresolved',delivery_phase='unknown'
        WHERE session_id=? AND agent_id=? AND answer_id=? AND delivery_phase != 'consumed'`).run(sessionId, agentId, answerId)
    }),
    restore: (sessionId: string, agentId: string, answerId: string, content: string, nativeTurn: number) => runtime.withDatabase(db => {
      if (!Number.isSafeInteger(nativeTurn) || nativeTurn < 1) return undefined
      const row = db.prepare(`SELECT answer_context_json, answer_content_digest, question_id, native_turn FROM dsh_clarification_claims
        WHERE session_id=? AND agent_id=? AND answer_id=? AND status='answer_reserved'
          AND native_turn IN (?,?) AND delivery_phase IN ('queued','captured','consumed')
          AND NOT EXISTS (SELECT 1 FROM dsh_clarification_claims AS newer
            WHERE newer.session_id=dsh_clarification_claims.session_id
              AND newer.native_turn>dsh_clarification_claims.native_turn)
        `).get(sessionId, agentId, answerId, nativeTurn, nativeTurn - 1)
      if (!row || row.answer_content_digest !== canonicalContentHash(content) || typeof row.answer_context_json !== 'string') return undefined
      const result = contextSchema.safeParse(JSON.parse(row.answer_context_json))
      if (!result.success || !result.data.answers.some(answer => answer.id === answerId)) return undefined
      const last = result.data.answers.at(-1)
      if (!last || last.id !== answerId) return undefined
      const reconstructed = clarificationReply({ sources: result.data.sources, answers: result.data.answers.slice(0, -1) }, last)
      if (reconstructed.content !== content) return undefined
      return { context: result.data, identity: { sessionId, agentId, questionId: row.question_id as string, turn: row.native_turn as number } }
    }),
    advance: (identity: ClarificationIdentity, answerId: string, phase: 'captured' | 'consumed') => runtime.withDatabase(db =>
      db.prepare(`UPDATE dsh_clarification_claims SET delivery_phase=?
        WHERE question_id=? AND session_id=? AND agent_id=? AND native_turn=?
          AND answer_id=? AND status='answer_reserved' AND delivery_phase IN (?,?)
        RETURNING question_id`).get(phase, identity.questionId, identity.sessionId, identity.agentId,
          identity.turn, answerId, phase === 'captured' ? 'queued' : 'captured', phase) !== undefined),
    settle: (identity: ClarificationIdentity, answerId?: string, receipt?: { context: ClarificationContext; content: string }) => runtime.withDatabase(db =>
      db.prepare(`UPDATE dsh_clarification_claims SET status=?,answer_id=?,delivery_phase=?,answer_context_json=?,answer_content_digest=?
        WHERE question_id=? AND session_id=? AND agent_id=? AND native_turn=? AND status='waiting'
        RETURNING question_id`).get(answerId ? 'answer_reserved' : 'unresolved', answerId ?? null, answerId ? 'queued' : 'unknown',
        receipt ? JSON.stringify(contextSchema.parse(receipt.context)) : null, receipt ? canonicalContentHash(receipt.content) : null,
        identity.questionId, identity.sessionId, identity.agentId, identity.turn) !== undefined),
  }
}
