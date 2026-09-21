import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionResult, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'

/** Every part retains identical required evidence; reject oversized state before any inference. */
export async function evaluateCompactionBatches(provider: DecisionProvider, batch: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult[]> {
  const size = provider.capabilities.maxPromptTokens ? 1 : Math.min(16, provider.capabilities.maxQuestions)
  const parts: DecisionBatch[] = []
  for (let offset = 0; offset < batch.questions.length; offset += size) {
    const part = { ...batch, questions: batch.questions.slice(offset, offset + size) }
    // UTF-8 bytes provide a deliberately conservative admission estimate, not a tokenizer.
    // Leave room for the provider envelope/template; the server remains authoritative.
    const budget = Math.min(provider.capabilities.maxBytes - 512, provider.capabilities.maxPromptTokens ? provider.capabilities.maxPromptTokens - 512 : Infinity)
    if (Buffer.byteLength(JSON.stringify(part)) > (provider.preflight ? provider.capabilities.maxBytes : budget)) throw new DecisionError('TOO_LARGE')
    parts.push(part)
  }
  if (provider.preflight) for (const part of parts) {
    signal.throwIfAborted()
    await abortable(provider.preflight(part, signal), signal)
  }
  const results: DecisionBatchResult[] = []
  for (const part of parts) {
    signal.throwIfAborted()
    results.push(parseDecisionResult(await abortable(provider.evaluate(part, signal), signal), part))
  }
  return results
}
