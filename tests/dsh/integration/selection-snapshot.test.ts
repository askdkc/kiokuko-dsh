import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture, seed } from './evolution/fixture.js'
import { openConnection } from '../../../src/db/connection.js'
import { withContextReadSnapshot } from '../../../src/context/read-snapshot.js'
import { contextSelectionStateHashes, ordinaryContextSelectionStateHash, contextRetrievalStateHash } from '../../../src/context/selection-state.js'
import { configureEvolution } from '../../../src/memory/evolution/store.js'
import { recordEntry, updateCandidateEntry, readEntry } from '../../../src/memory/entries.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

test('shared state hashes preserve each exclusion policy and observe subsequent revisions and modes', () => {
  const { db } = fixture()
  try {
    const episode = seed(db, 'state-hashes')
    recordEntry(db, { workspace: 'global', kind: 'reference', title: 'Global SQLITE_BUSY boundary', body: 'Only use for fixtures.', scope: { visibility: 'global' }, createdBy: 'fixture' })
    for (const mode of ['off','observe','active'] as const) {
      configureEvolution(db, mode)
      for (const workspaces of [[], [episode.workspace], [episode.workspace, 'global']]) for (const includeEcosystem of [false,true]) {
        assert.deepEqual(contextSelectionStateHashes(db, workspaces, { includeEcosystem }), {
          ordinary: ordinaryContextSelectionStateHash(db, workspaces, { includeEcosystem }), retrieval: contextRetrievalStateHash(db, workspaces, { includeEcosystem }) })
      }
    }
    const before = contextSelectionStateHashes(db, [episode.workspace])
    const source = readEntry(db, { workspace: episode.workspace, entryId: episode.sources[0]!.entryId })
    updateCandidateEntry(db, { workspace: episode.workspace, entryId: source.id, expectedRevision: source.revision, kind: source.kind, title: source.title, body: 'The observation was corrected.' })
    assert.notDeepEqual(contextSelectionStateHashes(db, [episode.workspace]), before)
  } finally { db.close() }
})

test('snapshot rows are isolated, consistent across connections, bounded to the call, and reject writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-read-snapshot-')), { db } = fixture(join(root, 'state.sqlite3'))
  const other = openConnection(join(root,'state.sqlite3'))
  try {
    db.exec('CREATE TABLE snapshot_fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO snapshot_fixture VALUES(1,\'old\')')
    let expired!: import('../../../src/db/adapter.js').SqliteDatabase
    withContextReadSnapshot(db, snapshot => {
      expired = snapshot
      const read = () => snapshot.prepare('SELECT value FROM snapshot_fixture WHERE id=1').get<{value:string}>()!
      const row = read(); assert.equal(row.value,'old'); row.value='caller mutation'
      other.prepare("UPDATE snapshot_fixture SET value='new' WHERE id=1").run()
      assert.equal(read().value,'old')
      assert.equal(snapshot.prepare('SELECT value FROM snapshot_fixture').all<{value:string}>()[0]!.value,'old', 'uncached reads share the same transaction snapshot')
      assert.throws(() => snapshot.prepare('UPDATE snapshot_fixture SET value=?').run('bad'), /read-only/u)
      assert.throws(() => snapshot.prepare('DELETE FROM snapshot_fixture RETURNING value').all(), /read-only/u)
    })
    assert.throws(() => expired.prepare('SELECT value FROM snapshot_fixture').get(), /request-local/u)
    assert.equal(withContextReadSnapshot(db, snapshot => snapshot.prepare('SELECT value FROM snapshot_fixture').get<{value:string}>()!.value),'new')
  } finally { other.close(); db.close(); await rm(root, { recursive: true, force: true }) }
})

test('scoped delivery retains selection, score, hash, receipts and persisted omission reasons on replay', async () => {
  const { db } = fixture(), root = await mkdtemp(join(tmpdir(),'snapshot-replay-'))
  try {
    await mkdir(join(root,'.git'))
    const project = (await resolveProjectWorkspace(db,root))!
    recordEntry(db, { workspace: project.workspace, kind: 'reference', title: 'SQLITE_BUSY', body: 'Never delete data. '.repeat(500), scope: {visibility:'project'}, createdBy:'fixture' })
    recordEntry(db, { workspace: project.workspace, kind: 'reference', title: 'SQLITE_BUSY', body: 'Check the fixture schema. Never use in production.', scope: {visibility:'project'}, createdBy:'fixture' })
    const prepared = await prepareAgentTask(db, { requestId:'snapshot-replay', task:'Diagnose SQLITE_BUSY', cwd:root, dshSessionId:'snapshot-session', executionSelection:true,
      profileHints:{taskType:'debug',target:'sqlite',expected:'resolve lock',constraints:'preserve data'}, skillDiscoveryMode:'off', maxContextChars:200,
      capabilities:[{kind:'skill',name:'memory-reasoning'}] })
    const query = { project, runId:prepared.run.runId, task:'SQLITE_BUSY', taskProfile:prepared.intake.profile, characterBudget:200 }
    const first = (await queryScopedContextGated(db,query,value=>({persist:true,value}))).context!
    const replay = (await queryScopedContextGated(db,query,value=>({persist:true,value}))).context!
    assert.deepEqual(replay.items, first.items); assert.equal(replay.deliveryId, first.deliveryId); assert.equal(replay.queryHash, first.queryHash)
    assert.equal(canonicalContentHash(replay.items), canonicalContentHash(first.items))
    assert.ok(first.omissions?.some(item=>item.reason==='budget'))
    assert.deepEqual([...replay.omissions!].sort((a,b)=>a.entryId.localeCompare(b.entryId)),[...first.omissions!].sort((a,b)=>a.entryId.localeCompare(b.entryId)))
  } finally { db.close(); await rm(root,{recursive:true,force:true}) }
})
