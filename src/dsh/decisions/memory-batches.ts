import { z } from 'zod'
import type { DecisionConfiguration } from './config.js'
import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionResult, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'

export const MemoryDecisionState = z.object({ task: z.string(), constraints: z.string(), memories: z.record(z.string(), z.string()) }).strict()

/** Bound each wire request to its own complete evidence. A failed part never becomes partial success. */
export async function evaluateMemoryBatches(provider: DecisionProvider, batch: DecisionBatch, kind: DecisionConfiguration['provider'], signal: AbortSignal): Promise<DecisionBatchResult> {
  const parsed = MemoryDecisionState.safeParse(batch.state)
  if (!parsed.success || Object.keys(parsed.data.memories).length !== batch.questions.length || batch.questions.some(q => !Object.hasOwn(parsed.data.memories, q.id))) throw new DecisionError('INVALID_INPUT')
  const state = parsed.data, size = kind === 'typesafe' ? Math.min(8, provider.capabilities.maxQuestions) : 1
  const batches: DecisionBatch[] = []
  for (let offset = 0; offset < batch.questions.length; offset += size) {
    const questions = batch.questions.slice(offset, offset + size)
    batches.push({ ...batch, questions, state: { task: state.task, constraints: state.constraints, memories: Object.fromEntries(questions.map(q => [q.id, state.memories[q.id]])) } })
  }
  const parts = new Array<DecisionBatchResult | null>(batches.length).fill(null)
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  let next = 0, failure: unknown
  const worker = async () => {
    try {
      while (next < batches.length) {
        combined.throwIfAborted()
        const index = next++, part = batches[index]!
        try { parts[index] = parseDecisionResult(await abortable(provider.evaluate(part, combined), combined), part) }
        catch (error) {
          // A single complete record that the endpoint cannot admit remains unassessed.
          if (error instanceof DecisionError && error.kind === 'TOO_LARGE' && part.questions.length === 1) continue
          throw error
        }
      }
    } catch (error) { failure ??= error; controller.abort() }
  }
  await Promise.all([worker(), worker()])
  if (failure) throw failure
  const completed = parts.filter((part): part is DecisionBatchResult => part !== null), first = completed[0]
  if (!first) throw new DecisionError('TOO_LARGE')
  if (completed.some(p => p.provider !== first.provider || p.requestedModel !== first.requestedModel || p.returnedModel !== first.returnedModel || p.revision !== first.revision || p.policyVersion !== first.policyVersion)) throw new DecisionError('MALFORMED_RESPONSE')
  const result: DecisionBatchResult = { ...first, answers: parts.flatMap((p, i) => p?.answers ?? batches[i]!.questions.map(q => ({ id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }))) }
  delete result.usage
  if (completed.every(p => p.usage)) result.usage = completed.reduce((sum, p) => ({ input_tokens: sum.input_tokens + p.usage!.input_tokens, output_tokens: sum.output_tokens + p.usage!.output_tokens }), { input_tokens: 0, output_tokens: 0 })
  return parseDecisionResult(result, batch)
}
