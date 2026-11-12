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

async function fixture(productionPlugin = false, maxSteps?: number, nativeTools = productionPlugin) {
  const ctx = new Context(), requests: unknown[] = []
  for (const plugin of [Llm, Sessions, Projections, Agents]) await ctx.plugin(plugin)
  if (nativeTools) for (const plugin of [SystemPrompt, Tools]) await ctx.plugin(plugin)
  if (nativeTools) await ctx.plugin(NativeExecutor)
  ctx.llm.registerAdapter(['harness-fixture'], new class extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32768 } } }
    async *stream(options: any) {
      requests.push(options)
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'Kiokuko owns this turn.' } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }
  }())
  let factory!: KiokukoAgentFactory
  const limits = maxSteps === undefined ? {} : { maxSteps }
  const plugin = productionPlugin ? await ctx.plugin(Harness, {provider:'harness-fixture',model:'contract-model',...limits}) : await ctx.plugin({name:'harness-contract',inject:['agents','sessions','llm',...(nativeTools?['tools','systemPrompt']:[])],apply(scope:Context) {
    factory = new KiokukoAgentFactory(scope, { provider: 'harness-fixture', model: 'contract-model', ...limits })
    scope.agents.setFactory(factory)
  }})
  if (productionPlugin) factory = ctx.kiokukoHarness
  return { ctx, factory, requests, async close() { await factory.dispose(); await plugin.dispose(); await ctx.fiber.dispose() } }
}

for (const productionPlugin of [false, true]) for (const cancel of [false, true]) {
  test(`${productionPlugin ? 'plugin' : 'factory'} defaults let work ${cancel ? 'be cancelled' : 'finish'} beyond 128 steps`, async () => {
    const f = await fixture(productionPlugin, undefined, true)
    try {
      let steps = 0, executions = 0
      const errors: unknown[] = []
      f.ctx.on('agent/error', event => errors.push(event.error))
      f.ctx.on('agent/pre-step', async (event, next) => {
        if (cancel && event.step === 130) event.agent.cancel({ kind: 'user' })
        return next()
      })
      f.ctx.tools.register({
        name: 'progress_probe', description: 'Record one completed work item.', parameters: { type: 'object' },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async () => { executions++; return 'work recorded' },
      })
      f.ctx.on('llm/stream', async function* (options, next) {
        if (++steps > 129) { yield* next(); return }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `work-${steps}` as any, name: 'progress_probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })
      const { agent } = await f.ctx.agents.create({ sessionId: SessionId(`long-work-${productionPlugin}`) })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish the work and report the result.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      assert.equal(steps, cancel ? 129 : 130, 'A successful tool result at step 128 must allow further work until completion or cancellation')
      assert.equal(executions, 129)
      assert.equal(events.filter(event => event.type === 'tool/result').length, 129)
      assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason),
        [cancel ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' }])
      assert.deepEqual(errors, [])
    } finally { await f.close() }
  })
}

test('an explicit step limit records a specific failure, preserves results and resets for continuation', async () => {
  const f = await fixture(true, 2)
  try {
    let steps = 0, executions = 0
    const errors: any[] = []
    f.ctx.on('agent/error', event => errors.push(event.error))
    f.ctx.tools.register({
      name: 'budget_probe', description: 'Record a completed work item.', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { executions++; return 'work recorded' },
    })
    f.ctx.on('llm/stream', async function* (options, next) {
      if (++steps > 3) { yield* next(); return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `bounded-work-${steps}` as any, name: 'budget_probe', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    const { agent } = await f.ctx.agents.create({ sessionId: SessionId('explicit-step-limit') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Begin bounded work.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    let events = agent.session.snapshotEvents()
    const failed = events.find(event => event.type === 'turn/end')!
    assert.equal(failed.data.reason.kind, 'error')
    assert.equal(failed.data.reason.error.code, 'KIOKUKO_STEP_BUDGET_REACHED')
    assert.match(failed.data.reason.error.message, /maxSteps=2/)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].failure.code, 'KIOKUKO_STEP_BUDGET_REACHED')
    assert.equal(steps, 2)
    assert.equal(executions, 2)
    assert.equal(events.filter(event => event.type === 'tool/result').length, 2)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue from the recorded results.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    events = agent.session.snapshotEvents()
    assert.equal(steps, 4, 'Continuation receives a fresh per-turn budget and may finish at its exact limit')
    assert.equal(executions, 3, 'Previously settled tool calls must not run again')
    assert.equal(events.filter(event => event.type === 'tool/result').length, 3)
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
    assert.equal(errors.length, 1)
  } finally { await f.close() }
})

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

for (const finish of ['max-tokens', 'stop'] as const) {
  test(`harness retains unfinished thinking as a failed attempt after ${finish}`, async () => {
    const f = await fixture(true)
    try {
      let first = true
      let nextHistory: readonly unknown[] = []
      const errors: string[] = []
      f.ctx.on('agent/error', event => {
        assert.ok(event.error instanceof Error)
        errors.push(event.error.message)
      })
      f.ctx.on('llm/stream', async function* (options, next) {
        if (!first) {
          nextHistory = options.messages
          yield* next()
          return
        }
        first = false
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>repeated draft' } }
        yield { type: 'finish', reason: { kind: finish } }
      })
      const { agent } = await f.ctx.agents.create({ sessionId: SessionId(`kiokuko-unfinished-${finish}`) })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work on this change.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      assert.equal(events.filter(event => event.type === 'assistant/message').length, 0)
      assert.equal(events.filter(event => event.type === 'assistant/attempt').length, 1)
      const reason = events.filter(event => event.type === 'turn/end').at(-1)?.data.reason
      assert.equal(reason?.kind, 'error')
      assert.equal(reason.error.code, 'INCOMPLETE_ASSISTANT_RESPONSE')
      assert.deepEqual(errors, [reason.error.message])
      assert.equal(nextHistory.length, 0, 'the failed answer must not start another request by itself')

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Can we continue?' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      assert.ok(!JSON.stringify(nextHistory).includes('repeated draft'))
      assert.ok(JSON.stringify(nextHistory).includes('Work on this change.'))
      assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
    } finally { await f.close() }
  })
}

test('harness records the output limit and never dispatches a tool from a capped response', async () => {
  const f = await fixture(true)
  try {
    let calls = 0
    f.ctx.tools.register({
      name: 'limit_probe', description: 'Count executions.', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { calls++; return 'executed' },
    })
    f.ctx.on('llm/stream', async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Partial answer.' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'capped-call' as any, name: 'limit_probe', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })
    const { agent } = await f.ctx.agents.create({ sessionId: SessionId('kiokuko-output-limit') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try the tool.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'max-tokens')
    assert.equal(events.some(event => event.type === 'tool/call'), false)
    assert.equal(calls, 0)
    assert.deepEqual(agent.session.deriveMessages().at(-1)?.content, [{ type: 'text', text: 'Partial answer.' }])
  } finally { await f.close() }
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

test('runtime context is delivered once across unchanged tool steps and turns', async () => {
  const f = await fixture(true)
  let handle: any, steps = 0
  try {
    f.ctx.systemPrompt.context({ name: 'fixture:policy', order: 0, text: 'Mode: read-only.' })
    f.ctx.tools.register({
      name: 'context_probe', description: 'Inspect unchanged context.', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'observed' }] },
      execute: async () => 'observed',
    })
    f.ctx.on('llm/stream', async function* (request, next) {
      const contexts = request.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      assert.equal(contexts.length, 1, 'Every request retains exactly one unchanged runtime snapshot')
      if (++steps > 3) { yield* next(); return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `context-${steps}` as any, name: 'context_probe', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    handle = await f.ctx.agents.create({ sessionId: SessionId('runtime-context-unchanged') })
    const send = async () => {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the current policy.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      assert.equal(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    }
    await send(); await send()
    assert.equal(steps, 5)
    assert.equal(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'user/message' && event.data.source.kind === 'runtime-context').length, 1)
  } finally { await handle?.dispose(); await f.close() }
})

test('runtime context changes, clears once, and is restored after compaction and resume', async () => {
  const f = await fixture(true)
  let handle: any, mode = 'read-only'
  let disposeContext = f.ctx.systemPrompt.context({ name: 'fixture:policy', order: 0, text: () => `Mode: ${mode}.` })
  try {
    handle = await f.ctx.agents.create({ sessionId: SessionId('runtime-context-lifecycle') })
    const send = async () => {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect current context.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      assert.equal(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    }
    const snapshots = () => handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    await send(); await send()
    assert.equal(snapshots().length, 1)
    mode = 'workspace-write'; await send(); await send()
    assert.equal(snapshots().length, 2)
    assert.match(snapshots().at(-1).data.content[0].text, /workspace-write/)
    disposeContext(); await send(); await send()
    assert.equal(snapshots().length, 3)
    assert.equal(snapshots().at(-1).data.content[0].text, 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.')
    disposeContext = f.ctx.systemPrompt.context({ name: 'fixture:policy', order: 0, text: 'Mode: read-only.' })
    await send()
    const retained = snapshots().at(-1)
    handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted policy.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: retained.seq, endSeq: retained.seq }, sourceEventSeqs: [retained.seq],
    })
    await send(); await send()
    assert.equal(snapshots().length, 5, 'Compaction requires one replacement snapshot, not permanent suppression or repeated delivery')
    const sessionId = handle.agent.session.id
    const seed = structuredClone(handle.agent.session.snapshotEvents())
    await handle.dispose()
    handle = await f.ctx.agents.create({ sessionId, seed })
    await send()
    assert.equal(snapshots().length, 5, 'Resume reuses the snapshot still retained in the native surface')
  } finally { disposeContext(); await handle?.dispose(); await f.close() }
})

for (const timing of ['admission', 'retry'] as const) test(`runtime context survives compaction during ${timing} without replaying input`, async () => {
  const f = await fixture(true)
  let handle: any, attempts = 0
  try {
    f.ctx.systemPrompt.context({ name: 'fixture:policy', order: 0, text: 'Mode: read-only.' })
    handle = await f.ctx.agents.create({ sessionId: SessionId(`context-compaction-${timing}`) })
    const compact = () => {
      const event = handle.agent.session.snapshotEvents().findLast((event: any) => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
      handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted snapshot.' }], source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot' } }), {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
      })
    }
    const send = async () => {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect policy.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      assert.equal(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    }
    await send()
    if (timing === 'admission') f.ctx.on('agent/pre-step', async (_event, next) => { const decision = await next(); compact(); return decision })
    else {
      f.ctx.on('llm/stream', async function* (_request, next) {
        if (++attempts === 1) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_LENGTH', message: 'Compact before retry.' } } }; return }
        yield* next()
      })
      f.ctx.on('agent/request-error', async () => { compact(); return { kind: 'retry' } })
    }
    await send()
    const request = f.requests.at(-1) as any
    assert.equal(request.messages.filter((message: any) => message.source?.kind === 'runtime-context').length, 1)
    assert.equal(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'user/message' && event.data.source.kind === 'user').length, 2)
  } finally { await handle?.dispose(); await f.close() }
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

for (const change of ['replace', 'disable', 'unknown'] as const) test(`Lisp tool registration ${change} during a model request settles without replay`, async () => {
  const f = await fixture(false, undefined, true)
  let handle: any, release: (() => void) | undefined, bodies = 0, requests = 0
  const register = () => f.ctx.tools.register({
    name: 'lisp_inspect', description: 'Read a saved result without starting Lisp.', parameters: { type: 'object' },
    output: { schema: {}, render: () => [{ type: 'text' as const, text: 'saved result: 42' }] },
    execute: async () => { bodies++; return 42 },
  })
  try {
    if (change !== 'unknown') release = register()
    f.ctx.on('llm/stream', async function* (_options, next) {
      requests++
      if (requests === 1) {
        // Human mode changes can revoke a registration while the model is replying.
        release?.(); release = undefined
        if (change === 'replace') release = register()
      } else if (change !== 'replace' || requests > 2) { yield* next(); return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `inspect-${requests}` as any,
        name: 'lisp_inspect', arguments: '{"resultOperationId":"saved-before-recovery"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    handle = await f.ctx.agents.create({ sessionId: SessionId(`lisp-registration-${change}`) })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the saved result.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const results = handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result')
    assert.equal(results.length, change === 'replace' ? 2 : 1)
    assert.equal(results[0].data.message.isError, true)
    const first = JSON.stringify(results[0].data.message.content)
    if (change === 'unknown') assert.match(first, /unknown tool/)
    else {
      assert.match(first, /TOOL_SURFACE_CHANGED/)
      assert.match(first, /not executed/)
      assert.doesNotMatch(first, /unknown tool/)
    }
    assert.equal(bodies, change === 'replace' ? 1 : 0, 'never execute a revoked registration or replay automatically')
    if (change === 'replace') {
      assert.equal(results[1].data.message.isError, false)
      assert.match(JSON.stringify(results[1].data.message.content), /saved result: 42/)
    }
  } finally { release?.(); await handle?.dispose(); await f.close() }
})

test('50 changing runtime snapshots keep one current frame in requests and all original audit events', async () => {
  const f = await fixture(true)
  let handle: any, state = 'A', reads = 0
  try {
    f.ctx.systemPrompt.context({ name: 'fixture:fixed', order: 0, text: 'FIXED_INSTRUCTION_ONCE' })
    f.ctx.systemPrompt.context({ name: 'fixture:reading', order: 1, text: () => `LATEST_STATE=${state}` })
    f.ctx.tools.register({ name: 'read_state', description: 'Change the observed fixture state.', parameters: {},
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { reads++; state = reads === 50 ? 'A' : `B${reads}`; return `TOOL_EVIDENCE_${reads}` } })
    let requests = 0
    f.ctx.on('llm/stream', async function* (request, next) {
      requests++
      const contexts = request.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      assert.equal(contexts.length, 1, 'old full snapshots must not accumulate in any provider request')
      const text = JSON.stringify(contexts[0]?.content)
      assert.equal(text.split('FIXED_INSTRUCTION_ONCE').length - 1, 1)
      assert.ok(text.includes(`LATEST_STATE=${state}`), text)
      const evidence = request.messages.filter(message => message.role === 'tool')
      assert.equal(evidence.length, reads, 'actual tool results remain available')
      if (requests > 50) { yield* next(); return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `state-${requests}` as any, name: 'read_state', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    handle = await f.ctx.agents.create({ sessionId: SessionId('runtime-state-history') })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe fifty updates.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.equal(requests, 51)
    assert.equal(handle.agent.session.deriveMessages().filter((message: any) => message.source?.kind === 'runtime-context').length, 1, 'native compaction and token estimation must not retain superseded snapshots')
    const events = handle.agent.session.snapshotEvents()
    assert.equal(events.filter((event: any) => event.type === 'user/message' && event.data.source.kind === 'runtime-context').length, 51)
    assert.equal(events.filter((event: any) => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    const sessionId = handle.agent.session.id, seed = structuredClone(events)
    await handle.dispose()
    handle = await f.ctx.agents.create({ sessionId, seed })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after resume.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.equal(requests, 52)
  } finally { await handle?.dispose(); await f.close() }
})

test('owned Goal rounds pass real answer-memory projection and dispatch fences across native turns', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { openConnection } = await import('../../../src/db/connection.js')
  const { migrateDatabase } = await import('../../../src/db/migrate.js')
  const { DshAnswerContext } = await import('../../../src/dsh/answer-context.js')
  const { OnDemandIntake } = await import('../../../src/dsh/on-demand-intake.js')
  const { mountDshComposition } = await import('../../../src/dsh/composition.js')
  const { MemoryRetrievalConfig } = await import('../../../src/memory/retrieval-contracts.js')
  const { createEmbeddingRuntime } = await import('../../../src/embedding/runtime.js')
  const { defaultEmbeddingConfig } = await import('../../../src/embedding/settings.js')
  const f = await fixture(true), root = await mkdtemp(join(tmpdir(), 'owned-goal-answer-'))
  await mkdir(join(root, '.git'))
  const db = openConnection(join(root, 'memory.sqlite3')); migrateDatabase(db)
  let prepared = 0, fenced = 0, handle: any, composition: any
  const answerContext = new DshAnswerContext({ async withDatabase(fn) { return fn(db, createEmbeddingRuntime(db, { ...defaultEmbeddingConfig(), mode: 'off' })) } },
    { root, projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}), instructions: async () => { prepared++; return ['GOAL_ANSWER_CONTEXT'] } })
  const demand = new OnDemandIntake({ answerContext, validate: async () => {}, existing: async () => false,
    classify: async () => ({ deferInference: true }), ready: () => false, prepare: async () => false, nativeOwnership: async () => 'owned' })
  const errors: unknown[] = []
  try {
    f.ctx.on('agent/error', event => errors.push(String(event.error)))
    composition = await mountDshComposition(f.ctx, { onDemandIntake: demand,
      intakeGate: { preStep() { throw Error('Goal capture was bypassed') } } as any,
      mapPreStep: () => { throw Error('Goal capture was bypassed') } })
    f.ctx.on('llm/stream', async function* (request, next) {
      await demand.beforeRequest(handle.agent)
      const guard = await demand.fence(handle.agent, request)
      guard?.check(); fenced++
      yield* next()
    })
    handle = await f.ctx.agents.create({ sessionId: SessionId('owned-goal-answer') })
    for (const round of [1, 2, 3]) {
      handle.agent.followup(createUserMessage({ source: { kind: 'goal', goalId: 'goal', revision: 1, round } as any,
        content: [{ type: 'text', text: `<goal_round>Continue the requested verification. Round ${round}</goal_round>` }] }))
      await handle.agent.whenIdle()
      assert.deepEqual(errors, [])
      assert.equal(f.requests.length, round)
      assert.equal(prepared, round, 'test must exercise real answer memory, not the unowned bypass')
      assert.equal(fenced, round)
    }
  } finally { await handle?.dispose(); await composition?.dispose(); await demand.dispose(); await f.close(); db.close(); await rm(root, { recursive: true, force: true }) }
})

test('legacy resume retires fifty interleaved snapshots before real token pressure and preserves evidence', async () => {
  const { default: TokenMeter } = await import('@deepseek-ai/dsh-token-meter')
  // Load the installed integration backend without merging its optional type
  // augmentation into unrelated production Lisp compilation.
  const compactionPackage = '@deepseek-ai/dsh-compaction-basic'
  const { default: BasicCompaction } = await import(compactionPackage)
  const { retireLegacyRuntimeContexts } = await import('../../../src/dsh/harness/runtime-context.js')
  const f = await fixture(true)
  let handle: any, calls = 0
  try {
    f.ctx.systemPrompt.context({ name: 'legacy:frame', order: 0, text: () => `STATE=${calls} ` + 'OLD_CONTEXT '.repeat(1000) })
    f.ctx.tools.register({ name: 'legacy_work', description: 'Record real evidence', parameters: {},
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => `EVIDENCE_${++calls}` })
    const off = f.ctx.on('llm/stream', async function* (_request, next) {
      if (calls === 50) { yield* next(); return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `legacy-${calls}` as any, name: 'legacy_work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    handle = await f.ctx.agents.create({ sessionId: SessionId('legacy-interleaved') })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Preserve this human instruction.' }] }))
    await handle.agent.whenIdle(); off()
    assert.equal(calls, 50)
    const seed: any[] = structuredClone(handle.agent.session.snapshotEvents())
    for (const event of seed) if (event.type === 'user/message' && event.data.source.kind === 'runtime-context') {
      event.surfaceOp = 'append'; delete event.sourceEventSeqs
    }
    const evidence = seed.filter(e => e.type === 'tool/result')
    await handle.dispose()
    await f.ctx.plugin(TokenMeter)
    await f.ctx.plugin(BasicCompaction, { auto: true, thresholdRatio: 0.8, headroomTokens: 0, retainTokens: 20, maxTokens: 32 })
    let summaries = 0
    f.ctx.on('llm/stream', async function* (request, next) { if (request.purpose === 'compaction') summaries++; yield* next() })
    handle = await f.ctx.agents.create({ sessionId: SessionId('legacy-interleaved'), seed })
    const session = handle.agent.session
    const count = () => session.deriveMessages().filter((m: any) => m.role === 'user' && m.source.kind === 'runtime-context').length
    assert.equal(count(), 1)
    assert.equal(f.ctx.tokenMeter.measure(session).nodes.filter((n: any) => session.eventAt(n.seq)?.data?.source?.kind === 'runtime-context').length, 1)
    assert.deepEqual(session.snapshotEvents().slice(0, seed.length), seed)
    assert.deepEqual(session.deriveMessages().filter((m: any) => m.role === 'tool'), evidence.map(e => e.data.message))
    const seq = session.seq
    retireLegacyRuntimeContexts(session); assert.equal(session.seq, seq)
    // Replay a partially persisted normalization, then finish the remaining nodes.
    const partial = structuredClone(session.snapshotEvents().slice(0, seed.length + 17))
    await handle.dispose()
    handle = await f.ctx.agents.create({ sessionId: SessionId('legacy-interleaved'), seed: partial })
    assert.equal(handle.agent.session.deriveMessages().filter((m: any) => m.source?.kind === 'runtime-context').length, 1)
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Resume without unnecessary compaction.' }] }))
    await handle.agent.whenIdle()
    assert.equal(summaries, 0)
    assert.equal((f.requests.at(-1) as any).messages.filter((m: any) => m.source?.kind === 'runtime-context').length, 1)
    assert.equal(handle.agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  } finally { await handle?.dispose(); await f.close() }
})

const stopRaceMessage=(text:string)=>createUserMessage({content:[{type:'text' as const,text}],source:{kind:'user' as const}})
const acceptedStopRaceInputs=(agent:any)=>agent.session.snapshotEvents().filter((event:any)=>event.type==='user/message'&&event.data.source.kind==='user').map((event:any)=>event.data.id)
const settleStopRace=()=>new Promise<void>(resolve=>setImmediate(resolve))

for(const keepInbox of [false,true])test(`same-tick Stop cancels reserved turn before any provider request (keepInbox=${keepInbox})`,async()=>{
  const f=await fixture(true)
  try {
    const {agent}=await f.ctx.agents.create({sessionId:SessionId(`reserved-stop-${keepInbox}`)})
    const input=stopRaceMessage('Do not run before resume')
    agent.followup(input);agent.cancel({kind:'user'},{keepInbox})
    await agent.whenIdle();await settleStopRace()
    assert.equal(f.requests.length,0)
    assert.deepEqual(agent.session.snapshotEvents().filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['aborted'])
    assert.deepEqual(agent.inbox.nextTurn.map(m=>m.id),keepInbox?[input.id]:[])
    assert.equal(agent.status,'idle')
  } finally {await f.close()}
})

for(const keepInbox of [false,true])test(`Stop aborts provider even when inbox mutation throws (keepInbox=${keepInbox})`,async()=>{
  const f=await fixture(),entered=deferred(),release=deferred()
  let signal!:AbortSignal
  try {
    f.ctx.on('llm/stream',async function*(options,next){signal=options.signal!;entered.resolve();await release.promise;signal.throwIfAborted();yield*next()})
    const {agent}=await f.ctx.agents.create({sessionId:SessionId(`failed-stop-${keepInbox}`)})
    agent.followup(stopRaceMessage('Start'));await entered.promise
    const inbox=agent.inbox as any,key=keepInbox?'discardClaimed':'clear',original=inbox[key],error=new Error('inbox persistence failed')
    inbox[key]=()=>{throw error}
    try {
      assert.throws(()=>agent.cancel({kind:'user'},{keepInbox}),value=>value===error)
      assert.equal(signal.aborted,true)
    } finally {inbox[key]=original;release.resolve()}
    await agent.whenIdle()
    assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'aborted')
  } finally {release.resolve();await f.close()}
})

for(const keepInbox of [false,true])test(`same-tick Stop and fresh followup drain exactly once across 100 resumes (keepInbox=${keepInbox})`,{timeout:15000},async()=>{
  const f=await fixture(true),expected:string[]=[]
  let active=0,maximum=0
  try {
    f.ctx.on('llm/stream',async function*(options,next){active++;maximum=Math.max(maximum,active);try{await settleStopRace();yield*next()}finally{active--}})
    const {agent}=await f.ctx.agents.create({sessionId:SessionId(`repeat-stop-${keepInbox}`)})
    for(let i=0;i<100;i++) {
      const old=stopRaceMessage(`old-${i}`),fresh=stopRaceMessage(`fresh-${i}`)
      agent.followup(old);agent.cancel({kind:'user'},{keepInbox});agent.followup(fresh)
      if(keepInbox)expected.push(old.id)
      expected.push(fresh.id)
      await agent.whenIdle()
      assert.deepEqual(acceptedStopRaceInputs(agent),expected)
      assert.equal(f.requests.length,expected.length)
      assert.equal(agent.inbox.nextTurn.length+agent.inbox.nextStep.length,0)
    }
    assert.equal(maximum,1)
    assert.equal(active,0)
    const events=agent.session.snapshotEvents()
    assert.equal(events.filter(e=>e.type==='turn/end'&&e.data.reason.kind==='aborted').length,100)
    assert.equal(events.filter(e=>e.type==='turn/end'&&e.data.reason.kind==='completed').length,expected.length)
    await settleStopRace();await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal(f.requests.length,expected.length,'completion with no input must not schedule another request')
    assert.equal(agent.session.snapshotEvents().length,events.length,'idle must not create empty turns')
  } finally {await f.close()}
})

test('same-tick disposal rejects new input and never calls provider',async()=>{
  const f=await fixture()
  try {
    const {agent}=await f.ctx.agents.create({sessionId:SessionId('dispose-reserved')})
    agent.followup(stopRaceMessage('old'));agent.cancel({kind:'disposed'})
    assert.throws(()=>agent.followup(stopRaceMessage('new')),/disposed/)
    await agent.whenIdle();await settleStopRace()
    assert.equal(f.requests.length,0)
    assert.equal(agent.inbox.nextTurn.length,0)
    assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'aborted')
  } finally {await f.close()}
})
