import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { nativeMock } from '../helpers/native-mock.js'
import { EVOLUTION_OBSERVATION_EVENT } from '../../../src/dsh/evolution-observation.js'

// Positive replay organization/preview/approval is covered by integration/replay-memory-review.test.ts.
const packageRoot=process.env.KIOKUKO_DSH_PACKAGE_ROOT,sourceRoot=process.env.KIOKUKO_DSH_SOURCE_ROOT
if(process.env.KIOKUKO_REQUIRE_DSH_NATIVE==='1'&&!packageRoot&&!sourceRoot)throw new Error('Native evolution coverage requires the pinned DSH runtime')
test('native result DTOs survive text-only logs without automatic episode extraction',{
  skip:!packageRoot&&!sourceRoot?'requires the pinned DSH runtime':false,timeout:30000,
},async()=>{
  const modules=[['cordis','vendor/cordis'],['dsh-llm','packages/llm/llm'],['dsh-session','packages/core/session'],['dsh-session-projection','packages/session/session-projection'],['dsh-system-prompt','packages/core/system-prompt'],['dsh-tools','packages/core/tools'],['dsh-agent','packages/core/agent'],['dsh-agent-loop','packages/core/agent-loop'],['dsh-skill','packages/skill/skill']]
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills]=await Promise.all(modules.map(([name,source])=>import(pathToFileURL(packageRoot?join(packageRoot,'@deepseek-ai',name!,'lib/index.js'):join(sourceRoot!,source!,'lib/index.js')).href)))
  const root=await mkdtemp(join(tmpdir(),'evolution-native-'));await mkdir(join(root,'.git'))
  const ctx=new cordis.Context(),fibers:any[]=[]
  let adapter:ReturnType<typeof createDshHostAdapter>|undefined,composition:Awaited<ReturnType<typeof mountDshComposition>>|undefined,disposeTool:(()=>void)|undefined
  try {
    for(const [plugin,config] of [[llm.default??llm],[session.default??session],[projection.default??projection],[systemPrompt.default??systemPrompt,{persona:''}],[tools.default??tools],[agents.default??agents],[skills.default??skills],[loop.default??loop,{agents:[]}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber
    }
    const nativeResults:any[]=[]
    ctx.on('tools/result',(execution:any,result:any)=>{nativeResults.push({name:execution.name,parent:typeof execution.parent,agent:execution.agent?.id,session:execution.agent?.session?.id,seq:execution.agent?.session?.seq,hasEventAt:typeof execution.agent?.session?.eventAt,value:result.value,isError:result.isError,content:result.content})})
    const mock=nativeMock(llm),model=new mock.MockAdapter([mock.toolCallResponse('prepare-checks', TASK_PREPARE_TOOL, { taskType: 'research' }),mock.toolCallResponse('failed-check','verify',{exitCode:1}),mock.toolCallResponse('passed-check','verify',{exitCode:0}),mock.textResponse('終了しました。')])
    ctx.llm.registerAdapter(['evolution-test'],model)
    disposeTool=ctx.tools.register(tools.defineTool({name:'verify',description:'Return a typed execution result',parameters:{exitCode:{type:'number',required:true}},
      output:{schema:{type:'object',additionalProperties:false,properties:{exitCode:{type:'number',required:true}}},render:()=>[{type:'text',text:'Native execution output; the renderer omits its exit code.'}]},
      execute:async(args:any)=>({exitCode:args.exitCode})}))
    const questions=ctx.plugin({name:'evolution-questions',apply(context:any){return context.provide('userQuestions',{async ask(request:any){return {answers:request.questions.map((q:any)=>({id:q.id,selected:[q.id==='kioku-agenticreplay-recording'?'記録しない':'chat']}))}}})}});fibers.push(questions);await questions
    let extractionCalls = 0
    adapter=createDshHostAdapter(ctx,{repositoryRoot:root,databasePath:join(root,'state.sqlite3'),migrationsDirectory:join(process.cwd(),'migrations'),llm:{async *stream(){
      extractionCalls++;throw new Error('unapproved automatic memory extraction')
    }}})
    composition=await mountDshComposition(ctx,adapter.host)
    const settingsBefore=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT mode,generation FROM memory_evolution_settings').get())
    const agent=await ctx.agentLoop.create(session.SessionId('evolution-native'),{provider:'evolution-test',model:'mock'},{cwd:root,delegationDepth:0})
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'検証結果を調査して、失敗と成功を報告してください。'}]}))
    const deadline=Date.now()+15000
    while(Date.now()<deadline) {
      if(agent.status==='idle'&&model.requests.length===4)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    await ctx.sessions.flush(agent.session)
    await adapter.host.checkpointSessionMirror!(agent.session)
    const close=await adapter.host.resolveSessionClose!(agent.session.id,agent.session)
    assert.equal(close, undefined, 'prepared ordinary work was already closed by its native completion')
    await adapter.host.memoryFinalizer!.whenIdle()
    const events=agent.session.snapshotEvents()
    assert.equal(events.filter((e:any)=>e.type===EVOLUTION_OBSERVATION_EVENT).length,0)
    const proofs=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT observation_json FROM dsh_evolution_observations ORDER BY call_seq').all<{observation_json:string}>().map(row=>JSON.parse(row.observation_json)))
    const persistence = await import(pathToFileURL(packageRoot ? join(packageRoot, '@deepseek-ai/dsh-session-persistence/lib/index.js') : join(sourceRoot!, 'packages/session/session-persistence/lib/index.js')).href)
    assert.doesNotThrow(() => persistence.validateStoredEvents(agent.session.header, structuredClone(events)), 'the native cold reader must accept every event written by Kiokuko')
    const reopened = session.Session.fromRestore(agent.session.id, structuredClone(events), structuredClone(agent.session.header), 0, 'detached')
    assert.deepEqual(reopened.snapshotEvents().slice(0,events.length), events)
    // Exercise DSH's actual disk writer and a fresh backend reader. A repair
    // script or an in-memory Session alone cannot prove normal chat reopen.
    const jsonlModule = await import(pathToFileURL(packageRoot
      ? join(packageRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
      : join(sourceRoot!, 'packages/session/session-persistence-jsonl/lib/index.js')).href)
    const jsonl=jsonlModule.default??jsonlModule
    const storageConfig = { root: join(root, 'native-history'), compression: 'zstd' }
    const writerContext = new cordis.Context()
    const writerFiber = writerContext.plugin(jsonl, storageConfig)
    await writerFiber
    try {
      const handle = await writerContext.sessionPersistence.create(agent.session.header)
      try { await handle.append(events); await handle.flush() } finally { await handle.close() }
    } finally { await writerFiber.dispose() }
    const readerContext = new cordis.Context()
    const readerFiber = readerContext.plugin(jsonl, storageConfig)
    await readerFiber
    try {
      const handle = await readerContext.sessionPersistence.open(agent.session.id, 'read')
      try {
        const restored = await handle.read()
        assert.deepEqual(restored.events, events, 'normal history reopen needs no repair command')
        const loaded = session.Session.fromRestore(handle.id, restored.events, handle.header, handle.inheritedEventCount, restored.eventState)
        assert.deepEqual(loaded.snapshotEvents().slice(0, events.length), events)
      } finally { await handle.close() }
    } finally { await readerFiber.dispose() }
    assert.equal(proofs.length,2,JSON.stringify({requests:model.requests.length,nativeResults,events:events.map((e:any)=>({type:e.type,seq:e.seq}))}))
    assert.deepEqual(proofs.map((e:any)=>e.exitCode),[1,0])
    const rows=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT episode_json FROM memory_episodes').all<{episode_json:string}>())
    assert.equal(rows.length,0,'native execution receipts are not approval to derive an episode')
    assert.equal(extractionCalls,0)
    assert.equal(await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get()?.n),0)
    assert.equal(await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n),0)
    const status=await adapter.host.memoryEvolution!.status(agent.session.id)
    assert.equal(status.mode,settingsBefore!.mode);assert.equal((status.episodes as {count:number}).count,0)
    assert.deepEqual(await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT mode,generation FROM memory_evolution_settings').get()),settingsBefore)
  } finally {
    await composition?.dispose();await adapter?.dispose();disposeTool?.();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})
  }
})
