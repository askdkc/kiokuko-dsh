import assert from 'node:assert/strict'
import test from 'node:test'
import { deepNativeFixture } from '../helpers/deep-native-fixture.js'
import { qualityResponse } from '../helpers/deep-quality-fixture.js'
const native={skip:process.env.KIOKUKO_DSH_PACKAGE_ROOT?false:'requires the pinned DSH package runtime',timeout:45000}
function inputFor(request:any):any {
  for(const message of request.messages??[]) for(const part of typeof message.content==='string'?[{text:message.content}]:message.content??[]) {
    if(typeof part.text==='string'&&part.text.includes('"originalProblem"')) {
      try{return JSON.parse(part.text.split('\n\n').at(-1))}catch{}
    }
  }
  throw new Error('Missing native quality job input')
}
test('quality uses the native command, explicit alternative model, reservations, read-only tools and finalizer',native,async()=>{
  const phases:string[]=[],models:string[]=[],sessions:string[]=[]
  const steps=['推論:','品質重視（実験）','別案のモデル:','mock / Alternative','保存']
  const f=await deepNativeFixture(mock=>Array.from({length:8},()=> (request:any)=>{
    if(request.purpose==='compaction') return mock.textResponse(JSON.stringify({schemaVersion:1,memories:[]}))
    const input=inputFor(request);phases.push(input.phase);models.push(request.model);sessions.push(request.sessionId)
    assert.equal(request.tools.some((t:any)=>/shell|bash|spawn|write|memory/.test(t.name)),false)
    if(input.phase==='draft-b'){assert.deepEqual(input.candidates,[]);assert.equal(request.model,'alternative')}
    return mock.textResponse(JSON.stringify(qualityResponse(input,{a:'WRONG',action:'repair'})))
  }),{questions:async request=>{
    const q=request.questions[0],prefix=steps.shift()!,option=q.options.find((o:any)=>o.label.startsWith(prefix));assert.ok(option,JSON.stringify(q));return {answers:[{id:q.id,selected:[option.label]}]}
  }})
  f.provider.listModels=async(provider:string)=>[{provider,id:'mock',name:'Mock'},{provider,id:'alternative',name:'Alternative'}]
  try {
    await f.command('/deep-planning --configure');assert.equal(steps.length,0)
    await f.command('/deep-planning Design a bounded read-only quality analysis')
    const intent=await f.complete();assert.ok(intent?.runId)
    const state=await f.deep.store.read(intent.runId),root=state.nodes[0]!
    assert.equal(state.phase,'answered',JSON.stringify(state));assert.equal(root.receipt?.verifierVersion,2)
    assert.deepEqual(phases,['plan','plan-review','draft-a','draft-b','compare','repair','final-review'])
    assert.equal(new Set(sessions).size,7);assert.equal(models[3],'alternative');assert.equal(state.usage.requests,8)
    const reservations=await f.deep.store.database(db=>db.prepare('SELECT status FROM dsh_deep_budget_reservations WHERE run_id=?').all<{status:string}>(state.runId))
    assert.equal(reservations.length,8);assert.ok(reservations.every(r=>r.status==='settled'))
    const finalization=await f.deep.store.database(db=>db.prepare('SELECT status,error FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string;error:string|null}>(state.runId))
    assert.equal(finalization?.status,'completed',finalization?.error??'')
    assert.ok((await f.deep.reports.snapshot(f.parent.session.id)).some(r=>r.kind==='report'&&r.text.includes('採用:')))
  }finally{await f.close()}
})
