import { memoryFailureDiagnostic } from './memory-failure.js'
import { scrubAgenticReplayText } from './agenticreplay-security.js'

function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try { return Object.getOwnPropertyDescriptor(value, name)?.value } catch { return undefined }
}

/** Explicit, bounded facts only. Never serialize error causes, stacks, headers or request/response bodies. */
export function failureDiagnostic(error: unknown, content: 'metadata' | 'redacted' = 'metadata'): Record<string, unknown> {
  const source = field(error, 'failure') ?? error
  const rawCode = field(source, 'code')
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(rawCode) ? rawCode : 'UNKNOWN'
  const status = field(source, 'status'), delay = field(source, 'providerRetryAfterMs'), requestId = field(source, 'requestId')
  const rawMessage = typeof source === 'string' ? source : field(source, 'message')
  return { code,
    ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? { status } : {}),
    ...(typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? { providerRetryAfterMs: delay } : {}),
    ...(typeof requestId === 'string' && requestId.length <= 256
      ? { requestId: scrubAgenticReplayText(requestId).replace(/[\p{Cc}\p{Cf}]/gu, '') } : {}),
    ...(content === 'redacted' && typeof rawMessage === 'string'
      ? { message: memoryFailureDiagnostic({ message: rawMessage }).message, messageTruncated: rawMessage.length > 2000 }
      : { messageOmitted: true }),
  }
}
