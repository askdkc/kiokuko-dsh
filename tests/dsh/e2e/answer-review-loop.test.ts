import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { mountCore } from '../../../src/dsh/core/host.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'
import { serveLaya, layaV1Reply } from '../helpers/laya.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packageRoot) throw new Error('Answer review coverage requires the pinned native DSH package runtime')
for (const host of ['full', 'core'] as const) for (const scenario of ['finding','tool-evidence','paired-candidate','paired-shadow','no-finding','unavailable','off','superseded','queued-superseded','claimed-superseded','cancelled'] as const) test(`native ${host}: answer review ${scenario}`, {
  skip: !packageRoot ? 'requires pinned native DSH package runtime' : false, timeout: 30000,
}, async t => {
  const paired = scenario === 'paired-candidate' || scenario === 'paired-shadow'
  const newRequest = scenario === 'superseded' || scenario === 'queued-superseded' || scenario === 'claimed-superseded'
  const originalRequest = 'Look up the sum of two plus two using verify_sum. Explain the result.'
  const followupRequest = 'Research addition using verify_sum.'
  const correction = scenario === 'finding' || scenario === 'tool-evidence' || scenario === 'paired-candidate'
  const [cordis,llm,session,projection,prompt,tools,agents,loop,skills] = await Promise.all(
    ['cordis','dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-skill']
      .map(name => import(pathToFileURL(join(packageRoot!,'@deepseek-ai',name,'lib/index.js')).href)))
  const ctx = new cordis.Context(), fibers: any[] = []
  const root = await mkdtemp(join(tmpdir(),'kiokuko-answer-native-')), databasePath = join(root,'state.sqlite3')
  let dispose: (() => Promise<void>) | undefined, questions = 0, reviewCalls = 0, taskTypeCalls = 0
  let toolCalls=0, taskTypeQuestions=0; const reviewInputs: any[]=[]
  let onReview: (() => void) | undefined
  const errors: unknown[] = []; let reviewStatus: () => unknown = () => undefined
  const socket = await serveLaya(t, request => {
    if(request.op==='predict' && request.questions?.request_fit) reviewInputs.push(JSON.parse(request.state))
    if(scenario==='unavailable' && request.op==='predict' && request.questions?.request_fit) {
      reviewCalls++
      return {version:1,ok:false,error:{code:'model_unavailable'}}
    }
    return layaV1Reply(request, (id, choices) => {
    if (id === 'task-type') { taskTypeCalls++; return 'research' }
    if (id.startsWith('grounding:')) return 'contradicted'
    if (id === 'request_fit') { reviewCalls++; onReview?.(); onReview = undefined; return paired || scenario === 'no-finding' || reviewCalls > 1 ? 'satisfied' : 'finding' }
    return choices.includes('abstain') ? 'abstain' : choices[0]!
  })})
  try {
    for (const [plugin, config] of [[llm.default],[session.default],[projection.default],[prompt.default,{persona:''}],[tools.default],[agents.default],[skills.default],[loop.default,{agents:[]}]]) {
      const fiber = ctx.plugin(plugin,config); fibers.push(fiber); await fiber
    }
    const ui = ctx.plugin({ name:'answer-test-ui', apply(c: any) { return c.provide('userQuestions',{ ask: async (request: any) => {
      questions++
      return { answers:request.questions.map((q:any)=>{
        // Explicit preparation supplies the advisory type; only execution choice
        // may ask a question, and automatic correction must not reopen it.
        if(q.id==='taskType')taskTypeQuestions++
        assert.notEqual(q.id,'taskType','explicit preparation must not reopen task classification')
        const label = '通常実行'
        assert.ok(q.options?.some((option:any)=>option.label===label),JSON.stringify(q))
        return {id:q.id,selected:[label]}
      }) }
    } }) } }); fibers.push(ui); await ui
    const config = { ...(scenario==='off'?{answerReview:{mode:'off' as const}}:{}), typedDecisions:{...(paired ? {groundingReview:{mode:scenario==='paired-shadow'?'shadow' as const:'candidate' as const,policyVersion:'grounding-pairs-v1' as const,minProbability:.6,minMargin:.25}}:{}),provider:'laya-coreml' as const,'laya-coreml':{socketPath:socket.path}} }
    if (host === 'full') {
      const adapter = createDshHostAdapter(ctx,{...config,repositoryRoot:root,databasePath,agenticReplay:{enabled:false},memoryReview:{mode:'off'},deepPlanning:{enabled:false},
        llm:{async *stream(){throw new Error('No auxiliary LLM in this fixture')}}})
      reviewStatus = () => adapter.host.decisions?.status()
      const composition = await mountDshComposition(ctx,adapter.host)
      dispose = async()=>{composition.stopIngress();await adapter.dispose();await composition.dispose()}
    } else {
      const handle = await mountCore(ctx,{...config,repositoryRoot:root,databasePath}); dispose = ()=>handle.dispose()
    }
    ctx.on('agent/error',(event:any)=>errors.push(event.error))
    const mock = nativeMock(llm)
    const verifyWork = (number: number) => () => {
      const check = openConnection(databasePath)
      try {
        assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()!.n,number,'each human request owns its own admitted work')
        assert.equal(check.prepare("SELECT COUNT(*) AS n FROM ledger_runs WHERE status='active'").get()!.n,1)
      } finally { check.close() }
      return mock.toolCallResponse(number===1?'check':'check-followup','verify_sum',{})
    }
    let expectedRequests = newRequest ? 5 : correction ? 4 : 3
    const script: any[] = [
      (request: any) => {
        const check = openConnection(databasePath)
        try {
          assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()!.n,0,'the first human request starts without eager intake')
        } finally { check.close() }
        assert.equal(questions,0,'answer-first ingress does not ask execution questions')
        assert.ok(request.tools.some((tool:any)=>tool.name===TASK_PREPARE_TOOL))
        return mock.toolCallResponse('prepare-1',TASK_PREPARE_TOOL,{taskType:'research'})
      },
      verifyWork(1),
      mock.textResponse(paired ? 'The answer is five. [tool-call:check]' : 'The answer is five.'),
    ]
    if(newRequest) script.push((request: any) => {
      const check = openConnection(databasePath)
      let admitted: boolean
      try {
        const runs = check.prepare('SELECT status FROM ledger_runs').all()
        admitted = runs.length===2
        assert.equal(runs.length,admitted?2:1)
        const retained = host==='full' && scenario!=='claimed-superseded'
        assert.equal(runs.filter(run=>run.status==='active').length,admitted || retained ? 1 : 0,
          'queued full-host work retains its owner until preparation; completed and core turns retire it first')
      } finally { check.close() }
      // Cancellation may leave the old execution owner in place until the
      // existing-owner admission path retires it and admits the new request.
      // That path needs no second preparation call. A fresh answer-first turn does.
      if(admitted) return verifyWork(2)()
      assert.ok(request.tools.some((tool:any)=>tool.name===TASK_PREPARE_TOOL))
      expectedRequests++
      script.unshift(verifyWork(2))
      return mock.toolCallResponse('prepare-2',TASK_PREPARE_TOOL,{taskType:'research'})
    },mock.textResponse('The checked sum is four.'))
    else if(correction) script.push(mock.textResponse('Correction: the answer is four.'))
    const model = new mock.MockAdapter(script)
    ctx.llm.registerAdapter(['ordinary'],model)
    ctx.tools.register({name:'verify_sum',description:'Return a known sum.',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_args:unknown,value:string)=>[{type:'text',text:value}]},execute:async()=>{toolCalls++;return 'Verified sum: four'}})
    const agent = await ctx.agentLoop.create(session.SessionId(`answer-${host}`),{provider:'ordinary',model:'mock'},{cwd:root})
    if (scenario === 'superseded') onReview = () => queueMicrotask(() => agent.followup(llm.createUserMessage({content:[{type:'text',text:followupRequest}],source:{kind:'user'}})))
    if (scenario === 'queued-superseded' || scenario === 'claimed-superseded') {
      let injected = false
      ctx.on(scenario==='queued-superseded'?'agent/inbox/inserted':'agent/inbox/claimed', (event: any) => {
        if(event.agent===agent && event.message?.source?.form==='answer-review' && !injected) {
          injected=true
          agent.followup(llm.createUserMessage({content:[{type:'text',text:followupRequest}],source:{kind:'user'}}))
        }
      })
    }
    if (scenario === 'cancelled') onReview = () => queueMicrotask(() => agent.cancel({kind:'test-stop'}))
    agent.followup(llm.createUserMessage({content:[{type:'text',text:originalRequest}],source:{kind:'user'}}))
    await agent.whenIdle()
    const questionCount = questions
    // The review intentionally finishes after the first native idle notification.
    for (let i=0;i<200;i++) {
      if(model.requests.length>=expectedRequests) {
        await agent.whenIdle()
        const check=openConnection(databasePath)
        const pending=check.prepare("SELECT 1 FROM ledger_runs WHERE status='active' LIMIT 1").get();check.close()
        if(!pending)break
      }
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    assert.deepEqual(errors,[])
    const db=openConnection(databasePath)
    try {
      const rows=db.prepare('SELECT * FROM dsh_answer_reviews').all()
      assert.equal(model.requests.length,expectedRequests,JSON.stringify({rows,status:reviewStatus(),events:agent.session.snapshotEvents().map((e:any)=>({type:e.type,seq:e.seq,turn:e.data?.turn,reason:e.data?.reason}))}))
      if(!newRequest) assert.equal(questions,questionCount,'correction does not reopen intake or execution choice')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()!.n,newRequest ? 2 : 1)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enno_contracts').get()!.n,0)
      assert.equal(taskTypeQuestions,0,'explicit preparation supplies the advisory task type')
      assert.equal(taskTypeCalls,newRequest?2:1,'each human request invokes classification once; corrective model requests do not');assert.equal(rows.length,scenario==='off'?0:newRequest ? 2 : 1);assert.equal(reviewCalls,scenario==='off'?0:newRequest ? 2 : 1)
      assert.ok(rows.every(row=>row.status==='closed'))
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_runs WHERE status='active'").get()!.n,0)
      if(host==='full') assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalizations').get()!.n,newRequest?2:1)
      if(expectedRequests>=2) assert.equal(model.requests.at(-1).provider,model.requests[0].provider);if(expectedRequests>=2) assert.equal(model.requests.at(-1).model,model.requests[0].model)
      const answers=agent.session.snapshotEvents().filter((event:any)=>event.type==='assistant/message' && event.data.message.content.some((b:any)=>b.type==='text'))
      assert.equal(answers.length,newRequest || correction ? 2 : 1);assert.match(JSON.stringify(answers[0]),/five/)
      assert.equal(toolCalls,newRequest?2:1,'only independently requested work executes tools')
      if(scenario==='finding' || scenario==='tool-evidence') assert.match(JSON.stringify(model.requests.at(-1).messages),/unverified suggestions/)
      if(newRequest) for(const request of model.requests.slice(3)) assert.doesNotMatch(JSON.stringify(request.messages),/unverified suggestions/)
      if(paired) { assert.equal(toolCalls,1); if(scenario==='paired-candidate') assert.deepEqual(model.requests.at(-1).tools,[]) }
      if(scenario!=='off') assert.equal(reviewInputs[0].task,originalRequest,'review retains the original tool-backed request')
      if(newRequest) assert.equal(reviewInputs[1].task,followupRequest,'superseding work gets its own review scope')
      if(scenario==='tool-evidence') assert.match(JSON.stringify(reviewInputs[0].evidence),/Verified sum: four/)
      assert.doesNotMatch(JSON.stringify(rows),/The answer is five|Correction: the answer/)
    } finally {db.close()}
  } finally {await dispose?.();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
