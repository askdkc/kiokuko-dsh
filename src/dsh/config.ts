import { ObservationPackConfig } from './observation-pack/policy.js'
import { SemanticCompactionConfig } from './semantic-compaction/contracts.js'
import { ModelHandoffConfig } from './model-handoff.js'
import { MemoryReuseConfig } from '../memory/reuse.js'
import { TypedDecisionsConfig } from './decisions/config.js'
import { MemoryReviewConfig } from '../memory/review/contracts.js'
export { MemoryReviewConfig }
import { AkinatorMemoryConfig } from '../akinator/memory-probe-types.js'
export { AkinatorMemoryConfig }
import { MemoryEvolutionConfig } from '../memory/evolution/contracts.js'
export { MemoryEvolutionConfig }
import { z } from 'zod'
import { AnswerReviewConfig } from './answer-review/contracts.js'
import { SkillPromptsConfig } from './skill-prompt-contracts.js'
export { SkillPromptsConfig }
import { LispConfig } from './lisp/contracts.js'
export { LispConfig }
import { ContinuityConfig } from '../context/continuity-view.js'
export { ContinuityConfig }
import { ModelRouteSchema } from './model-configuration.js'
import { ModelAutoConfig } from './model-auto/contracts.js'
import { ToolExposureConfig } from './tool-exposure.js'
import { DeepThinkerConfigSchema } from '../deep-thinker/core/contracts.js'

const limit = (value: number) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(value)
export const OrcaConfig = z.object({
  enabled: z.boolean().default(true),
  /** `false` records every interactive session without a per-session question; `true` asks first. */
  askOnStart: z.boolean().default(false),
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
export const EfficiencyConfig = z.object({ observe: z.boolean().default(false) }).strict()
export const FinalizationConfig = z.object({ inputMode: z.enum(['prefix_reuse', 'bounded_evidence']).default('prefix_reuse') }).strict()
export const EnnoMemoryConfig = z.object({
  mode: z.enum(['off', 'observe', 'active']).default('off'),
  maxFullSearchesPerRun: z.number().int().min(1).max(32).default(8),
  localBudgetMs: z.number().int().min(100).max(5000).default(1000),
  // Rerank has not met the separate measurement gate in PLAN.md.
  rerank: z.literal(false).default(false),
}).strict()
export type EnnoMemoryConfig = z.infer<typeof EnnoMemoryConfig>
export const DiffReviewConfig = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(1000).default(200),
  maxFileBytes: z.number().int().min(1024).max(4_194_304).default(262_144),
  maxSnapshotBytes: z.number().int().min(65_536).max(16_777_216).default(2_097_152),
  maxInputBytes: z.number().int().min(4096).max(131_072).default(32_768),
  maxChunks: z.number().int().min(1).max(16).default(4),
  maxOutputTokens: z.number().int().min(128).max(8192).default(2048),
  deadlineMs: z.number().int().min(1000).max(600_000).default(120_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  maxCacheBytes: z.number().int().min(1_048_576).max(268_435_456).default(33_554_432),
  ttlMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
}).strict()
export type DiffReviewConfig = z.infer<typeof DiffReviewConfig>
/** Runtime configuration accepted by the dsh bundle entrypoint. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  skillPrompts: SkillPromptsConfig.prefault({}),
  lisp: LispConfig.prefault({}),
  typedDecisions: TypedDecisionsConfig.prefault({}),
  answerReview: AnswerReviewConfig.prefault({}),
  memoryReuse: MemoryReuseConfig.prefault({}),
  semanticCompaction: SemanticCompactionConfig.prefault({}),
  modelHandoff: ModelHandoffConfig.prefault({}),
  modelAutoMode: ModelAutoConfig.prefault({}),
  observationPack: ObservationPackConfig.prefault({}),
  akinatorMemory: AkinatorMemoryConfig.prefault({}),
  deepPlanning: DeepThinkerConfigSchema.prefault({}),
  modelRoutes: z.array(ModelRouteSchema).max(128).default([]).refine(routes => new Set(routes.map(r => r.provider)).size === routes.length, 'Each DSH provider must have one route declaration'),
  orca: OrcaConfig.prefault({}),
  toolExposure: ToolExposureConfig.prefault({}),
  efficiency: EfficiencyConfig.prefault({}),
  continuity: ContinuityConfig.prefault({}),
  ennoMemory: EnnoMemoryConfig.prefault({}),
  finalization: FinalizationConfig.prefault({}),
  memoryEvolution: MemoryEvolutionConfig.prefault({}),
  autoGlobalization: z.object({ enabled: z.boolean().default(true) }).strict().prefault({}),
  memoryReview: MemoryReviewConfig.prefault({}),
  diffReview: DiffReviewConfig.prefault({}),
})
export type Config = z.input<typeof Config>
