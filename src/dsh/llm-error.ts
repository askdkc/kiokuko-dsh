import { LlmError, type LlmFailure, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'

/** Preserve provider failures across the open and built-in-only SDK contracts. */
export function llmError(message: string, code: string, options?: LlmErrorOptions): LlmError {
  const modern = LlmError as typeof LlmError & {
    fromFailure?: (failure: LlmFailure, options?: ErrorOptions) => LlmError
  }
  const { cause, ...facts } = options ?? {}
  if (typeof modern.fromFailure === 'function') {
    return modern.fromFailure({ ...facts, message, code }, cause === undefined ? undefined : { cause })
  }
  // Only older SDKs without fromFailure enter this branch. They accept arbitrary codes.
  const LegacyError = LlmError as unknown as new (message: string, code: string, options?: LlmErrorOptions) => LlmError
  return new LegacyError(message, code, options)
}
