import { layaCompactionPart, LAYA_COMPACTION_POLICY } from './laya-compaction.js'
import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionResult, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'

/** Every part retains its complete required evidence; reject oversized state before any inference. */
export async function evaluateCompactionBatches(provider: DecisionProvider, batch: DecisionBatch, signal: AbortSignal, providerId?: string): Promise<DecisionBatchResult[]> {
  if (providerId === 'laya-coreml' && !provider.preflight) throw new DecisionError('UNSUPPORTED')
  const size = providerId === 'laya-coreml' || provider.capabilities.maxPromptTokens ? 1 : Math.min(16, provider.capabilities.maxQuestions)
  const parts: DecisionBatch[] = []
  for (let offset = 0; offset < batch.questions.length; offset += size) {
    const sliced = { ...batch, questions: batch.questions.slice(offset, offset + size) }
    const part = providerId === 'laya-coreml' && sliced.questions.length === 1 ? layaCompactionPart(batch, sliced.questions[0]!) : sliced
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
