import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, seed, evidence as baseEvidence } from './evolution/fixture.js'
import { configureEvolution } from '../../../src/memory/evolution/store.js'
import { recordEntry, readEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { hybridSearch } from '../../../src/memory/hybrid-retrieval.js'
import { digest } from '../../../src/memory/evolution/contracts.js'
import { buildStructuredScope } from '../../../src/memory/structured-memory.js'
import { projectMemoryEntry, renderMemoryFields, assertMemoryProjection } from '../../../src/context/memory-projection.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { readContextDelivery } from '../../../src/context/delivery.js'
import { recallScopedMemory } from '../../../src/memory/scoped-memory.js'

const active = { mode: 'active' as const, maxRelatedCandidates: 12, parseAbsoluteDates: true, defaultTimeBasis: 'occurred' as const, timeZone: 'UTC' }
const capabilities = ['kiokuko-soul', 'memory-reasoning', 'kiokuko-single-purpose-functions', 'one-shot-software-completion']
  .map(name => ({ kind: 'skill' as const, name }))

test('related retrieval is one hop, workspace-local and confirms case-sensitive path identity', () => {
  const { db } = fixture()
  try {
    const seedEntry = recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Needle source', body: 'Unique source text', createdBy: 'test',
      scope: buildStructuredScope({ visibility: 'project', signals: { symbols: ['WidgetManager'], paths: ['src/Widget.ts'] } }) })
    const related = recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Neighbor fact', body: 'No direct query word here', createdBy: 'test',
      scope: buildStructuredScope({ visibility: 'project', signals: { symbols: ['WidgetManager'] } }) })
    const caseMismatch = recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Other path', body: 'No direct query word here either', createdBy: 'test',
      scope: buildStructuredScope({ visibility: 'project', signals: { paths: ['src/widget.ts'] } }) })
    const foreign = recordEntry(db, { workspace: 'project:other', kind: 'reference', title: 'Foreign fact', body: 'Needle appears only to seed it', createdBy: 'test',
      scope: buildStructuredScope({ visibility: 'project', signals: { symbols: ['WidgetManager'] } }) })
    const ordinary = hybridSearch(db, { workspace: 'project:test', query: 'Needle', limit: 10 })
    assert.ok(ordinary.some(hit => hit.entryId === seedEntry.id))
    assert.ok(!ordinary.some(hit => hit.entryId === related.id))
    const expanded = hybridSearch(db, { workspace: 'project:test', query: 'Needle', limit: 10 }, { memoryRetrieval: active })
    assert.ok(expanded.some(hit => hit.entryId === related.id && hit.reasons.includes('related_signal_match')))
    assert.ok(!expanded.some(hit => hit.entryId === caseMismatch.id && hit.reasons.includes('related_signal_match')))
    assert.ok(!expanded.some(hit => hit.entryId === foreign.id))
    const observations: import('../../../src/memory/hybrid-retrieval.js').MemoryRetrievalObservation[] = []
    const observed = hybridSearch(db, { workspace: 'project:test', query: 'Needle', limit: 10 }, {
      memoryRetrieval: { ...active, mode: 'observe' }, onMemoryRetrievalObservation: value => observations.push(value),
    })
    assert.deepEqual(observed, ordinary)
    assert.equal(observations.length, 1)
    assert.equal(observations[0]?.addedByRelated, 1)
  } finally { db.close() }
})

test('recorded-time restriction uses current revision time before lane caps', () => {
  const { db } = fixture()
  try {
    const revised = recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Needle original', body: 'old revision', createdBy: 'test', scope: { visibility: 'project' } },
      { now: '2020-01-01T00:00:00.000Z' })
    updateCandidateEntry(db, { workspace: revised.workspace, entryId: revised.id, expectedRevision: revised.revision,
      kind: revised.kind, title: 'Needle revised', body: 'current revision', scope: revised.scope, now: '2026-09-10T03:00:00.000Z' })
    const outside = recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Needle outside', body: 'outside range', createdBy: 'test', scope: { visibility: 'project' } },
      { now: '2026-09-09T23:59:59.000Z' })
    const timeConstraint = { version: 1 as const, basis: 'recorded' as const, mode: 'restrict' as const,
      startMs: Date.parse('2026-09-10T00:00:00.000Z'), endMs: Date.parse('2026-09-11T00:00:00.000Z'),
      anchorTimeMs: Date.parse('2026-09-10T12:00:00.000Z'), timeZone: 'UTC' }
    const hits = hybridSearch(db, { workspace: 'project:test', query: 'Needle', limit: 10 }, { memoryRetrieval: active, timeConstraint })
    assert.ok(hits.some(hit => hit.entryId === revised.id))
    assert.ok(!hits.some(hit => hit.entryId === outside.id))
    assert.equal(db.prepare('SELECT created_at AS value FROM entry_revisions WHERE entry_id=? AND revision=(SELECT current_revision FROM entries WHERE id=?)')
      .get<{ value: string }>(revised.id, revised.id)!.value, '2026-09-10T03:00:00.000Z')
  } finally { db.close() }
})

test('occurred-time restriction excludes unknown and mixed-period derived evidence', () => {
  const { db } = fixture()
  try {
    configureEvolution(db, 'active')
    const inRangeId = 'occurred-in-window'
    const mixedId = 'occurred-mixed-window'
    const base = Date.parse('2026-09-10T03:00:00.000Z')
    const makeEvidence = (id: string, mixed: boolean) => {
      const sessionId = `session-${id}`
      return baseEvidence(id).map(item => ({ ...item, occurred: {
        version: 1 as const,
        timeMs: mixed && item.seq === 4 ? Date.parse('2026-09-09T23:00:00.000Z') : base + item.seq * 1000,
        sessionId,
        nativeSequence: item.seq,
        sourceDigest: digest({ id, seq: item.seq, native: true }),
      } }))
    }
    const eligible = seed(db, inRangeId, { evidence: makeEvidence(inRangeId, false) })
    const mixed = seed(db, mixedId, { evidence: makeEvidence(mixedId, true) })
    const unknown = seed(db, 'occurred-unknown')
    const startMs = Date.parse('2026-09-10T00:00:00.000Z'), endMs = Date.parse('2026-09-11T00:00:00.000Z')
    const hits = hybridSearch(db, { workspace: 'project:test', query: 'SQLITE_BUSY', limit: 30 }, { memoryRetrieval: active,
      timeConstraint: { version: 1, basis: 'occurred', mode: 'restrict', startMs, endMs, anchorTimeMs: startMs, timeZone: 'UTC' } })
    const episodeIds = [eligible, mixed, unknown].map(episode => db.prepare('SELECT overview_entry_id FROM memory_episodes WHERE run_id=?').get<{ overview_entry_id: string }>(episode.runId)!.overview_entry_id)
    assert.ok(hits.some(hit => episodeIds[0] === hit.entryId))
    assert.ok(!hits.some(hit => episodeIds[1] === hit.entryId))
    assert.ok(!hits.some(hit => episodeIds[2] === hit.entryId))
  } finally { db.close() }
})

test('evidence receipt binds episode and source revisions and budgets visible references', () => {
  const { db } = fixture()
  try {
    configureEvolution(db, 'active')
    const episode = seed(db, 'receipt-evidence')
    const overviewId = db.prepare('SELECT overview_entry_id AS id FROM memory_episodes WHERE run_id=?').get<{ id: string }>(episode.runId)!.id
    const entry = readEntry(db, { workspace: episode.workspace, entryId: overviewId })
    const projected = projectMemoryEntry(db, entry, { includeEvidence: true })!
    const evidenceReceipt = projected.projection
    if (evidenceReceipt.version !== 2) throw new Error('evidence receipt version was not emitted')
    assert.deepEqual(evidenceReceipt.sources, episode.sources)
    assert.equal(evidenceReceipt.episodes[0]?.runId, episode.runId)
    assert.ok(renderMemoryFields(projected)!.includes('Evidence references:'))
    assert.ok(evidenceReceipt.characters > projectMemoryEntry(db, entry)!.projection.characters)
    assertMemoryProjection(projected)
    assert.throws(() => assertMemoryProjection({ ...projected, projection: { ...evidenceReceipt, sources: [] } }), /receipt|projection/iu)
  } finally { db.close() }
})

test('active scoped delivery stores its evidence receipt and binds structured time bounds', async () => {
  const { db } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'memory-retrieval-delivery-'))
  try {
    await mkdir(join(root, '.git'))
    const project = (await resolveProjectWorkspace(db, root))!
    configureEvolution(db, 'active')
    const episode = seed(db, 'scoped-evidence-delivery', { workspace: project.workspace })
    const firstConstraint = { version: 1 as const, basis: 'recorded' as const, mode: 'restrict' as const,
      startMs: Date.parse('2026-09-10T00:00:00.000Z'), endMs: Date.parse('2026-09-11T00:00:00.000Z'),
      anchorTimeMs: Date.parse('2026-09-10T12:00:00.000Z'), timeZone: 'UTC' }
    const prepared = await prepareAgentTask(db, { requestId: 'scoped-evidence-delivery-task', task: 'SQLITE_BUSY', cwd: root,
      dshSessionId: 'scoped-evidence-delivery-session', executionSelection: true,
      profileHints: { taskType: 'debug', target: 'sqlite', expected: 'Resolve SQLITE_BUSY', constraints: 'Preserve data' },
      capabilities, skillDiscoveryMode: 'off', memoryRetrieval: active, timeConstraint: firstConstraint })
    const first = prepared.context!
    assert.equal(first.policyVersion, 'context-ranking-v10')
    const overviewId = db.prepare('SELECT overview_entry_id AS id FROM memory_episodes WHERE run_id=?').get<{ id: string }>(episode.runId)!.id
    const delivered = first.items.find(item => item.entryId === overviewId)
    assert.equal(delivered?.projection?.version, 2)
    const persisted = readContextDelivery(db, { workspace: project.workspace, deliveryId: first.deliveryId! })
    assert.equal(persisted.items.find(item => item.entryId === overviewId)?.projection?.version, 2)
    if (delivered?.projection?.version !== 2) assert.fail('delivery did not contain a v2 evidence receipt')
    assert.ok(delivered.projection.episodes.some(item => item.runId === episode.runId))
    assert.ok(delivered.projection.sources.some(item => item.entryId === episode.sources[0]?.entryId && item.hash === episode.sources[0]?.hash))

    const secondConstraint = { ...firstConstraint, startMs: Date.parse('2026-09-11T00:00:00.000Z'),
      endMs: Date.parse('2026-09-12T00:00:00.000Z'), anchorTimeMs: Date.parse('2026-09-11T12:00:00.000Z') }
    const query = { project, projectOnly: true, task: 'SQLITE_BUSY', taskProfile: prepared.intake.profile, runId: prepared.run.runId,
      limit: 10, characterBudget: 8_000 }
    const second = (await queryScopedContextGated(db, { ...query, timeConstraint: secondConstraint }, value => ({ persist: true, value }),
      { memoryRetrieval: active })).context!
    assert.notEqual(second.queryHash, first.queryHash)
    assert.ok(!second.items.some(item => item.entryId === overviewId))
    const recalled = await recallScopedMemory(db, { project, scope: 'project', query: 'SQLITE_BUSY', readOnly: true, limit: 20,
      timeConstraint: firstConstraint }, { memoryRetrieval: active })
    assert.ok(recalled.project?.memory.items.some(item => item.id === overviewId))
    const outsideRecall = await recallScopedMemory(db, { project, scope: 'project', query: 'SQLITE_BUSY', readOnly: true, limit: 20,
      timeConstraint: secondConstraint }, { memoryRetrieval: active })
    assert.ok(!outsideRecall.project?.memory.items.some(item => item.id === overviewId))
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
