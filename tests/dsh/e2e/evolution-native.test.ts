import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from '../helpers/native-mock.js'
import { EVOLUTION_OBSERVATION_EVENT } from '../../../src/dsh/evolution-observation.js'

const packageRoot=process.env.KIOKUKO_DSH_PACKAGE_ROOT,sourceRoot=process.env.KIOKUKO_DSH_SOURCE_ROOT
if(process.env.KIOKUKO_REQUIRE_DSH_NATIVE==='1'&&!packageRoot&&!sourceRoot)throw new Error('Native evolution coverage requires the pinned DSH runtime')
test('native result DTOs survive text-only log rendering as identity-bound episode evidence',{
  skip:!packageRoot&&!sourceRoot?'requires the pinned DSH runtime':false,timeout:30000,
},async()=>{
  const modules=[['cordis','vendor/cordis'],['dsh-llm','packages/llm/llm'],['dsh-session','packages/core/session'],['dsh-session-projection','packages/session/session-projection'],['dsh-system-prompt','packages/core/system-prompt'],['dsh-tools','packages/core/tools'],['dsh-agent','packages/core/agent'],['dsh-agent-loop','packages/core/agent-loop'],['dsh-skill','packages/skill/skill']]
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills]=await Promise.all(modules.map(([name,source])=>import(pathToFileURL(packageRoot?join(packageRoot,'@deepseek-ai',name!,'lib/index.js'):join(sourceRoot!,source!,'lib/index.js')).href)))
  const root=await mkdtemp(join(tmpdir(),'evolution-native-'));await mkdir(join(root,'.git'))
  const ctx=new cordis.Context(),fibers:any[]=[]
  let adapter:ReturnType<typeof createDshHostAdapter>|undefined,composition:Awaited<ReturnType<typeof mountDshComposition>>|undefined,disposeTool:(()=>void)|undefined
  try {
    for(const [plugin,config] of [[llm.default],[session.default],[projection.default],[systemPrompt.default,{persona:''}],[tools.default],[agents.default],[skills.default],[loop.default,{agents:[]}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber
    }
    const nativeResults:any[]=[]
    ctx.on('tools/result',(execution:any,result:any)=>{nativeResults.push({name:execution.name,parent:typeof execution.parent,agent:execution.agent?.id,session:execution.agent?.session?.id,seq:execution.agent?.session?.seq,hasEventAt:typeof execution.agent?.session?.eventAt,value:result.value,isError:result.isError,content:result.content})})
    const mock=nativeMock(llm),model=new mock.MockAdapter([mock.toolCallResponse('failed-check','verify',{exitCode:1}),mock.toolCallResponse('passed-check','verify',{exitCode:0}),mock.textResponse('終了しました。')])
    ctx.llm.registerAdapter(['evolution-test'],model)
    disposeTool=ctx.tools.register(tools.defineTool({name:'verify',description:'Return a typed execution result',parameters:{exitCode:{type:'number',required:true}},
      output:{schema:{type:'object',additionalProperties:false,properties:{exitCode:{type:'number',required:true}}},render:()=>[{type:'text',text:'Native execution output; the renderer omits its exit code.'}]},
      execute:async(args:any)=>({exitCode:args.exitCode})}))
    const questions=ctx.plugin({name:'evolution-questions',apply(context:any){return context.provide('userQuestions',{async ask(request:any){return {answers:request.questions.map((q:any)=>({id:q.id,selected:[q.id==='kioku-orca-recording'?'記録しない':'chat']}))}}})}});fibers.push(questions);await questions
    adapter=createDshHostAdapter(ctx,{repositoryRoot:root,databasePath:join(root,'state.sqlite3'),migrationsDirectory:join(process.cwd(),'migrations'),llm:{async *stream(request){
      const prompt=(request.messages.at(-1) as any).content[0].text
      const evidence=JSON.parse(prompt.split('\n\n').at(-1))
      const action=evidence.filter((e:any)=>e.kind==='action').at(-1),failed=evidence.find((e:any)=>e.outcome==='failed'),passed=evidence.find((e:any)=>e.outcome==='passed')
      assert.ok(action&&failed&&passed,'Both typed execution outcomes must be in the bounded native manifest')
      yield {type:'text-delta',text:JSON.stringify({schemaVersion:2,memories:[],episode:{goal:'Observed native recovery',applicability:'Native test',anchors:{error:'unknown',tool:'verify',target:'unknown',version:'unknown'},events:[{kind:'failure',description:failed.text,evidence:[failed.seq]},{kind:'action',description:action.text,evidence:[action.seq]},{kind:'verification',description:passed.text,evidence:[passed.seq]}],procedure:action.text,verification:passed.text,boundary:'Not proof of general correctness',unresolved:[],avoidance:null}})}
      yield {type:'finish',reason:{kind:'stop'}}
    }}})
    composition=await mountDshComposition(ctx,adapter.host)
    const agent=await ctx.agentLoop.create(session.SessionId('evolution-native'),{provider:'evolution-test',model:'mock'},{cwd:root,delegationDepth:0})
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'こんにちは'}]}))
    const deadline=Date.now()+15000
    while(Date.now()<deadline) {
      if(agent.status==='idle'&&model.requests.length===3)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    await ctx.sessions.flush(agent.session)
    await adapter.host.checkpointSessionMirror!(agent.session)
    const close=await adapter.host.resolveSessionClose!(agent.session.id,agent.session)
    assert.ok(close)
    const end=agent.session.snapshotEvents().findLast((e:any)=>e.type==='turn/end')
    await adapter.host.lifecycle!.closeTurn({...close,sourceEndSeq:end.seq})
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
    const { default: jsonl } = await import(pathToFileURL(packageRoot
      ? join(packageRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
      : join(sourceRoot!, 'packages/session/session-persistence-jsonl/lib/index.js')).href)
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
    assert.equal(rows.length,1)
    const episode=JSON.parse(rows[0]!.episode_json)
    assert.equal(episode.failed,true);assert.equal(episode.successful,true);assert.equal(episode.procedureSupported,true)
    const status=await adapter.host.memoryEvolution!.status(agent.session.id)
    assert.equal(status.mode,'active');assert.equal((status.episodes as {count:number}).count,1)
  } finally {
    await composition?.dispose();await adapter?.dispose();disposeTool?.();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})
  }
})
