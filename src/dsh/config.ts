import { z } from 'zod'
import { ModelRouteSchema } from './model-configuration.js'

const limit = (value: number) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(value)
export const OrcaConfig = z.object({
  enabled: z.boolean().default(true),
  storage: z.enum(['project', 'data-dir']).default('project'),
  includeAuxiliary: z.boolean().default(false),
  capture: z.object({
    content: z.enum(['redacted', 'metadata']).default('redacted'),
    reasoning: z.boolean().default(false),
  }).prefault({}),
  maxQueuedBytesPerTrace: limit(4_194_304),
  maxQueuedBytesTotal: limit(16_777_216),
  maxTraceBytes: limit(268_435_456),
  maxOpenTraces: limit(32),
  maxTimelineEventsPerPage: limit(200),
  maxTimelineReadBytesPerPage: limit(1_048_576),
  shutdownDrainTimeoutMs: z.number().int().positive().max(2_147_483_647).default(30_000),
  maxHtmlExportInputBytes: limit(8_388_608),
  maxHtmlExportEvents: limit(10_000),
  maxHtmlInlineCharsPerEvent: limit(32_768),
  maxHtmlExportOutputBytes: limit(67_108_864),
})
export type OrcaConfig = z.infer<typeof OrcaConfig>
/** Runtime configuration accepted by the dsh bundle entrypoint. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  modelRoutes: z.array(ModelRouteSchema).max(128).default([]).refine(routes => new Set(routes.map(r => r.provider)).size === routes.length, 'Each DSH provider must have one route declaration'),
  orca: OrcaConfig.prefault({}),
})
export type Config = z.input<typeof Config>
