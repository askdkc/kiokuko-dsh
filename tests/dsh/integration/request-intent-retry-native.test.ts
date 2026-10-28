import { mountNativeTools, mountToolExecutor, executeNativeTool } from '../helpers/native-tools.js'
/** Real native and PTC dispatch plus DecisionService fallback. Host admission is a
 * dependency double: this proves intake identity/permission boundaries, not model judgment. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OnDemandIntake, TASK_PREPARE_TOOL, type DemandInput } from '../../../src/dsh/on-demand-intake.js'
import { classifyRequestIntent, createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds,
  type RequestIntentContext, type RequestIntentDecision } from '../../../src/dsh/decisions/request-intent.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionError } from '../../../src/dsh/decisions/contracts.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Request-intent retry tests require the configured native DSH package root')
}
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
const text = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')

for (const mode of ['native', 'ptc'] as const) for (const action of ['research', 'verify'] as const) {
  test(`${mode}: DECISION_AUTH, rejected no-Goal scope changes and explicit new/${action} retry preserve admission and native policy`,
    { skip: !available, timeout: 30_000 }, async () => {
    const [cordis, tools, prompt, sessions] = await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt', 'dsh-session'].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'request-intent-retry-')))
    const ctx = new cordis.Context(), fibers: any[] = []
    let intake: OnDemandIntake | undefined, restoreRuntime: (() => void) | undefined
    const admissions: Array<{ input: DemandInput; taskType: string; intent: RequestIntentDecision | undefined; context: RequestIntentContext | undefined }> = []
    let runtimePrograms = 0, bodies = 0, ready = false, calls = 0, providerCalls = 0
    const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml',
      'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: '/not-used-in-auth-fixture' } }),
    () => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 },
      async evaluate() { providerCalls++; throw new DecisionError('AUTH') } }))
    try {
      fibers.push(await ctx.plugin(prompt.default, {}))
      if (mode === 'ptc') {
        for (const name of ['dsh-session-projection', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local',
          'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node']) {
          const plugin = await load(name)
          const config = name === 'dsh-fs-local' ? { cwd: root } : name === 'dsh-working-directory' ? { defaultDirectory: root }
            : name === 'dsh-sandbox-policy' ? { mode: 'read-only', workspaceRoot: root }
              : name === 'dsh-ptc-runtime-node' ? { timeoutMs: 10000 } : {}
          fibers.push(await ctx.plugin(plugin.default, config))
        }
        const runtime = ctx.get('ptcRuntime', false), original = runtime.run
        runtime.run = function (...args: any[]) { runtimePrograms++; return original.apply(this, args) }
        restoreRuntime = () => { runtime.run = original }
      }
      await mountToolExecutor(ctx, tools, packages, mode, fibers)
      const session = sessions.Session.create(sessions.SessionId('intent-retry'), [],
        { version: 4, id: 'intent-retry', createdAt: 1, isSeeded: false, cwd: root })
      const agent = { id: 'intent-retry-agent', session, ctx }
      const messages = ['Inspect src/parser.ts behavior.', 'Verify only; do not edit files, install packages or deploy.']
        .map((value, index) => ({ id: `human-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: value }] }))
      const task = messages.map(message => message.content[0]!.text).join('\n')
      const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task),
        proposals: [{ id: 'inspection', revision: 2, digest: 'a'.repeat(64), text: 'Inspect parser behavior without editing files.' }] })!
      const initialContext = structuredClone(context)
      intake = new OnDemandIntake({ validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
        existing: async () => false, classify: async () => ({ deferInference: true }),
        interpret: async () => ({ context, decision: (await classifyRequestIntent(decisions, 'auth-fallback', context, signal()))! }),
        prepare: async (input, taskType, intent, boundContext) => {
          admissions.push({ input, taskType, intent, context: boundContext }); ready = true; return true
        }, ready: candidate => candidate === agent && ready,
      })
      intake.mount(ctx, ctx.tools)
      const releaseProbe = ctx.tools.register({ name: 'effect_probe', parameters: {}, output: { schema: {}, render: () => [] },
        execute() { bodies++; return 'unexpected effect' } })
      const input = { agent, turn: 1, step: 0, messages, signal: signal() }
      await intake.capture(input)
      const initial = intake.snapshot(session.id)!
      assert.equal(initial.requestIntent?.unresolvedReason, 'DECISION_AUTH')
      assert.equal(initial.requestIntent?.source, 'unresolved'); assert.equal(providerCalls, 1)
      const guidance = JSON.stringify(await intake.answerMessages(input, messages))
      const refs = requestIntentReferenceIds(context)
      const name = mode === 'ptc' ? 'run_code' : TASK_PREPARE_TOOL
      const invoke = (args: unknown, overrides: Record<string, unknown> = {}) => executeNativeTool(ctx, packages, {
        callId: `intent-${++calls}`, name, arguments: mode === 'ptc'
          ? { description: 'Prepare requested work only', code: `return await tools.prepare_requested_work(${JSON.stringify(args)})` } : args,
        agent, signal: signal(), ...overrides,
      })
      const request = (relation: string, evidenceRefs = refs) => ({ requestIntent: { relation, action, evidenceRefs } })
      const unchanged = () => {
        assert.equal(admissions.length, 0); assert.equal(bodies, 0); assert.equal(runtimePrograms, 0)
        assert.deepEqual(intake!.snapshot(session.id), initial)
      }
      for (const relation of ['scope_change']) {
        const rejected = await invoke(request(relation,refs.filter(ref=>!ref.startsWith('proposal:'))))
        assert.equal(rejected.isError, true)
        assert.match(text(rejected), new RegExp(`Request relation ${relation} cannot be used without an active Goal`))
        assert.match(text(rejected), /relation=new/)
        assert.doesNotMatch(text(rejected), /stale revision|another request/)
        unchanged()
      }
      assert.match(guidance, /no active Goal/); assert.match(guidance, /relation=new/); assert.match(guidance, /verify for verification/)
      for (const [evidenceRefs, expected] of [[refs.slice(1), /missing required current/],
        [[...refs, 'foreign-ref'], /another request, stale revision/],
        [requestIntentReferenceIds({ ...context, proposals: context.proposals.map(proposal => ({ ...proposal, revision: 1 })) }), /stale revision/]] as const) {
        const rejected = await invoke(request('new', [...evidenceRefs]))
        assert.equal(rejected.isError, true); assert.match(text(rejected), expected); unchanged()
      }
      assert.equal((await invoke(request('new', []))).isError, true); unchanged()
      context.proposals[0]!.revision = 3
      const stale = await invoke(request('new'))
      assert.equal(stale.isError, true); assert.match(text(stale), /context is stale/); unchanged()
      context.proposals[0]!.revision = 2
      const deny = ctx.tools.guard((execution: any) => execution.name === name ? 'native preparation denial' : undefined)
      try { assert.equal((await invoke(request('new'))).isError, true); unchanged() } finally { deny() }
      const ask = ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'native approval required' }))
      try { assert.equal((await invoke(request('new'))).isError, true); unchanged() } finally { ask() }
      const result = await invoke(request('new'), { callId: 'corrected' })
      assert.equal(result.isError, false, JSON.stringify(result))
      const receipt = mode === 'ptc' ? result.value.result : result.value
      assert.equal(receipt.permissions, 'unchanged_native_policy')
      if (mode === 'ptc') assert.equal(receipt.programExecuted, false)
      assert.equal(receipt.originalTask, task); assert.equal(receipt.requestIntent.action, action)
      assert.equal(receipt.requestIntent.relation, 'new'); assert.equal(admissions.length, 1)
      const admission = admissions[0]!
      assert.equal(admission.taskType, action === 'verify' ? 'review' : 'research')
      assert.deepEqual(admission.input.messages, messages); assert.deepEqual(admission.context, initialContext)
      assert.deepEqual(admission.intent?.evidence.messageRefs, initialContext.messageRefs)
      assert.equal(admission.intent?.evidence.runId, undefined)
      assert.equal((await invoke(request('new'), { callId: 'corrected' })).isError, true, 'same call identity cannot replay preparation')
      const denyWork = ctx.tools.guard(() => 'native execution denial remains authoritative')
      try {
        const denied = await executeNativeTool(ctx, packages, { callId: 'forbidden-work', name: mode === 'ptc' ? 'run_code' : 'effect_probe',
          arguments: mode === 'ptc' ? { description: 'Attempt work', code: 'return await tools.effect_probe({})' } : {}, agent, signal: signal() })
        assert.equal(denied.isError, true)
      } finally { denyWork(); releaseProbe() }
      assert.equal(admissions.length, 1); assert.equal(bodies, 0); assert.equal(runtimePrograms, 0)
    } finally {
      await intake?.dispose(); restoreRuntime?.()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('KDSH-REVIEW-GATE-RECOVERY-001: actual PTC preparation carrier reports unresolved interpretation without evaluating code',{skip:!available},async()=>{
  const [cordis,tools,prompt,sessions]=await Promise.all(['cordis','dsh-tools','dsh-system-prompt','dsh-session'].map(load))
  const {unresolvedRequestIntent}=await import('../../../src/dsh/decisions/request-intent.js')
  const root=realpathSync(await mkdtemp(join(tmpdir(),'review-guidance-ptc-'))),ctx=new cordis.Context(),fibers:any[]=[]
  let intake:OnDemandIntake|undefined,ready=false,admissions=0
  try{
    fibers.push(await ctx.plugin(prompt.default,{}))
    for(const name of ['dsh-session-projection','dsh-fs-local','dsh-working-directory','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node']){
      const plugin=await load(name),config=name==='dsh-fs-local'?{cwd:root}:name==='dsh-working-directory'?{defaultDirectory:root}:name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:10000}:{}
      fibers.push(await ctx.plugin(plugin.default,config))
    }
    ctx.get('ptcRuntime',false).run=()=>assert.fail('the preparation-only carrier must not evaluate a program')
    await mountToolExecutor(ctx, tools, packages, 'ptc', fibers)
    const session=sessions.Session.create(sessions.SessionId('review-guidance-ptc'),[],{version:4,id:'review-guidance-ptc',createdAt:1,isSeeded:false,cwd:root})
    const agent={id:'review-guidance-agent',session,ctx},messages=[{id:'current-review',role:'user',source:{kind:'user'},content:[{type:'text',text:'Review src/parser.ts without changing files.'}]}]
    const task=messages[0]!.content[0]!.text,context=createRequestIntentContext({task,messageRefs:requestIntentMessageRefs(messages,task)})!
    intake=new OnDemandIntake({validate:async()=>{},existing:async()=>false,classify:async()=>({deferInference:true}),interpret:async()=>({context,decision:unresolvedRequestIntent(context,'decision_service_disabled')}),prepare:async()=>{admissions++;ready=true;return true},ready:candidate=>candidate===agent&&ready})
    intake.mount(ctx,ctx.tools);await intake.capture({agent,turn:1,step:0,messages,signal:signal()})
    const receipt=await executeNativeTool(ctx, packages, {name:'run_code',callId:'carrier',arguments:{description:'Prepare requested work only',code:'return await tools.prepare_requested_work({"taskType":"review"})'},agent,signal:signal()})
    assert.equal(receipt.isError,false,text(receipt))
    assert.equal(receipt.value.result.programExecuted,false)
    assert.equal(receipt.value.result.requestInterpretation.state,'required')
    assert.equal(receipt.value.result.requestInterpretation.nextAction,'submit_current_request_intent')
    assert.deepEqual(receipt.value.result.requestInterpretation.currentReferences,requestIntentReferenceIds(context))
    assert.equal(receipt.value.result.prepared,false)
    assert.equal(admissions,0)
    const corrected=await executeNativeTool(ctx,packages,{name:'run_code',callId:'corrected',arguments:{description:'Prepare current verification only',code:`return await tools.prepare_requested_work(${JSON.stringify({requestIntent:{relation:'new',action:'verify',evidenceRefs:requestIntentReferenceIds(context)}})})`},agent,signal:signal()})
    assert.equal(corrected.isError,false,text(corrected))
    assert.equal(corrected.value.result.prepared,true)
    assert.equal(corrected.value.result.programExecuted,false)
    assert.equal(admissions,1)
  }finally{await intake?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
