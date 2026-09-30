import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture,seed,NOW} from '../evolution/fixture.js'
import {deepFixture} from '../../helpers/deep-fixture.js'
import {DeepScheduler} from '../../../../src/deep-thinker/scheduler.js'
import {DeepMemoryFinalizer} from '../../../../src/deep-thinker/memory-finalizer.js'
import {withImmediateTransaction} from '../../../../src/db/transaction.js'
import {excludeCapture,abortCapture} from '../../../../src/memory/capture-policy.js'
import {EvolutionWorker} from '../../../../src/memory/evolution/worker.js'
import {canonicalJson} from '../../../../src/serialization/validate.js'
import {digest,EVOLUTION_VERSION,MemoryEvolutionConfig} from '../../../../src/memory/evolution/contracts.js'

test('capture exclusion fences a mixed Evolution job before and after dispatch',async()=>{
 for(const phase of ['before','after']){
  const f=fixture();const episodes=['one','two','three'].map(id=>seed(f.db,id));let calls=0,signal:AbortSignal|undefined,sent!:()=>void
  const dispatched=new Promise<void>(r=>{sent=r})
  // This cancellation race specifically covers a persisted legacy v1 job,
  // whose already-dispatched LLM request must still be fenced by capture.
  const input=canonicalJson(episodes),inputDigest=digest({version:EVOLUTION_VERSION,kind:'positive',episodes})
  f.db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest,episodes[0]!.workspace,'three',episodes[0]!.signature,'positive',input,
      canonicalJson(episodes.map(e=>e.evidenceDigest)),inputDigest,canonicalJson({provider:'fixture',model:'fixed',sessionId:'session-three',contextWindow:100000}),EVOLUTION_VERSION,NOW,NOW)
  const exclude=()=>{withImmediateTransaction(f.db,()=>excludeCapture(f.db,'project:test','session-one','excluded','capture_excluded',NOW));abortCapture('project:test','session-one')}
  const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream(request){calls++;signal=request.signal;sent();await new Promise(()=>{});yield {}}}})
  try{
   if(phase==='before')exclude()
   worker.kick();if(phase==='after'){await dispatched;exclude()}
   await worker.whenIdle();assert.equal(calls,phase==='after'?1:0)
   if(phase==='after')assert.equal(signal?.aborted,true)
   assert.equal(f.db.prepare('SELECT reason FROM memory_evolution_jobs').get()?.reason,'capture_excluded')
   assert.equal(f.db.prepare("SELECT count(*) AS n FROM memory_derivations WHERE kind='positive'").get()?.n,0)
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_episodes').get()?.n,episodes.length)
  }finally{await worker.dispose();f.db.close()}
 }
})
test('capture exclusion invalidates an existing Deep memory job without dispatching or cancelling Deep work',async()=>{
 const f=await deepFixture({maxTotalTokens:0}),scheduler=new DeepScheduler(f.store,{execute:async()=>undefined},async()=>{})
 try{
  await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId)
  const before=await f.store.read(f.state.runId)
  withImmediateTransaction(f.db,()=>excludeCapture(f.db,'deep-fixture','parent','excluded','capture_excluded',NOW))
  assert.equal(f.db.prepare('SELECT status FROM dsh_deep_finalizations').get()?.status,'skipped')
  const finalizer=new DeepMemoryFinalizer(f.store,{stream:()=>{throw new Error('excluded job must not stream')}})
  assert.equal(await finalizer.processNext(),false)
  assert.equal((await f.store.read(f.state.runId)).phase,before.phase)
 }finally{await scheduler.dispose();await f.close()}
})
