import { z } from 'zod'
import { DecisionError, type DecisionBatch } from './contracts.js'
import { LAYA_COMPACTION_POLICY_VERSION } from './config.js'

export const LAYA_COMPACTION_POLICY = LAYA_COMPACTION_POLICY_VERSION
/** Host work cap, never a substitute for tokenizer/collator admission. */
export const LAYA_COMPACTION_INPUT_BYTES = 6000
export const CompactionTaskEvidence = z.object({
  currentRequest: z.string().min(1), target: z.string().min(1).optional(),
  successCriteria: z.string().min(1).optional(), constraints: z.string().min(1).optional(),
  remainingTodos: z.array(z.string().min(1)),
}).strict()
export type CompactionTaskEvidence = z.infer<typeof CompactionTaskEvidence>
const schema = z.object({
  policy: z.literal(LAYA_COMPACTION_POLICY), task: CompactionTaskEvidence,
  results: z.array(z.object({ id: z.string().min(1), callId: z.string().min(1), tool: z.string().min(1),
    sourceDigest: z.string().min(1), replacement: z.string().min(1),
    nativeEstimated: z.object({ original: z.number().finite().nonnegative(), replacement: z.number().finite().nonnegative() }).strict(),
  }).strict()).min(1).max(8),
}).strict()
export type LayaCompactionState = z.infer<typeof schema>

/** A question sees its complete envelope and task only; host cache retains all source digests. */
export function layaCompactionPart(batch: DecisionBatch, question: DecisionBatch['questions'][number]): DecisionBatch {
  const parsed = schema.safeParse(batch.state)
  if (!parsed.success) throw new DecisionError('INVALID_INPUT')
  const result = parsed.data.results.find(result => result.id === question.id)
  if (!result || !('choices' in question) || question.abstainId !== 'abstain'
    || question.choices.map(choice => choice.id).join(',') !== 'keep,lossless,abstain') throw new DecisionError('INVALID_INPUT')
  const part = { ...batch, state: { policy: LAYA_COMPACTION_POLICY, task: parsed.data.task, result }, questions: [question] }
  if (Buffer.byteLength(JSON.stringify(part)) > LAYA_COMPACTION_INPUT_BYTES) throw new DecisionError('TOO_LARGE')
  return part
}

export function layaCompactionInputFits(batch: DecisionBatch, question: DecisionBatch['questions'][number]): boolean {
  try { layaCompactionPart(batch, question); return true }
  catch (error) { if (error instanceof DecisionError && error.kind === 'TOO_LARGE') return false; throw error }
}
