import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { deepFixture, deferred } from '../helpers/deep-fixture.js'
import { DeepScheduler } from '../../../src/deep-thinker/scheduler.js'
import { DeepReportPort } from '../../../src/deep-thinker/report-port.js'
import { DeepMemoryFinalizer } from '../../../src/deep-thinker/memory-finalizer.js'
import { deepQuestion } from '../../../src/deep-thinker/configuration.js'
import { abortableStream } from '../../../src/deep-thinker/abortable-stream.js'

test('independent OS processes cannot simultaneously own a Deep run', {timeout:20_000}, async () => {
  const f=await deepFixture()
  const children=[1,2].map(i=>fork(new URL('../helpers/deep-claim-process.ts',import.meta.url),[f.dbPath,f.state.runId,`process-${i}`],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']}))
  try {
    await Promise.all(children.map(async child=>assert.deepEqual((await once(child,'message'))[0],{ready:true})))
    const replies=children.map(child=>once(child,'message'));children.forEach(child=>child.send('claim'))
    const outcomes=await Promise.all(replies)
    assert.equal(outcomes.filter(([message])=>message.claimed).length,1)
    assert.match(outcomes.find(([message])=>!message.claimed)![0].error,/別の実行プロセス/u)
  } finally {children.forEach(child=>child.kill());await f.close()}
})
test('foreign live ownership cannot be cancelled and an expired owner cannot accept a response', async()=>{
  const f=await deepFixture(), scheduler=new DeepScheduler(f.store,{execute:async()=>undefined},async()=>{})
  try {
    const state=await f.store.claim(f.state.runId,'foreign-process')
    await assert.rejects(scheduler.cancel(state.runId),/別の実行プロセス/u)
    assert.equal((await f.store.read(state.runId)).phase,'running')
    f.advance(45_001)
    await scheduler.cancel(state.runId)
    assert.equal((await f.store.read(state.runId)).phase,'cancelled')
  } finally {await scheduler.dispose();await f.close()}
})
test('intent compare-and-swap and command replay preserve bound input and do not duplicate a run', async()=>{
  const f=await deepFixture()
  try {
    const one=(await f.store.intent('parent'))!, two=structuredClone(one)
    await f.store.transaction(db=>{one.problem='retained';f.store.saveIntentInTransaction(db,one)})
    await assert.rejects(f.store.transaction(db=>{two.problem='stale';f.store.saveIntentInTransaction(db,two)}),/別の処理/u)
    assert.equal((await f.store.replayedCommand('parent','start-command',f.intent.task,false))?.runId,f.state.runId)
    await assert.rejects(f.store.replayedCommand('parent','start-command','changed',false),/異なる入力/u)
  } finally {await f.close()}
})
test('uncertain completed attempt is reconciled once without resending and rejects a later requirement revision', async()=>{
  const f=await deepFixture(), started=deferred<void>()
  let attempt=''
  const scheduler=new DeepScheduler(f.store,{execute:async(authority,_job,state,signal)=>{
    attempt=authority.attemptId
    await f.store.reserveRequest(authority,100)
    started.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
    return {kind:'leaf',reason:'completed in the child record'}
  }},async()=>{})
  try {
    await scheduler.start(f.state.runId);await started.promise;await scheduler.pause(f.state.runId,'recover')
    await scheduler.reconcile(attempt,{kind:'leaf',reason:'completed in the child record'})
    await scheduler.reconcile(attempt,{kind:'blocked',reason:'duplicate must not apply'})
    const recovered=await f.store.read(f.state.runId)
    assert.equal(recovered.nodes[0]!.status,'ready');assert.equal(recovered.usage.requests,1);assert.equal(recovered.usage.tokens,100)
    await f.store.mutate(f.state.runId, (state,db)=>{state.requirementRevision++;db.prepare("UPDATE dsh_deep_attempts SET status='uncertain' WHERE attempt_id=?").run(attempt)})
    await assert.rejects(scheduler.reconcile(attempt,{kind:'leaf',reason:'stale'}),/identity changed/u)
  } finally {await scheduler.dispose();await f.close()}
})
test('report delivery survives disconnect and acknowledges the exact Session and report once',async()=>{
  const f=await deepFixture({maxTotalTokens:0}), events:any[]=[]
  const scheduler=new DeepScheduler(f.store,{execute:async()=>undefined},async()=>{})
  const session={id:'parent',snapshotEvents:()=>events,append:()=>{throw new Error('Reports must not write unknown native events')}}
  const reports=new DeepReportPort(f.store,{get:()=>session,flush:async()=>{}})
  try {
    await f.store.database(db=>db.prepare("UPDATE dsh_deep_outbox SET status='delivered'").run())
    await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId)
    await reports.deliver({id:'parent-agent',session} as never)
    const first=await reports.snapshot('parent'), second=await reports.snapshot('parent')
    assert.deepEqual(first,second)
    const report=first.find(item=>item.kind==='report')!
    assert.equal(report.delivered,false)
    await assert.rejects(reports.acknowledge('other-session',[report.id]),/identity mismatch/u)
    assert.equal((await reports.snapshot('parent')).find(item=>item.kind==='report')!.delivered,false)
    await reports.acknowledge('parent',first.map(item=>item.id))
    await reports.acknowledge('parent',first.map(item=>item.id))
    assert.equal((await reports.snapshot('parent')).find(item=>item.kind==='report')!.delivered,true)
    assert.equal(events.length,0)
  }finally{await scheduler.dispose();await f.close()}
})
test('expired Deep memory claims become uncertain without an automatic model resend',async()=>{
  const f=await deepFixture({maxTotalTokens:0}), scheduler=new DeepScheduler(f.store,{execute:async()=>undefined},async()=>{})
  try {
    await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId)
    await f.store.database(db=>db.prepare("UPDATE dsh_deep_finalizations SET status='processing',process_id='crashed',lease_until=999").run())
    const finalizer=new DeepMemoryFinalizer(f.store,{stream:()=>{throw new Error('must not resend')}})
    assert.equal(await finalizer.processNext(),false)
    assert.equal(await f.store.database(db=>db.prepare('SELECT status FROM dsh_deep_finalizations').get<{status:string}>()!.status),'uncertain')
  }finally{await scheduler.dispose();await f.close()}
})
test('numeric custom budget input is literal and non-cooperative streams can be aborted',async()=>{
  const result=await deepQuestion({ask:async()=>({answers:[{id:'limit',selected:[],custom:'0'}]})},{} as never,new AbortController().signal,'limit','Limit',['4096'])
  assert.equal(result,'0')
  const abort=new AbortController(), entered=deferred<void>()
  const stream=abortableStream({[Symbol.asyncIterator]:()=>({next:()=>{entered.resolve();return new Promise<IteratorResult<unknown>>(()=>{})}})},abort.signal)[Symbol.asyncIterator]()
  const pending=stream.next();await entered.promise;abort.abort(new Error('stop now'))
  await assert.rejects(pending,/stop now/u)
})
