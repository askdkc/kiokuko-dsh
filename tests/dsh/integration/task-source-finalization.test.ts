import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, NOW } from './evolution/fixture.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { DshMemoryFinalizer, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import { bindTaskRepository, transitionTask, readTaskSnapshot, recordTaskEvidence, transferTaskOwner, requestTaskStop, confirmTaskStop } from '../../../src/dsh/task-state.js'
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
function log(start:number,text:string):DshLogEvent[]{return [
 {seq:start,time:start,type:'turn/start',data:{turn:1}},
 {seq:start+1,time:start+1,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user'},content:[{type:'text',text}]}},
 {seq:start+2,time:start+2,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}},
 {seq:start+3,time:start+3,type:'request/context',data:{contextWindow:100000}},
 {seq:start+4,time:start+4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
]}
function result(request:any) {const e=JSON.parse(request.messages.at(-1).content[0].text).reconciliation.evidence.find((e:any)=>e.eligibleForNewMemory);return {schemaVersion:4,memoryOperations:[{action:'add',kind:'preference',title:e.text,body:e.text,evidenceIds:[e.id],claims:[{id:'statement',text:e.text,evidence:[{evidenceId:e.id,supportingText:e.text}]}]}]}}
function close(f:ReturnType<typeof setup>,finalizer:DshMemoryFinalizer,sessionId:string,end:number) {withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.runId);finalizer.scheduleInTransaction(f.db,{runId:f.runId,workspace:f.workspace,dshSessionId:sessionId,sourceEndSeq:end})})}

test('explicit same-session resume archives completed source and finalizes its new range independently',async()=>{
 const f=setup(), events=[...log(1,'Use concise Japanese replies.'),...log(6,'Include the observed test outcome.')]
 const finalizer=new DshMemoryFinalizer({runtime:f.runtime,autoGlobalizationEnabled:false,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events}}},llm:{async *stream(req){yield {type:'text-delta',text:JSON.stringify(result(req))};yield {type:'finish',reason:{kind:'stop'}}}}})
 try {
  await finalizer.start();await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:1,sourceStartTurn:1})
  close(f,finalizer,f.identity.sessionId,5);finalizer.kick();await finalizer.whenIdle()
  assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get()!.status,'completed')
  const prior=f.db.prepare('SELECT * FROM dsh_memory_finalizations').get()!, entry=f.db.prepare('SELECT entry_id FROM dsh_memory_finalization_entries').get()!.entry_id
  const task=readTaskSnapshot(f.db,f.identity)
  transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume',expectedRevision:task.revision,reason:'Explicit continuation',explicit:true})
  const history=f.db.prepare('SELECT finalization_json FROM dsh_task_source_history').get<{finalization_json:string}>()!
  assert.deepEqual(JSON.parse(history.finalization_json),{...prior});assert.equal(f.db.prepare('SELECT entry_id FROM dsh_task_source_entries').get()!.entry_id,entry)
  await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:6,sourceStartTurn:2})
  close(f,finalizer,f.identity.sessionId,10);finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual({...f.db.prepare('SELECT status,source_epoch,source_start_seq,source_end_seq FROM dsh_memory_finalizations').get()},{status:'completed',source_epoch:2,source_start_seq:6,source_end_seq:10})
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()!.n,2)
  assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs').get()!.dsh_session_id,f.identity.sessionId)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{await finalizer.dispose();f.db.close()}
})

test('owner handoff preserves original provenance, rebinds review source and refuses old async finalizer commit',async()=>{
 const f=setup();let release!:()=>void, entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
 let calls=0
 const finalizer=new DshMemoryFinalizer({runtime:f.runtime,autoGlobalizationEnabled:false,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events:log(1,id==='source-first'?'Old preference.':'New preference.')}}},llm:{async *stream(req){if(!req.system?.includes('Override the legacy memory output format')){yield {type:'finish',reason:{kind:'stop'}};return}if(++calls===1){entered();await hold}yield {type:'text-delta',text:JSON.stringify(result(req))};yield {type:'finish',reason:{kind:'stop'}}}}})
 try {
  await finalizer.start();await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:1,sourceStartTurn:1})
  close(f,finalizer,f.identity.sessionId,5);finalizer.kick();await enteredPromise
  const task=readTaskSnapshot(f.db,f.identity)
  transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume',expectedRevision:task.revision,reason:'Resume',explicit:true})
  const current=readTaskSnapshot(f.db,f.identity)
  recordTaskEvidence(f.db,f.identity,{ref:'observed-stop',kind:'stopped',generation:current.generation,verified:true})
  transferTaskOwner(f.db,f.identity,{sessionId:'source-second',operationId:'switch',expectedRevision:current.revision,expectedGeneration:current.generation,reason:'Model switch',evidence:['observed-stop']})
  await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:'source-second',sourceStartSeq:1,sourceStartTurn:1})
  admitReview(f.db,{workspace:f.workspace,sessionId:'source-second',runId:f.runId,sourceGeneration:'native-second',startSeq:1,endSeq:5})
  close(f,finalizer,'source-second',5);release();await finalizer.whenIdle();finalizer.kick();await finalizer.whenIdle()
  const row=f.db.prepare('SELECT status,dsh_session_id,source_epoch FROM dsh_memory_finalizations').get()!
  assert.equal(row.status,'completed');assert.equal(row.dsh_session_id,'source-second');assert.ok(Number(row.source_epoch)>1)
  assert.equal(calls,3,'old claim is discarded; archived source is reclaimed with a fresh nonce before the new source')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()!.n,2,'old and new source memories are each adopted once')
  assert.equal(f.db.prepare("SELECT json_extract(job_json,'$.status') AS status FROM dsh_task_source_finalizations WHERE source_epoch=1").get()!.status,'completed')
  assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs').get()!.dsh_session_id,'source-first')
  assert.equal(f.db.prepare('SELECT session_id FROM memory_review_states').get()!.session_id,'source-second')
  assert.throws(()=>f.db.prepare("UPDATE dsh_task_source_history SET reason='rewrite'").run(),/immutable/)
 }finally{release?.();await finalizer.dispose();f.db.close()}
})


test('active model switch fixes the old end sequence and processes both source segments after restart',async()=>{
 const f=setup()
 const factory=()=>new DshMemoryFinalizer({runtime:f.runtime,autoGlobalizationEnabled:false,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),
 sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events:log(1,id==='source-first'?'Keep original evidence.':'Report new evidence.')}}},
 llm:{async *stream(req){yield {type:'text-delta',text:JSON.stringify(result(req))};yield {type:'finish',reason:{kind:'stop'}}}}})
 let finalizer=factory()
 try{
  await finalizer.start();await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:1,sourceStartTurn:1})
  const task=readTaskSnapshot(f.db,f.identity)
  recordTaskEvidence(f.db,task,{ref:'stopped',kind:'stopped',generation:task.generation,verified:true})
  const input={sessionId:'source-second',operationId:'switch',expectedRevision:task.revision,expectedGeneration:task.generation,reason:'Switch model',evidence:['stopped']}
  assert.throws(()=>transferTaskOwner(f.db,task,input),/stopped log end/)
  transferTaskOwner(f.db,task,{...input,sourceEndSeq:5})
  assert.equal(f.db.prepare("SELECT json_extract(job_json,'$.outcome') AS outcome FROM dsh_task_source_finalizations").get()!.outcome,'interrupted')
  await finalizer.dispose();finalizer=factory();await finalizer.start();await finalizer.whenIdle()
  assert.equal(f.db.prepare("SELECT json_extract(job_json,'$.status') AS status FROM dsh_task_source_finalizations").get()!.status,'completed')
  await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:'source-second',sourceStartSeq:1,sourceStartTurn:1})
  close(f,finalizer,'source-second',5);finalizer.kick();await finalizer.whenIdle()
  assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get()!.status,'completed')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()!.n,2)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{await finalizer.dispose();f.db.close()}
})


test('confirmed wait/Ignore finalizes its stopped source without changing execution outcome or task generation',async()=>{
 for(const operation of ['wait','ignore'] as const)for(const outcome of ['active','cancelled'] as const){
 const f=setup(),finalizer=new DshMemoryFinalizer({runtime:f.runtime,autoGlobalizationEnabled:false,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),
 sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events:log(1,'Keep the reason work was stopped.')}}},
 llm:{async *stream(req){yield {type:'text-delta',text:JSON.stringify(result(req))};yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  await finalizer.start();await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:1,sourceStartTurn:1})
  const task=readTaskSnapshot(f.db,f.identity),stopping=requestTaskStop(f.db,task,{operation,operationId:'ignore',expectedRevision:task.revision,reason:'User explicitly stops this task'})
  if(outcome==='cancelled')f.db.prepare("UPDATE ledger_runs SET status='cancelled' WHERE run_id=?").run(f.runId)
  const current=readTaskSnapshot(f.db,stopping)
  recordTaskEvidence(f.db,current,{ref:'stop-receipt',kind:'stopped',generation:current.generation,verified:true})
  const ignored=confirmTaskStop(f.db,current,{operationId:'ignore',expectedRevision:current.revision,evidenceRef:'stop-receipt'})
  assert.throws(()=>scheduleStoppedTaskFinalization(f.db,ignored,{evidenceRef:'model-claimed-stop',sourceEndSeq:5}),/host stop receipt/)
  withImmediateTransaction(f.db,()=>assert.equal(scheduleStoppedTaskFinalization(f.db,ignored,{evidenceRef:'stop-receipt',sourceEndSeq:5}),true))
  finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual({...f.db.prepare('SELECT status,source_outcome FROM dsh_memory_finalizations').get()},{status:'completed',source_outcome:outcome==='active'?'interrupted':'cancelled'})
  assert.deepEqual(readTaskSnapshot(f.db,ignored),ignored)
  assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()!.status,outcome)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()!.n,1)
 }finally{await finalizer.dispose();f.db.close()}
 }
})


test('Done finalization requires the verified revision at native idle and refuses an obsolete callback',async()=>{
 const f=setup(),finalizer=new DshMemoryFinalizer({runtime:f.runtime,autoGlobalizationEnabled:false,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),
 sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events:log(1,'The requested observation was verified.')}}},
 llm:{async *stream(req){yield {type:'text-delta',text:JSON.stringify(result(req))};yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  await finalizer.start();await finalizer.bindRunStart({runId:f.runId,workspace:f.workspace,dshSessionId:f.identity.sessionId,sourceStartSeq:1,sourceStartTurn:1})
  const task=readTaskSnapshot(f.db,f.identity)
  recordTaskEvidence(f.db,task,{ref:'real-verification',kind:'verification',generation:task.generation,verified:true})
  const done=transitionTask(f.db,task,{operation:'complete',operationId:'complete',expectedRevision:task.revision,evidence:['real-verification'],reason:'Verified observation'})
  const input={expectedRevision:done.revision,expectedGeneration:done.generation,sourceEndSeq:5}
  assert.throws(()=>scheduleCompletedTaskFinalization(f.db,done,{...input,expectedGeneration:task.generation}),/revision and generation/)
  withImmediateTransaction(f.db,()=>assert.equal(scheduleCompletedTaskFinalization(f.db,done,input),true))
  finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual({...f.db.prepare('SELECT status,source_outcome FROM dsh_memory_finalizations').get()},{status:'completed',source_outcome:'completed'})
  assert.deepEqual(readTaskSnapshot(f.db,done),done)
  const resumed=transitionTask(f.db,done,{operation:'resume',operationId:'resume',expectedRevision:done.revision,explicit:true,reason:'Explicit new execution'})
  assert.equal(resumed.state,'Working')
  assert.throws(()=>scheduleCompletedTaskFinalization(f.db,done,input),/revision and generation/)
  assert.equal(f.db.prepare('SELECT 1 FROM dsh_memory_finalizations').get(),undefined)
 }finally{await finalizer.dispose();f.db.close()}
})
