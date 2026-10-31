/**
 * Presentation helpers shared by the server-side card and the Web settings
 * control. This module stays free of zod and cordis so the browser bundle can
 * import it: the client must not pull server-only dependencies.
 */

/**
 * The native Web question UI preselects options whose label carries this
 * suffix, so a configured default stays visible and overridable per task.
 */
export const RECOMMENDED_SUFFIX = ' (Recommended)'

/** The three settings values, in the order the form presents them. */
export const STARTUP_MODES = ['ask', 'on', 'off'] as const
export type StartupMode = typeof STARTUP_MODES[number]

/** Label the startup card shows for one option, marking the configured default. */
export function startupOptionLabel(label: string, recommended: boolean): string {
  return recommended ? label + RECOMMENDED_SUFFIX : label
}

/** Recover the option label from an answer that may carry the preset marker. */
export function stripRecommendedSuffix(answer: string): string {
  return answer.endsWith(RECOMMENDED_SUFFIX) ? answer.slice(0, -RECOMMENDED_SUFFIX.length) : answer
}

/** Whether the card option at this index is the configured default. */
export function isDefaultOption(decision: StartupMode, lisp: StartupMode, index: number): boolean {
  if (decision === 'ask' && lisp === 'ask') return false
  return (decision === 'on') === (index < 2) && (lisp === 'on') === (index % 2 === 0)
}
