import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeReview } from '../../../../src/diff-review/analyzer.js'
import { reviewMarkdown } from '../../../../src/diff-review/markdown.js'
import type { DiffReview } from '../../../../src/diff-review/schema.js'
import type { DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'

const base: DiffReview = {
  schemaVersion: 1, reviewId: 'review', sessionId: 'session', state: 'facts-only', freshness: 'current', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  claims: [], errors: [], analyzedFileIds: [], unanalyzedFileIds: [], context: { source: 'unavailable', memory: 'empty', memories: [] },
  snapshot: { schemaVersion: 1, snapshotId: 'snapshot', source: 'current-git', mode: 'current', sessionId: 'session', repositoryId: 'repo', repositoryRoot: '/tmp/repo',
    capturedAt: '2026-01-01T00:00:00Z', totalFiles: 1, exclusions: [], files: [{ fileId: 'file-1', layer: 'unstaged', newPath: 'file.ts', displayPath: 'file.ts', kind: 'text',
      patch: '@@ -1 +1 @@\n-old\n+new', hunks: [{ id: 'hunk-1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }] },
}
const limits = { maxInputBytes: 32768, maxChunks: 4, maxOutputTokens: 2048, deadlineMs: 2000 }

function llmFor(output: object): DshLlm {
  return { async *stream(options) {
    assert.deepEqual(options.tools, [])
    yield { type: 'text-delta', text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
const details = { overallRisk: 'medium', impact: [], breakingChanges: [], testGaps: [], memoryConflicts: [], assumptions: [] }

test('analysis accepts only server-issued evidence IDs', async () => {
  const valid = await analyzeReview(structuredClone(base), llmFor({ summary: 'One line changed', ...details, claims: [{ text: 'Behavior changed', evidenceIds: ['file-1:hunk-1'], confidence: 'medium', unverifiedAssumptions: [],
    anchor: { fileId: 'file-1', hunkId: 'hunk-1', side: 'new', startLine: 1, endLine: 1 } }] }),
    { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, new AbortController().signal)
  assert.equal(valid.state, 'analyzed')
  assert.equal(valid.claims.length, 1)
  assert.equal(valid.claims[0]?.anchor?.snapshotId, 'snapshot')
  const invalid = await analyzeReview(structuredClone(base), llmFor({ summary: 'Unsupported', ...details, claims: [{ text: 'Invented citation', evidenceIds: ['other'], confidence: 'high', unverifiedAssumptions: [] }] }),
    { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, new AbortController().signal)
  assert.equal(invalid.state, 'partial')
  assert.equal(invalid.claims.length, 0)
  assert.ok(invalid.errors.includes('invalid_evidence_reference'))
  const wrongLine = await analyzeReview(structuredClone(base), llmFor({ summary: 'Bad line', ...details, claims: [{ text: 'Wrong line', evidenceIds: ['file-1:hunk-1'], confidence: 'high', unverifiedAssumptions: [],
    anchor: { fileId: 'file-1', hunkId: 'hunk-1', side: 'old', startLine: 99, endLine: 99 } }] }),
    { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, new AbortController().signal)
  assert.equal(wrongLine.claims.length, 0)
  assert.equal(wrongLine.state, 'partial')
})

test('provider failure and malformed JSON leave the facts and explain failure', async () => {
  const broken: DshLlm = { async *stream() { yield { type: 'text-delta', text: 'not-json' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const review = await analyzeReview(structuredClone(base), broken, { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, new AbortController().signal)
  assert.equal(review.state, 'facts-only')
  assert.equal(review.snapshot.files[0]?.patch, base.snapshot.files[0]?.patch)
  assert.ok(review.errors.includes('invalid_model_json'))
})

test('Markdown export keeps source fences and model HTML inert', () => {
  const review = structuredClone(base)
  review.snapshot.files[0]!.patch = '```\n+<script>alert(1)</script>'
  review.summary = '<img src=x onerror=alert(1)> [open](javascript:alert(1))'
  const markdown = reviewMarkdown(review)
  assert.match(markdown, /````diff/u)
  assert.match(markdown, /&lt;img/u)
  assert.match(markdown, /\\\[open\\\]/u)
})

test('cancelling a pending provider stream returns the fixed facts without a late claim', async () => {
  const abort = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const slow: DshLlm = { async *stream() {
    entered()
    await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'text-delta', text: JSON.stringify({ summary: 'late', ...details, claims: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const pending = analyzeReview(structuredClone(base), slow, { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, abort.signal)
  await started
  abort.abort()
  const result = await pending
  assert.equal(result.state, 'cancelled')
  assert.equal(result.claims.length, 0)
  assert.equal(result.snapshot.snapshotId, 'snapshot')
})

test('partial snapshot coverage cannot report low overall risk', async () => {
  const review = structuredClone(base)
  review.snapshot.totalFiles = 2
  const output = await analyzeReview(review, llmFor({ summary: 'Looks simple', ...details, overallRisk: 'low', claims: [] }),
    { provider: 'provider', model: 'model' }, ['file-1'], undefined, limits, new AbortController().signal)
  assert.equal(output.state, 'partial')
  assert.equal(output.analysis?.overallRisk, 'unknown')
})
