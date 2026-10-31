import { z } from 'zod'
import { isDefaultOption, startupOptionLabel, stripRecommendedSuffix, type StartupMode as PresentationMode } from './startup-defaults-settings.js'

export { startupOptionLabel, stripRecommendedSuffix }

/**
 * `ask` keeps the per-task startup card without a preset. `on`/`off` preselect
 * that side of the card and become the answer when no question service exists.
 * A default never grants execution authority: it only selects an offered answer.
 */
export const StartupModeSchema = z.enum(['ask', 'on', 'off'])
export type StartupMode = z.infer<typeof StartupModeSchema>

export const StartupDefaultsConfig = z.object({
  /** Default for typed decisions in the startup card. */
  decision: StartupModeSchema.default('ask'),
  /** Default for Lisp in the startup card. */
  lisp: StartupModeSchema.default('ask'),
}).strict()
export type StartupDefaults = z.infer<typeof StartupDefaultsConfig>

/** Profile-level service carrying the live defaults; absent on a plain parse. */
export const STARTUP_DEFAULTS_SERVICE = 'kiokukoStartupDefaults'
export interface StartupDefaultsSource {
  decision(): StartupMode
  lisp(): StartupMode
}

/** Whether the card option at this index expresses the configured default. */
export function isStartupDefault(defaults: StartupDefaults, index: number): boolean {
  return isDefaultOption(defaults.decision as PresentationMode, defaults.lisp as PresentationMode, index)
}

/**
 * Answer used when no question service is available. `ask` preserves the
 * caller's existing behaviour instead of inventing a preference.
 */
export function applyStartupDefault(mode: StartupMode, fallback: boolean): boolean {
  return mode === 'ask' ? fallback : mode === 'on'
}
