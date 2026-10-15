import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, NOW } from './evolution/fixture.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { DshMemoryFinalizer, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import { authorizeTaskLease, captureTaskLease, bindTaskRepository, transitionTask, readTaskSnapshot, recordTaskEvidence, transferTaskOwner, requestTaskStop, confirmTaskStop } from '../../../src/dsh/task-state.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { MemoryEvolutionConfig } from '../../../src/memory/evolution/contracts.js'
import { scheduleStoppedTaskFinalization, scheduleCompletedTaskFinalization } from '../../../src/dsh/task-source-history.js'
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
function bind(f:ReturnType<typeof setup>,sessionId=f.identity.sessionId,start=1) {
 f.db.prepare('INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,?,1,?,?)').run(f.runId,f.workspace,sessionId,start,NOW,NOW)
}
function worker(f:ReturnType<typeof setup>){return new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:{async readSession(){throw new Error('Retired worker must not read source')}},llm:{async *stream(){throw new Error('No automatic memory extraction')}}})}
function noDerived(f:ReturnType<typeof setup>){for(const table of ['entries','dsh_task_source_finalizations'])assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<any>()!.n,0,table)}

test('explicit same-session resume archives each raw source range without automatic memory finalization',async()=>{
 const f=setup(),finalizer=worker(f)
 try{
  bind(f);const lease=captureTaskLease(f.db,readTaskSnapshot(f.db,f.identity));f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.runId)
  const task=readTaskSnapshot(f.db,f.identity)
  transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume',expectedRevision:task.revision,reason:'Explicit continuation',explicit:true},{sourceEndSeq:5})
  const history=f.db.prepare('SELECT * FROM dsh_task_source_history').get<any>()!
  assert.equal(JSON.parse(history.boundary_json).source_start_seq,1);assert.equal(JSON.parse(history.boundary_json).source_end_seq,5)
  assert.equal(history.finalization_json,null);assert.equal(history.review_state_json,null);assert.throws(()=>authorizeTaskLease(f.db,lease),/stale|generation|changed/i)
  bind(f,f.identity.sessionId,6);await finalizer.start();finalizer.kick();await finalizer.whenIdle()
  assert.equal(f.db.prepare('SELECT source_start_seq FROM dsh_run_log_boundaries').get<any>()!.source_start_seq,6)
  assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs').get<any>()!.dsh_session_id,f.identity.sessionId)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get<any>()!.n,0);noDerived(f)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{await finalizer.dispose();f.db.close()}
})

test('owner handoff preserves original provenance and historical jobs cannot dispatch or adopt under a new owner',async()=>{
 const f=setup(),finalizer=worker(f)
 try{
  bind(f)
  admitReview(f.db,{workspace:f.workspace,sessionId:f.identity.sessionId,runId:f.runId,sourceGeneration:'old-native',startSeq:1,endSeq:5})
  f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.runId)
  f.db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,claim_nonce,lease_until)
   VALUES(?,?,?,1,5,'processing',1,?,?,'old-worker','2099-01-01T00:00:00Z')`).run(f.runId,f.workspace,f.identity.sessionId,NOW,NOW)
  const prior={...f.db.prepare('SELECT * FROM dsh_memory_finalizations').get()},review={...f.db.prepare('SELECT * FROM memory_review_states').get()}
  const old=readTaskSnapshot(f.db,f.identity);transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume-before-handoff',expectedRevision:old.revision,reason:'Explicit source continuation',explicit:true},{sourceEndSeq:5});bind(f,f.identity.sessionId,6)
  const task=readTaskSnapshot(f.db,f.identity),lease=captureTaskLease(f.db,task)
  recordTaskEvidence(f.db,task,{ref:'observed-stop',kind:'stopped',generation:task.generation,verified:true})
  transferTaskOwner(f.db,task,{sessionId:'source-second',operationId:'switch',expectedRevision:task.revision,expectedGeneration:task.generation,reason:'Model switch',evidence:['observed-stop'],sourceEndSeq:10})
  assert.throws(()=>authorizeTaskLease(f.db,lease),/stale|owner|session|generation|changed/i)
  bind(f,'source-second');await finalizer.start();finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual({...f.db.prepare('SELECT * FROM dsh_memory_finalizations').get()},prior);assert.deepEqual({...f.db.prepare('SELECT * FROM memory_review_states').get()},review)
  const history=f.db.prepare('SELECT * FROM dsh_task_source_history ORDER BY source_epoch DESC LIMIT 1').get<any>()!
  assert.equal(history.source_session_id,'source-first');assert.equal(history.next_owner_session_id,'source-second');assert.equal(JSON.parse(history.boundary_json).source_start_seq,6);assert.equal(JSON.parse(history.boundary_json).source_end_seq,10)
  assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs').get<any>()!.dsh_session_id,'source-first')
  assert.throws(()=>f.db.prepare("UPDATE dsh_task_source_history SET reason='rewrite'").run(),/immutable/);noDerived(f)
 }finally{await finalizer.dispose();f.db.close()}
})

test('active model switch fixes the observed source end and restart never revives automatic memory extraction',async()=>{
 const f=setup();let finalizer=worker(f)
 try{
  bind(f);const task=readTaskSnapshot(f.db,f.identity)
  recordTaskEvidence(f.db,task,{ref:'stopped',kind:'stopped',generation:task.generation,verified:true})
  const input={sessionId:'source-second',operationId:'switch',expectedRevision:task.revision,expectedGeneration:task.generation,reason:'Switch model',evidence:['stopped']}
  assert.throws(()=>transferTaskOwner(f.db,task,{...input,evidence:['model-claimed-stop']}),/Stop current task execution/)
  transferTaskOwner(f.db,task,{...input,sourceEndSeq:5})
  const history=f.db.prepare('SELECT * FROM dsh_task_source_history').get<any>()!;assert.equal(JSON.parse(history.boundary_json).source_end_seq,5)
  await finalizer.dispose();finalizer=worker(f);await finalizer.start();await finalizer.whenIdle();bind(f,'source-second')
  assert.equal(f.db.prepare('SELECT dsh_session_id FROM dsh_run_log_boundaries').get<any>()!.dsh_session_id,'source-second')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get<any>()!.n,0);noDerived(f);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{await finalizer.dispose();f.db.close()}
})

test('confirmed wait/Ignore retains its host stop proof and outcome without approving memory',async()=>{
 for(const operation of ['wait','ignore'] as const)for(const outcome of ['active','cancelled'] as const){
  const f=setup(),finalizer=worker(f)
  try{
   bind(f);const task=readTaskSnapshot(f.db,f.identity),stopping=requestTaskStop(f.db,task,{operation,operationId:'ignore',expectedRevision:task.revision,reason:'User explicitly stops this task'})
   if(outcome==='cancelled')f.db.prepare("UPDATE ledger_runs SET status='cancelled' WHERE run_id=?").run(f.runId)
   const current=readTaskSnapshot(f.db,stopping);recordTaskEvidence(f.db,current,{ref:'stop-receipt',kind:'stopped',generation:current.generation,verified:true})
   const ignored=confirmTaskStop(f.db,current,{operationId:'ignore',expectedRevision:current.revision,evidenceRef:'stop-receipt'})
   assert.throws(()=>scheduleStoppedTaskFinalization(f.db,ignored,{evidenceRef:'model-claimed-stop',sourceEndSeq:5}),/host stop receipt/)
   withImmediateTransaction(f.db,()=>assert.equal(scheduleStoppedTaskFinalization(f.db,ignored,{evidenceRef:'stop-receipt',sourceEndSeq:5}),false))
   finalizer.kick();await finalizer.whenIdle();assert.deepEqual(readTaskSnapshot(f.db,ignored),ignored);assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get<any>()!.status,outcome)
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get<any>()!.n,0);noDerived(f)
  }finally{await finalizer.dispose();f.db.close()}
 }
})

test('Done callback requires verified current revision but completion alone never approves a memory proposal',async()=>{
 const f=setup(),finalizer=worker(f)
 try{
  bind(f);const task=readTaskSnapshot(f.db,f.identity);recordTaskEvidence(f.db,task,{ref:'real-verification',kind:'verification',generation:task.generation,verified:true})
  const done=transitionTask(f.db,task,{operation:'complete',operationId:'complete',expectedRevision:task.revision,evidence:['real-verification'],reason:'Verified observation'})
  const input={expectedRevision:done.revision,expectedGeneration:done.generation,sourceEndSeq:5}
  assert.throws(()=>scheduleCompletedTaskFinalization(f.db,done,{...input,expectedGeneration:task.generation}),/revision and generation/)
  withImmediateTransaction(f.db,()=>assert.equal(scheduleCompletedTaskFinalization(f.db,done,input),false));finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual(readTaskSnapshot(f.db,done),done)
  const resumed=transitionTask(f.db,done,{operation:'resume',operationId:'resume',expectedRevision:done.revision,explicit:true,reason:'Explicit new execution'},{sourceEndSeq:5})
  assert.equal(resumed.state,'Working');assert.throws(()=>scheduleCompletedTaskFinalization(f.db,done,input),/revision and generation/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get<any>()!.n,0);noDerived(f)
 }finally{await finalizer.dispose();f.db.close()}
})
