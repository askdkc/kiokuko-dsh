import { z } from 'zod'

export const SemanticCompactionConfig = z.object({
  mode: z.enum(['auto', 'off']).default('auto'),
  preemptive: z.boolean().default(true),
  budgetMs: z.number().int().min(1).max(600000).default(5000),
}).strict()
export type SemanticCompactionConfiguration = z.infer<typeof SemanticCompactionConfig>
export const COMPACTION_POLICY = 'semantic-results-v2'
export const COMPACTION_MARKER = '[Kiokuko shortened earlier tool output; the original remains in session history.]'

export interface CompactionOutcome {
  outcome: 'shortened' | 'skipped' | 'fallback' | 'cancelled' | 'commit_failed'
  reason: string
  shortened: number
  elapsedMs: number
  landedEvents?: number
  beforeTokens?: number
  afterTokens?: number
  trigger?: 'pressure' | 'todo_boundary'
}
/** Native values are inspected here, never decoded from classifier output. */
export interface SurfaceMessage {
  id: string
  role: string
  content: Array<{ type: string; [key: string]: any }>
  source: { kind: string; [key: string]: any }
  [key: string]: unknown
}
export interface SurfaceEvent {
  seq: number
  type: string
  data: Record<string, any>
  sourceEventSeqs?: readonly number[]
}
export interface CompactionSession {
  id: string
  seq: number
  header: { version: number; cwd: string; parentSession?: string; origin?: string; delegationDepth?: number }
  surface: { nodes: readonly number[] }
  eventAt(seq: number): SurfaceEvent | undefined
  requestHeader(): { config: { provider: string; model: string }; [key: string]: unknown } | undefined
  append(type: string, data: unknown, options?: unknown): SurfaceEvent
}
export interface CompactionAgent {
  id: string
  session?: CompactionSession
  ctx?: { on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void }
}
export interface NativeTokenMeter {
  measure(session: CompactionSession, header?: unknown): { totalTokens: number; logRevision: number; nodes: readonly { seq: number; tokens: number; heuristicTokens: number }[] }
  estimateMessage(message: SurfaceMessage): number
}
export interface ResultCandidate {
  id: string
  tool: string
  callId: string
  event: SurfaceEvent
  original: SurfaceMessage
  replacement: SurfaceMessage
  savings: number
  position: number
}
export type ResultProjector = (text: string) => string | undefined
export type CompactionAuthority = () => Promise<unknown | undefined>
