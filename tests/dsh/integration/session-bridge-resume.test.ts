import { scheduleLegacyFinalizer } from '../helpers/legacy-finalizer.js'
import { CURRENT_MIGRATION_VERSIONS } from '../../fixtures/current-migrations.js'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { MemoryIndexReasoningConfig } from '../../../src/memory/index-reasoning/contracts.js'
import { openConnection } from '../../../src/db/connection.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { DshMemoryFinalizer, reduceDshFinalizationLog, bindDshRunLogStartInTransaction, type DshSessionLogSnapshot } from '../../../src/dsh/session-memory-finalizer.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { type EfficiencyObservation, DshEfficiencyObserver } from '../../../src/dsh/efficiency.js'
import { FINALIZATION_STREAM_MAX_BYTES } from '../../../src/dsh/finalization-request.js'

async function fixture(migrationsDirectory = join(process.cwd(), 'migrations')): Promise<{ root: string; database: SqliteDatabase; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-finalizer-'))
  await mkdir(join(root, '.git'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, migrationsDirectory)
  registerRepositoryAndLocation(database, {
    repositoryId: 'repo-finalizer', workspace: 'workspace-finalizer', displayName: 'finalizer',
    canonicalRoot: realpathSync(root), remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1,
  })
  new LedgerStore(database).createRun({
    runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', protocolVersion: '1',
    captureProfile: 'minimal',
    coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
    task: { title: 'finish work', query: 'finish work', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
  })
  return {
    root,
    database,
    cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

function snapshot(): DshSessionLogSnapshot {
  const user = { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Implement the durable design.' }], source: { kind: 'user' } }
  const result = {
    id: 'tool-result-1', role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: `important\n${'x'.repeat(70_000)}` }] }],
    source: { kind: 'tool', callId: 'read-1' },
  }
  const assistant = {
    id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Implemented and verified.' }],
    source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
  }
  return {
    session: { id: 'archived-dsh-session', createdAt: 1, cwd: '/archived/project' },
    inheritedEventCount: 0,
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: user, surfaceOp: 'append' },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'test-provider', model: 'test-model' }, system: 'system-prefix', tools: [{ name: 'Read', description: 'read', parameters: {} }] }, reason: 'initial' } },
      { type: 'request/context', seq: 3, time: 4, data: { provider: 'test-provider', model: 'test-model', contextWindow: 1_000_000 } },
      { type: 'tool/call', seq: 4, time: 5, data: { callId: 'read-1', name: 'Read', arguments: '{"path":"large.txt"}' } },
      { type: 'tool/result', seq: 5, time: 6, data: { message: result }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 6, time: 7, data: { message: assistant, usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 18_000 } }, surfaceOp: 'append' },
      { type: 'goal/change', seq: 7, time: 8, data: { kind: 'goal/change', version: 1, operation: 'complete', goal: { objective: 'Durable memory', phase: 'complete' } } },
      { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 9, time: 10, data: { turn: 2 } },
      { type: 'user/message', seq: 10, time: 11, data: { id: 'future-user', role: 'user', content: [{ type: 'text', text: 'FUTURE RUN MUST NOT LEAK' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 11, time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  }
}

test('version-10 pending finalization upgrades with prefix mode and unchanged job identity', async () => {
  const legacy = await mkdtemp(join(tmpdir(), 'kiokuko-finalizer-v10-'))
  const source = join(process.cwd(), 'migrations')
  for (const file of await readdir(source)) if (/^00\d_|^010_/u.test(file)) await copyFile(join(source, file), join(legacy, file))
  const f = await fixture(legacy)
  try {
    f.database.prepare('INSERT INTO dsh_run_log_boundaries (run_id, workspace, dsh_session_id, source_start_seq, source_start_turn, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)')
      .run('run-finalizer', 'workspace-finalizer', 'archived-dsh-session', '2026-09-09', '2026-09-09')
    new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
    f.database.prepare("INSERT INTO dsh_memory_finalizations (run_id, workspace, dsh_session_id, source_start_seq, source_end_seq, status, attempt_count, scheduled_at, updated_at) VALUES (?, ?, ?, 0, 8, 'pending', 1, ?, ?)")
      .run('run-finalizer', 'workspace-finalizer', 'archived-dsh-session', '2026-09-09', '2026-09-09')
    assert.deepEqual(migrateDatabase(f.database, source).applied, CURRENT_MIGRATION_VERSIONS.filter(version => version > 10))
    const row = f.database.prepare('SELECT input_mode AS mode, attempt_count AS attempts, status, source_end_seq AS end FROM dsh_memory_finalizations').get()
    assert.deepEqual({ ...row }, { mode: 'prefix_reuse', attempts: 1, status: 'pending', end: 8 })
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.cleanup(); await rm(legacy, { recursive: true, force: true }) }
})

function runtime(database: SqliteDatabase) {
  return {
    async withDatabase<T>(operation: (database: SqliteDatabase, embedding: never) => T | PromiseLike<T>): Promise<T> {
      return await operation(database, undefined as never)
    },
  }
}

test('new DSH run creation and its turn-start boundary commit atomically', async () => {
  const f = await fixture()
  try {
    const beforeRuns = f.database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()!.count
    await assert.rejects(prepareAgentTask(f.database, {
      requestId: 'atomic-invalid-boundary',
      task: 'hello',
      cwd: f.root,
      profileHints: { taskType: 'chat', target: null, expected: null, constraints: null },
      capabilities: [],
      dshSessionId: 'atomic-session',
      dshLogStart: { sourceStartSeq: -1, sourceStartTurn: 1 },
      skillDiscoveryMode: 'off',
    }), /sourceStartSeq/u)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()!.count, beforeRuns)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_run_log_boundaries').get<{ count: number }>()!.count, 0)

    const prepared = await prepareAgentTask(f.database, {
      requestId: 'atomic-valid-boundary',
      task: 'hello',
      cwd: f.root,
      profileHints: { taskType: 'chat', target: null, expected: null, constraints: null },
      capabilities: [],
      dshSessionId: 'atomic-session',
      dshLogStart: { sourceStartSeq: 12, sourceStartTurn: 2 },
      skillDiscoveryMode: 'off',
    })
    const metadata=JSON.parse(f.database.prepare('SELECT metadata_json FROM ledger_runs WHERE run_id=?').get<{metadata_json:string}>(prepared.run.runId)!.metadata_json)
    assert.deepEqual(metadata.nativeSourceStart,{sessionId:'atomic-session',seq:12,turn:2})
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM dsh_run_log_boundaries').get<{n:number}>()!.n,0,'Native raw provenance adds no optional memory job boundary')
  } finally {
    await f.cleanup()
  }
})

/** Historical jobs are evidence, never approval to restart a derived-memory writer. */
function reserveHistoricalJob(db:SqliteDatabase,mode='prefix_reuse') {
  withImmediateTransaction(db,()=>{
    bindDshRunLogStartInTransaction(db,{runId:'run-finalizer',workspace:'workspace-finalizer',dshSessionId:'archived-dsh-session',sourceStartSeq:0,sourceStartTurn:1},new Date().toISOString())
    new LedgerStore(db).updateRunStatusInTransaction('run-finalizer','completed')
    scheduleLegacyFinalizer(db,{runId:'run-finalizer',workspace:'workspace-finalizer',dshSessionId:'archived-dsh-session',sourceEndSeq:8},mode)
  })
}
function assertNoDerived(db:SqliteDatabase) {
  for(const table of ['entries','dsh_memory_finalization_entries','memory_episodes'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{n:number}>()!.n,0,table)
  assert.equal(new LedgerStore(db).readRun('run-finalizer')!.status,'completed')
}
async function reduce(mode:'prefix_reuse'|'bounded_evidence') {
  async function* events(){yield* snapshot().events}
  return await reduceDshFinalizationLog(events(),0,8,mode)
}

test('archived source remains bounded and source-linked while a historical job cannot auto-save',async()=>{
 const f=await fixture();let reads=0,calls=0
 const finalizer=new DshMemoryFinalizer({runtime:runtime(f.database),sessionQuery:{async readSession(){reads++;return snapshot()}},llm:{async *stream(){calls++;throw new Error('An unapproved job must not dispatch')}}})
 try{
  reserveHistoricalJob(f.database);const prior={...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()}
  await finalizer.start();finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual({...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()},prior);assert.equal(reads,0);assert.equal(calls,0);assertNoDerived(f.database)
  const selected=await reduce('prefix_reuse'),body=JSON.stringify(selected.messages)
  assert.equal(selected.eventCount,9);assert.equal(selected.envelope.provider,'test-provider');assert.equal(selected.envelope.model,'test-model')
  assert.match(body,/Implement the durable design/);assert.match(body,/Implemented and verified/);assert.doesNotMatch(body,/FUTURE RUN MUST NOT LEAK/)
  assert.throws(()=>f.database.prepare('UPDATE dsh_memory_finalizations SET source_end_seq=11').run(),/immutable/)
  finalizer.kick();await finalizer.whenIdle();assert.equal(reads,0);assertNoDerived(f.database)
 }finally{await finalizer.dispose();await f.cleanup()}
})

test('historical failed jobs stay unchanged through retry and host reload without altering native completion',async()=>{
 const f=await fixture();let calls=0
 const make=()=>new DshMemoryFinalizer({runtime:runtime(f.database),llm:{async *stream(){calls++;throw new Error('No automatic retry')}}})
 let finalizer=make()
 try{
  reserveHistoricalJob(f.database)
  f.database.prepare("UPDATE dsh_memory_finalizations SET status='failed',last_error_message='Historical provider failure',attempt_count=1").run()
  const prior={...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()}
  await finalizer.start();await finalizer.retryFailed('run-finalizer');finalizer.kick();await finalizer.whenIdle();await finalizer.dispose()
  finalizer=make();await finalizer.start();await finalizer.whenIdle()
  assert.deepEqual({...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()},prior);assert.equal(calls,0);assertNoDerived(f.database)
 }finally{await finalizer.dispose();await f.cleanup()}
})

for(const failure of ['capsule','finish','throw','limit','storage','abort'] as const)test(`retired automatic finalizer does not enter ${failure} failure or block native completion`,async()=>{
 const f=await fixture();let calls=0,reads=0,observations=0
 const finalizer=new DshMemoryFinalizer({runtime:runtime(f.database),sessionQuery:{async readSession(){reads++;return snapshot()}},
  onObservation:()=>{observations++;throw new Error('telemetry sink failed')},llm:{async *stream(options){
    calls++;if(failure==='abort')await new Promise<void>(resolve=>options.signal!.addEventListener('abort',()=>resolve(),{once:true}))
    if(failure==='throw')throw new Error('stream failed')
    yield {type:'text-delta',text:failure==='capsule'?'not json':failure==='limit'?'x'.repeat(FINALIZATION_STREAM_MAX_BYTES+1):'{"schemaVersion":1,"memories":[]}'}
    if(failure!=='finish')yield {type:'finish',reason:{kind:'stop'}}
  }}})
 try{
  reserveHistoricalJob(f.database,'bounded_evidence');const prior={...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()}
  if(failure==='storage')f.database.exec("CREATE TRIGGER reject_finalization_completion BEFORE UPDATE OF status ON dsh_memory_finalizations WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;")
  await finalizer.start();finalizer.kick();await finalizer.whenIdle();await finalizer.dispose()
  assert.equal(calls,0);assert.equal(reads,0);assert.equal(observations,0)
  assert.deepEqual({...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()},prior);assertNoDerived(f.database)
 }finally{await finalizer.dispose();await f.cleanup()}
})

test('bounded evidence is reproducible across reload while historical input mode and job remain immutable',async()=>{
 const f=await fixture();let calls=0
 const make=(inputMode:'prefix_reuse'|'bounded_evidence')=>new DshMemoryFinalizer({runtime:runtime(f.database),inputMode,llm:{async *stream(){calls++;throw new Error('No approval')}}})
 const first=make('bounded_evidence'),second=make('prefix_reuse')
 try{
  reserveHistoricalJob(f.database,'bounded_evidence');const prior={...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()}
  await first.start();first.kick();await first.whenIdle();await first.dispose();await second.start();await second.whenIdle()
  assert.equal(calls,0);assert.deepEqual({...f.database.prepare('SELECT * FROM dsh_memory_finalizations').get()},prior)
  assert.throws(()=>f.database.prepare("UPDATE dsh_memory_finalizations SET input_mode='prefix_reuse'").run(),/immutable/)
  const a=await reduce('bounded_evidence'),b=await reduce('bounded_evidence');assert.deepEqual(a,b)
  const body=a.boundedEvidence!;assert.ok(body);assert.match(body,/Implement the durable design/);assert.match(body,/Implemented and verified/);assert.doesNotMatch(body,/FUTURE RUN MUST NOT LEAK/)
  assert.ok(Buffer.byteLength(body)<10_000);assert.equal(a.envelope.tools?.length,1);assertNoDerived(f.database)
 }finally{await first.dispose();await second.dispose();await f.cleanup()}
})
