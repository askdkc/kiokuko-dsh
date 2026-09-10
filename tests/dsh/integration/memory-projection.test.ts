import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture, seed, draft } from './evolution/fixture.js'
import { recordEntry, readEntry } from '../../../src/memory/entries.js'
import { projectMemoryEntry, renderMemoryFields, assertMemoryProjection } from '../../../src/context/memory-projection.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { configureEvolution } from '../../../src/memory/evolution/store.js'

test('projection counts exactly the deduplicated UTF-8 model text and rejects changed receipts', () => {
  const { db } = fixture()
  try {
    const entry = recordEntry(db, { workspace: 'global', kind: 'reference', title: '同じ本文', summary: '同じ本文', body: '同じ本文', scope: { visibility: 'global' }, createdBy: 'test' })
    const projected = projectMemoryEntry(db, entry)!
    assert.equal(renderMemoryFields(projected), '同じ本文')
    assert.equal(projected.projection.characters, 4)
    assert.equal(projected.projection.bytes, 12)
    assert.deepEqual(projected.projection.selectedFields, ['title'])
    assertMemoryProjection(projected)
    assert.throws(() => assertMemoryProjection({ ...projected, bodyPreview: 'Different procedure' }), /receipt/u)
  } finally { db.close() }
})

test('packing skips a full unsafe-to-split unit and continues to an affordable exact hit', async () => {
  const { db } = fixture(), root = await mkdtemp(join(tmpdir(), 'projection-packing-'))
  try {
    await mkdir(join(root, '.git'))
    const project = (await resolveProjectWorkspace(db, root))!
    const large = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'SQLITE_BUSY', body: 'Repair the writer. '.repeat(100) + 'NEVER APPLY TO CORRUPTION', summary: 'Repair the writer.', createdBy: 'test', scope: { visibility: 'project' } })
    const small = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'SQLITE_BUSY', body: 'Read-only check; never delete data.', summary: null, createdBy: 'test', scope: { visibility: 'project' } })
    const result = await queryScopedContextGated(db, { project, task: 'SQLITE_BUSY', taskProfile: { taskType: 'debug', target: 'sqlite', expected: 'check', constraints: null }, characterBudget: 80 }, context => ({ persist: false, value: context }))
    assert.ok(!result.value.items.some(item => item.entryId === large.id))
    assert.ok(result.value.items.some(item => item.entryId === small.id))
    assert.deepEqual(result.value.omissions?.find(item => item.entryId === large.id), { entryId: large.id, reason: 'budget' })
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test('derived projections retain source conditions, unresolved items and unverified status', () => {
  const { db } = fixture()
  try {
    const episode = seed(db, 'structured-projection', { draft: { ...draft(), unresolved: ['Concurrent callers not tested'] } })
    configureEvolution(db, 'active')
    const row = db.prepare('SELECT overview_entry_id AS id FROM memory_episodes WHERE run_id=?').get<{ id: string }>(episode.runId)!
    const entry = readEntry(db, { workspace: episode.workspace, entryId: row.id })
    const projected = projectMemoryEntry(db, entry)!, text = renderMemoryFields(projected)!
    for (const value of [episode.draft.applicability, episode.draft.procedure, episode.draft.verification, episode.draft.boundary, 'Concurrent callers not tested', 'Unverified']) assert.ok(text.includes(value))
    assert.ok(projected.projection.manifestDigest)
  } finally { db.close() }
})

test('an oversized lesson does not suppress its affordable source overview', async () => {
  const { db } = fixture(), root = await mkdtemp(join(tmpdir(), 'projection-fallback-'))
  try {
    await mkdir(join(root, '.git'))
    const project = (await resolveProjectWorkspace(db, root))!
    const episodes = ['one','two','three'].map(id => seed(db, `fallback-${id}`, { workspace: project.workspace,
      draft: { ...draft(), unresolved: [`Independent ${id} writers remain untested`] } }))
    const { saveLesson } = await import('../../../src/memory/evolution/store.js')
    const { withImmediateTransaction } = await import('../../../src/db/transaction.js')
    const d = episodes[0]!.draft
    const lesson = withImmediateTransaction(db, () => saveLesson(db, episodes, 'positive', { applicability: d.applicability, procedure: d.procedure,
      verification: d.verification, boundary: d.boundary, evidence: episodes.map(e => e.runId), conflict: false }, new Date().toISOString()))
    configureEvolution(db, 'active')
    const overviewIds = db.prepare('SELECT overview_entry_id AS id FROM memory_episodes').all<{id:string}>().map(row => row.id)
    const overview = projectMemoryEntry(db, readEntry(db, { workspace: project.workspace, entryId: overviewIds[0]! }))!
    const budget = overview.projection.characters + 400
    assert.ok(projectMemoryEntry(db, lesson)!.projection.characters > budget)
    const result = await queryScopedContextGated(db, { project, task: 'Release writer', taskProfile: { taskType: 'debug', target: null, expected: null, constraints: null }, characterBudget: budget }, value => ({ persist: false, value }))
    assert.ok(!result.value.items.some(item => item.entryId === lesson.id))
    assert.ok(result.value.items.some(item => overviewIds.includes(item.entryId)), JSON.stringify(result.value.omissions))
    assert.equal(result.value.omissions?.find(item => item.entryId === lesson.id)?.reason, 'budget')
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
