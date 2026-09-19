import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture,seed,NOW} from '../evolution/fixture.js'
import {deepFixture} from '../../helpers/deep-fixture.js'
import {DeepScheduler} from '../../../../src/deep-thinker/scheduler.js'
import {DeepMemoryFinalizer} from '../../../../src/deep-thinker/memory-finalizer.js'
import {withImmediateTransaction} from '../../../../src/db/transaction.js'
import {excludeCapture,abortCapture} from '../../../../src/memory/capture-policy.js'
import {scheduleEvolution} from '../../../../src/memory/evolution/store.js'
import {EvolutionWorker} from '../../../../src/memory/evolution/worker.js'
import {MemoryEvolutionConfig} from '../../../../src/memory/evolution/contracts.js'

test('capture exclusion fences a mixed Evolution job before and after dispatch',async()=>{
 for(const phase of ['before','after']){
  const f=fixture();const episodes=['one','two','three'].map(id=>seed(f.db,id));let calls=0,signal:AbortSignal|undefined,sent!:()=>void
  const dispatched=new Promise<void>(r=>{sent=r})
  withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'three',{provider:'fixture',model:'fixed',contextWindow:100000},NOW))
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
