import path from 'node:path'
import { canonicalContentHash } from '../serialization/validate.js'

export interface ExplorationOperation {
  kind: 'read' | 'write'
  paths: string[]
  key: string
  range: unknown
}
export function recordObject(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}

/** Adapters for the pinned DSH structured filesystem tools; never parse Shell. */
export function explorationOperation(name: string, value: unknown, cwd: string): ExplorationOperation | undefined {
  const args = recordObject(value)
  if (!args) return undefined
  let kind: 'read' | 'write'
  let target: unknown
  if (['read', 'read_image'].includes(name)) { kind = 'read'; target = args.file_path }
  else if (['glob', 'grep'].includes(name)) { kind = 'read'; target = args.path ?? cwd }
  else if (['write', 'edit'].includes(name)) { kind = 'write'; target = args.file_path }
  else if (name === 'str_replace_editor' && ['view', 'create', 'str_replace', 'insert', 'undo_edit'].includes(args.command)) {
    kind = args.command === 'view' ? 'read' : 'write'; target = args.path
  } else return undefined
  if (typeof target !== 'string' || !target.trim()) return undefined
  // Include all arguments: different queries and ranges are different evidence.
  return { kind, paths: [path.resolve(cwd, target)], key: canonicalContentHash({ name, args }),
    range: { offset: args.offset ?? null, limit: args.limit ?? null, viewRange: args.view_range ?? null, pattern: args.pattern ?? null } }
}

export type EvidencePresentation = 'full' | 'partial' | 'unknown'
export interface ExecutionEvidence {
  id: string
  callId: string
  rootCallId: string
  turn: number
  generation: string
  operation: ExplorationOperation
  digest: string
  presentation: EvidencePresentation
  afterCorrection?: boolean
  acquisition?: EvidencePresentation
  toolSucceeded?: boolean
  acquiredRange?: { firstLine: number; lastLine: number; totalLines: number }
  sourceSeq?: number
}
export interface ExplorationState {
  version: 1
  generation: string
  humanEpoch: number
  humanTurn?: number
  humanInput?: string
  counts: Record<string, number>
  total: number
  warned: string[]
  presented?: string[]
  pauseKey?: string
  paused: boolean
  notice?: string
}
export function newExplorationState(generation: string, humanEpoch = 0): ExplorationState {
  return { version: 1, generation, humanEpoch, counts: {}, total: 0, warned: [], paused: false }
}
export function explorationResultKey(evidence: ExecutionEvidence): string {
  return canonicalContentHash({ operation: evidence.operation.key, result: evidence.digest })
}
export function observeExploration(previous: ExplorationState, evidence: ExecutionEvidence): ExplorationState {
  const state = previous.generation === evidence.generation ? structuredClone(previous) : newExplorationState(evidence.generation, previous.humanEpoch)
  if (state.paused) return state
  const key = explorationResultKey(evidence)
  const count = (state.counts[key] ?? 0) + 1
  state.counts[key] = count
  state.total += 1
  if (Object.keys(state.counts).length > 256) delete state.counts[Object.keys(state.counts)[0]!]
  if (count === 3 && !state.warned.includes(key)) {
    state.warned = [...state.warned, key].slice(-256)
    state.notice = 'The same read/search produced the same result three times. Use the evidence already collected; narrow the next question or explain what is missing. Do not repeat that operation unchanged.'
  } else if (count > 3 && state.warned.includes(key) && evidence.afterCorrection === true) {
    state.pauseKey = key
  } else if (state.total % 24 === 0) {
    state.notice = 'Exploration checkpoint: summarize established evidence and missing facts, then narrow the next search. This is advice, not a file or time limit.'
  }
  return state
}

/** Native read windows expose their actual range, independently of requested limits. */
export function acquiredReadRange(value: unknown): ExecutionEvidence['acquiredRange'] {
  const record = recordObject(value)
  if (!record || !Array.isArray(record.lines) || !Number.isSafeInteger(record.totalLines) || record.totalLines < 0) return undefined
  const numbers = record.lines.map((line: any) => line?.number)
  if (numbers.some((number: unknown) => !Number.isSafeInteger(number) || (number as number) < 1)) return undefined
  return { firstLine: numbers[0] ?? 0, lastLine: numbers.at(-1) ?? 0, totalLines: record.totalLines }
}

/** A logged/projection fragment is not proof that the model received all bytes. */
export function evidencePresentation(content: unknown, originalDigest: string): EvidencePresentation {
  const serialized = JSON.stringify(content)
  if (typeof serialized !== 'string') return 'unknown'
  if (/tool result middle pruned|Output capped|line truncated|output truncated/iu.test(serialized)) return 'partial'
  return canonicalContentHash(content) === originalDigest ? 'full' : 'unknown'
}
