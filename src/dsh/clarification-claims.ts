import { withImmediateTransaction } from '../db/transaction.js'
import type { DshCoreRuntime } from './core-runtime.js'

export const CLARIFICATION_REPLY_PREFIX = 'kiokuko-clarification-'

export interface ClarificationIdentity {
  sessionId: string
  agentId: string
  turn: number
  questionId: string
}

export function clarificationClaims(runtime: DshCoreRuntime) {
  return {
    claim: (identity: ClarificationIdentity) => runtime.withDatabase(db =>
      withImmediateTransaction(db, () => {
        db.prepare(`UPDATE dsh_clarification_claims SET status='unresolved'
          WHERE session_id=? AND native_turn<? AND status='waiting'`).run(identity.sessionId, identity.turn)
        return db.prepare(`INSERT OR IGNORE INTO dsh_clarification_claims
          (question_id,session_id,agent_id,native_turn,status)
          SELECT ?,?,?,?,'waiting' WHERE NOT EXISTS (
            SELECT 1 FROM dsh_clarification_claims WHERE session_id=? AND native_turn>?
          )
          RETURNING question_id`).get(identity.questionId, identity.sessionId, identity.agentId, identity.turn,
            identity.sessionId, identity.turn) !== undefined
      })),
    settle: (identity: ClarificationIdentity, answerId?: string) => runtime.withDatabase(db =>
      db.prepare(`UPDATE dsh_clarification_claims SET status=?,answer_id=?
        WHERE question_id=? AND session_id=? AND agent_id=? AND native_turn=? AND status='waiting'
        RETURNING question_id`).get(answerId ? 'answer_reserved' : 'unresolved', answerId ?? null,
        identity.questionId, identity.sessionId, identity.agentId, identity.turn) !== undefined),
  }
}
