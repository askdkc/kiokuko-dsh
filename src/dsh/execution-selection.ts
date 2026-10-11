import { z } from 'zod'
import { LegacyDeepConfigurationSchema, DeepConfigurationSchema } from '../deep-thinker/core/contracts.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'
import { LegacyModelConfigurationSchema, ModelConfigurationSchema, LegacyModelConfigurationDraftSchema, ModelBindingSchema } from './model-configuration.js'

export const ExecutionSelectionSchema = z.object({
  mode: z.enum(['pending', 'normal', 'enno', 'deep-thinker']),
  status: z.enum(['selecting', 'ready', 'reselect']),
  configuration: z.union([ModelConfigurationSchema, LegacyModelConfigurationSchema]).optional(),
  deepConfiguration: z.union([DeepConfigurationSchema, LegacyDeepConfigurationSchema]).optional(),
  ordinaryModel: ModelBindingSchema.optional(),
  draft: LegacyModelConfigurationDraftSchema.optional(),
  problem: z.string().max(1024).optional(),
  discussion: z.object({
    questionId: z.string().min(1).max(256),
    text: z.string().trim().min(1).max(64 * 1024),
    turn: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.discussion && value.status === 'ready') ctx.addIssue({ code: 'custom', message: 'Discussion cannot authorize execution' })
  if (value.mode === 'deep-thinker' && (!value.deepConfiguration || value.configuration || value.draft)) ctx.addIssue({ code: 'custom', message: 'Deep requires its independent configuration' })
  if (value.mode !== 'deep-thinker' && value.deepConfiguration) ctx.addIssue({ code: 'custom', message: 'Deep configuration requires Deep ownership' })
  if (value.mode === 'enno' && value.status === 'ready' && !value.configuration) ctx.addIssue({ code: 'custom', message: 'Enno requires a complete model configuration' })
  if (value.mode === 'pending' && value.status === 'ready') ctx.addIssue({ code: 'custom', message: 'Pending selection cannot be ready' })
})
export type ExecutionSelection = z.infer<typeof ExecutionSelectionSchema>
export interface StoredExecutionSelection { readonly revision: number; readonly value: ExecutionSelection }
export function readExecutionSelection(database: SqliteDatabase, runId: string): StoredExecutionSelection | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dsh_execution_selections'").get()) return undefined
  const row = database.prepare('SELECT revision, state_json FROM dsh_execution_selections WHERE run_id = ?').get<{ revision: number; state_json: string }>(runId)
  if (!row) return undefined // Legacy runs retain their original contract.
  const value = ExecutionSelectionSchema.parse(JSON.parse(row.state_json))
  const configurations = [value.configuration, value.deepConfiguration, value.draft].filter(Boolean)
  if (configurations.some(c => c!.routeBindings?.some(r => r.family === 'orcarouter') || Object.values(c!.roles).some(binding => binding?.provider === 'orcarouter'))) {
    value.status = 'reselect'
    value.problem = 'OrcaRouter is retired; explicitly select replacement models before running again'
  }
  return { revision: row.revision, value }
}
export function initializeExecutionSelection(database: SqliteDatabase, runId: string): void {
  database.prepare('INSERT OR IGNORE INTO dsh_execution_selections (run_id, state_json, updated_at) VALUES (?, ?, ?)')
    .run(runId, JSON.stringify({ mode: 'pending', status: 'selecting' }), new Date().toISOString())
}
export function writeExecutionSelection(database: SqliteDatabase, runId: string, expectedRevision: number, value: ExecutionSelection): StoredExecutionSelection {
  const parsed = ExecutionSelectionSchema.parse(value)
  if (parsed.status === 'ready') {
    if (parsed.configuration) ModelConfigurationSchema.parse(parsed.configuration)
    if (parsed.deepConfiguration) DeepConfigurationSchema.parse(parsed.deepConfiguration)
  }
  database.prepare('UPDATE dsh_execution_selections SET state_json = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?')
    .run(JSON.stringify(parsed), new Date().toISOString(), runId, expectedRevision)
  if (database.prepare('SELECT changes() AS count').get<{ count: number }>()?.count !== 1) throw new KiokukoError('CONFLICT', 'Execution selection changed; reload the exact task before choosing again')
  if (parsed.mode === 'enno' || parsed.mode === 'normal') database.prepare('UPDATE dsh_execution_owners SET mode=? WHERE run_id=?').run(parsed.mode, runId)
  return { revision: expectedRevision + 1, value: parsed }
}
/** Only explicit, affirmative instructions count; negative clauses win. */
export function explicitExecutionMode(task: string): 'normal' | 'enno' | undefined {
  if (/(?:役小角|enno(?:-oduno)?).{0,12}(?:使わず|使わない|利用しない|なしで)|(?:without|do not use|don't use)\s+(?:enno(?:-oduno)?|役小角)|通常実行(?:で|を)/iu.test(task)) return 'normal'
  if (/(?:役小角|enno(?:-oduno)?).{0,8}(?:使って|使用して|利用して|で実行)|\buse\s+enno(?:-oduno)?\b/iu.test(task)) return 'enno'
  return undefined
}
