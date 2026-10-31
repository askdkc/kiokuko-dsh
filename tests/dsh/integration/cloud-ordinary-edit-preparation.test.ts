/** Incident-shaped request through real decision decoding, finite checking and native guards.
 * Inference is scripted; this does not claim live model quality. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { OpenAIDecisionProvider } from '../../../src/dsh/decisions/openai.js'
import { TypeSafeDecisionProvider } from '../../../src/dsh/decisions/providers.js'
import { assessRequestIntent, type IntentAssessment } from '../../../src/dsh/decisions/intent-assessment.js'
import { createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds, unresolvedRequestIntent } from '../../../src/dsh/decisions/request-intent.js'
import { OnDemandIntake, TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { mountOwnedExecution } from '../../../src/dsh/owned-execution.js'
import { workingLispTask } from '../helpers/lisp-task.js'
import { openConnection } from '../../../src/db/connection.js'
import { mountNativeTools, executeNativeTool } from '../helpers/native-tools.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const [cordis, tools] = await Promise.all([load('cordis'), load('dsh-tools')])
const cliRoot = process.env.KIOKUKO_CLI_SOURCE_ROOT
for (const provider of ['typesafe', 'openai'] as const) for (const host of ['official', ...(cliRoot ? ['cli'] : [])]) for (const verdict of ['supported', 'insufficient', 'contradicted'] as const) for (const answer of verdict==='insufficient'?['confirm','cancel','empty']:['none']) {
  test(`ordinary document edit: ${host}, ${provider}, independent ${verdict}, native answer ${answer}`, { timeout: 20000 }, async t => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'ordinary-edit-'))), path = join(base, 'README.md')
    await writeFile(path, 'Original introduction.\n')
    const ctx = new cordis.Context(), fibers: any[] = [], db = openConnection(join(base, 'state.sqlite3'))
    ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
    await mountNativeTools(ctx, tools, packages, fibers)
    const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
    const session = { id: 'ordinary', header: { id: 'ordinary', cwd: base }, snapshotEvents: () => events }
    let queued:any,questions=0,turn=1
    const agent: any = { id: 'ordinary-agent', session, followup(message:any){queued=message} }
    ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined, list: () => [session] })
    if (host === 'cli') {
      const { ExecutionFenceRuntime } = await import(pathToFileURL(join(cliRoot!, 'lib/types/dsh-adapter/execution-fences.js')).href)
      fibers.push(await ctx.plugin(ExecutionFenceRuntime))
      fibers.push(await ctx.plugin({ name: 'ordinary-edit-owner', apply(c: any) {
        const fence = c.get('executionFences', false).attach({ id: 'ordinary-edit', tools: [], check: () => undefined })
        fence.protect(session.id)
      } }))
    }
    let nativeBodies = 0, providerCalls = 0, admissions = 0, readyTurn: number | undefined, task: ReturnType<typeof workingLispTask> | undefined
    const taskText = 'Simplify README.md to a short project introduction.'
    let message = { id: 'original-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: taskText }] }
    let context = createRequestIntentContext({ task: taskText, messageRefs: requestIntentMessageRefs([message], taskText) })!
    const assessments: IntentAssessment[] = []
    const config=TypedDecisionsConfig.parse({provider,openai:{model:'gpt-6-luna'}})
    const decisions = new DecisionService(config, (config, observer) => {
      const request:typeof fetch=async (_url, init) => {
        providerCalls++
        const wire = JSON.parse(String(init?.body))
        assert.ok(JSON.stringify(wire).includes(taskText), 'the assessment receives the original captured source')
        if(provider==='openai')return Response.json({model:wire.model,answers:wire.questions.map((q:any)=>({name:q.name,type:'choice',choice:verdict,confidence:1,probabilities:q.choices.map((c:any)=>({value:c.value,probability:c.value===verdict?1:0}))})),usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}}})
        return Response.json({ model: wire.model, answers: Object.fromEntries(Object.keys(wire.questions).map(id => [id, {
          type: 'choice', choice: verdict, confidence: 1,
          probabilities: { supported: verdict === 'supported' ? 1 : 0, contradicted: verdict === 'contradicted' ? 1 : 0, insufficient: verdict === 'insufficient' ? 1 : 0 },
        }])) })
      }
      return provider==='openai'?new OpenAIDecisionProvider(config.openai,async()=> 'fixture',request,observer):new TypeSafeDecisionProvider(config.typesafe,async()=> 'fixture',request,observer)
    })
    const intake = new OnDemandIntake({ validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
      existing: async () => false, classify: async () => ({ deferInference: true }),
      requestContext: async () => context,
      interpret: async () => ({ context, decision: unresolvedRequestIntent(context, 'fixture_classifier_abstained') }),
      assess: async (input, source, candidate, _refresh, userConfirmed) => {
        assert.equal(candidate.source, 'main-model'); assert.equal(candidate.providerSent, false)
        const value = await assessRequestIntent(decisions, 'ordinary-' + input.turn, source, candidate, input.signal, {userConfirmed: userConfirmed === true})
        if (value) assessments.push(value)
        return value
      },
      questions:{async ask(request:any){questions++;const q=request.questions[0];assert.match(q.question,/README.md/);if(answer==='confirm'){assert.equal(q.options[0].label,'この依頼の対象・操作・制約のまま進める');return {answers:[{id:q.id,selected:[q.options[0].label]}]}}return {answers:answer==='empty'?[]:[{id:q.id,selected:[]}]}}} as any,
      prepare: async input => { admissions++; readyTurn = input.turn; task = workingLispTask(db, { sessionId: session.id, agentId: agent.id, root: base }, 'turn-' + input.turn); return true },
      ready: (a, turn) => a === agent && readyTurn !== undefined && (turn === undefined || turn === readyTurn),
    })
    intake.mount(ctx, ctx.tools)
    const runtime: any = { withDatabase: async (fn: any) => fn(db), executionJournalDirectory: join(base, 'journal') }
    const owned = mountOwnedExecution(ctx, { runtime, resolve: e => task && e.agent === agent ? {
      runId: task.taskId, sessionId: session.id, repositoryRoot: base, workspace: 'project:lisp-tests', generation: 'fixture', agent,
    } : undefined })
    // Write/Edit bodies are bounded filesystem fixtures; kioku_write below is the real owned service.
    for (const name of ['write','edit']) ctx.tools.register({name,parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:async(args:any)=>{
      assert.equal(args.file_path,path);nativeBodies++;
      const content=name==='edit'?(await readFile(path,'utf8')).replace(args.old_string,args.new_string):args.content;
      await writeFile(path,content);return 'applied'
    }})
    const signal = () => new AbortController().signal
    let call = 0
    const execute = (name: string, args: any = {}) => executeNativeTool(ctx, packages, { callId: 'edit-' + (++call), name, arguments: args, agent, signal: signal() })
    const submit = () => ({ requestIntent: { relation: 'new', action: 'change', changeScope: 'document', evidenceRefs: requestIntentReferenceIds(context).filter(ref => !ref.startsWith('proposal:')) } })
    t.after(async () => { await intake.dispose(); await owned(); for (const f of fibers.reverse()) await f.dispose(); await ctx.fiber.dispose(); db.close(); await rm(base, { recursive: true, force: true }) })
    await intake.capture({ agent, turn: 1, step: 0, messages: [message], signal: signal() })
    for (const name of ['write', 'kioku_write', 'edit']) {
      assert.equal((await execute(name, name === 'kioku_write' ? {path:'README.md',content:'unauthorized'} : name === 'edit' ? {file_path:path,old_string:'Original introduction.',new_string:'unauthorized'} : {file_path:path,content:'unauthorized'})).isError, true)
      assert.equal(await readFile(path, 'utf8'), 'Original introduction.\n')
    }
    const label = await execute(TASK_PREPARE_TOOL, { taskType: 'writing' })
    assert.equal(label.value.prepared, false)
    assert.equal(label.value.status, 'request_interpretation_required')
    const foreign = await execute(TASK_PREPARE_TOOL, { requestIntent: { ...submit().requestIntent, evidenceRefs: ['foreign'] } })
    assert.equal(foreign.isError, true); assert.equal(providerCalls, 0)
    let prepared = await execute(TASK_PREPARE_TOOL, submit())
    assert.equal(prepared.isError, false, JSON.stringify(prepared))
    assert.equal(providerCalls, 1, 'candidate providerSent=false does not mean the independent provider was not called')
    assert.equal(assessments[0]?.semantic, verdict)
    if(verdict==='insufficient'){
      assert.equal(prepared.value.prepared,false,'uncertainty must never auto-admit');assert.equal(admissions,0);assert.equal(await readFile(path,'utf8'),'Original introduction.\n');assert.equal(questions,1)
      if(answer!=='confirm'){assert.equal(queued,undefined);assert.equal((await execute('kioku_write',{path:'README.md',content:'forbidden'})).isError,true);assert.equal(await readFile(path,'utf8'),'Original introduction.\n');assert.equal(questions,1,'cancellation cannot repeatedly ask or auto-admit');return}
      assert.equal(prepared.value.status,'clarification_answer_queued');assert.ok(queued)
      intake.finish(session,turn);turn++;events.push({type:'turn/start',seq:turn,time:turn,data:{turn}})
      context=createRequestIntentContext({task:taskText,messageRefs:requestIntentMessageRefs([message,queued],taskText),proposals:[{id:'assistant-final',revision:null,digest:'a'.repeat(64),text:'Awaiting your native answer.'}]})!
      await intake.capture({agent,turn,step:0,messages:[message,queued],signal:signal()})
      prepared=await execute(TASK_PREPARE_TOOL,submit());assert.equal(assessments.at(-1)?.outcome,'user_confirmed');assert.equal(assessments.at(-1)?.semantic,'insufficient');assert.equal(questions,1,'same confirmed question cannot loop')
    }
    assert.equal(prepared.value.prepared, verdict !== 'contradicted', JSON.stringify(prepared))
    if (verdict === 'contradicted') { assert.equal(admissions, 0); assert.equal(nativeBodies, 0); return }
    assert.equal(admissions, 1)
    for (const name of ['write', 'kioku_write', 'edit']) {
      const content = `Short introduction via ${name}.\n`
      const previous = await readFile(path, 'utf8')
      const result = await execute(name, name === 'kioku_write' ? {path:'README.md',content} : name === 'edit' ? {file_path:path,old_string:previous,new_string:content} : {file_path:path,content})
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(await readFile(path, 'utf8'), content)
    }
    const deny = ctx.tools.guard((e: any) => e.name === 'edit' ? 'native policy denied' : undefined)
    const before = await readFile(path, 'utf8')
    assert.equal((await execute('edit', { file_path: path, old_string: before, new_string: 'not allowed' })).isError, true)
    assert.equal(await readFile(path, 'utf8'), before); deny()
    const oldRefs = submit()
    intake.finish(session,turn);turn++;events.push({ type: 'turn/start', seq: turn, time: turn, data: { turn } })
    message = { ...message, id: 'next-user' }; context = createRequestIntentContext({ task: taskText, messageRefs: requestIntentMessageRefs([message], taskText) })!
    await intake.capture({ agent, turn, step: 0, messages: [message], signal: signal() })
    assert.equal((await execute(TASK_PREPARE_TOOL, oldRefs)).isError, true)
    assert.equal((await execute('write', { file_path: path, content: 'stale' })).isError, true)
    assert.equal(await readFile(path, 'utf8'), before)
  })
}
