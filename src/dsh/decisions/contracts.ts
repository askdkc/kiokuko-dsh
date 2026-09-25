import { z } from 'zod'
import { HostServiceError } from '../service-error.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { findSecretInValue } from '../../memory/secrets.js'
import { consistentScore } from './score-consistency.js'

export const DECISION_BYTES = 256 * 1024
const id = z.string().min(1).max(256).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s))
const text = z.string().min(1).max(65536)
const choiceQuestion = z.object({
  id, instructions: text, choices: z.array(z.object({ id, description: z.string().max(8192) }).strict()).min(2).max(256), abstainId: id,
}).strict().refine(q => new Set(q.choices.map(c => c.id)).size === q.choices.length && q.choices.some(c => c.id === q.abstainId), 'Choices must be unique and include abstention')
const typedChoiceQuestion = z.object({ id, type: z.literal('choice'), instructions: text,
  choices: z.array(z.object({ id, description: z.string().max(8192) }).strict()).min(2).max(256), abstainId: id,
}).strict().refine(q => new Set(q.choices.map(c => c.id)).size === q.choices.length && q.choices.some(c => c.id === q.abstainId))
const noulQuestion = z.object({ id, type: z.literal('noul'), instructions: text,
  criteria: z.object({ true: z.string().max(8192).optional(), false: z.string().max(8192).optional() }).strict().optional(),
}).strict()
const scoreQuestion = z.object({ id, type: z.literal('score'), instructions: text,
  criteria: z.array(z.string().min(1).max(8192)).min(2).max(10).refine(levels => new Set(levels).size === levels.length),
}).strict()
export const DecisionQuestionSchema = z.union([choiceQuestion, typedChoiceQuestion, noulQuestion, scoreQuestion])
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>
export type QuestionType = 'choice' | 'noul' | 'score'
export function questionType(question: DecisionQuestion): QuestionType { return 'type' in question ? question.type : 'choice' }
export function requireChoice(question: DecisionQuestion): Extract<DecisionQuestion, { choices: unknown }> {
  if (!('choices' in question)) throw new DecisionError('UNSUPPORTED')
  return question
}
export const DecisionBatchSchema = z.object({
  purpose: z.enum(['akinator', 'skills', 'enno-check', 'lisp', 'memory-reuse', 'compaction', 'model-handoff', 'answer-review']), state: z.unknown(),
  questions: z.array(DecisionQuestionSchema).min(1).max(300), contractVersion: z.literal('typed-decisions-v1').optional(),
}).strict().refine(b => b.questions.length <= 256 || b.purpose === 'memory-reuse' && b.questions.length <= 300 && b.questions.every(q => questionType(q) === 'noul'), 'Too many questions')
  .refine(b => new Set(b.questions.map(q => q.id)).size === b.questions.length, 'Question IDs must be unique')
export type DecisionBatch = z.infer<typeof DecisionBatchSchema>
export interface DecisionCapabilities { maxQuestions: number; maxChoices: number; maxBytes: number; maxPromptTokens?: number; questionTypes?: readonly QuestionType[]; maxScoreLevels?: number }
export const DecisionAnswerSchema = z.union([
  z.object({ id, status: z.literal('selected'), choiceId: id }).strict(),
  z.object({ id, status: z.literal('abstained'), reason: z.enum(['insufficient', 'uncertain', 'tie', 'unassessed']) }).strict(),
  z.object({ id, status: z.literal('measured'), type: z.literal('noul'), probability: z.number().finite().min(0).max(1) }).strict(),
  z.object({ id, status: z.literal('measured'), type: z.literal('score'), score: z.number().finite(), probabilities: z.array(z.number().finite().min(0).max(1)).min(2).max(10), confidence: z.number().finite().min(0).max(1) }).strict(),
])
const resultSchema = z.object({
  answers: z.array(DecisionAnswerSchema).max(300), provider: id, requestedModel: id,
  returnedModel: id.optional(), revision: id.optional(), policyVersion: id,
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict().optional(),
}).strict()
export type DecisionBatchResult = z.infer<typeof resultSchema>
export interface DecisionProvider {
  readonly capabilities: DecisionCapabilities
  /** Same per-part limits as evaluate. Checks admission without model inference. */
  preflight?(request: DecisionBatch, signal: AbortSignal): Promise<void>
  evaluate(request: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult>
}
export type DecisionErrorCode = 'UNAVAILABLE' | 'AUTH' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_INPUT' | 'UNSUPPORTED' | 'TOO_LARGE' | 'MALFORMED_RESPONSE'
export class DecisionError extends HostServiceError {
  constructor(readonly kind: DecisionErrorCode) {
    super(`DECISION_${kind}`, `Typed decision ${kind.toLowerCase().replaceAll('_', ' ')}.`, 'Use /kioku-decisions status. No automatic retry or provider substitution was made.')
  }
}
/** Validate JSON before any provider, credential or network effect. Arrays preserve rubric order. */
export function parseDecisionBatch(value: unknown): DecisionBatch {
  try {
    const hash = canonicalContentHash(value)
    if (!hash || Buffer.byteLength(JSON.stringify(value), 'utf8') > DECISION_BYTES) throw new DecisionError('TOO_LARGE')
    const batch = DecisionBatchSchema.parse(value)
    if (batch.questions.some(q => questionType(q) !== 'choice') && !batch.contractVersion) batch.contractVersion = 'typed-decisions-v1'
    batch.questions = batch.questions.map(q => 'choices' in q && 'type' in q ? { id: q.id, instructions: q.instructions, choices: q.choices, abstainId: q.abstainId } : q)
    if (findSecretInValue(batch) !== undefined) throw new DecisionError('INVALID_INPUT')
    return batch
  } catch (error) { throw error instanceof DecisionError ? error : new DecisionError('INVALID_INPUT') }
}
export function parseDecisionResult(value: unknown, batch: DecisionBatch): DecisionBatchResult {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > DECISION_BYTES || findSecretInValue(value) !== undefined) throw new Error()
    const result = resultSchema.parse(value)
    if (result.answers.length !== batch.questions.length) throw new Error()
    for (const [index, question] of batch.questions.entries()) {
      const answer = result.answers[index]!
      if (answer.id !== question.id) throw new Error()
      if (answer.status === 'abstained' && answer.reason === 'unassessed' && batch.purpose !== 'memory-reuse') throw new Error()
      if (questionType(question) === 'choice') {
        if (answer.status === 'measured' || answer.status === 'selected' && (!('choices' in question) || answer.choiceId === question.abstainId || !question.choices.some(c => c.id === answer.choiceId))) throw new Error()
      } else if (answer.status === 'selected' || answer.status === 'measured' && answer.type !== questionType(question)) throw new Error()
      if ('type' in question && question.type === 'score' && answer.status === 'measured' && answer.type === 'score' &&
        (answer.score < 0 || answer.score > question.criteria.length - 1 || answer.probabilities.length !== question.criteria.length || Math.abs(answer.probabilities.reduce((n, p) => n + p, 0) - 1) > .001 || !consistentScore(answer.score, answer.probabilities))) throw new Error()
    }
    return result
  } catch { throw new DecisionError('MALFORMED_RESPONSE') }
}
