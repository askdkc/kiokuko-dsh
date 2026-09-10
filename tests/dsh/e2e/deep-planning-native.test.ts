import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from '../helpers/native-mock.js'
import { deepNativeFixture } from '../helpers/deep-native-fixture.js'
import { writeFile } from 'node:fs/promises'
import { deferred } from '../helpers/deep-fixture.js'
import { deepReportResponse, mountDeepReportSurface } from '../../../src/deep-thinker/report-surface.js'
import { mountDshSessionExportSurface } from '../../../src/dsh/session-log-surface.js'
import { loadJapaneseOutputSkill } from '../../../src/dsh/japanese-output-skill.js'
import { estimateRequestTokens } from '../../../src/deep-thinker/core/budget.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('Deep native coverage requires KIOKUKO_DSH_PACKAGE_ROOT with the pinned published runtime')
const modulePath = (name: string) => pathToFileURL(join(packages!, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href

for (const armed of [false, true]) test(`Deep native: ${armed ? 'armed human input' : 'command body'}, no parent model request, same Session report`, {
  skip: packages ? false : 'requires the pinned DSH package runtime', timeout: 45_000,
}, async () => {
  const [cordis, llm, session, projection, systemPrompt, tools, agents, loop, skills, subagents, spawn, commands] = await Promise.all(
    ['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','subagent','subagent-spawn-in-process','commands'].map(name => import(modulePath(name))))
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'deep-native-root-'))), data = await mkdtemp(join(tmpdir(), 'deep-native-data-'))
  execFileSync('git', ['init', '-q', root])
  const databasePath = join(data, 'state.sqlite3'); await initializeDatabase({ databasePath })
  const db = openConnection(databasePath)
  registerRepositoryAndLocation(db, { repositoryId: 'deep-fixture', workspace: 'deep-workspace', displayName: 'Deep fixture', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 })
  db.close()
  const mock = nativeMock(llm), requests: any[] = []
  const responses = [
    { kind: 'leaf', reason: 'One bounded question' },
    { kind: 'candidate', answer: 'Use a read-only analysis stage.', evidence: [], assumptions: [], unresolved: [] },
    { kind: 'supported', requirementIds: ['request'], reason: 'The answer covers the requested plan.', evidence: [] },
  ]
  const provider = new mock.MockAdapter([
    ...responses.map(response => (request: any) => { requests.push(request); assert.notEqual(request.sessionId, 'deep-parent'); assert.equal(request.maxTokens, 4096); return mock.textResponse(JSON.stringify(response)) }),
    (request: any) => { requests.push(request); assert.equal(request.sessionId, 'deep-parent'); assert.equal(request.purpose, 'compaction'); return mock.textResponse(JSON.stringify({ schemaVersion: 1, memories: [{ kind: 'fact', title: 'Read-only planning', body: 'The proposed analysis stage is read-only.', summary: null, confidence: 0.7, tags: [] }] })) },
  ])
  provider.listModels = async (id: string) => [{ provider: id, id: 'mock', name: 'Mock' }]
  const ctx = new cordis.Context()
  for (const plugin of [llm, session, projection, systemPrompt, tools, agents, skills, subagents, commands]) await ctx.plugin(plugin.default, plugin === systemPrompt ? { persona: '' } : undefined)
  await ctx.plugin(loop.default, { agents: [] }); await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], provider)
  const adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath, modelRoutes: [{ provider: 'mock', family: 'other', connection: 'api', protocol: 'chat-completions' }], orca: { enabled: false }, deepPlanning: { budget: { maxConcurrentAgents: 1 } } })
  const composition = await mountDshComposition(ctx, adapter.host)
  const parent = await ctx.agentLoop.create(session.SessionId('deep-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  try {
    const task = 'Design a read-only analysis stage.\nPreserve this code: `const x = 1`.'
    const executed = await ctx.commands.execute(parent, armed ? '/deep-planning' : `/deep-planning ${task}`, [], new AbortController().signal)
    assert.equal(executed?.result?.kind, 'success', JSON.stringify(executed))
    assert.ok(executed.commandId)
    if (armed) parent.followup({ id: 'human-deep-input', role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' } })
    await parent.whenIdle()
    const intent = await adapter.host.deepPlanning!.store.intent('deep-parent')
    assert.ok(intent?.runId, JSON.stringify(intent))
    await adapter.host.deepPlanning!.kick(parent)
    await adapter.host.deepPlanning!.scheduler.idle(intent.runId)
    await adapter.host.memoryFinalizer!.whenIdle()
    const state = await adapter.host.deepPlanning!.store.read(intent.runId)
    assert.equal(state.phase, 'answered', JSON.stringify(state))
    assert.equal(state.task, task)
    assert.equal(requests.length, 4)
    assert.equal(state.usage.requests, 4)
    const finalization = await adapter.host.deepPlanning!.store.database(db => db.prepare('SELECT status,error FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string;error:string|null}>(intent.runId!))
    assert.equal(finalization?.status, 'completed', finalization?.error ?? '')
    assert.equal(parent.session.snapshotEvents().filter((e: any) => e.type === 'llm/request').length, 0)
    assert.ok((await adapter.host.deepPlanning!.reports.snapshot(parent.session.id)).some(e => e.kind === 'report' && e.text.includes('read-only analysis stage')))
    assert.equal(await adapter.host.deepPlanning!.store.database(db => db.prepare('SELECT count(*) AS count FROM enno_contracts').get<{count:number}>()!.count), 0)
  } finally {
    composition.stopIngress(); await adapter.dispose(); await composition.dispose()
    await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true })
  }
})

const nativeOptions = { skip: packages ? false : 'requires the pinned DSH package runtime', timeout: 30_000 }
test('Deep native: Japanese Skill reaches all OSS workers without tool access and is included in budget reservations', nativeOptions, async () => {
  const f=await deepNativeFixture(mock=>[
    mock.textResponse('{"kind":"leaf","reason":"一つの質問"}'),
    mock.textResponse('{"kind":"candidate","answer":"設定を確認してください。","evidence":[],"assumptions":[],"unresolved":[]}'),
    mock.textResponse('{"kind":"supported","requirementIds":["request"],"reason":"質問に回答している","evidence":[]}'),
    mock.textResponse('{"schemaVersion":1,"memories":[]}'),
  ])
  f.parent.options.model='qwen3-coder'
  f.provider.listModels=async(provider:string)=>[{provider,id:'qwen3-coder',name:'Qwen'}]
  try {
    await f.command('/deep-planning 設定の確認手順を日本語でまとめてください。')
    const intent=await f.complete(), state=await f.deep.store.read(intent!.runId!)
    assert.equal(state.phase,'answered',state.reason??'')
    const skill=await loadJapaneseOutputSkill()
    const requests=f.provider.requests.filter(r=>r.sessionId!==f.parent.session.id)
    assert.equal(requests.length,3)
    const reservations=await f.deep.store.database(db=>db.prepare("SELECT tokens FROM dsh_deep_budget_reservations WHERE run_id=? AND kind='agent' ORDER BY rowid").all<{tokens:number}>(state.runId))
    for(const [index,request] of requests.entries()) {
      const system=request.system??request.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.content).map((b:any)=>b.text??'').join('\n')
      assert.ok(system.includes(skill.content))
      assert.match(system,/human-readable Japanese string values/u)
      assert.equal(request.tools.some((tool:any)=>/skill|shell|bash|spawn/.test(tool.name)),false)
      assert.equal(reservations[index]!.tokens,estimateRequestTokens(Buffer.byteLength(JSON.stringify({system:request.system,messages:request.messages,tools:request.tools})),4096))
    }
  } finally {await f.close()}
})
test('Deep native: closing configuration retains a zero-budget draft without failing the command', nativeOptions, async () => {
  const actions = ['予算を編集', '総トークン数（推定）: 120000', '0', '閉じる・下書きを保持', '保存']
  const f = await deepNativeFixture(() => [], {questions:async request=>{
    const question=request.questions[0], action=actions.shift()!
    if(action==='保存') assert.match(question.detail,/総トークン数（推定）: 0/u)
    return {answers:[{id:question.id,selected:action==='0'?[]:[action],...(action==='0'?{custom:action}:{})}]}
  }})
  try {
    const closed=await f.command('/deep-planning --configure')
    assert.equal(closed.result.kind,'success');assert.match(closed.result.text,/下書きは保持/u)
    assert.equal((await f.command('/deep-planning --configure')).result.kind,'success')
    const saved=await f.deep.configuration.resolve('deep-cases',f.parent)
    assert.equal(saved!.budget.maxTotalTokens,0)
    assert.ok(Object.values(saved!.roles).every(role=>role.provider==='mock'&&role.model==='mock'))
    assert.equal(f.provider.requests.length,0);assert.deepEqual(actions,[])
  } finally {await f.close()}
})
test('Deep native: authenticated report transport is Session-bound and leaves native logs reopenable', nativeOptions, async () => {
  const fixture = await deepNativeFixture(() => [], {budget:{maxTotalTokens:0}})
  const connection = await import(modulePath('client-connection'))
  const fiber = await fixture.ctx.plugin({name:'deep-native-connection',apply(ctx:any){new connection.HostConnectionService(ctx, [], {isAuthenticated:()=>true})}})
  const unmountReport = mountDeepReportSurface(fixture.ctx, fixture.deep)
  const unmountExport = mountDshSessionExportSurface(fixture.ctx, {open:async()=>({status:200,headers:{},body:(async function*(){yield new Uint8Array([1])})()})} as any)
  try {
    await fixture.command('/deep-planning Preserve a zero-budget answer')
    await fixture.complete()
    const url = `http://localhost/api/kiokuko.deep?sessionId=${fixture.parent.session.id}`
    const transport = fixture.ctx.connection.createSharedFetchHandler('/api')
    // 0.1.5's real HTTP bridge treats omitted requestBody as streaming, which
    // constructs an invalid GET-with-body before dispatching either route.
    assert.equal(transport.requestBodyMode({method:'GET',url:new URL(url)}),'buffered')
    assert.equal(transport.requestBodyMode({method:'GET',url:new URL('http://localhost/api/session.export')}),'buffered')
    const response = await transport.fetch(new Request(url))
    assert.equal(response.status,200)
    assert.equal((await deepReportResponse(fixture.deep,new Request(url,{headers:{'if-none-match':response.headers.get('etag')!}}))).status,304)
    const {items} = await response.json() as {items:{id:string;kind:string;delivered:boolean}[]}
    const report=items.find(item=>item.kind==='report')!
    assert.ok(report);assert.equal(report.delivered,false)
    const ack=`${url}&id=${encodeURIComponent(report.id)}`
    assert.equal((await deepReportResponse(fixture.deep,new Request(ack,{method:'POST',headers:{origin:'http://other'}}))).status,403)
    assert.equal((await deepReportResponse(fixture.deep,new Request(ack.replace('http://localhost','http://dsh.internal'),{method:'POST',headers:{origin:'http://localhost:51554',host:'localhost:51554'}}))).status,200)
    assert.equal((await fixture.deep.reports.snapshot(fixture.parent.session.id)).find(item=>item.id===report.id)!.delivered,true)
    assert.equal(fixture.parent.session.snapshotEvents().some((event:any)=>event.type.startsWith('kiokuko/')),false)
    await fixture.ctx.sessions.flush(fixture.parent.session)
  } finally {await unmountExport();unmountReport();await fiber.dispose();await fixture.close()}
})
test('Deep native: Web model selection overrides initial Agent options before any parent request', nativeOptions, async () => {
  const fixture = await deepNativeFixture(() => [], { budget: { maxTotalTokens: 0 } })
  try {
    const projection = await import(pathToFileURL(join(packages!, '@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js')).href)
    projection.installModelSelectionProjection(fixture.ctx)
    fixture.parent.options.provider = 'unavailable-initial-provider'
    fixture.parent.session.append('model/selection', { provider: 'mock', model: 'mock' })
    assert.equal((await fixture.command('/deep-planning Use the selected Web model')).result.kind, 'success')
    const intent = await fixture.complete()
    assert.ok(intent?.runId)
    const state = await fixture.deep.store.read(intent.runId)
    assert.equal(state.phase, 'partial')
    assert.equal(state.configuration.roles.planner.provider, 'mock')
    assert.equal(fixture.provider.requests.length, 0)
  } finally { await fixture.close() }
})
test('Deep native: zero tokens and request exhaustion still deliver partial answers with Orca disabled', nativeOptions, async () => {
  for(const budget of [{maxTotalTokens:0},{maxModelRequests:1}]) {
    const fixture=await deepNativeFixture(mock=>[mock.textResponse('{"kind":"leaf","reason":"A bounded question"}')],{budget})
    try {
      const result=await fixture.command('/deep-planning Analyze this question');assert.equal(result.result.kind,'success',JSON.stringify(result))
      const intent=await fixture.complete();assert.ok(intent?.runId)
      const state=await fixture.deep.store.read(intent.runId)
      assert.equal(state.phase,'partial');assert.equal(state.usage.requests,'maxTotalTokens' in budget?0:1)
      assert.equal(fixture.provider.requests.length,state.usage.requests)
      assert.ok((await fixture.deep.reports.snapshot(fixture.parent.session.id)).some(e=>e.kind==='report'))
    } finally {await fixture.close()}
  }
})
test('Deep native: failure after input claim and before pre-step keeps input and cannot call the parent model', nativeOptions, async () => {
  const fixture=await deepNativeFixture(()=>[],{budget:{maxTotalTokens:0}})
  const remove=fixture.parent.ctx.on('system-prompt/assemble',()=>{throw new Error('Injected assembly failure')})
  try {
    await fixture.command('/deep-planning Preserve this exact input\n  with indentation')
    await fixture.parent.whenIdle()
    const intent=await fixture.deep.store.intent(fixture.parent.session.id)
    assert.ok(intent?.messages.length);assert.equal(intent.task,'Preserve this exact input\n  with indentation')
    assert.equal(fixture.provider.requests.length,0)
    remove();await fixture.command('/deep-planning --resume');await fixture.complete()
    assert.ok((await fixture.deep.reports.snapshot(fixture.parent.session.id)).some(e=>e.kind==='report'))
  } finally {remove();await fixture.close()}
})
test('Deep native: allowlisted read creates a citable artifact; provider receives no shell, mutation, Enno or spawn tools', nativeOptions, async () => {
  const fixture=await deepNativeFixture((mock,_root,dbPath)=>[
    mock.textResponse('{"kind":"leaf","reason":"Inspect the source"}'),
    (request:any)=>{assert.deepEqual(request.tools.map((t:any)=>t.name).sort(),['deep_list_files','deep_read_file','deep_search_files']);return mock.toolCallResponse('read-proof','deep_read_file',{path:'source.txt'})},
    ()=>{const db=openConnection(dbPath);try{const artifact=JSON.parse(db.prepare('SELECT state_json FROM dsh_deep_artifacts').get<{state_json:string}>()!.state_json);return mock.textResponse(JSON.stringify({kind:'candidate',answer:'The source says verified text.',evidence:[{artifactId:artifact.id,quote:'verified text'}],assumptions:[],unresolved:[]}))}finally{db.close()}},
    mock.textResponse('{"kind":"supported","requirementIds":["request"],"reason":"Source matches the claim","evidence":[]}'),
    mock.textResponse('{"schemaVersion":1,"memories":[]}'),
  ])
  try {
    await writeFile(join(fixture.root,'source.txt'),'verified text\n')
    await fixture.command('/deep-planning Explain source.txt');const intent=await fixture.complete();assert.ok(intent?.runId)
    const state=await fixture.deep.store.read(intent.runId);assert.equal(state.phase,'answered',JSON.stringify(state))
    assert.equal(state.nodes[0]!.receipt?.assessment,'source-supported')
    assert.equal((await fixture.deep.store.artifacts(intent.runId)).length,1)
  } finally {await fixture.close()}
})
test('Deep native: cancelling an armed reservation restores the next ordinary input', nativeOptions, async () => {
  const fixture=await deepNativeFixture(mock=>[mock.textResponse('Hello.'),mock.textResponse('{"schemaVersion":1,"memories":[]}')])
  try {
    await fixture.command('/deep-planning');await fixture.command('/deep-planning --status')
    assert.equal((await fixture.deep.store.intent(fixture.parent.session.id))?.status,'armed')
    await fixture.command('/deep-planning --cancel')
    fixture.parent.followup({id:'ordinary-after-cancel',role:'user',content:[{type:'text',text:'hello'}],source:{kind:'user'}})
    await fixture.parent.whenIdle()
    assert.ok(fixture.provider.requests.some((request:any)=>request.sessionId===fixture.parent.session.id&&request.purpose===undefined))
    assert.equal(await fixture.deep.store.database(db=>db.prepare('SELECT count(*) AS count FROM dsh_deep_runs').get<{count:number}>()!.count),0)
  } finally {await fixture.close()}
})

test('Deep native: completed Deep returns the next input to ordinary routing with bounded report context', nativeOptions, async()=>{
  const f=await deepNativeFixture(mock=>[
    mock.textResponse('{"kind":"leaf","reason":"bounded"}'),mock.textResponse('{"kind":"candidate","answer":"Distinct saved plan","evidence":[],"assumptions":[],"unresolved":[]}'),mock.textResponse('{"kind":"supported","requirementIds":["request"],"reason":"covered","evidence":[]}'),mock.textResponse('{"schemaVersion":1,"memories":[]}'),mock.textResponse('Hello.'),mock.textResponse('{"schemaVersion":1,"memories":[]}')])
  try {
    await f.command('/deep-planning Design a process');await f.complete()
    f.parent.followup({id:'after-deep',role:'user',content:[{type:'text',text:'hello'}],source:{kind:'user'}})
    await f.parent.whenIdle()
    const request=f.provider.requests.find((r:any)=>r.sessionId===f.parent.session.id&&!r.purpose)
    assert.ok(request);assert.match(JSON.stringify(request.messages),/Distinct saved plan/u)
    assert.equal(await f.deep.store.database(db=>db.prepare('SELECT count(*) AS count FROM dsh_deep_runs').get<{count:number}>()!.count),1)
  }finally{await f.close()}
})
test('Deep native: armed attachments are retained and never reach a model',nativeOptions,async()=>{
  const f=await deepNativeFixture(()=>[])
  try{
    await f.command('/deep-planning')
    const input={id:'with-attachment',role:'user',content:[{type:'text',text:'Keep this text'},{type:'image',attachment:{id:'retained-reference'}}],source:{kind:'user'}}
    f.parent.followup(input);await f.parent.whenIdle()
    const intent=await f.deep.store.intent(f.parent.session.id)
    assert.match(intent!.problem,/添付/u);assert.deepEqual(intent!.messages[0],input);assert.equal(f.provider.requests.length,0)
  }finally{await f.close()}
})
test('Deep native: 0.1.5 file command admission retains the body and file without starting a model',nativeOptions,async()=>{
  const f=await deepNativeFixture(()=>[])
  const attachment={attachmentId:'deep-file-fixture',name:'plan.txt',bytes:3}
  const scope=await f.ctx.plugin({name:'deep-file-store-fixture',apply(ctx:any){ctx.provide('attachments',{})}})
  const remove=f.ctx.commands.registerFileReceiptResolver((agent:any,id:string)=>agent===f.parent&&id==='file-receipt'?attachment:undefined)
  try {
    const result=await f.ctx.commands.execute(f.parent,'/deep-planning Keep the entire problem',[{type:'file',receiptId:'file-receipt'}],new AbortController().signal)
    assert.equal(result.result.kind,'error');assert.match(result.result.text,/添付/u)
    const intent=await f.deep.store.intent(f.parent.session.id)
    assert.ok(intent);assert.equal(intent.runId,null);assert.match(JSON.stringify(intent.messages),/Keep the entire problem/u)
    assert.ok(JSON.stringify(intent.messages).includes('deep-file-fixture'));assert.equal(f.provider.requests.length,0)
  } finally {remove();await scope?.dispose?.();await f.close()}
})
test('Deep native: prepared and direct auxiliary calls share the request ceiling; missing Session identity fails closed',nativeOptions,async()=>{
  for(const prepared of [false,true]){
    const f=await deepNativeFixture(mock=>[mock.textResponse('auxiliary result')],{budget:{maxModelRequests:1}})
    let auxiliary=0
    const remove=f.ctx.on('agent/pre-step',async({agent,signal}:any,next:()=>unknown)=>{
      if(f.deep.executor.isChild(agent)){
        const options={provider:'mock',model:'mock',maxTokens:4096,messages:[],tools:[],signal,sessionId:agent.session.id}
        const collect=async(stream:AsyncIterable<unknown>)=>{for await(const _ of stream){}}
        await assert.rejects(async()=>collect(agent.ctx.llm.stream({...options,sessionId:undefined})),/Session identity/u)
        const stream=prepared?(await agent.ctx.llm.prepareCall({provider:'mock',model:'mock',maxTokens:4096},signal)).stream(options):agent.ctx.llm.stream(options)
        await collect(stream);auxiliary++
      }
      return next()
    },{global:true})
    try{
      await f.command('/deep-planning Check auxiliary limits');const intent=await f.complete()
      assert.equal(auxiliary,1);assert.equal(f.provider.requests.length,1)
      const state=await f.deep.store.read(intent!.runId!);assert.equal(state.usage.requests,1);assert.equal(state.phase,'partial')
    }finally{remove();await f.close()}
  }
})
test('Deep native: new input pauses work, applies a fresh requirement revision, and requires consent for an uncertain resend',nativeOptions,async()=>{
  const entered=deferred<void>(), questions:string[]=[]
  const f=await deepNativeFixture((mock,_root,dbPath)=>[
    mock.textResponse('{"kind":"leaf","reason":"bounded"}'),
    async function*(request:any){entered.resolve();await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));request.signal.throwIfAborted()},
    mock.textResponse('{"kind":"leaf","reason":"revised bounded problem"}'),
    mock.textResponse('{"kind":"candidate","answer":"Plan with added constraint","evidence":[],"assumptions":[],"unresolved":[]}'),
    ()=>{const db=openConnection(dbPath);try{const state=JSON.parse(db.prepare('SELECT state_json FROM dsh_deep_nodes').get<{state_json:string}>()!.state_json);return mock.textResponse(JSON.stringify({kind:'supported',requirementIds:state.requirementIds,reason:'New constraint covered',evidence:[]}))}finally{db.close()}},
    mock.textResponse('{"schemaVersion":1,"memories":[]}'),
  ],{questions:async request=>{const q=request.questions[0];questions.push(q.id);return {answers:[{id:q.id,selected:[q.id==='deep-pending-input'?'制約として追加':'費用発生の可能性を確認して再試行']}]}}})
  try{
    await f.command('/deep-planning Design the first plan');await entered.promise
    f.parent.followup({id:'new-constraint',role:'user',content:[{type:'text',text:'Keep all source files unchanged'}],source:{kind:'user'}})
    const intent=await f.complete(),state=await f.deep.store.read(intent!.runId!)
    assert.equal(state.phase,'answered',JSON.stringify(state));assert.equal(state.requirementRevision,2)
    assert.deepEqual(state.constraints,['Keep all source files unchanged']);assert.deepEqual(questions,['deep-pending-input','deep-uncertain'])
    assert.ok(state.usage.reservedTokens>0)
  }finally{await f.close()}
})
test('Deep native: unavailable models pause without silently choosing another model',nativeOptions,async()=>{
  const f=await deepNativeFixture(()=>[()=>{throw Object.assign(new Error('model not found'),{status:404})}])
  try{
    await f.command('/deep-planning Check the selected model');const intent=await f.complete(),state=await f.deep.store.read(intent!.runId!)
    assert.equal(state.phase,'paused');assert.match(state.reason,/configure|利用/u);assert.equal(f.provider.requests.length,1)
  }finally{await f.close()}
})
test('Deep native: child recordings inherit only the exact parent choice and link to the Deep run',nativeOptions,async()=>{
  let asked=0
  const f=await deepNativeFixture(mock=>[mock.textResponse('{"kind":"leaf","reason":"bounded"}'),mock.textResponse('{"kind":"candidate","answer":"A recorded plan","evidence":[],"assumptions":[],"unresolved":[]}'),mock.textResponse('{"kind":"supported","requirementIds":["request"],"reason":"covered","evidence":[]}'),mock.textResponse('{"schemaVersion":1,"memories":[]}')],{orca:true,questions:async()=>{asked++;throw new Error('Children must not ask')}})
  try{
    const recording=await f.command('/kioku-orca start');assert.equal(recording.result.kind,'success',JSON.stringify(recording))
    await f.command('/deep-planning Create a recorded plan');const intent=await f.complete()
    await f.command('/kioku-orca stop')
    const evidence=await f.deep.store.database(db=>({
      choices:db.prepare('SELECT dsh_session_id FROM dsh_orca_session_choices').all<{dsh_session_id:string}>(),
      traces:db.prepare('SELECT t.dsh_session_id,l.kiokuko_run_id FROM dsh_orca_traces t JOIN dsh_orca_trace_run_links l USING(orca_run_id) WHERE t.dsh_session_id<>?').all<{dsh_session_id:string;kiokuko_run_id:string}>(f.parent.session.id),
    }))
    assert.equal(asked,0);assert.deepEqual(evidence.choices.map(row=>row.dsh_session_id),[f.parent.session.id])
    assert.equal(evidence.traces.length,3);assert.ok(evidence.traces.every(t=>t.kiokuko_run_id===intent!.runId))
  }finally{await f.close()}
})
test('Deep native: unloading during initial configuration preserves claimed input and closes before database teardown',nativeOptions,async()=>{
  const entered=deferred<void>()
  const f=await deepNativeFixture(()=>[],{questions:async request=>{entered.resolve();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}))}})
  f.deep.configuration.resolve=async()=>null
  try{
    await f.command('/deep-planning Keep input while configuration is open');await entered.promise
    await f.deep.stop();await f.parent.whenIdle()
    const intent=await f.deep.store.intent(f.parent.session.id)
    assert.equal(intent!.task,'Keep input while configuration is open');assert.equal(intent!.runId,null)
    assert.equal(f.provider.requests.length,0)
  }finally{await f.close()}
})
