import { abortable } from '../http-json.js'

export type TargetTokenCount = { inputTokens: number; tokenizerFingerprint: string } | { unsupported: string }
/** Implementations must count the complete serialized request for this exact route and serializer. */
export interface TargetTokenCounter {
  count(serializedRequest: string, routeFingerprint: string, signal: AbortSignal): Promise<TargetTokenCount>
}
export interface CompactionRequestCosts {
  nativeEstimated: { before: number; after: number }
  requestBytes: { before: number; after: number }
  targetExact: { before: number; after: number; tokenizerFingerprint: string } | { unsupported: string }
}

/** Existing native admission applies to the whole request, including framing and pending input. */
export function nativeCompactionSavingsGate(before: number, after: number, threshold: number): boolean {
  return Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(threshold)
    && before > 0 && after >= 0 && before - after >= before * .25 && after < threshold
}

/** Both requests share the caller's deadline; no approximate fallback is provided. */
export async function measureCompactionRequests(original: string, replacement: string, routeFingerprint: string,
  nativeEstimated: CompactionRequestCosts['nativeEstimated'], counter: TargetTokenCounter | undefined,
  signal: AbortSignal): Promise<CompactionRequestCosts> {
  const costs: CompactionRequestCosts = { nativeEstimated: { ...nativeEstimated },
    requestBytes: { before: Buffer.byteLength(original), after: Buffer.byteLength(replacement) },
    targetExact: { unsupported: 'target_tokenizer_unavailable' } }
  signal.throwIfAborted()
  if (!counter || !routeFingerprint) return costs
  const before = await abortable(counter.count(original, routeFingerprint, signal), signal)
  signal.throwIfAborted()
  if ('unsupported' in before) { costs.targetExact = before; return costs }
  const after = await abortable(counter.count(replacement, routeFingerprint, signal), signal)
  signal.throwIfAborted()
  if ('unsupported' in after) { costs.targetExact = after; return costs }
  if (!before.tokenizerFingerprint || before.tokenizerFingerprint !== after.tokenizerFingerprint
    || !Number.isSafeInteger(before.inputTokens) || !Number.isSafeInteger(after.inputTokens)
    || before.inputTokens <= 0 || after.inputTokens < 0) {
    costs.targetExact = { unsupported: 'target_tokenizer_identity_or_count_mismatch' }; return costs
  }
  costs.targetExact = { before: before.inputTokens, after: after.inputTokens, tokenizerFingerprint: before.tokenizerFingerprint }
  return costs
}

/** Whole-request C4 gate, also used by evaluation adapters; local candidate ratios cannot satisfy it. */
export function compactionSavingsGate(costs: CompactionRequestCosts, threshold: number): { accepted: boolean; reason: string } {
  const valid = (before: number, after: number, fraction: number) => Number.isSafeInteger(before) && Number.isSafeInteger(after)
    && before > 0 && after >= 0 && before - after >= before * fraction
  if (!Number.isSafeInteger(threshold) || threshold <= 0
    || !valid(costs.nativeEstimated.before, costs.nativeEstimated.after, .25)
    || !nativeCompactionSavingsGate(costs.nativeEstimated.before, costs.nativeEstimated.after, threshold))
    return { accepted: false, reason: 'native_whole_request_reduction' }
  if ('unsupported' in costs.targetExact) return { accepted: false, reason: costs.targetExact.unsupported }
  if (!costs.targetExact.tokenizerFingerprint || !valid(costs.targetExact.before, costs.targetExact.after, .25))
    return { accepted: false, reason: 'target_exact_reduction' }
  if (!valid(costs.requestBytes.before, costs.requestBytes.after, .20)) return { accepted: false, reason: 'request_bytes_reduction' }
  return { accepted: true, reason: 'whole_request_gates_passed' }
}
