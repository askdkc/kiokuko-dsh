import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture,createRun,seed,NOW} from '../evolution/fixture.js'
import {DeepScheduler} from '../../../../src/deep-thinker/scheduler.js'
import {DeepStore,IntentSchema} from '../../../../src/deep-thinker/store.js'
import {initialDeepState} from '../../../../src/deep-thinker/initial-state.js'
import {DeepConfigurationSchema,DEEP_ROLES} from '../../../../src/deep-thinker/core/contracts.js'
import {DeepMemoryFinalizer,DeepFinalizationSourceSchema} from '../../../../src/deep-thinker/memory-finalizer.js'
import {withImmediateTransaction} from '../../../../src/db/transaction.js'
import {excludeCapture,abortCapture,watchCapture} from '../../../../src/memory/capture-policy.js'
import {EvolutionWorker} from '../../../../src/memory/evolution/worker.js'
import {canonicalContentHash,canonicalJson} from '../../../../src/serialization/validate.js'
import {digest,EVOLUTION_VERSION,MemoryEvolutionConfig} from '../../../../src/memory/evolution/contracts.js'

test('capture exclusion fences pending and historical dispatched Evolution claims without new dispatch',async()=>{
 for(const phase of ['before','after']){
  const f=fixture();const episodes=['one','two','three'].map(id=>seed(f.db,id));let calls=0
  const controller=new AbortController(),unwatch=watchCapture('project:test','session-one',controller)
  // Seed both pending and previously dispatched legacy v1 state explicitly.
  // Current workers must not dispatch either state after retirement.
  const input=canonicalJson(episodes),inputDigest=digest({version:EVOLUTION_VERSION,kind:'positive',episodes})
  f.db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest,episodes[0]!.workspace,'three',episodes[0]!.signature,'positive',input,
      canonicalJson(episodes.map(e=>e.evidenceDigest)),inputDigest,canonicalJson({provider:'fixture',model:'fixed',sessionId:'session-three',contextWindow:100000}),EVOLUTION_VERSION,NOW,NOW)
  if(phase==='after'){
    f.db.prepare("UPDATE memory_evolution_jobs SET state='processing',attempts=1,claim_token='historical-claim',lease_until=? WHERE id=?").run('2099-01-01T00:00:00.000Z',inputDigest)
    f.db.prepare("INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,outcome,created_at) VALUES('historical-call',?,'three','project:test',?,?,'uncertain',?)").run(inputDigest,NOW.slice(0,10),Buffer.byteLength(input),NOW)
  }
  const accounting=f.db.prepare('SELECT * FROM memory_evolution_calls').all()
  const exclude=()=>{withImmediateTransaction(f.db,()=>excludeCapture(f.db,'project:test','session-one','excluded','capture_excluded',NOW));abortCapture('project:test','session-one')}
  const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream(){calls++;yield {}}}})
  try{
   if(phase==='before')exclude()
   worker.kick();await worker.whenIdle();if(phase==='after')exclude()
   worker.kick();await worker.whenIdle();assert.equal(calls,0)
   assert.equal(controller.signal.aborted,true)
   assert.equal(f.db.prepare('SELECT claim_token FROM memory_evolution_jobs').get()?.claim_token,null)
   assert.deepEqual(f.db.prepare('SELECT * FROM memory_evolution_calls').all(),accounting)
   assert.equal(f.db.prepare('SELECT reason FROM memory_evolution_jobs').get()?.reason,'capture_excluded')
   assert.equal(f.db.prepare("SELECT count(*) AS n FROM memory_derivations WHERE kind='positive'").get()?.n,0)
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_episodes').get()?.n,episodes.length)
  }finally{unwatch();await worker.dispose();f.db.close()}
 }
})
test('capture exclusion invalidates a historical Deep memory job without dispatching or rewriting Deep work',async()=>{
 const f=fixture(),runId='historical-deep',workspace='deep-fixture',sessionId=`session-${runId}`
 createRun(f.db,runId,workspace)
 const configuration=DeepConfigurationSchema.parse({roles:Object.fromEntries(DEEP_ROLES.map(role=>[role,{provider:'fixture',model:role}])),budget:{maxTotalTokens:0}})
 const intent=IntentSchema.parse({revision:1,startId:'historical-intent',workspace,sessionId,rootPath:process.cwd(),commandId:'historical-command',messageId:'historical-message',
   task:'Historical bounded analysis',status:'accepted',runId,configuration,messages:[],problem:''})
 const state=initialDeepState(intent,runId,'');state.revision=1
 const {nodes,...header}=state
 const store=new DeepStore(f.runtime),scheduler=new DeepScheduler(store,{execute:async()=>{throw Error('zero-budget Deep work must not dispatch')}},async()=>{})
 try{
  // Seed a valid existing Deep run independently of current admission. The real
  // scheduler must close it without creating a new memory finalizer.
  f.db.prepare(`INSERT INTO dsh_deep_intents(start_id,workspace,dsh_session_id,command_id,command_digest,message_id,input_digest,state_json,revision,status,run_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'accepted',?,0)`).run(intent.startId,workspace,sessionId,intent.commandId,canonicalContentHash(intent.task),intent.messageId,canonicalContentHash(intent.task),JSON.stringify(intent),1,runId)
  f.db.prepare('INSERT INTO dsh_deep_runs(run_id,start_id,workspace,dsh_session_id,phase,revision,state_json) VALUES(?,?,?,?,?,?,?)').run(runId,intent.startId,workspace,sessionId,state.phase,1,JSON.stringify(header))
  for(const node of nodes)f.db.prepare('INSERT INTO dsh_deep_nodes(run_id,node_id,revision,state_json) VALUES(?,?,?,?)').run(runId,node.id,node.revision,JSON.stringify(node))
  f.db.prepare("INSERT INTO dsh_execution_owners(dsh_session_id,workspace,mode,start_id,run_id) VALUES(?,?,'deep-thinker',?,?)").run(sessionId,workspace,intent.startId,runId)
  await scheduler.start(runId);await scheduler.idle(runId)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_deep_finalizations').get()?.n,0,'current scheduler does not create memory extraction jobs')
  const before=await store.read(runId)
  assert.equal(before.phase,'partial')
  const ledger=f.db.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get(runId)
  const source=DeepFinalizationSourceSchema.parse({kind:'deep-report',workspace,sessionId,configuration,
    report:{reportId:'historical-report',runId,revision:before.revision,phase:before.phase,text:intent.task,summary:'Historical source fixture',protocolVersion:state.protocolVersion},accepted:[]})
  f.db.prepare("INSERT INTO dsh_deep_finalizations(run_id,source_json,status) VALUES(?,?,'pending')").run(runId,JSON.stringify(source))
  withImmediateTransaction(f.db,()=>excludeCapture(f.db,workspace,sessionId,'excluded','capture_excluded',NOW))
  assert.equal(f.db.prepare('SELECT status FROM dsh_deep_finalizations').get()?.status,'skipped')
  const finalizer=new DeepMemoryFinalizer(store,{stream:()=>{throw new Error('excluded job must not stream')}})
  assert.equal(await finalizer.processNext(),false)
  assert.deepEqual(await store.read(runId),before)
  assert.deepEqual(f.db.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get(runId),ledger)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{await scheduler.dispose();f.db.close()}
})
