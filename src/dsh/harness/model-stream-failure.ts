import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Recover transient Codex close codes flattened into pi-ai's generic failure.
 * Only classifies model-stream failures; the host still owns retry policy.
 * Unknown diagnostics and existing classifications retain their original meaning.
 */
export function normalizeModelStreamFailure(failure: LlmFailure): LlmFailure {
  if (failure.code !== 'PI_AI_ERROR' || failure.message.length > 8192
    || (failure.status !== undefined && failure.status >= 400 && failure.status < 500)) return failure
  const match = /^Codex WebSocket failure\s+(\{[\s\S]*\})\s*$/.exec(failure.message)
  if (!match) return failure
  let diagnostic: unknown
  try { diagnostic = JSON.parse(match[1]!) }
  catch { return failure } // Unrecognized provider prose is not retry authority.
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
    || !('code' in diagnostic) || (diagnostic.code !== 1012 && diagnostic.code !== 1013)
    || !('phase' in diagnostic) || !('eventsEmitted' in diagnostic)) return failure
  const consistentPhase = (diagnostic.phase === 'after_message_stream_start' && diagnostic.eventsEmitted === true)
    || (diagnostic.phase === 'before_message_stream_start' && diagnostic.eventsEmitted === false)
  return consistentPhase ? { ...failure, code: 'TRANSPORT' } : failure
}
