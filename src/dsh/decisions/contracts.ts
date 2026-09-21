import { z } from 'zod'
import { HostServiceError } from '../service-error.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { findSecretInValue } from '../../memory/secrets.js'

export const DECISION_BYTES = 256 * 1024
const id = z.string().min(1).max(256).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s))
const text = z.string().min(1).max(65536)
export const DecisionQuestionSchema = z.object({
  id, instructions: text, choices: z.array(z.object({ id, description: z.string().max(8192) }).strict()).min(2).max(256), abstainId: id,
}).strict().refine(q => new Set(q.choices.map(c => c.id)).size === q.choices.length && q.choices.some(c => c.id === q.abstainId), 'Choices must be unique and include abstention')
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>
export const DecisionBatchSchema = z.object({
  purpose: z.enum(['akinator', 'skills', 'enno-check', 'lisp', 'memory-reuse', 'compaction']), state: z.unknown(),
  questions: z.array(DecisionQuestionSchema).min(1).max(256),
}).strict().refine(b => new Set(b.questions.map(q => q.id)).size === b.questions.length, 'Question IDs must be unique')
export type DecisionBatch = z.infer<typeof DecisionBatchSchema>
export interface DecisionCapabilities { maxQuestions: number; maxChoices: number; maxBytes: number; maxPromptTokens?: number }
export const DecisionAnswerSchema = z.discriminatedUnion('status', [
  z.object({ id, status: z.literal('selected'), choiceId: id }).strict(),
  z.object({ id, status: z.literal('abstained'), reason: z.enum(['insufficient', 'uncertain', 'tie']) }).strict(),
])
const resultSchema = z.object({
  answers: z.array(DecisionAnswerSchema).max(256), provider: id, requestedModel: id,
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
      if (answer.id !== question.id || answer.status === 'selected' && (answer.choiceId === question.abstainId || !question.choices.some(c => c.id === answer.choiceId))) throw new Error()
    }
    return result
  } catch { throw new DecisionError('MALFORMED_RESPONSE') }
}
