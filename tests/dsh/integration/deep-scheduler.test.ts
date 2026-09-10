import assert from 'node:assert/strict'
import { writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DeepScheduler } from '../../../src/deep-thinker/scheduler.js'
import { DeepReadPort, readDeepFile } from '../../../src/deep-thinker/read-port.js'
import { DeepStore, assertDeepAuthority } from '../../../src/deep-thinker/store.js'
import { changedSources, evidenceReceipt } from '../../../src/deep-thinker/evidence.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { deepFixture, deferred } from '../helpers/deep-fixture.js'
import type { Candidate } from '../../../src/deep-thinker/core/contracts.js'

const candidate: Candidate = {kind:'candidate',answer:'A bounded answer',evidence:[],assumptions:[],unresolved:[]}
for (const concurrency of [1,3]) test(`Deep recursive aggregation at concurrency ${concurrency} preserves an independent leaf during local replan`, async () => {
  const fixture = await deepFixture({maxConcurrentAgents:concurrency})
  const { store, state } = fixture
  const jobs: {question:string;role:string}[] = [], both = deferred<void>()
  let active = 0, peak = 0, leaves = 0
  const scheduler = new DeepScheduler(store, { execute: async (authority, job, state) => {
    active++; peak=Math.max(peak,active)
    try {
      const node = state.nodes.find(n => n.id === job.nodeId)!, question = node.question
      jobs.push({question,role:job.role})
      const reservation = await store.reserveRequest(authority,100)
      await store.settleRequest(state.runId,reservation,50,true)
      if (job.role === 'planner') {
        if (node.parentId === null || question === 'part a' && node.replans > 0) return {kind:'decompose',synthesis:'Combine the checked answers',children:(node.parentId === null ? ['part a','part b'] : ['nested a','nested b']).map((q,i)=>({key:`child-${i}`,question:q,requirementIds:node.requirementIds,acceptanceCriteria:['Answer this part'],assumptions:[],dependsOn:[]}))}
        return {kind:'leaf',reason:'A bounded problem'}
      }
      if (job.role === 'critic') return {kind:'supported',requirementIds:node.requirementIds,reason:'Requirements covered',evidence:[]}
      if (job.role === 'solver' && question.startsWith('part ')) {
        if (concurrency > 1) { leaves++; if (leaves === 2) both.resolve(); await both.promise }
        if (question === 'part a') return {kind:'needs-decomposition',reason:'Two smaller checks are necessary'}
      }
      return candidate
    } finally { active-- }
  } }, async () => {})
  try {
    await scheduler.start(state.runId); await scheduler.idle(state.runId)
    const result = await store.read(state.runId)
    assert.equal(result.phase,'answered',JSON.stringify(result))
    assert.equal(result.nodes.length,5)
    assert.equal(jobs.filter(j=>j.question==='part b'&&j.role==='solver').length,1)
    assert.equal(result.nodes.every(n=>n.status==='accepted'&&n.receipt!==null),true)
    assert.equal(peak,concurrency===1?1:2)
  } finally { await scheduler.dispose(); await fixture.close() }
})
test('zero budget produces a durable partial report without invoking an agent', async () => {
  const fixture = await deepFixture({maxTotalTokens:0})
  const scheduler = new DeepScheduler(fixture.store,{execute:async()=>{throw new Error('Must not execute')}},async()=>{})
  try { await scheduler.start(fixture.state.runId); await scheduler.idle(fixture.state.runId)
    assert.equal((await fixture.store.read(fixture.state.runId)).phase,'partial')
    const reports = await fixture.store.pending('parent'); assert.ok(reports.some(r=>r.kind==='report'&&r.payload_json.includes('未解決')))
  } finally { await scheduler.dispose(); await fixture.close() }
})
test('unknown use remains reserved, cancelled responses cannot commit, and resume requires explicit recovery', async () => {
  const fixture = await deepFixture(), started=deferred<void>()
  let authority: Parameters<DeepReadPort['execute']>[0] | undefined
  const scheduler = new DeepScheduler(fixture.store,{execute:async(a,_job,state,signal)=>{
    authority=a
    const id=await fixture.store.reserveRequest(a,200)
    await fixture.store.settleRequest(state.runId,id,undefined,false)
    started.resolve()
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
    return {kind:'leaf',reason:'A late result'}
  }},async()=>{})
  try {
    await scheduler.start(fixture.state.runId); await started.promise
    await scheduler.pause(fixture.state.runId,'Pause requested')
    const state=await fixture.store.read(fixture.state.runId)
    assert.equal(state.phase,'paused'); assert.equal(state.usage.reservedTokens,200); assert.equal(state.nodes[0]!.status,'planning')
    await assert.rejects(fixture.store.claim(state.runId,'replacement'),/不明/u)
    await assert.rejects(fixture.store.transaction(db=>assertDeepAuthority(db,state,authority!,1000)),/失効/u)
    await scheduler.cancel(state.runId); assert.equal((await fixture.store.read(state.runId)).phase,'cancelled')
  } finally { await scheduler.dispose(); await fixture.close() }
})
test('Deep and ordinary intake use the same atomic Session owner', async () => {
  const fixture=await deepFixture()
  try {
    await assert.rejects(prepareAgentTask(fixture.db,{requestId:'normal-request',task:'Review source',cwd:fixture.root,dshSessionId:'parent',sessionOwnership:true,executionSelection:true,skillDiscoveryMode:'off'}),/別のタスク|未完了/u)
    const second=new DeepStore(fixture.runtime,()=>1000)
    const claims=await Promise.allSettled([fixture.store.claim(fixture.state.runId,'one'),second.claim(fixture.state.runId,'two')])
    assert.equal(claims.filter(c=>c.status==='fulfilled').length,1)
    assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM ledger_runs').get<{count:number}>()!.count,1)
  } finally { await fixture.close() }
})
test('read artifacts bind exact content and reject traversal, symlinks and source changes', async () => {
  const fixture=await deepFixture(), {store,state,root}=fixture
  await writeFile(join(root,'source.txt'),'Line one\nLine two\n')
  await symlink('source.txt',join(root,'link.txt'))
  const scheduler=new DeepScheduler(store,{execute:async(authority,job,current)=>{
    if(job.role==='planner') return {kind:'leaf',reason:'Read source'}
    if(job.role==='critic') return {kind:'supported',requirementIds:['request'],reason:'Checked source',evidence:current.nodes[0]!.candidate!.evidence}
    const result=await new DeepReadPort(store).execute(authority,'deep_read_file',{path:'source.txt'},new AbortController().signal) as {artifactId:string}
    return {...candidate,evidence:[{artifactId:result.artifactId,quote:'Line two'}]}
  }},async()=>{})
  try {
    await assert.rejects(readDeepFile(root,'../outside'),/workspace/u)
    await assert.rejects(readDeepFile(root,'link.txt'),/symbolic/u)
    await scheduler.start(state.runId); await scheduler.idle(state.runId)
    assert.equal((await store.read(state.runId)).phase,'answered')
    const artifacts=await store.artifacts(state.runId); assert.equal(artifacts.length,1)
    assert.throws(()=>evidenceReceipt({...candidate,evidence:[{artifactId:'invented'}]},null,artifacts,'input'),/outside/u)
    await writeFile(join(root,'source.txt'),'Changed')
    assert.deepEqual(await changedSources(root,artifacts),[state.nodes[0]!.id])
  } finally {await scheduler.dispose(); await fixture.close()}
})
