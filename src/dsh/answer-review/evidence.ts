import { canonicalContentHash } from '../../serialization/validate.js'
import { DECISION_BYTES } from '../decisions/contracts.js'
import { answerReviewQuestions, ANSWER_REVIEW_POLICY, type ReviewEvent } from './contracts.js'

/** Consume only host-committed events in the bound native turn. Never shorten a candidate. */
export function answerReviewInput(task: string, events: readonly ReviewEvent[], turn: number, startSeq: number) {
  const owned = events.filter(event => Number.isSafeInteger(event.seq) && event.seq >= startSeq && event.data?.turn === turn)
  const end = [...owned].reverse().find(event => event.type === 'turn/end')
  if (!end || end.data?.reason?.kind !== 'completed') return { skipped: 'not_completed' } as const
  const candidate = [...owned].reverse().find(event => event.type === 'assistant/message' && event.seq < end.seq)
  const content = candidate?.data?.message?.content
  if (!candidate || !Array.isArray(content) || content.some(block => block.type !== 'text' && block.type !== 'reasoning')) return { skipped: 'no_text_answer' } as const
  const answer = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (!answer.trim()) return { skipped: 'no_text_answer' } as const
  const calls = new Set(owned.filter(event => event.type === 'tool/call' && event.seq < candidate.seq).map(event => event.data?.callId))
  const evidence = owned.filter(event => event.type === 'tool/result' && event.seq < candidate.seq).map(event => {
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks) || blocks.some(block => block.type !== 'tool-result' || !calls.has(block.toolCallId))) throw new Error('Unbound tool evidence')
    return { seq: event.seq, result: event.data.message }
  })
  const unassessed = evidence.length === 0 ? ['grounding', 'verification'] : []
  const questions = answerReviewQuestions
  const batch = { purpose: 'answer-review' as const, state: { policy: ANSWER_REVIEW_POLICY, task, answer, evidence, unassessed, evidenceScope: 'Only host-committed tool results in this native turn; absence is not proof of failure.' }, questions }
  if (Buffer.byteLength(JSON.stringify(batch)) > DECISION_BYTES) return { skipped: 'too_large' } as const
  return { batch, unassessed, answerSeq: candidate.seq, endSeq: end.seq, inputDigest: canonicalContentHash(batch), answerDigest: canonicalContentHash(answer), evidenceRefs: evidence.map(item => item.seq) }
}
