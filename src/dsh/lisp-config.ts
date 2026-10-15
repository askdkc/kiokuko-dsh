import { z } from 'zod'

/** Shared configuration schema; Core must not import the optional Lisp implementation. */
export const LispConfig = z.object({
  executionMode: z.enum(['development','protected']).default('development'),
  approvalMode: z.enum(['ask', 'auto']).default('ask'),
  enabled: z.boolean().default(false), sbclPath: z.string().min(1).default('sbcl'),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  startupTimeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  maxWorkers: z.number().int().min(1).max(32).default(4),
  idleTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  maxOutputBytes: z.number().int().min(1024).max(8_388_608).default(8_388_608),
}).strict()
export type LispConfiguration = z.infer<typeof LispConfig>
