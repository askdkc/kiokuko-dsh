import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
import { recordEntry } from '../../../src/memory/entries.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, NOW } from './evolution/fixture.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { authorizeTaskLease, captureTaskLease, bindTaskRepository, transitionTask, readTaskSnapshot } from '../../../src/dsh/task-state.js'
import { admitReview } from '../../../src/memory/review/store.js'

function setup() {
 const f=fixture(), workspace='project:source-test',sessionId='source-first'
 f.db.prepare('INSERT INTO repositories VALUES(?,?,?,NULL,1,0,?,?)').run(workspace,workspace,'test',NOW,NOW)
 const opened=new DshRunIntakeService(f.db,{akinatorMemory:AkinatorMemoryConfig.parse({mode:'off'})}).openRun({idempotencyKey:'create',dshSessionId:sessionId,
 request:{apiVersion:'1',workspace,task:{title:'Inspect',query:'Inspect source history',profileHints:{taskType:'research',target:'.',expected:'Report observations',constraints:null}},captureProfile:'minimal',coverage:{run:'unavailable',tool:'unavailable',command:'unavailable',file:'unavailable',approval:'unavailable'},metadata:{taskStateExplicit:true}}})
 const identity={taskId:opened.runId,sessionId,repositoryRoot:'/tmp/kiokuko-followup/implementation'}
 const todo=bindTaskRepository(f.db,identity)
 transitionTask(f.db,identity,{operation:'start',operationId:'start',expectedRevision:todo.revision,reason:'Start'})
 return {...f,workspace,identity,runId:opened.runId}
}
test('resume preserves raw and historical provenance without optional memory reads or new jobs',async()=>{
 const f=setup()
 try {
  f.db.prepare('INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,1,1,?,?)').run(f.runId,f.workspace,f.identity.sessionId,NOW,NOW)
  const oldLease=captureTaskLease(f.db,readTaskSnapshot(f.db,f.identity))
  admitReview(f.db,{workspace:f.workspace,sessionId:f.identity.sessionId,runId:f.runId,sourceGeneration:'old-native',startSeq:1,endSeq:5})
  f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.runId)
  f.db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,extraction_version,source_epoch,claim_nonce,lease_until)
    VALUES(?,?,?,1,5,'processing',1,?,?,2,1,'old-worker','2099-01-01T00:00:00Z')`).run(f.runId,f.workspace,f.identity.sessionId,NOW,NOW)
  const entry = recordEntry(f.db,{workspace:f.workspace,kind:'lesson',title:'Historical source',body:'Previously approved source.',createdBy:'fixture'})
  f.db.prepare('INSERT INTO dsh_memory_finalization_entries VALUES(?,?,0,?)').run(f.runId,entry.id,NOW)
  const before=f.db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get(f.runId)!
  const priorReview=f.db.prepare('SELECT * FROM memory_review_states WHERE run_id=?').get(f.runId)!
  const task=readTaskSnapshot(f.db,f.identity)
  transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume',expectedRevision:task.revision,
    expectedGeneration:task.generation,reason:'Explicit resume',explicit:true},{sourceEndSeq:5})
  const history=f.db.prepare('SELECT * FROM dsh_task_source_history WHERE run_id=?').get<any>(f.runId)!
  assert.equal(history.finalization_json,null); assert.equal(history.review_state_json,null)
  assert.deepEqual({...f.db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get(f.runId)},{...before})
  assert.deepEqual({...f.db.prepare('SELECT * FROM memory_review_states WHERE run_id=?').get(f.runId)},{...priorReview})
  assert.throws(()=>authorizeTaskLease(f.db,oldLease),/stale|changed|generation/i)
  const retired = new DshMemoryFinalizer({runtime:f.runtime})
  try { await retired.start(); retired.kick(); await retired.whenIdle() } finally { await retired.dispose() }
  assert.deepEqual({...f.db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get(f.runId)},{...before})
  assert.equal(JSON.parse(history.boundary_json).source_end_seq,5)
  assert.equal(history.source_session_id,f.identity.sessionId);assert.equal(history.original_session_id,f.identity.sessionId)
  assert.equal(history.next_owner_session_id,f.identity.sessionId)
  assert.equal(f.db.prepare('SELECT entry_id FROM dsh_memory_finalization_entries WHERE run_id=?').get<any>(f.runId)!.entry_id,entry.id)
  assert.equal(f.db.prepare('SELECT count(*) n FROM dsh_task_source_finalizations').get<any>()!.n,0)
  const current=f.db.prepare('SELECT * FROM memory_review_states WHERE run_id=?').get<any>(f.runId)!
  assert.equal(current.session_id,f.identity.sessionId);assert.equal(current.lease_nonce,priorReview.lease_nonce)
  assert.equal(f.db.prepare('SELECT count(*) n FROM entries').get<any>()!.n,1)
  assert.throws(()=>f.db.prepare("UPDATE dsh_task_source_history SET reason='forged'").run(),/immutable/)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{f.db.close()}
})
