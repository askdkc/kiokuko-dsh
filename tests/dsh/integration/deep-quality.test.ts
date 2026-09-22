import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deepFixture, deferred } from '../helpers/deep-fixture.js'
import { qualityInput, qualityResponse } from '../helpers/deep-quality-fixture.js'
import { DeepScheduler } from '../../../src/deep-thinker/scheduler.js'
import { DeepReadPort } from '../../../src/deep-thinker/read-port.js'
import { DeepStateSchema, type DeepJob, type QualityReply } from '../../../src/deep-thinker/core/contracts.js'
import { deepReport } from '../../../src/deep-thinker/report.js'
import { DeepFinalizationSourceSchema } from '../../../src/deep-thinker/memory-finalizer.js'
const mode={reasoningMode:'quality' as const,alternativeSolver:{provider:'mock',model:'alternative'}}

for(const action of [undefined,'repair','synthesize'] as const) test(`quality executes isolated alternatives and ${action??'selection'} through the scheduler`,async()=>{
  const f=await deepFixture({},mode), jobs:DeepJob[]=[]
  const scheduler=new DeepScheduler(f.store,{execute:async(_authority,job)=>{jobs.push(job);return qualityResponse(qualityInput(job),{a:'WRONG',...(action?{action}:{})})}},async()=>{})
  try {
    await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId)
    const state=await f.store.read(f.state.runId), root=state.nodes[0]!
    assert.equal(state.phase,'answered',state.reason);assert.equal(root.candidate?.answer,'CORRECT')
    assert.equal(jobs.length,action?7:5);assert.equal(jobs[3]!.quality!.model.model,'alternative')
    assert.deepEqual(qualityInput(jobs[3]!).candidates,[]);assert.equal(jobs[3]!.prompt.includes('WRONG'),false)
    const receipt=root.receipt!;assert.equal(receipt.verifierVersion,2)
    assert.equal(root.quality!.correctionUsed,!!action);assert.equal(root.quality!.candidates.length,action?3:2)
    assert.equal(qualityInput(jobs[4]!).candidates.some((c:any)=>'model' in c||'attemptId'in c),false)
    const report=deepReport(state,[]);assert.match(report.text,/採用:/);assert.equal(report.protocolVersion,2)
    const source=f.db.prepare('SELECT source_json FROM dsh_deep_finalizations WHERE run_id=?').get<{source_json:string}>(state.runId)!
    DeepFinalizationSourceSchema.parse(JSON.parse(source.source_json))
    const attempts=f.db.prepare('SELECT model_json,job_json FROM dsh_deep_attempts WHERE run_id=?').all<{model_json:string;job_json:string}>(state.runId)
    assert.ok(attempts.every(a=>JSON.parse(a.job_json).model.model===JSON.parse(a.model_json).model))
  } finally {await scheduler.dispose();await f.close()}
})

test('agreement between two wrong answers never skips the critic or accepts the root',async()=>{
  const f=await deepFixture({},mode), phases:string[]=[]
  const scheduler=new DeepScheduler(f.store,{execute:async(_a,job)=>{phases.push(job.quality!.phase);return qualityResponse(qualityInput(job),{a:'WRONG',b:'WRONG',rejectConsensus:true})}},async()=>{})
  try {await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);const state=await f.store.read(f.state.runId);assert.equal(state.phase,'partial');assert.equal(phases.at(-1),'compare');assert.equal(state.nodes[0]!.receipt,null)} finally{await scheduler.dispose();await f.close()}
})

test('final review can retain a correct earlier candidate after repair introduces a regression',async()=>{
  const f=await deepFixture({},mode)
  const scheduler=new DeepScheduler(f.store,{execute:async(_a,job)=>{
    const input=qualityInput(job),reply=qualityResponse(input,{a:'CORRECT',b:'WRONG',action:'repair',selectFirst:true})
    if(input.phase==='repair'&&reply.kind==='quality-candidate') {
      reply.answer='REGRESSION';reply.findings.forEach(finding=>{finding.conclusion='REGRESSION'})
    }
    return reply
  }},async()=>{})
  try {
    await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId)
    const state=await f.store.read(f.state.runId),root=state.nodes[0]!
    assert.equal(state.phase,'answered',state.reason);assert.equal(root.candidate?.answer,'CORRECT')
    assert.equal(root.quality!.candidates.at(-1)!.reply.answer,'REGRESSION')
    assert.equal(root.receipt!.verifierVersion,2)
    if(root.receipt!.verifierVersion===2) assert.equal(root.receipt!.selectedCandidateId,root.quality!.candidates[0]!.id)
    assert.equal(root.quality!.review!.resolutions[0]!.status,'resolved')
    const report = deepReport(state, [])
    assert.match(report.text, /採用: 案1/)
    assert.match(report.text, /案3 .*: 矛盾あり/)
  }finally{await scheduler.dispose();await f.close()}
})

for(const defect of ['missing-matrix','invented-check','unresolved-issue','second-repair','unsupported-selection'] as const) test(`quality rejects ${defect}`,async()=>{
  const f=await deepFixture({},mode)
  const scheduler=new DeepScheduler(f.store,{execute:async(_a,job)=>{
    const input=qualityInput(job), reply=qualityResponse(input,{action:'repair'})
    if(reply.kind==='quality-review'&&input.phase==='final-review') {
      if(defect==='missing-matrix') reply.evaluations.pop()
      if(defect==='invented-check') reply.agreement[0]!.checkId='invented'
      if(defect==='unresolved-issue') reply.resolutions=[]
      if(defect==='second-repair') {reply.action='repair';reply.selectedCandidateId=null;reply.issues=[{checkId:input.checks[0].id,text:'Again'}]}
      if(defect==='unsupported-selection') reply.evaluations.forEach(e=>{e.verdict='unresolved'})
    }
    return reply
  }},async()=>{})
  try {await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);const state=await f.store.read(f.state.runId);assert.equal(state.phase,'partial');assert.equal(state.nodes[0]!.receipt,null);assert.equal(state.nodes[0]!.quality!.correctionUsed,true)} finally{await scheduler.dispose();await f.close()}
})

test('a quality candidate cannot cite a preceding candidate read, even within the same node',async()=>{
  const f=await deepFixture({},mode);await writeFile(join(f.root,'source.txt'),'Evidence belongs to the first attempt.\n')
  let stolen:string|undefined
  const scheduler=new DeepScheduler(f.store,{execute:async(authority,job,_state,signal)=>{
    const reply=qualityResponse(qualityInput(job))
    if(job.quality!.phase==='draft-a') {
      const read=await new DeepReadPort(f.store).execute(authority,'deep_read_file',{path:'source.txt'},signal) as {artifactId:string};stolen=read.artifactId
      assert.equal(reply.kind,'quality-candidate');if(reply.kind==='quality-candidate') reply.findings[0]!.evidence=[{artifactId:stolen}]
    }
    if(job.quality!.phase==='draft-b') {
      assert.ok(stolen);assert.equal(job.inputArtifactIds.includes(stolen),false)
      if(reply.kind==='quality-candidate') reply.findings[0]!.evidence=[{artifactId:stolen}]
    }
    return reply
  }},async()=>{})
  try {await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);const state=await f.store.read(f.state.runId);assert.equal(state.phase,'partial');assert.match(state.nodes[0]!.reason,/outside/);const artifacts=await f.store.artifacts(state.runId);assert.ok(artifacts[0]!.attemptId)}finally{await scheduler.dispose();await f.close()}
})

test('uncertain quality output reconciles once with the original phase, model and candidate identity',async()=>{
  const f=await deepFixture({},mode), started=deferred<void>(), finish=deferred<QualityReply>();let held:DeepJob|undefined
  const scheduler=new DeepScheduler(f.store,{execute:async(authority,job)=>{
    if(job.quality!.phase==='draft-b') {held=job;await f.store.reserveRequest(authority,100);started.resolve();return finish.promise}
    return qualityResponse(qualityInput(job))
  }},async()=>{})
  try {
    await scheduler.start(f.state.runId);await started.promise
    const paused=scheduler.pause(f.state.runId,'Interrupted');finish.resolve(qualityResponse(qualityInput(held!)));await paused
    const attempt=f.db.prepare("SELECT attempt_id FROM dsh_deep_attempts WHERE status='uncertain'").get<{attempt_id:string}>()!
    await scheduler.reconcile(attempt.attempt_id,qualityResponse(qualityInput(held!)))
    await scheduler.reconcile(attempt.attempt_id,qualityResponse(qualityInput(held!)))
    const state=await f.store.read(f.state.runId);assert.equal(state.nodes[0]!.quality!.candidates.length,2);assert.equal(state.nodes[0]!.quality!.phase,'compare');assert.equal(state.usage.tokens,100);assert.equal(state.usage.reservedTokens,0)
    DeepStateSchema.parse(state)
  }finally{await scheduler.dispose();await f.close()}
})

test('quality zero budget produces a durable partial result without workers',async()=>{
  const f=await deepFixture({maxAgentJobs:0},mode);let calls=0
  const scheduler=new DeepScheduler(f.store,{execute:async()=>{calls++;throw new Error('No calls')}},async()=>{})
  try{await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);assert.equal(calls,0);assert.equal((await f.store.read(f.state.runId)).phase,'partial')}finally{await scheduler.dispose();await f.close()}
})

test('quality decomposition inherits immutable check assignments and verifies parent composition',async()=>{
  const f=await deepFixture({},mode)
  const scheduler=new DeepScheduler(f.store,{execute:async(_a,job,state)=>{
    const input=qualityInput(job),reply=qualityResponse(input)
    if(reply.kind==='quality-plan'&&job.nodeId===state.nodes[0]!.id) {
      reply.decision='decompose';reply.children=reply.checks.map((check,i)=>({key:`child-${i}`,question:`Investigate ${check.key}`,requirementIds:[check.requirementId],acceptanceCriteria:[check.text],assumptions:[],dependsOn:[],checkKeys:[check.key]}))
    }
    return reply
  }},async()=>{})
  try {await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);const state=await f.store.read(f.state.runId);assert.equal(state.phase,'answered',state.reason);assert.equal(state.nodes.length,3);assert.equal(state.nodes[0]!.quality!.candidates.length,1);for(const child of state.nodes.slice(1)){assert.equal(child.quality!.checks.length,1);assert.deepEqual(child.quality!.checks,child.quality!.inheritedChecks)}}finally{await scheduler.dispose();await f.close()}
})

test('a rejected child assignment is not persisted or dispatched even when a sibling covers the gap', async () => {
  const f = await deepFixture({}, mode), jobs: DeepJob[] = []
  await f.store.mutate(f.state.runId, state => { state.nodes[0]!.requirementIds = ['R1', 'R2'] })
  const scheduler = new DeepScheduler(f.store, { execute: async (_authority, job) => {
    jobs.push(job)
    const reply = qualityResponse(qualityInput(job))
    if (reply.kind === 'quality-plan') {
      reply.decision = 'decompose'
      reply.children = ['R1', 'R2'].map((requirementId, index) => ({ key: `child-${index}`, question: `Investigate ${requirementId}`,
        requirementIds: index === 0 ? ['R1', 'R2'] : ['R2'], acceptanceCriteria: ['Verify assigned requirements'], assumptions: [], dependsOn: [],
        checkKeys: reply.checks.filter(check => check.requirementId === requirementId).map(check => check.key) }))
    }
    return reply
  } }, async () => {})
  try {
    await scheduler.start(f.state.runId); await scheduler.idle(f.state.runId)
    const state = await f.store.read(f.state.runId), root = state.nodes[0]!
    assert.equal(state.phase, 'partial'); assert.equal(state.nodes.length, 1)
    assert.equal(root.receipt, null); assert.equal(root.proposal, null); assert.deepEqual(root.quality!.checks, [])
    assert.match(root.reason, /check requirements/)
    assert.equal(jobs.length, 1)
    const attempts = f.db.prepare('SELECT status,result_json FROM dsh_deep_attempts WHERE run_id=?').all<{ status: string; result_json: string | null }>(state.runId)
    assert.deepEqual(attempts.map(row => ({ ...row })), [{ status: 'failed', result_json: null }])
  } finally { await scheduler.dispose(); await f.close() }
})

test('replanning retains unresolved issues and frozen checks for the next comparison',async()=>{
  const f=await deepFixture({},mode);let replanned=false, issueId:string|undefined
  const scheduler=new DeepScheduler(f.store,{execute:async(_a,job)=>{
    const input=qualityInput(job),reply=qualityResponse(input)
    if(reply.kind==='quality-review'&&!replanned) {
      reply.action='replan';reply.selectedCandidateId=null;reply.issues=[{checkId:input.checks[0].id,text:'Counterexample must survive replanning'}];replanned=true
    }else if(reply.kind==='quality-review') {
      assert.equal(input.issues.length,1);issueId=input.issues[0].id
      assert.equal(reply.resolutions[0]!.issueId,issueId)
    }
    return reply
  }},async()=>{})
  try{await scheduler.start(f.state.runId);await scheduler.idle(f.state.runId);const state=await f.store.read(f.state.runId);assert.equal(state.phase,'answered',state.reason);assert.ok(issueId);assert.equal(state.nodes[0]!.replans,1)}finally{await scheduler.dispose();await f.close()}
})
