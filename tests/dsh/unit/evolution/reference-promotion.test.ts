import test from 'node:test'
import assert from 'node:assert/strict'
import { draft as makeDraft, evidence, fixture, NOW, seed } from '../../integration/evolution/fixture.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { scheduleEvolution } from '../../../../src/memory/evolution/store.js'
import { MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'
import { EvolutionWorker } from '../../../../src/memory/evolution/worker.js'
import { formatEvolutionStatus } from '../../../../src/memory/evolution/status.js'
import { buildReferenceLesson, referencePromotionSignature, renderReferenceLesson } from '../../../../src/memory/evolution/reference-promotion.js'

test('positive promotion selects one deterministic observed field set and retains episode caveats', () => {
  const { db } = fixture()
  try {
    const first = seed(db, 'compact-z')
    const second = seed(db, 'compact-a', { draft: { ...first.draft, unresolved: ['The test does not cover multi-process writers.'] } })
    const third = seed(db, 'compact-b', { draft: { ...first.draft, unresolved: ['Do not apply to corrupt databases.'] } })
    const lesson = buildReferenceLesson([third, first, second], 'positive')!
    assert.equal(lesson.procedure, first.draft.procedure)
    assert.equal(lesson.selectedFromRunId, 'compact-a')
    assert.deepEqual(lesson.supportRunIds, ['compact-a', 'compact-b', 'compact-z'])
    assert.deepEqual(lesson.unresolved.map(item => item.items[0]), [
      'The test does not cover multi-process writers.', 'Do not apply to corrupt databases.',
    ])
    assert.match(renderReferenceLesson(lesson), /When: SQLITE_BUSY sqlite migration 3\.46/)
    assert.match(renderReferenceLesson(lesson), /Not for: Not for corrupt databases\./)
    assert.match(renderReferenceLesson(lesson), /Unresolved \(one observation\)/)
  } finally { db.close() }
})

test('condition changes never share support and case-sensitive anchor changes split groups', () => {
  const { db } = fixture()
  try {
    const first = seed(db, 'condition-a')
    const changed = { ...first, runId: 'condition-b', draft: { ...first.draft, applicability: `${first.draft.applicability} on Windows` } }
    assert.notEqual(referencePromotionSignature(first, 'positive'), referencePromotionSignature(changed, 'positive'))
    assert.equal(buildReferenceLesson([first, changed], 'positive'), undefined)
    const caseChanged = { ...first, runId: 'case-change', draft: { ...first.draft, anchors: { ...first.draft.anchors, target: 'Migration' } } }
    assert.notEqual(referencePromotionSignature(first, 'positive'), referencePromotionSignature(caseChanged, 'positive'))
  } finally { db.close() }
})

test('contradictory procedures under one condition are withheld instead of combined', () => {
  const { db } = fixture()
  try {
    const first = seed(db, 'method-a')
    const second = { ...first, runId: 'method-b', draft: { ...first.draft, procedure: 'Change journal mode before retrying migration.' } }
    const third = { ...first, runId: 'method-c' }
    assert.equal(referencePromotionSignature(first, 'positive'), referencePromotionSignature(second, 'positive'))
    assert.equal(buildReferenceLesson([first, second, third], 'positive'), undefined)
  } finally { db.close() }
})

test('candidate selection minimizes the actual rendered lesson, then ties by run ID', () => {
  const { db } = fixture()
  try {
    const long = seed(db, 'smallness-z', { draft: { ...makeDraft(), goal: 'Repair the migration runner after the concurrent writer blocks its first transaction' } })
    const small = seed(db, 'smallness-b', { draft: { ...makeDraft(), goal: 'Fix the lock' } })
    const tie = seed(db, 'smallness-a', { draft: { ...makeDraft(), goal: 'Fix the lock' } })
    assert.equal(buildReferenceLesson([long, small, tie], 'positive')?.selectedFromRunId, tie.runId)
  } finally { db.close() }
})

test('avoidance promotion keeps the observed correction and its triggering condition together', () => {
  const { db } = fixture()
  try {
    const firstDraft = makeDraft()
    const draft = { ...firstDraft, avoidance: {
      trigger: firstDraft.applicability, avoid: 'Retry while holding the writer lock.',
      alternative: firstDraft.procedure, verification: firstDraft.verification, evidence: [3],
    } }
    // Re-seed with the complete episode shape so native signals are recalculated from the correction.
    const first = seed(db, 'avoidance-one', { draft: { ...draft, events: [
      { kind: 'failure', description: 'Writer lock blocks migration.', evidence: [2] },
      { kind: 'correction', description: 'Release the writer before retrying.', evidence: [1] },
      { kind: 'action', description: 'Release the writer.', evidence: [3] },
      { kind: 'verification', description: 'Migration test passed.', evidence: [4] },
    ] } })
    const lesson = buildReferenceLesson([first], 'avoidance')!
    assert.equal(lesson.kind, 'avoidance')
    assert.equal(lesson.condition.applicability, draft.applicability)
    assert.equal(lesson.avoidance?.avoid, draft.avoidance!.avoid)
    assert.equal(lesson.corrections[0]?.description, 'Release the writer before retrying.')
    assert.match(renderReferenceLesson(lesson), /Observed correction at native seq 1/)
  } finally { db.close() }
})

test('separate applicability conditions accumulate support independently', async () => {
  const f = fixture()
  const schedule = (runId: string) => withImmediateTransaction(f.db,
    () => scheduleEvolution(f.db, runId, { provider: 'p', model: 'm', contextWindow: 100000 }, NOW))
  try {
    const first = seed(f.db, 'condition-set-a1'); schedule(first.runId)
    const second = seed(f.db, 'condition-set-a2'); schedule(second.runId)
    const third = seed(f.db, 'condition-set-a3'); schedule(third.runId)
    const conditionB = `${makeDraft().applicability} on Windows`
    const windows = ['condition-set-b1', 'condition-set-b2', 'condition-set-b3'].map(id => {
      const observation = evidence(id)
      observation[0]!.text += ' on Windows'
      const episode = seed(f.db, id, { draft: { ...makeDraft(), applicability: conditionB }, evidence: observation })
      schedule(episode.runId)
      return episode
    })
    const jobs = f.db.prepare('SELECT trigger_run,signature,algorithm FROM memory_evolution_jobs ORDER BY trigger_run').all() as Array<{trigger_run:string;signature:string;algorithm:string}>
    assert.deepEqual(jobs.map(job => job.trigger_run), ['condition-set-a3', 'condition-set-b3'])
    assert.equal(new Set(jobs.map(job => job.signature)).size, 2)
    assert.ok(jobs.every(job => job.algorithm === 'reference-promotion-v2'))
    assert.equal(f.db.prepare("SELECT reason FROM memory_evolution_skips WHERE run_id='condition-set-b1'").get()?.reason, 'condition_mismatch')

    const worker = new EvolutionWorker({ runtime: f.runtime, config: MemoryEvolutionConfig.parse({}), now: () => NOW })
    try { worker.kick(); await worker.whenIdle() }
    finally { await worker.dispose() }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_derivations WHERE algorithm='reference-promotion-v2'").get()?.n, 2)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls').get()?.n, 0)
    assert.equal(windows.length, 3)
  } finally { f.db.close() }
})

test('same-condition procedure conflicts cannot become a scheduled lesson', () => {
  const f = fixture()
  try {
    const first = seed(f.db, 'conflict-a')
    const conflictDraft = { ...makeDraft(), procedure: 'Rebuild transaction state before retrying migration.' }
    const conflictEvidence = evidence('conflict-b')
    conflictEvidence[2]!.text = conflictDraft.procedure
    seed(f.db, 'conflict-b', { draft: conflictDraft, evidence: conflictEvidence })
    seed(f.db, 'conflict-c')
    withImmediateTransaction(f.db, () => scheduleEvolution(f.db, 'conflict-c', { provider: 'p', model: 'm', contextWindow: 100000 }, NOW))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get()?.n, 0)
    assert.equal(f.db.prepare("SELECT reason FROM memory_evolution_skips WHERE run_id='conflict-c'").get()?.reason, 'conflicting_procedures')
    assert.ok(first.successful)
  } finally { f.db.close() }
})

test('status identifies v2 and explains separate-condition or procedure-conflict holds', () => {
  const text = formatEvolutionStatus({ mode: 'active', requested: 'active', promotionAlgorithm: 'reference-promotion-v2',
    derivations: { ready: 0, held: 0 }, episodes: { count: 4 }, calls: { count: 0, inputTokens: null, outputTokens: null, durationMs: null },
    extraction: [], skips: [{ reason: 'condition_mismatch', count: 1 }], jobs: [
      { algorithm: 'episode-evolution-v1', state: 'held', reason: 'conflicting_procedures', count: 1 },
      { algorithm: 'reference-promotion-v2', state: 'pending', reason: null, count: 1 },
    ] })
  assert.match(text, /reference-promotion-v2/u)
  assert.match(text, /episode-evolution-v1/u)
  assert.match(text, /適用条件が異なるため支持を分離/u)
  assert.match(text, /同じ適用条件で手順が衝突/u)
})
