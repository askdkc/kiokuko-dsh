import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import YAML from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Harness from '../../../src/dsh/harness/index.js'
import Llm, { LlmAdapter, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { KiokukoAgentFactory } from '../../../src/dsh/harness/factory.js'
import {currentTaskAuthority,withTaskAuthority} from '../../../src/dsh/task-authority-context.js'

function deferred() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve} }

test('legacy compatibility overlay restores one stock factory and removes its Kiokuko factory dependency',async()=>{
  const rows=YAML.parse(await readFile(new URL('../../../dsh/cordis.legacy.patch.yml',import.meta.url),'utf8'))
  assert.equal(rows.find((r:any)=>r.id==='agent-loop')?.disabled,false)
  assert.equal(rows.find((r:any)=>r.id==='kiokuko-harness')?.disabled,true)
  assert.equal(rows.find((r:any)=>r.id==='kiokuko-dsh')?.inject.includes('kiokukoHarness'),false)
  assert.equal(rows.some((r:any)=>r.insert),false,'Overlay must not duplicate bundle entries')
})

async function fixture(productionPlugin = false) {
  const ctx = new Context(), requests: unknown[] = []
  for (const plugin of [Llm, Sessions, Projections, Agents]) await ctx.plugin(plugin)
  if (productionPlugin) for (const plugin of [SystemPrompt, Tools]) await ctx.plugin(plugin)
  if (productionPlugin) await ctx.plugin(NativeExecutor)
  ctx.llm.registerAdapter(['harness-fixture'], new class extends LlmAdapter {
    async *stream(options: any) {
      requests.push(options)
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'Kiokuko owns this turn.' } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }
  }())
  let factory!: KiokukoAgentFactory
  const plugin = productionPlugin ? await ctx.plugin(Harness, {provider:'harness-fixture',model:'contract-model'}) : await ctx.plugin({name:'harness-contract',inject:['agents','sessions','llm'],apply(scope:Context) {
    factory = new KiokukoAgentFactory(scope, { provider: 'harness-fixture', model: 'contract-model' })
    scope.agents.setFactory(factory)
  }})
  if (productionPlugin) factory = ctx.kiokukoHarness
  return { ctx, factory, requests, async close() { await factory.dispose(); await plugin.dispose(); await ctx.fiber.dispose() } }
}

test('rejected intake retains input and waits for another wake instead of silently consuming or spinning', async () => {
  const f=await fixture()
  try {
    let reject=true,calls=0
    f.factory.lifecycle.onStep(async(event,next)=>{calls++;return reject?{kind:'reject'}:next()})
    const {agent}=await f.ctx.agents.create({sessionId:SessionId('kiokuko-rejected')})
    agent.followup(createUserMessage({content:[{type:'text',text:'Retain this request'}],source:{kind:'user'}}))
    await agent.whenIdle()
    assert.equal(calls,1);assert.equal(f.requests.length,0);assert.equal(agent.inbox.nextTurn.length,1)
    reject=false
    agent.steer(createUserMessage({content:[{type:'text',text:'Missing fact supplied'}],source:{kind:'user'}}))
    await agent.whenIdle()
    assert.equal(f.requests.length,1);assert.equal(agent.inbox.nextTurn.length,0)
  } finally {await f.close()}
})

test('harness captures its durable model selection for pre-step and the matching request', async () => {
  const f=await fixture(true);let handle:any
  try {
    const selections:any[]=[]
    const errors:string[]=[]
    f.ctx.on('agent/error',event=>{errors.push(String(event.error))})
    f.ctx.on('agent/pre-step',async(payload:any,next)=>{selections.push(payload.modelSelection);return next()})
    handle=await f.ctx.agents.create({sessionId:SessionId('kiokuko-model-selection')})
    assert.deepEqual(handle.agent.model.current(),{provider:'harness-fixture',model:'contract-model'})
    handle.agent.model.select({provider:'harness-fixture',model:'selected-model'})
    assert.deepEqual(f.ctx.sessionProjections.snapshot(handle.agent.session).values.modelSelection?.next,
      {provider:'harness-fixture',model:'selected-model'},'Web and CLI must receive the same durable selection')
    handle.agent.followup(createUserMessage({content:[{type:'text',text:'Use the selected model'}],source:{kind:'user'}}))
    await handle.agent.whenIdle()
    assert.deepEqual(errors,[])
    assert.deepEqual(selections,[{provider:'harness-fixture',model:'selected-model'}])
    assert.equal((f.requests[0] as any).model,'selected-model')
  } finally {await handle?.dispose();await f.close()}
})

test('context preparation failure parks retained input and only a new wake retries it',async()=>{
 const f=await fixture();let calls=0,fault=true,agent:any
 try{
  await f.ctx.plugin({name:'context-outage-fixture',apply(ctx:Context){ctx.provide('systemPrompt',{assemble(){calls++;if(fault){if(calls===2)agent.cancel({kind:'user'});throw new Error('Context unavailable')}return undefined}} as any)}})
  agent=(await f.ctx.agents.create({sessionId:SessionId('context-outage')})).agent
  agent.followup(createUserMessage({content:[{type:'text',text:'Retain before preparation'}],source:{kind:'user'}}));await agent.whenIdle()
  assert.equal(calls,1,'Preparation must stop after its first failure');assert.equal(agent.inbox.nextTurn.length,1);assert.equal(f.requests.length,0)
  const failedReason=(agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/end').at(-1) as any).data.reason
  assert.equal(failedReason.kind,'error')
  // The durable failure records the real cause instead of an opaque sentinel.
  assert.match(failedReason.error.message,/Context unavailable/)
  assert.equal(failedReason.error.code,'UNKNOWN')
  const auditRecord=agent.session.snapshotEvents().find((e:any)=>e.type==='plugin:kiokuko-dsh/harness-action'&&e.data.action==='turn'&&e.data.phase==='error') as any
  assert.equal(auditRecord.data.diagnostic.message,'Context unavailable')
  assert.equal(auditRecord.data.diagnostic.code,'UNKNOWN')
  fault=false;agent.steer(createUserMessage({content:[{type:'text',text:'The context is available now'}],source:{kind:'user'}}));await agent.whenIdle()
  assert.equal(agent.inbox.nextTurn.length,0);assert.equal(f.requests.length,1)
  assert.equal(agent.session.snapshotEvents().filter((e:any)=>e.type==='user/message'&&e.data.content?.some((b:any)=>b.text==='Retain before preparation')).length,1)
 }finally{await f.close()}
})

test('provider preparation failure records the accepted request and a failed turn without inventing completion', async () => {
  const f=await fixture()
  try {
    const {agent}=await f.ctx.agents.create({sessionId:SessionId('kiokuko-outage'),agentOptions:{provider:'absent-provider',model:'absent-model'}})
    agent.followup(createUserMessage({content:[{type:'text',text:'Keep this accepted request across provider outage'}],source:{kind:'user'}}))
    await agent.whenIdle()
    const events=agent.session.snapshotEvents()
    assert.equal(events.filter(event=>event.type==='user/message').length,1)
    const failedReason=(events.filter(event=>event.type==='turn/end').at(-1) as any)?.data.reason
    assert.equal(failedReason.kind,'error')
    // An LlmError keeps its provider failure facts verbatim per the current DSH contract.
    assert.equal(failedReason.error.code,'NO_ADAPTER')
    assert.match(failedReason.error.message,/no adapter registered for provider "absent-provider"/)
    assert.equal(events.filter(event=>event.type==='assistant/message').length,0)
  } finally {await f.close()}
})

test('cancel commits an interrupted prefix, preserves later waking input and does not publish a runtime error', async () => {
  const f=await fixture(),started=deferred(),errors:unknown[]=[]
  try {
    let first=true
    f.ctx.on('agent/error',event=>errors.push(event.error))
    f.ctx.on('llm/stream',async function*(options,next){
      if(!first){yield*next();return}first=false
      yield{type:'text-delta' as const,index:0,text:'Observed prefix'};started.resolve()
      await new Promise((_,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}))
    })
    const {agent}=await f.ctx.agents.create({sessionId:SessionId('kiokuko-cancel')})
    agent.followup(createUserMessage({content:[{type:'text',text:'Begin'}],source:{kind:'user'}}))
    await started.promise;agent.cancel({kind:'user'})
    agent.followup(createUserMessage({content:[{type:'text',text:'Continue after cancel'}],source:{kind:'user'}}))
    await agent.whenIdle()
    const events=agent.session.snapshotEvents()
    assert.ok(events.some(e=>e.type==='turn/end'&&e.data.reason.kind==='aborted'))
    assert.ok(events.some(e=>e.type==='assistant/message'&&e.data.interrupted))
    assert.equal(events.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'completed')
    assert.deepEqual(errors,[])
  } finally {await f.close()}
})

test('creation cancellation rolls back unpublished setup without waiting for its late completion', async () => {
  const f=await fixture(),entered=deferred(),late=deferred(),abort=new AbortController()
  try {
    const pending=f.ctx.agents.create({sessionId:SessionId('kiokuko-setup-cancel'),signal:abort.signal,
      async setup(){entered.resolve();await late.promise}})
    await entered.promise;abort.abort(new Error('cancel fixture creation'))
    const result=await Promise.race([pending.then(()=> 'published',()=> 'cancelled'),new Promise(resolve=>setTimeout(()=>resolve('still waiting'),30))])
    assert.equal(result,'cancelled')
    assert.equal(f.ctx.agents.get(SessionId('kiokuko-setup-cancel')),undefined)
    assert.equal(f.ctx.sessions.get(SessionId('kiokuko-setup-cancel')),undefined)
    late.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests.length,0)
  } finally {late.resolve();await f.close()}
})

test('provider recovery uses the DSH request-error contract without duplicating accepted messages', async () => {
  const f=await fixture();let first=true,recovered=0
  try {
    f.ctx.on('llm/stream',async function*(options,next){if(first){first=false;yield{type:'finish' as const,reason:{kind:'error' as const,failure:{code:'RATE_LIMIT',message:'Fixture provider unavailable'}}};return}yield*next()})
    f.ctx.on('agent/request-error',async(event,next)=>{assert.equal(event.failure.code,'RATE_LIMIT');recovered++;return{kind:'retry'}})
    const {agent}=await f.ctx.agents.create({sessionId:SessionId('kiokuko-provider-recovery')})
    agent.followup(createUserMessage({content:[{type:'text',text:'Continue after a transient provider failure'}],source:{kind:'user'}}))
    await agent.whenIdle()
    const events=agent.session.snapshotEvents()
    assert.equal(recovered,1);assert.equal(events.filter(e=>e.type==='user/message').length,1)
    assert.equal(events.filter(e=>e.type==='assistant/attempt').length,1)
    assert.equal(events.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'completed')
  } finally {await f.close()}
})

test('Kiokuko factory owns create, unpublished setup, queued turns and canonical session events without AgentLoop', async () => {
  const f = await fixture()
  try {
    let setup = false
    const handle = await f.ctx.agents.create({ sessionId: SessionId('kiokuko-root'), meta: { cwd: process.cwd() },
      setup(_scope, agent) {
        assert.equal(f.ctx.agents.get(agent.id), undefined)
        assert.equal(f.ctx.sessions.get(agent.id), agent.session, 'native setup appends only to an entered Session')
        setup = true
        agent.followup(createUserMessage({ content: [{type:'text',text:'First task'}], source:{kind:'user'} }))
      } })
    assert.equal(setup, true)
    assert.equal(handle.agent.constructor.name, 'KiokukoHarnessAgent')
    await handle.agent.whenIdle()
    assert.equal(f.requests.length, 1)
    assert.equal(isAgentLoopRequest(f.requests[0] as any),true,'DSH middleware must recognize the session-derived request')
    assert.equal(Object.isFrozen(f.requests[0]),true)
    const events = handle.agent.session.snapshotEvents()
    assert.deepEqual(events.filter(e => e.type === 'turn/start' || e.type === 'turn/end').map(e => e.type), ['turn/start','turn/end'])
    assert.equal(events.filter(e => e.type === 'assistant/message').length, 1)
    assert.equal(events.find(e => e.type === 'user/message')?.data.content[0]?.type, 'text')
    assert.equal(handle.agent.status, 'idle')
    await handle.dispose()
    assert.equal(f.ctx.agents.get(SessionId('kiokuko-root')), undefined)
    assert.equal(f.ctx.sessions.get(SessionId('kiokuko-root')), undefined)
  } finally { await f.close() }
})

test('injected context parks until wake and child handles keep independent identity and ownership', async () => {
  const f = await fixture()
  try {
    const parent = await f.ctx.agents.create({ sessionId:SessionId('kiokuko-parent') })
    parent.agent.inject(createUserMessage({content:[{type:'text',text:'Advisory context'}],source:{kind:'user'}}))
    await parent.agent.whenIdle()
    assert.equal(f.requests.length, 0)
    const registry = f.ctx.agents
    const legacyOwnership = 'isOwnedBy' in registry && typeof registry.isOwnedBy === 'function'
    const child = await parent.agent.ctx.agents.create({ sessionId:SessionId('kiokuko-child'),
      ...(legacyOwnership ? { parentAgent: parent.agent } : {}),
      meta:{origin:'subagent',parentSession:parent.agent.id,delegationDepth:1} })
    if ('isOwnedBy' in registry && typeof registry.isOwnedBy === 'function')
      assert.equal(registry.isOwnedBy(child.agent.id,parent.agent), true)
    let inherited:unknown='not observed'
    f.factory.lifecycle.onStep(async(event,next)=>{if(event.agent===child.agent)inherited=currentTaskAuthority();return next()})
    const callerLease={taskId:'parent-task',sessionId:parent.agent.id,repositoryRoot:'/workspace',revision:1,generation:1} as any
    withTaskAuthority(callerLease,()=>child.agent.followup(createUserMessage({content:[{type:'text',text:'Inspect independently'}],source:{kind:'user'}})))
    await child.agent.whenIdle()
    assert.equal(inherited,undefined,'New child turns must not inherit the caller\'s ambient task lease')
    assert.equal(f.requests.length,1)
    assert.equal(parent.agent.inbox.nextStep.length,1)
    parent.agent.steer(createUserMessage({content:[{type:'text',text:'Continue parent'}],source:{kind:'user'}}))
    await parent.agent.whenIdle()
    assert.equal(f.requests.length,2)
    assert.equal(parent.agent.inbox.nextStep.length,0)
    await parent.dispose()
    assert.equal(f.ctx.agents.get(child.agent.id), undefined, 'disposing the parent scope disposes its owned child handle')
    await child.dispose()
  } finally { await f.close() }
})


for(const protocol of ['single','batch'] as const)test(`${protocol==='batch'?'current batch':'legacy single'} tool API settles one call without replay`,async()=>{
 const f=await fixture();let handle:any,executions=0;const received:any[]=[],resolved:any[]=[],disposed=new Set<any>()
 try{
  await f.ctx.plugin({name:'tool-contract-fixture',apply(ctx:Context){ctx.provide('tools',{
   ...(protocol==='batch'?{setExecutor(){},async resolve(input:any){assert.equal(input.agent.session.id,'harness-batch');const token={dispose(){disposed.add(token)}};resolved.push(token);return token}}:{}),
   async execute(input:any){received.push(input);const call=protocol==='batch'?input.calls[0]:input
    if(protocol==='batch'){assert.equal(input.toolSet,resolved[0],'Dispatch must use this step’s admitted native tool set');assert.equal(disposed.has(input.toolSet),false)}
    assert.equal(call.name,'fixture_call');executions++
    const result={isError:false,content:[{type:'text',text:'effect confirmed'}],meta:{fixture:'retained-native-result'}}
    return protocol==='batch'?{results:[{callId:call.id,result}],additionalContexts:[],concluded:false}:result
   }
  } as any)}})
  let first=true
  f.ctx.on('llm/stream',async function*(options,next){if(!first){yield*next();return}first=false
   yield{type:'block-start' as const,index:0,blockType:'tool-call' as const}
   yield{type:'block-end' as const,index:0,block:{type:'tool-call' as const,id:'fixture-call' as any,name:'fixture_call',arguments:'{}'}}
   yield{type:'finish' as const,reason:{kind:'tool-calls' as const}}
  })
  handle=await f.ctx.agents.create({sessionId:SessionId(`harness-${protocol}`)})
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Run the fixture once'}],source:{kind:'user'}}));await handle.agent.whenIdle()
  const events=handle.agent.session.snapshotEvents()
  assert.equal(executions,1);assert.equal(received.length,1)
  if(protocol==='batch'){assert.equal(resolved.length,2);assert.equal(disposed.size,2,'Every admitted step releases its exact tool set')}
  assert.equal(events.filter((e:any)=>e.type==='tool/call').length,1)
  const results=events.filter((e:any)=>e.type==='tool/result');assert.equal(results.length,1);assert.equal(results[0].data.message.isError,false)
  assert.deepEqual(results[0].sourceEventSeqs,[events.find((event:any)=>event.type==='tool/call')!.seq],'The result keeps its exact originating call')
  assert.deepEqual(results[0].data.meta,{fixture:'retained-native-result'},'Host result metadata is preserved')
 }finally{await handle?.dispose();await f.close()}
})

test('batch dispatch failure remains a failed turn and never retries an uncertain effect',async()=>{
 const f=await fixture(),errors:unknown[]=[];let handle:any,executions=0
 try{
  await f.ctx.plugin({name:'tool-failure-fixture',apply(ctx:Context){ctx.provide('tools',{setExecutor(){},async execute(){executions++;throw new Error('Fixture scheduler failed after possible effect')}} as any)}})
  f.ctx.on('agent/error',event=>errors.push(event.error));let first=true
  f.ctx.on('llm/stream',async function*(options,next){if(!first){yield*next();return}first=false
   yield{type:'block-start' as const,index:0,blockType:'tool-call' as const}
   yield{type:'block-end' as const,index:0,block:{type:'tool-call' as const,id:'uncertain-call' as any,name:'fixture_call',arguments:'{}'}}
   yield{type:'finish' as const,reason:{kind:'tool-calls' as const}}
  })
  handle=await f.ctx.agents.create({sessionId:SessionId('uncertain-effect')});handle.agent.followup(createUserMessage({content:[{type:'text',text:'Execute once'}],source:{kind:'user'}}))
  await handle.agent.whenIdle();await handle.agent.whenIdle()
  assert.equal(executions,1);assert.equal(errors.length,1)
  assert.equal(handle.agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/end').at(-1).data.reason.kind,'error')
 }finally{await handle?.dispose();await f.close()}
})

test('disposal exposes session persistence failure, cleans ownership and leaves another agent usable',async()=>{
 const f=await fixture(),errors:any[]=[];let failed:any,other:any
 const original=f.ctx.sessions.flush
 try{
  failed=await f.ctx.agents.create({sessionId:SessionId('disposal-failure')});other=await f.ctx.agents.create({sessionId:SessionId('disposal-independent')})
  f.ctx.on('agent/error',event=>errors.push(event.error))
  f.ctx.sessions.flush=async(session:any)=>{if(session===failed.agent.session)throw new Error('Synthetic session flush failure');return original.call(f.ctx.sessions,session)}
  await assert.rejects(failed.dispose(),(error:any)=>error.code==='SESSION_PERSISTENCE_FAILED')
  assert.equal(f.ctx.agents.get(failed.agent.id),undefined);assert.equal(f.ctx.sessions.get(failed.agent.id),undefined)
  assert.ok(errors.some(error=>error.code==='SESSION_PERSISTENCE_FAILED'))
  f.ctx.sessions.flush=original
  other.agent.followup(createUserMessage({content:[{type:'text',text:'Independent work continues'}],source:{kind:'user'}}));await other.agent.whenIdle()
  assert.equal(other.agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/end').at(-1).data.reason.kind,'completed')
 }finally{f.ctx.sessions.flush=original;await other?.dispose();await f.close()}
})

test('native batch termination does not dispatch another model request after a host refusal',async()=>{
 const f=await fixture();let handle:any,calls=0
 try{
  await f.ctx.plugin({name:'terminal-tool-contract',apply(ctx:Context){ctx.provide('tools',{setExecutor(){},async execute(input:any){calls++;return{results:[{callId:input.calls[0].id,result:{isError:true,content:[{type:'text',text:'Host refused this request'}]}}],additionalContexts:[],concluded:true}}} as any)}})
  let first=true
  f.ctx.on('llm/stream',async function*(options,next){if(!first){yield*next();return}first=false
   yield{type:'block-start' as const,index:0,blockType:'tool-call' as const}
   yield{type:'block-end' as const,index:0,block:{type:'tool-call' as const,id:'host-refusal' as any,name:'fixture_call',arguments:'{}'}}
   yield{type:'finish' as const,reason:{kind:'tool-calls' as const}}
  })
  handle=await f.ctx.agents.create({sessionId:SessionId('host-terminated-turn')});handle.agent.followup(createUserMessage({content:[{type:'text',text:'Observe the host decision'}],source:{kind:'user'}}));await handle.agent.whenIdle()
  assert.equal(calls,1);assert.equal(f.requests.length,0,'The executor owns the batch termination decision')
  const results=handle.agent.session.snapshotEvents().filter((event:any)=>event.type==='tool/result');assert.equal(results.length,1);assert.equal(results[0].data.message.isError,true)
 }finally{await handle?.dispose();await f.close()}
})

for(const ignoresAbort of [false,true])test(`cancel during intake discards only claimed input and preserves pending work (${ignoresAbort?'late admission':'abort-aware'})`,async()=>{
  const f=await fixture(),entered=deferred(),release=deferred(),seen:string[]=[]
  let first=true
  try{
    f.factory.lifecycle.onStep(async(event,next)=>{
      seen.push(...event.messages.map(message=>message.content.filter(b=>b.type==='text').map(b=>b.text).join('')))
      if(first){first=false;entered.resolve();await release.promise;if(!ignoresAbort)event.signal.throwIfAborted()}
      return next()
    })
    const handle=await f.ctx.agents.create({sessionId:SessionId(`intake-cancel-${ignoresAbort}`)})
    const agent=handle.agent,msg=(text:string)=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
    agent.followup(msg('old'));await entered.promise
    agent.followup(msg('queued'));agent.inject(msg('pending-steer'))
    agent.cancel({kind:'user'},{keepInbox:true});release.resolve();await agent.whenIdle()
    agent.followup(msg('new'));await agent.whenIdle()
    assert.deepEqual(seen,['old','queued','pending-steer','new'])
    const accepted=agent.session.snapshotEvents().filter(e=>e.type==='user/message').flatMap(e=>e.data.content.filter(b=>b.type==='text').map(b=>b.text))
    assert.deepEqual(accepted,['queued','pending-steer','new'],'aborted admission must not execute; pending messages are accepted once')
    assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/end'&&e.data.reason.kind==='aborted').length,1)
    assert.equal(agent.inbox.nextTurn.length+agent.inbox.nextStep.length,0)
    await handle.dispose()
  }finally{release.resolve();await f.close()}
})

test('provider failure retains retry and request identity facts at the request-error seam',async()=>{
  const f=await fixture();let observed:any
  try{
    f.ctx.on('llm/stream',async function*(){yield{type:'finish' as const,reason:{kind:'error' as const,failure:{code:'RATE_LIMIT',message:'Bounded fixture failure',status:429,providerRetryAfterMs:12,requestId:'fixture-request' as any}}}})
    f.ctx.on('agent/request-error',async(event,next)=>{observed=event.failure;return next()})
    const handle=await f.ctx.agents.create({sessionId:SessionId('provider-failure-facts')})
    handle.agent.followup(createUserMessage({content:[{type:'text',text:'Observe the failure without retry'}],source:{kind:'user'}}));await handle.agent.whenIdle()
    assert.equal(observed.status,429);assert.equal(observed.providerRetryAfterMs,12);assert.equal(observed.requestId,'fixture-request')
    await handle.dispose()
  }finally{await f.close()}
})
for(const interrupted of [false,true])test(`assembled replay state survives ${interrupted?'interruption':'completion'}`,async()=>{
  const f=await fixture(),yielded=deferred(),replay={response:{id:'opaque-fixture'},blocks:[{part:'one'}]}
  try{
    f.ctx.on('llm/stream',async function*(options){
      yield{type:'block-start' as const,index:0,blockType:'text' as const};yield{type:'block-end' as const,index:0,block:{type:'text' as const,text:'Replay-bound content'}}
      yield{type:'finish' as const,reason:{kind:'stop' as const},replayState:replay};yielded.resolve()
      if(interrupted)await new Promise((_,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}))
    })
    const handle=await f.ctx.agents.create({sessionId:SessionId(`replay-state-${interrupted}`)})
    handle.agent.followup(createUserMessage({content:[{type:'text',text:'Retain adapter replay state'}],source:{kind:'user'}}));await yielded.promise
    if(interrupted)handle.agent.cancel({kind:'user'})
    await handle.agent.whenIdle()
    const event=handle.agent.session.snapshotEvents().find(e=>e.type==='assistant/message') as any
    assert.deepEqual(event.data.message.source.replayState,replay)
    assert.equal(event.data.interrupted===true,interrupted)
    await handle.dispose()
  }finally{await f.close()}
})

test('admission receives assembled context and commits the host-updated snapshot once',async()=>{
  const f=await fixture();let admitted=0,pendingKinds:string[]=[]
  try{
    await f.ctx.plugin(SystemPrompt)
    f.ctx.systemPrompt.context({name:'fixture:frame',order:1,text:'CURRENT_FRAME'})
    f.factory.lifecycle.onStep(async(event,next)=>{
      pendingKinds=event.messages.map(message=>message.source.kind)
      const result=await next(),contexts=result.kind==='enter'?result.messages.filter(m=>m.source.kind==='runtime-context'):[]
      admitted=contexts.length
      if(result.kind!=='enter'||contexts.length)return result
      return {...result,messages:[...result.messages,createUserMessage({content:[{type:'text',text:'CURRENT_FRAME'}],source:{kind:'runtime-context',form:'snapshot',sections:[{name:'fixture:frame',text:'CURRENT_FRAME'}]} as any})]}
    })
    const handle=await f.ctx.agents.create({sessionId:SessionId('runtime-context-admission')})
    handle.agent.followup(createUserMessage({content:[{type:'text',text:'Inspect the current frame'}],source:{kind:'user'}}));await handle.agent.whenIdle()
    assert.deepEqual(pendingKinds,['user'],'Generated runtime context is admission output, never pending input')
    assert.equal(admitted,1,'Host admission must receive the same assembled runtime-context contract as a native request')
    const request=f.requests[0] as any
    assert.equal(request.messages.filter((m:any)=>m.content?.some((b:any)=>b.text?.includes('CURRENT_FRAME'))).length,1,'The host-updated frame is committed once')
    await handle.dispose()
  }finally{await f.close()}
})

for(const outcome of ['reject','provider-error'] as const)test(`native step tool set is released after ${outcome}`,async()=>{
 const f=await fixture();let handle:any,resolved=0,disposed=0
 try{
  await f.ctx.plugin({name:'tool-set-cleanup',apply(ctx:Context){ctx.provide('tools',{async resolve(){resolved++;return{dispose(){disposed++}}}} as any)}})
  if(outcome==='reject')f.factory.lifecycle.onStep(async()=>({kind:'reject'}))
  else f.ctx.on('llm/stream',async function*(){throw new Error('Fixture provider failed')})
  handle=await f.ctx.agents.create({sessionId:SessionId('tool-set-'+outcome)})
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Inspect this step'}],source:{kind:'user'}}));await handle.agent.whenIdle()
  assert.equal(resolved,1);assert.equal(disposed,1)
  assert.equal(handle.agent.session.snapshotEvents().filter((event:any)=>event.type==='turn/end').at(-1).data.reason.kind,outcome==='reject'?'blocked':'error')
 }finally{await handle?.dispose();await f.close()}
})

for (const followup of [false,true]) test(`consumed steering schedules no empty turn and preserves a later followup (${followup})`,async()=>{
 const f=await fixture();let handle:any;const requests:any[]=[]
 try {
  f.ctx.llm.registerAdapter(['steering-wake'],new class extends LlmAdapter {
   async *stream(options:any) {
    requests.push(options)
    if(requests.length===1)handle.agent.steer(createUserMessage({content:[{type:'text',text:'Verify the current change'}],source:{kind:'user'}}))
    if(followup&&requests.length===2)handle.agent.followup(createUserMessage({content:[{type:'text',text:'A separate queued request'}],source:{kind:'user'}}))
    yield {type:'block-start' as const,index:0,blockType:'text' as const}
    yield {type:'block-end' as const,index:0,block:{type:'text' as const,text:'Observed input'}}
    yield {type:'finish' as const,reason:{kind:'stop' as const}}
   }
  }())
  handle=await f.ctx.agents.create({sessionId:SessionId('steering-wake-'+followup),agentOptions:{provider:'steering-wake',model:'fixture'}})
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'The original request'}],source:{kind:'user'}}))
  await handle.agent.whenIdle()
  assert.equal(requests.length,followup?3:2,'a consumed steer cannot wake an empty turn')
  assert.equal(handle.agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/start').length,followup?2:1)
  assert.equal(handle.agent.inbox.nextTurn.length,0);assert.equal(handle.agent.inbox.nextStep.length,0)
  if(followup)assert.ok(JSON.stringify(requests[2].messages).includes('A separate queued request'))
 } finally {await handle?.dispose();await f.close()}
})
