import { randomUUID } from 'node:crypto'
import type { DshLlm } from '../dsh/session-memory-finalizer.js'
import type { DshCoreRuntime } from '../dsh/core-runtime.js'
import { readModelCatalog, type DshModelCatalog } from '../dsh/model-configuration.js'
import { readSessionReviewContext, resolveReviewSession, type ReviewPersistenceSource, type ReviewSessionBinding, type ReviewSessionSource } from '../dsh/session-review-context.js'
import { analyzeReview, type AnalyzerLimits } from './analyzer.js'
import { GitReader, type GitLimits, type SubprocessService } from './current-git-source.js'
import { captureNativeTurn, type NativeChanges } from './native-turn-source.js'
import { exclusionReason, safeReviewInput } from './redaction.js'
import { DiffReviewError, REVIEW_SCHEMA_VERSION, sha256, snapshotDigest, type DiffReview, type DiffSnapshot, type ReviewMode } from './schema.js'

export interface ReviewLimits extends GitLimits, AnalyzerLimits { maxCacheBytes: number; ttlMs: number }
export interface ReviewHost {
  runtime: Pick<DshCoreRuntime, 'withDatabase'>
  sessions?: ReviewSessionSource
  persistence?: ReviewPersistenceSource
  subprocess?: SubprocessService
  workspaceChanges?: NativeChanges
  llm?: DshLlm
  catalog?: DshModelCatalog
}

interface StoredReview { review: DiffReview; binding: ReviewSessionBinding; expiresAt: number; requestId: string; inputDigest: string; abort?: AbortController | undefined; done?: Promise<void> | undefined }

export class DiffReviewController {
  private readonly reviews = new Map<string, StoredReview>()
  private readonly captures = new Map<string, { digest: string; sessionId: string; abort: AbortController; done: Promise<DiffReview>; reviewId?: string | undefined }>()
  private readonly analyses = new Map<string, { digest: string; reviewId: string }>()
  private closed = false
  constructor(private readonly host: ReviewHost, private readonly limits: ReviewLimits, private readonly now: () => number = Date.now) {}

  async binding(sessionId: string): Promise<ReviewSessionBinding> {
    if (this.closed) throw new DiffReviewError('service_unavailable', 503)
    return resolveReviewSession(this.host.runtime, this.host.sessions, this.host.persistence, sessionId)
  }

  async availability(sessionId: string): Promise<{ availability: 'available' | 'repo_unavailable'; models: { provider: string; model: string }[]; untracked: string[]; turns: number[]; review?: DiffReview }> {
    let binding: ReviewSessionBinding
    try { binding = await this.binding(sessionId) }
    catch (error) {
      if (error instanceof DiffReviewError && error.code === 'repo_unavailable') return { availability: 'repo_unavailable', models: [], untracked: [], turns: [] }
      throw error
    }
    const git = this.host.subprocess ? new GitReader(this.host.subprocess, binding.repositoryRoot, this.limits) : undefined
    const available = git ? await git.available(new AbortController().signal) : false
    const untracked = available && git ? (await git.status(new AbortController().signal)).filter(item => item.x === '?' && !exclusionReason(item.path)).map(item => item.path) : []
    const live = this.host.sessions?.get(sessionId) as { snapshotEvents?: () => { type: string; seq: number }[] } | undefined
    const turns = live?.snapshotEvents?.().filter(event => event.type === 'workspace/changes').map(event => event.seq).slice(-20).reverse() ?? []
    let models: { provider: string; model: string }[] = []
    if (this.host.catalog && this.host.llm) {
      try { models = (await readModelCatalog(this.host.catalog)).models.map(item => ({ provider: item.provider, model: item.id })) }
      catch { /* facts remain available without the model catalog */ }
    }
    this.prune()
    const latest = [...this.reviews.values()].reverse().find(item => item.binding.sessionId === sessionId && item.binding.workspace === binding.workspace && item.binding.repositoryRoot === binding.repositoryRoot)
    return { availability: available ? 'available' : 'repo_unavailable', models, untracked, turns, ...(latest ? { review: structuredClone(latest.review) } : {}) }
  }

  private prune(): void {
    for (const [id, item] of this.reviews) if (item.expiresAt <= this.now() && !item.done) this.reviews.delete(id)
    let bytes = [...this.reviews.values()].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.review)), 0)
    for (const [id, item] of this.reviews) {
      if (bytes <= this.limits.maxCacheBytes) break
      if (item.done) continue
      bytes -= Buffer.byteLength(JSON.stringify(item.review))
      this.reviews.delete(id)
    }
    for (const [key, capture] of this.captures) if (capture.reviewId && !this.reviews.has(capture.reviewId)) this.captures.delete(key)
    for (const [key, analysis] of this.analyses) if (!this.reviews.has(analysis.reviewId)) this.analyses.delete(key)
  }

  async get(sessionId: string, reviewId: string): Promise<DiffReview> {
    const binding = await this.binding(sessionId)
    this.prune()
    const item = this.reviews.get(reviewId)
    if (!item) throw new DiffReviewError('review_expired', 410)
    if (item.binding.sessionId !== sessionId || item.binding.repositoryRoot !== binding.repositoryRoot || item.binding.workspace !== binding.workspace) throw new DiffReviewError('review_identity_mismatch', 409)
    if (item.review.snapshot.source === 'current-git' && this.host.subprocess) {
      try {
        const reader = new GitReader(this.host.subprocess, binding.repositoryRoot, this.limits)
        const fingerprint = await reader.fingerprint(new AbortController().signal)
        item.review.freshness = fingerprint === item.review.snapshot.indexDigest && await reader.matchesCapturedFiles(item.review.snapshot.files) ? 'current' : 'stale'
      } catch { item.review.freshness = 'unknown' }
    }
    return structuredClone(item.review)
  }

  async fileAddress(sessionId: string, reviewId: string, fileId: string): Promise<string> {
    const review = await this.get(sessionId, reviewId)
    const file = review.snapshot.files.find(item => item.fileId === fileId)
    if (!file || review.snapshot.source !== 'current-git' || file.kind !== 'text' || !file.newPath || file.newPath.includes('\\') || !file.newDigest || !this.host.subprocess) {
      throw new DiffReviewError('file_link_unavailable', 409)
    }
    const reader = new GitReader(this.host.subprocess, review.snapshot.repositoryRoot, this.limits)
    if (!await reader.matchesWorkingDigest(file.newPath, file.newDigest)) throw new DiffReviewError('file_changed', 409)
    const encodedPath = file.newPath.split('/').map(encodeURIComponent).join('/')
    return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encodedPath}`
  }

  async capture(input: { sessionId: string; mode: ReviewMode; turnSeq?: number | undefined; untracked: string[]; requestId: string }): Promise<DiffReview> {
    const binding = await this.binding(input.sessionId)
    const digest = sha256(JSON.stringify([binding, input.mode, input.turnSeq ?? null, input.untracked]))
    const key = `${input.sessionId}:${input.requestId}`
    this.prune()
    const replay = this.captures.get(key)
    if (replay) {
      if (replay.digest !== digest) throw new DiffReviewError('request_id_conflict', 409)
      return structuredClone(await replay.done)
    }
    if ([...this.captures.values()].some(item => item.sessionId === input.sessionId && !item.reviewId)) throw new DiffReviewError('capture_in_progress', 409)
    if ([...this.reviews.values()].some(item => item.binding.sessionId === input.sessionId && item.done)) {
      throw new DiffReviewError('analysis_in_progress', 409)
    }
    const abort = new AbortController()
    const done = this.captureNow(binding, input, abort.signal)
    const entry = { digest, sessionId: input.sessionId, abort, done, reviewId: undefined as string | undefined }
    this.captures.set(key, entry)
    try { const review = await done; entry.reviewId = review.reviewId; return structuredClone(review) }
    catch (error) { this.captures.delete(key); throw error }
  }

  private async captureNow(binding: ReviewSessionBinding, input: { mode: ReviewMode; turnSeq?: number | undefined; untracked: string[]; requestId: string }, signal: AbortSignal): Promise<DiffReview> {
    const capturedAt = new Date(this.now()).toISOString()
    let source: DiffSnapshot['source'], files: DiffSnapshot['files'], totalFiles: number
    let headOid: string | undefined, indexDigest: string | undefined, beforeTree: string | undefined, afterTree: string | undefined
    if (input.mode === 'turn') {
      if (input.turnSeq === undefined) throw new DiffReviewError('turn_seq_required', 400)
      const result = await captureNativeTurn(this.host.workspaceChanges, binding.sessionId, input.turnSeq, binding.repositoryRoot, this.limits, signal)
      source = 'native-turn'; files = result.files; totalFiles = result.total; beforeTree = result.beforeTree; afterTree = result.afterTree
    } else {
      if (!this.host.subprocess) throw new DiffReviewError('git_unavailable', 503)
      const result = await new GitReader(this.host.subprocess, binding.repositoryRoot, this.limits).capture(input.mode, input.untracked, signal)
      source = 'current-git'; files = result.files; totalFiles = result.total; headOid = result.headOid; indexDigest = result.indexDigest
    }
    const body: Omit<DiffSnapshot, 'snapshotId'> = { schemaVersion: REVIEW_SCHEMA_VERSION, source, mode: input.mode,
      sessionId: binding.sessionId, repositoryId: binding.repositoryId, repositoryRoot: binding.repositoryRoot, capturedAt,
      ...(headOid ? { headOid } : {}), ...(indexDigest ? { indexDigest } : {}), ...(input.turnSeq !== undefined ? { turnSeq: input.turnSeq } : {}),
      ...(beforeTree ? { beforeTree } : {}), ...(afterTree ? { afterTree } : {}), totalFiles, files,
      exclusions: files.filter(file => file.reason).map(file => `${file.fileId}:${file.reason}`) }
    const snapshot: DiffSnapshot = { ...body, snapshotId: snapshotDigest(body) }
    let context
    try { context = await readSessionReviewContext(this.host.runtime, binding) }
    catch { context = { source: 'unavailable' as const, memory: 'unavailable' as const, memories: [], reason: 'context_unavailable' } }
    const review: DiffReview = { schemaVersion: REVIEW_SCHEMA_VERSION, reviewId: randomUUID(), sessionId: binding.sessionId,
      snapshot, context, state: 'facts-only', freshness: source === 'current-git' ? 'current' : 'unknown', claims: [], analyzedFileIds: [],
      unanalyzedFileIds: [], errors: [], createdAt: capturedAt, updatedAt: capturedAt }
    if (signal.aborted || this.closed) throw new DiffReviewError('cancelled', 409)
    this.prune()
    for (const [id, item] of this.reviews) {
      if (item.binding.sessionId === binding.sessionId) this.reviews.delete(id)
    }
    this.reviews.set(review.reviewId, { review, binding, expiresAt: this.now() + this.limits.ttlMs, requestId: input.requestId,
      inputDigest: sha256(JSON.stringify(input)) })
    return review
  }

  async analyze(input: { sessionId: string; reviewId: string; requestId: string; selectedFileIds: string[]; provider: string; model: string; purpose?: string | undefined; runId?: string | undefined }): Promise<DiffReview> {
    const current = await this.get(input.sessionId, input.reviewId)
    const item = this.reviews.get(input.reviewId)!
    const digest = sha256(JSON.stringify(input))
    const key = `${input.sessionId}:${input.requestId}`
    const previous = this.analyses.get(key)
    if (previous) {
      if (previous.digest !== digest || previous.reviewId !== input.reviewId) throw new DiffReviewError('request_id_conflict', 409)
      return structuredClone(item.review)
    }
    if (item.done) throw new DiffReviewError('analysis_in_progress', 409)
    if ([...this.reviews.values()].some(other => other !== item && other.binding.sessionId === input.sessionId && other.done)) {
      throw new DiffReviewError('analysis_in_progress', 409)
    }
    if (!input.selectedFileIds.length) throw new DiffReviewError('empty_file_selection', 400)
    if (new Set(input.selectedFileIds).size !== input.selectedFileIds.length || input.selectedFileIds.some(id => !current.snapshot.files.some(file => file.fileId === id && file.kind === 'text'))) {
      throw new DiffReviewError('invalid_file_selection', 400)
    }
    if (current.snapshot.files.some(file => file.kind === 'conflict')) throw new DiffReviewError('unmerged_conflict', 409)
    if (input.purpose && !safeReviewInput(input.purpose)) throw new DiffReviewError('unsafe_review_input', 400)
    if (!this.host.llm || !this.host.catalog) throw new DiffReviewError('model_unavailable', 503)
    const catalog = await readModelCatalog(this.host.catalog)
    if (!catalog.models.some(model => model.provider === input.provider && model.id === input.model)) throw new DiffReviewError('model_unavailable', 503)
    if (catalog.resolveCallConfig) {
      const resolved = await catalog.resolveCallConfig({ provider: input.provider, model: input.model })
      if (resolved.provider !== input.provider || resolved.model !== input.model) throw new DiffReviewError('model_binding_changed', 409)
    }
    if (input.runId) {
      const context = await readSessionReviewContext(this.host.runtime, item.binding, input.runId)
      if (context.source === 'unavailable' && context.memory === 'mismatch') throw new DiffReviewError('run_identity_mismatch', 409)
      item.review.context = context
    }
    if (input.purpose?.trim()) item.review.context = { ...item.review.context,
      ...(item.review.context.source === 'unavailable' ? { source: 'review-input' as const } : {}), reviewInput: input.purpose.trim() }
    const abort = new AbortController()
    item.abort = abort
    const { summary: _priorSummary, analysis: _priorAnalysis, ...facts } = current
    item.review = { ...facts, context: item.review.context, state: 'analyzing', model: { provider: input.provider, model: input.model },
      claims: [], analyzedFileIds: [], unanalyzedFileIds: input.selectedFileIds, errors: [], updatedAt: new Date(this.now()).toISOString() }
    this.analyses.set(key, { digest, reviewId: input.reviewId })
    item.done = analyzeReview(item.review, this.host.llm, { provider: input.provider, model: input.model }, input.selectedFileIds,
      input.purpose, this.limits, abort.signal).then(result => { if (!abort.signal.aborted) item.review = result; else item.review = { ...result, state: 'cancelled' } })
      .catch(() => { item.review = { ...item.review, state: abort.signal.aborted ? 'cancelled' : 'failed', errors: ['analysis_failed'], updatedAt: new Date(this.now()).toISOString() } })
      .finally(() => { item.done = undefined; item.abort = undefined })
    return structuredClone(item.review)
  }

  async cancel(sessionId: string, reviewId: string): Promise<DiffReview> {
    await this.get(sessionId, reviewId)
    const item = this.reviews.get(reviewId)!
    item.abort?.abort()
    if (item.done) await item.done
    return structuredClone(item.review)
  }

  async dispose(): Promise<void> {
    this.closed = true
    const jobs = [...this.reviews.values()]
    const captures = [...this.captures.values()]
    captures.forEach(item => item.abort.abort())
    jobs.forEach(item => item.abort?.abort())
    await Promise.allSettled([...jobs.map(item => item.done), ...captures.map(item => item.done)])
    this.reviews.clear(); this.captures.clear(); this.analyses.clear()
  }
}
