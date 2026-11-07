import { requestIntentIsUnresolved, type RequestIntentDecision } from './decisions/request-intent.js'

/** Reuse a host-bound workspace only after the current request is resolved.
 * The unchanged request still limits the work; a directory is not permission. */
export function resolveNativeIntakeTarget(target: string | null | undefined, canonicalCwd: string, intent: RequestIntentDecision | undefined): string | null {
  return target ?? (!requestIntentIsUnresolved(intent) && intent?.action !== 'answer' ? canonicalCwd : null)
}
