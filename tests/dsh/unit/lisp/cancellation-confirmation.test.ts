import test from 'node:test'
import assert from 'node:assert/strict'
import * as manager from '../../../../src/dsh/lisp/manager.js'

type Confirm = (id: string, read: (cancel: boolean, signal: AbortSignal) => Promise<unknown>) => Promise<void>
function confirmation(): Confirm {
  const fn = (manager as unknown as {confirmOwnedJobStop?: Confirm}).confirmOwnedJobStop
  assert.equal(typeof fn, 'function', 'owned cancellation needs bounded terminal confirmation, not a started acknowledgement')
  return fn!
}
const receipt = (state: string, generation = 'original', operationId = 'owned-job') => ({receipt:{state,processStopped:state==='completed'||state==='cancelled',generation,operationId,runId:'task',sessionId:'session'}})
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve} }

test('cancel waits for actual terminal evidence and cancels the exact operation only once', async t => {
  const confirm=confirmation();t.mock.timers.enable({apis:['setTimeout']})
  const entered=deferred(), calls:boolean[]=[];let completed=false
  const pending=confirm('owned-job',async cancel=>{calls.push(cancel);if(calls.length===1){entered.resolve();return receipt('started')}return receipt('completed')}).then(()=>{completed=true})
  await entered.promise;await Promise.resolve();await Promise.resolve()
  assert.equal(completed,false,'a started acknowledgement is not evidence of stop')
  t.mock.timers.tick(25);await pending
  assert.deepEqual(calls,[true,false]);assert.equal(completed,true)
})
for (const state of ['unknown','missing','failed']) test(`unconfirmed ${state} result cannot release the owned job`,async()=>{
  await assert.rejects(confirmation()('owned-job',async()=>receipt(state)),{code:'STOP_UNCONFIRMED'})
})
test('a different operation cannot satisfy cancellation',async()=>{
  await assert.rejects(confirmation()('owned-job',async()=>receipt('completed','original','other-job')),{code:'STOP_UNCONFIRMED'})
})
test('a newer generation cannot satisfy an older pending cancellation',async t=>{
  const confirm=confirmation();t.mock.timers.enable({apis:['setTimeout']});const entered=deferred();let calls=0
  const pending=confirm('owned-job',async()=>{calls++;if(calls===1){entered.resolve();return receipt('started')}return receipt('completed','new-generation')})
  const rejected=assert.rejects(pending,{code:'STOP_UNCONFIRMED'})
  await entered.promise;await Promise.resolve();await Promise.resolve();t.mock.timers.tick(25);await rejected;assert.equal(calls,2)
})
test('a hung result adapter is bounded and its observation signal is aborted',async t=>{
  const confirm=confirmation();t.mock.timers.enable({apis:['setTimeout']});let signal:AbortSignal|undefined
  const pending=confirm('owned-job',async(_cancel,current)=>{signal=current;return new Promise(()=>{})})
  const rejected=assert.rejects(pending,{code:'STOP_UNCONFIRMED'});t.mock.timers.tick(5000);await rejected;assert.equal(signal?.aborted,true)
})
test('an adapter failure remains the primary cause rather than a fabricated terminal receipt',async()=>{
  const error=new Error('owner no longer matches')
  await assert.rejects(confirmation()('owned-job',async()=>{throw error}),cause=>cause===error)
})

test('completed orchestration without observed process stop cannot release a job',async()=>{
  await assert.rejects(confirmation()('owned-job',async()=>({receipt:{...receipt('completed').receipt,processStopped:false}})),{code:'STOP_UNCONFIRMED'})
})
