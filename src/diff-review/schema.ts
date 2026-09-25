import { createHash } from 'node:crypto'
import { z } from 'zod'

export const REVIEW_SCHEMA_VERSION = 1
export const REVIEW_MODES = ['current', 'staged', 'unstaged', 'turn'] as const
export type ReviewMode = typeof REVIEW_MODES[number]
export type DiffLayer = 'staged' | 'unstaged' | 'untracked' | 'turn'
export type ReviewState = 'facts-only' | 'analyzing' | 'analyzed' | 'partial' | 'cancelled' | 'failed'

export interface DiffHunk {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DiffFile {
  fileId: string
  layer: DiffLayer
  oldPath?: string
  newPath?: string
  displayPath: string
  kind: 'text' | 'binary' | 'symlink' | 'submodule' | 'mode' | 'conflict' | 'oversized' | 'excluded'
  reason?: string
  oldMode?: string
  newMode?: string
  oldDigest?: string
  newDigest?: string
  hunks: DiffHunk[]
  patch?: string
}

export interface DiffSnapshot {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION
  snapshotId: string
  source: 'current-git' | 'native-turn'
  mode: ReviewMode
  sessionId: string
  repositoryId: string
  repositoryRoot: string
  capturedAt: string
  headOid?: string
  indexDigest?: string
  turnSeq?: number
  beforeTree?: string
  afterTree?: string
  totalFiles: number
  files: DiffFile[]
  exclusions: string[]
}

export interface ReviewContext {
  source: 'current-run' | 'completed-run' | 'review-input' | 'unavailable'
  status?: string
  runId?: string
  task?: string
  reviewInput?: string
  constraints?: string
  expected?: string
  candidates?: { runId: string; task: string; status: string; startedAt: string }[]
  memory: 'available' | 'empty' | 'unavailable' | 'withheld' | 'mismatch'
  memories: { entryId: string; revision: number; deliveryId: string; text: string; untrusted: true }[]
  execution?: { id: string; command: string; cwd: string; status: 'passed' | 'failed' | 'timeout' | 'unknown';
    snapshotMatch: 'unproven' | 'stale' | 'exact'; source: 'verifier-receipt' }[]
  reason?: string
}

export interface DiffAnchor {
  snapshotId: string
  fileId: string
  layer: DiffLayer
  side: 'old' | 'new'
  hunkId: string
  startLine: number
  endLine: number
}

export interface ReviewClaim {
  id: string
  origin: 'ai'
  text: string
  evidenceIds: string[]
  anchor?: DiffAnchor
  confidence: 'low' | 'medium' | 'high'
  unverifiedAssumptions: string[]
}

export interface DiffReview {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION
  reviewId: string
  sessionId: string
  snapshot: DiffSnapshot
  context: ReviewContext
  state: ReviewState
  freshness: 'current' | 'stale' | 'unknown'
  model?: { provider: string; model: string }
  summary?: string
  analysis?: {
    overallRisk: 'low' | 'medium' | 'high' | 'unknown'
    impact: string[]
    breakingChanges: string[]
    testGaps: string[]
    memoryConflicts: string[]
    assumptions: string[]
  }
  claims: ReviewClaim[]
  analyzedFileIds: string[]
  unanalyzedFileIds: string[]
  excludedFileIds?: string[]
  errors: string[]
  createdAt: string
  updatedAt: string
}

export const CaptureRequest = z.object({
  action: z.literal('capture'),
  sessionId: z.string().min(1).max(256),
  mode: z.enum(REVIEW_MODES),
  turnSeq: z.number().int().nonnegative().optional(),
  untracked: z.array(z.string().min(1).max(4096)).max(200).default([]),
  requestId: z.string().uuid(),
}).strict()

export const AnalyzeRequest = z.object({
  action: z.literal('analyze'),
  sessionId: z.string().min(1).max(256),
  reviewId: z.string().uuid(),
  requestId: z.string().uuid(),
  selectedFileIds: z.array(z.string().min(1).max(128)).max(200),
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  purpose: z.string().max(4000).optional(),
  runId: z.string().max(256).optional(),
}).strict()

export const CancelRequest = z.object({
  action: z.literal('cancel'), sessionId: z.string().min(1).max(256),
  reviewId: z.string().uuid(),
}).strict()

export const ReviewRequest = z.discriminatedUnion('action', [CaptureRequest, AnalyzeRequest, CancelRequest])

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable across object insertion order because callers pass this fixed projection. */
export function snapshotDigest(snapshot: Omit<DiffSnapshot, 'snapshotId'>): string {
  return sha256(JSON.stringify(snapshot))
}

export class DiffReviewError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
