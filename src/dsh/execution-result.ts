import type { TapSummary } from './node-tap-summary.js'

// Object identity is private to the host. Model/Lisp JSON cannot mint proof.
const observed = new WeakSet<object>()
export interface HostProcessResult {
  isError: boolean
  value: { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; processStarted?: boolean; outputComplete?: boolean; summary?: TapSummary | undefined }
  content: { type: 'text'; text: string }[]
}
export function observeProcessResult(result: HostProcessResult): HostProcessResult { observed.add(result); return result }
export function isHostExecutionResult(result: unknown): result is HostProcessResult {
  return typeof result === 'object' && result !== null && observed.has(result)
}
