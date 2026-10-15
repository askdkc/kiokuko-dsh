import { z } from 'zod'

/** Shared configuration schemas; Core does not load optional Deep implementation. */
export const DeepBudgetSchema = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  maxDepth: z.number().int().min(0).max(8).default(4),
  maxNodes: z.number().int().min(1).max(128).default(32),
  maxChildrenPerNode: z.number().int().min(1).max(8).default(3),
  maxReplansPerNode: z.number().int().min(0).max(4).default(2),
  maxAgentJobs: z.number().int().min(0).max(256).default(48),
  maxModelRequests: z.number().int().min(0).max(512).default(80),
  maxTotalTokens: z.number().int().min(0).max(2_000_000).default(120_000),
  maxOutputTokensPerRequest: z.number().int().min(1).max(32_768).default(4_096),
  maxActiveSeconds: z.number().int().min(1).max(7_200).default(600),
}).strict()
export type DeepBudget = z.infer<typeof DeepBudgetSchema>

export const DeepThinkerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentAgentsTotal: z.number().int().min(1).max(32).default(6),
  budget: DeepBudgetSchema.prefault({}),
}).strict()
