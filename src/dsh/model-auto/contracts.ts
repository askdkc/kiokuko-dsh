import { z } from 'zod'
import { ModelBindingSchema } from '../model-configuration.js'

export const MODEL_AUTO_POLICY = 'codex-luna-sol-v1'
export const ModelAutoRouteId = z.enum(['luna-low', 'luna-medium', 'luna-high', 'sol-high'])
export type ModelAutoRouteId = z.infer<typeof ModelAutoRouteId>
export const ModelAutoConfig = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('off'),
  preset: z.literal(MODEL_AUTO_POLICY).default(MODEL_AUTO_POLICY),
  budgetMs: z.number().int().min(100).max(600_000).default(5000),
  routes: z.array(z.object({ id: ModelAutoRouteId, binding: ModelBindingSchema }).strict()).max(4)
    .refine(routes => new Set(routes.map(route => route.id)).size === routes.length, 'Duplicate model-auto route').optional(),
}).strict()
export type ModelAutoConfiguration = z.infer<typeof ModelAutoConfig>

export type ModelAutoReason = 'selected' | 'observed' | 'mode_off' | 'manual_pin' | 'ineligible_task'
  | 'decision_off' | 'decision_unavailable' | 'candidate_unavailable' | 'candidate_insufficient'
  | 'input_too_large' | 'abstained' | 'invalid_result' | 'decision_timeout' | 'restart_no_retry'
  | 'session_changed' | 'unsupported_runtime'

export interface ModelAutoInput {
  readonly runId: string
  readonly sessionId: string
  readonly requestId: string
  readonly turn: number
  readonly task: string
  readonly taskType?: string
  readonly attachmentTypes?: readonly string[]
  /** Native token meter snapshot; called only for a new route. */
  readonly measureContext?: () => number | undefined
  readonly admitted: boolean
  readonly signal: AbortSignal
}

export type ModelAutoSelection =
  | { readonly kind: 'apply'; readonly binding: z.infer<typeof ModelBindingSchema>; readonly reason: ModelAutoReason }
  | { readonly kind: 'native'; readonly reason: ModelAutoReason }

export const DEFAULT_MODEL_AUTO_ROUTES: readonly { id: ModelAutoRouteId; binding: z.infer<typeof ModelBindingSchema> }[] = [
  { id: 'luna-low', binding: { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'low' } },
  { id: 'luna-medium', binding: { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'medium' } },
  { id: 'luna-high', binding: { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'high' } },
  { id: 'sol-high', binding: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'high' } },
]
