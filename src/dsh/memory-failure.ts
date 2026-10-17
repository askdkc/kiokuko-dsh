/** Bounded diagnostic projection. Never copies raw error objects, response/request fields or stacks. */
import { scrubAgenticReplayText } from './agenticreplay-security.js';
import { redactDshSourceText } from '../context/memory-projection.js';

export interface MemoryFailureDiagnostic { code: string; message: string }
const providerCodes = new Set(['INVALID_REQUEST', 'AUTHENTICATION_ERROR', 'MISSING_CREDENTIAL', 'RATE_LIMITED', 'API_ERROR', 'ABORTED', 'MODEL_NOT_FOUND', 'PROTOCOL_ERROR', 'NETWORK_ERROR', 'TIMEOUT']);
const safeCodes = new Set(['USAGE_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'DATABASE_ERROR', 'BACKPRESSURE', 'SERVICE_UNAVAILABLE', 'SECURITY_REJECTION', 'AUTHENTICATION_ERROR', 'INTEGRITY_ERROR', 'PARTIAL_FAILURE', 'NOT_IMPLEMENTED', 'FINALIZATION_FAILED', 'INVALID_MODEL_JSON', 'INVALID_MODEL_OUTPUT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'ERR_SQLITE_ERROR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'LLM_STREAM_ERROR', 'LLM_MISSING_FINISH', 'LLM_OUTPUT_LIMIT', 'LLM_UNEXPECTED_TOOL_CALLS', 'LLM_ABORTED', ...[...providerCodes].map(code => `LLM_${code}`)]);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;

/** Keep a useful cause while redacting credentials, URLs, internal identities and paths. */
export function memoryFailureDiagnostic(error: unknown): MemoryFailureDiagnostic {
  const value = record(error);
  const code = typeof value?.code === 'string' && safeCodes.has(value.code) ? value.code
    : error instanceof SyntaxError ? 'INVALID_MODEL_JSON' : value?.name === 'ZodError' ? 'INVALID_MODEL_OUTPUT' : 'FINALIZATION_FAILED';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof value?.message === 'string' ? value.message : 'Memory operation failed without a structured error';
  const bounded = raw.slice(0, 8192);
  // Error prose can disclose credentials without ':' or '='. Retain only the explanation before a credential marker.
  const credential = bounded.search(/\b(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|password|passwd|secret|credentials?|authorization|proxy-authorization|cookies?|set-cookie|token|bearer|basic)\b/iu);
  const explanation = credential < 0 ? bounded : `${bounded.slice(0, credential)}[credential detail redacted]`;
  const scrubbed = scrubAgenticReplayText(explanation).replace(/\bhttps?:\/\/[^\s"'<>]+/giu, '[url redacted]');
  const safe = redactDshSourceText(scrubbed) ?? 'Diagnostic redacted';
  const status = typeof value?.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? `HTTP ${value.status}: ` : '';
  return { code, message: (status + safe).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 2000) };
}

/** Preserve a failed provider finish as a failure; it is never a successful extraction. */
export function memoryStreamFailure(reason: unknown): Error {
  const value = record(reason), failure = record(value?.failure);
  const kind = typeof value?.kind === 'string' && ['error', 'aborted', 'length', 'tool-calls'].includes(value.kind) ? value.kind : 'missing-finish';
  const code = kind === 'error' ? typeof failure?.code === 'string' && providerCodes.has(failure.code) ? `LLM_${failure.code}` : 'LLM_STREAM_ERROR'
    : kind === 'aborted' ? 'LLM_ABORTED' : kind === 'length' ? 'LLM_OUTPUT_LIMIT' : kind === 'tool-calls' ? 'LLM_UNEXPECTED_TOOL_CALLS' : 'LLM_MISSING_FINISH';
  const message = typeof failure?.message === 'string' ? failure.message : `Memory finalization did not stop normally (${kind})`;
  return Object.assign(new Error(message), { code, ...(typeof failure?.status === 'number' ? { status: failure.status } : {}) });
}

/** A failed worker may update only its still-processing claim, never a completed or replaced owner. */
export function failedFinalizationPatch(current: Readonly<Record<string, unknown>> | undefined, claimNonce: string, error: unknown): {
  status: 'failed'; claim_nonce: null; lease_until: null; last_error_code: string; last_error_message: string;
} | undefined {
  if (!claimNonce || current?.status !== 'processing' || current.claim_nonce !== claimNonce) return undefined;
  const failure = memoryFailureDiagnostic(error);
  return { status: 'failed', claim_nonce: null, lease_until: null, last_error_code: failure.code, last_error_message: failure.message };
}
