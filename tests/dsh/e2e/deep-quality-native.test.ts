import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deepNativeFixture } from '../helpers/deep-native-fixture.js'
import { deferred } from '../helpers/deep-fixture.js'
import { qualityResponse } from '../helpers/deep-quality-fixture.js'
import { mountDeepReportSurface } from '../../../src/deep-thinker/report-surface.js'
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !process.env.KIOKUKO_DSH_PACKAGE_ROOT) throw new Error('Quality native coverage requires the pinned DSH package runtime')
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
  let unmount: (() => unknown) | undefined, connectionFiber: any
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
    const report = (await f.deep.reports.snapshot(f.parent.session.id)).find(r => r.id === `deep-report:${intent.runId}`)!
    for (const expected of ['採用:', '検証項目:', '候補間の評価:', '[未選択]', '矛盾あり', '解消と評価:']) assert.ok(report.text.includes(expected), expected)
    const requestsBeforeRead = f.provider.requests.length
    const status = await f.command('/deep-planning --status')
    assert.equal(status.result.kind, 'success'); assert.ok(status.result.text.includes(report.text))
    const connection = await import(pathToFileURL(join(process.env.KIOKUKO_DSH_PACKAGE_ROOT!, '@deepseek-ai/dsh-client-connection/lib/index.js')).href)
    connectionFiber = await f.ctx.plugin({ name: 'quality-report-connection', apply(ctx: any) { new connection.HostConnectionService(ctx, [], { isAuthenticated: () => true }) } })
    unmount = mountDeepReportSurface(f.ctx, f.deep)
    const transport = f.ctx.connection.createSharedFetchHandler('/api')
    const response = await transport.fetch(new Request(`http://localhost/api/kiokuko.deep?sessionId=${f.parent.session.id}`))
    assert.equal(response.status, 200)
    const { items } = await response.json() as { items: { id: string; text: string }[] }
    assert.equal(items.find(item => item.id === report.id)?.text, report.text)
    assert.equal(f.provider.requests.length, requestsBeforeRead)
  }finally{unmount?.();await connectionFiber?.dispose();await f.close()}
})

test('quality status shows only its current run while Web history retains older reports', native, async () => {
  const started = deferred<void>(), release = deferred<void>()
  const steps = ['推論:', '品質重視（実験）', '別案のモデル:', '設定済みの役割からコピー', '保存']
  const firstProblem = 'First bounded quality problem', secondProblem = 'Second bounded quality problem'
  const f = await deepNativeFixture(mock => Array.from({ length: 12 }, () => async (request: any) => {
    if (request.purpose === 'compaction') return mock.textResponse(JSON.stringify({ schemaVersion: 1, memories: [] }))
    const input = inputFor(request)
    if (input.originalProblem === secondProblem && input.phase === 'plan') { started.resolve(); await release.promise }
    return mock.textResponse(JSON.stringify(qualityResponse(input)))
  }), { questions: async request => {
    const q = request.questions[0], prefix = steps.shift()!, option = q.options.find((o: any) => o.label.startsWith(prefix))
    assert.ok(option, JSON.stringify(q)); return { answers: [{ id: q.id, selected: [option.label] }] }
  } })
  try {
    await f.command('/deep-planning --configure')
    await f.command(`/deep-planning ${firstProblem}`)
    const first = await f.complete(); assert.ok(first?.runId)
    assert.ok((await f.command('/deep-planning --status')).result.text.includes(firstProblem))
    await f.command(`/deep-planning ${secondProblem}`)
    await started.promise
    const running = await f.command('/deep-planning --status')
    assert.equal(running.result.kind, 'success')
    assert.ok(running.result.text.includes('実行中'))
    assert.equal(running.result.text.includes(firstProblem), false)
    release.resolve()
    const second = await f.complete(); assert.ok(second?.runId); assert.notEqual(second.runId, first.runId)
    const completed = await f.command('/deep-planning --status')
    assert.ok(completed.result.text.includes(secondProblem))
    assert.equal(completed.result.text.includes(firstProblem), false)
    const history = await f.deep.reports.snapshot(f.parent.session.id)
    assert.ok(history.some(item => item.id === `deep-report:${first.runId}` && item.text.includes(firstProblem)))
    assert.ok(history.some(item => item.id === `deep-report:${second.runId}` && item.text.includes(secondProblem)))
    await f.command('/deep-planning')
    const armed = await f.command('/deep-planning --status')
    assert.ok(armed.result.text.includes('予約中'))
    assert.equal(armed.result.text.includes(secondProblem), false)
  } finally { release.resolve(); await f.close() }
})
