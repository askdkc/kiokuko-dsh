import { z } from 'zod'
import type { DecisionConfiguration } from './config.js'
import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionResult, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'

export const MemoryDecisionState = z.object({ task: z.string(), constraints: z.string(), memories: z.record(z.string(), z.string()) }).strict()
const NoulMemoryState = MemoryDecisionState.safeExtend({ questionMemory: z.record(z.string(), z.string()) })

/** Bound each wire request to its own complete evidence. A failed part never becomes partial success. */
export async function evaluateMemoryBatches(provider: DecisionProvider, batch: DecisionBatch, kind: DecisionConfiguration['provider'], signal: AbortSignal): Promise<DecisionBatchResult> {
  const noul = batch.questions.every(q => 'type' in q && q.type === 'noul')
  const parsed = (noul ? NoulMemoryState : MemoryDecisionState).safeParse(batch.state)
  if (!parsed.success) throw new DecisionError('INVALID_INPUT')
  const state = parsed.data
  const mapped = noul ? NoulMemoryState.parse(state) : undefined
  const groups: DecisionBatch['questions'][] = []
  if (mapped) {
    if (Object.keys(mapped.questionMemory).length !== batch.questions.length) throw new DecisionError('INVALID_INPUT')
    if (batch.questions.some(q => !/^memory_(0|[1-9]\d*):(applicability|constraints|prerequisites)$/.test(q.id)
      || mapped.questionMemory[q.id] !== q.id.slice(0, q.id.indexOf(':')))) throw new DecisionError('INVALID_INPUT')
    for (const [memoryId] of Object.entries(mapped.memories)) {
      const questions = batch.questions.filter(q => mapped.questionMemory[q.id] === memoryId)
      if (questions.length !== 3 || !['applicability', 'constraints', 'prerequisites'].every(name =>
        questions.some(q => q.id === `${memoryId}:${name}`))) throw new DecisionError('INVALID_INPUT')
      groups.push(questions)
    }
    if (groups.flat().length !== batch.questions.length || batch.questions.some(q => !Object.hasOwn(mapped.questionMemory, q.id))) throw new DecisionError('INVALID_INPUT')
  } else {
    if (Object.keys(state.memories).length !== batch.questions.length || batch.questions.some(q => !Object.hasOwn(state.memories, q.id))) throw new DecisionError('INVALID_INPUT')
    groups.push(...batch.questions.map(q => [q]))
  }
  const groupSize = kind === 'typesafe' ? Math.min(8, Math.floor(provider.capabilities.maxQuestions / (noul ? 3 : 1))) : 1
  if (groupSize < 1) throw new DecisionError('UNSUPPORTED')
  const makePart = (chunk: DecisionBatch['questions'][]): DecisionBatch => {
    const questions = chunk.flat()
    const memoryIds = mapped ? [...new Set(questions.map(q => mapped.questionMemory[q.id]!))] : questions.map(q => q.id)
    const memories = Object.fromEntries(memoryIds.map(id => [id, state.memories[id]]))
    return { ...batch, questions, state: mapped
      ? { task: state.task, constraints: state.constraints, memories, questionMemory: Object.fromEntries(questions.map(q => [q.id, mapped.questionMemory[q.id]])) }
      : { task: state.task, constraints: state.constraints, memories } }
  }
  const chunks: DecisionBatch['questions'][][] = []
  for (let offset = 0; offset < groups.length; offset += groupSize) chunks.push(groups.slice(offset, offset + groupSize))
  const batches = chunks.map(makePart)
  const skipped = new Set<DecisionBatch>()
  if (provider.preflight) for (let index = 0; index < batches.length; index++) {
    const part = batches[index]!
    try { await abortable(provider.preflight(part, signal), signal) }
    catch (error) {
      if (error instanceof DecisionError && error.kind === 'TOO_LARGE') {
        const chunk = chunks[index]!
        if (chunk.length === 1) { skipped.add(part); continue }
        const middle = Math.floor(chunk.length / 2), halves = [chunk.slice(0, middle), chunk.slice(middle)]
        chunks.splice(index, 1, ...halves)
        batches.splice(index, 1, ...halves.map(makePart))
        index--
        continue
      }
      throw error
    }
  }
  const parts = new Array<DecisionBatchResult | null>(batches.length).fill(null)
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  let next = 0, failure: unknown
  const worker = async () => {
    try {
      while (next < batches.length) {
        combined.throwIfAborted()
        const index = next++, part = batches[index]!
        if (skipped.has(part)) continue
        try { parts[index] = parseDecisionResult(await abortable(provider.evaluate(part, combined), combined), part) }
        catch (error) {
          // A single complete record that the endpoint cannot admit remains unassessed.
          if (error instanceof DecisionError && error.kind === 'TOO_LARGE' && part.questions.length === (noul ? 3 : 1)) continue
          throw error
        }
      }
    } catch (error) { failure ??= error; controller.abort() }
  }
  await Promise.all([worker(), worker()])
  if (failure) throw failure
  const completed = parts.filter((part): part is DecisionBatchResult => part !== null), first = completed[0]
  if (!first) return parseDecisionResult({ provider: kind, requestedModel: 'unassessed', policyVersion: 'memory-reuse-unassessed-v1',
    answers: batch.questions.map(q => ({ id: q.id, status: 'abstained', reason: 'unassessed' })) }, batch)
  if (completed.some(p => p.provider !== first.provider || p.requestedModel !== first.requestedModel || p.returnedModel !== first.returnedModel || p.revision !== first.revision || p.policyVersion !== first.policyVersion)) throw new DecisionError('MALFORMED_RESPONSE')
  const result: DecisionBatchResult = { ...first, answers: parts.flatMap((p, i) => p?.answers ?? batches[i]!.questions.map(q => ({ id: q.id, status: 'abstained' as const, reason: 'unassessed' as const }))) }
  delete result.usage
  if (completed.every(p => p.usage)) result.usage = completed.reduce((sum, p) => ({ input_tokens: sum.input_tokens + p.usage!.input_tokens, output_tokens: sum.output_tokens + p.usage!.output_tokens }), { input_tokens: 0, output_tokens: 0 })
  return parseDecisionResult(result, batch)
}
