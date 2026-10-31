import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { TaskStartup, TASK_STARTUP_OPTIONS, parseTaskStartupAnswer } from '../../../src/dsh/task-startup.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionService, databaseDecisionStore } from '../../../src/dsh/decisions/service.js'
import { dshTurnRequestId } from '../../../src/dsh/intake-profile-resolver.js'
import { LispCodingPreparation } from '../../../src/dsh/lisp/coding-preparation.js'
import { ExecutionSelectionPending } from '../../../src/dsh/execution-pending.js'
import type { DshUserQuestions } from '../../../src/dsh/intake-questions.js'
import { mountDecisionCommand } from '../../../src/dsh/decisions/host.js'

const signal = () => new AbortController().signal
const agent = { id: 'agent', session: { id: 'session' } }
const request = (turn = 1, task = 'Implement the requested parser') => ({ agent, sessionId: 'session', turn, task, taskType: 'build' as const, signal: signal() })
const batch = { purpose: 'lisp', state: {}, questions: [{ id: 'check', instructions: 'Check', choices: [
  { id: 'yes', description: 'Yes' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }
async function setup(t: import('node:test').TestContext, configured: Record<string, unknown> = {}) {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:')); t.after(() => db.close())
  db.exec(await readFile(new URL('../../../migrations/021_typed_decisions.sql', import.meta.url), 'utf8'))
  const store = databaseDecisionStore({ withDatabase: async (op: any) => op(db) })
  let calls = 0, enabled = false, activations = 0, legacyAsks = 0
  const base = TypedDecisionsConfig.parse(configured)
  const make = () => new DecisionService(base, config => ({ capabilities: { maxQuestions: 64, maxChoices: 255, maxBytes: 262144 },
    evaluate: async input => { calls++; return { answers: input.questions.map(q => ({ id: q.id, status: 'selected' as const, choiceId: 'yes' })),
      provider: config.provider, requestedModel: 'fixture', policyVersion: 'fixture' } } }), store)
  const preparation = new LispCodingPreparation({ identity: () => ({ sessionId: 'session', root: '/repo' }), enabled: () => enabled,
    activate: async () => { activations++; enabled = true }, deactivate: async () => { enabled = false },
    choose: async () => { legacyAsks++; return { status: 'unavailable', reason: 'Unexpected second question' } } })
  const lisp = { prepare: async () => ({ taskType: 'build' as const }), enabled: () => enabled, discussing: () => false,
    selectTask: preparation.selectTask.bind(preparation), manualSelected: async () => false }
  return { db, make, lisp, preparation, counts: () => ({ calls, enabled, activations, legacyAsks }) }
}
for (let index = 0; index < 4; index++) test(`startup combination ${TASK_STARTUP_OPTIONS[index]} binds before inference and asks once`, async t => {
  const f = await setup(t), decisions = f.make(); let asks = 0
  const startup = new TaskStartup({ decisions, root: () => '/repo', lisp: () => f.lisp, questions: { ask: async q => {
    asks++; assert.equal(f.counts().calls, 0)
    return { answers: [{ id: q.questions[0].id, selected: [TASK_STARTUP_OPTIONS[index]!] }] }
  } } })
  await Promise.all([startup.prepare(request()), startup.prepare(request())])
  const bound = await decisions.bind(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.equal(bound.mode, index < 2 ? 'auto' : 'off'); assert.equal(f.counts().enabled, index % 2 === 0)
  await f.preparation.prepare(request())
  assert.equal(f.counts().legacyAsks, 0, 'ordinary Lisp must not repeat the startup UI')
  const outcome = await decisions.evaluate(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }), batch, signal())
  assert.equal(outcome.status, index < 2 ? 'completed' : 'fallback'); assert.equal(f.counts().calls, index < 2 ? 1 : 0)
  await startup.prepare(request()); assert.equal(asks, 1)
})

test('restart, explicit continuation and new task keep distinct durable choices', async t => {
  const f = await setup(t); let asks = 0
  const questions: DshUserQuestions = { ask: async q => { asks++; return { answers: [{ id: q.questions[0].id, selected: [TASK_STARTUP_OPTIONS[3]] }] } } }
  await new TaskStartup({ decisions: f.make(), root: () => '/repo', lisp: () => f.lisp, questions }).prepare(request())
  const decisions = f.make(), restarted = new TaskStartup({ decisions, root: () => '/repo', lisp: () => f.lisp, questions })
  await restarted.prepare(request()); assert.equal(asks, 1)
  await restarted.prepare(request(2, 'keep going')); assert.equal(asks, 1)
  assert.equal((await decisions.bind(dshTurnRequestId({ dshSessionId: 'session', turn: 2 }))).mode, 'off')
  await restarted.prepare(request(3, 'Implement a different project')); assert.equal(asks, 2)
  assert.equal(f.counts().activations, 0)
})

test('cancel and Skip persist without starting work, including after restart', async t => {
  for (const selected of [[TASK_STARTUP_OPTIONS[4]], []]) {
    const f = await setup(t); let asks = 0
    const questions: DshUserQuestions = { ask: async q => { asks++; return { answers: [{ id: q.questions[0].id, selected }] } } }
    const create = () => new TaskStartup({ decisions: f.make(), root: () => '/repo', lisp: () => f.lisp, questions })
    await assert.rejects(create().prepare(request()), { code: 'ASK_CANCELLED' })
    await assert.rejects(create().prepare(request()), { code: 'ASK_CANCELLED' })
    assert.equal(asks, 1); assert.deepEqual(f.counts(), { calls: 0, enabled: false, activations: 0, legacyAsks: 0 })
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM dsh_decision_bindings WHERE request_id LIKE 'dsh-turn-%'").get()!.n, 0)
  }
})

test('invalid and cross-question answers never bind or enable', async t => {
  const f = await setup(t)
  for (const answers of [[], [{ id: 'other', selected: [TASK_STARTUP_OPTIONS[0]] }]]) {
    const startup = new TaskStartup({ decisions: f.make(), root: () => '/repo', lisp: () => f.lisp,
      questions: { ask: async () => ({ answers } as any) } })
    await assert.rejects(startup.prepare(request()), ExecutionSelectionPending)
  }
  assert.equal(f.counts().activations, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_bindings').get()!.n, 0)
  assert.equal(parseTaskStartupAnswer({ answers: [{ id: 'x', selected: ['1', '2'] }] }, 'x'), undefined)
})

test('new instruction cancels pending old UI; late old answer cannot enable Lisp', { timeout: 5000 }, async t => {
  const f = await setup(t), decisions = f.make()
  let resolve!: (v: any) => void, oldId = '', asks = 0
  let ready!: () => void; const asked = new Promise<void>(r => { ready = r })
  const startup = new TaskStartup({ decisions, root: () => '/repo', lisp: () => f.lisp, questions: { ask: async q => {
    asks++
    if (asks === 1) { oldId = q.questions[0].id; ready(); return new Promise(r => { resolve = r }) }
    return { answers: [{ id: q.questions[0].id, selected: [TASK_STARTUP_OPTIONS[3]] }] }
  } } })
  const old = startup.prepare(request()); const rejected = assert.rejects(old)
  await asked
  await startup.prepare(request(1, 'Implement a new scoped task'))
  await rejected
  resolve({ answers: [{ id: oldId, selected: [TASK_STARTUP_OPTIONS[0]] }] })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(f.counts().activations, 0); assert.equal(f.counts().calls, 0)
})

test('headless preserves configured OFF, accepts explicit both ON, and runtime failure remains retryable', async t => {
  const f = await setup(t, { mode: 'off' }), decisions = f.make()
  await new TaskStartup({ decisions, root: () => '/repo', lisp: () => f.lisp }).prepare(request())
  assert.equal((await decisions.bind(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))).mode, 'off')
  assert.equal(f.counts().enabled, false)
  const g = await setup(t, { startup: { decision: true, lisp: true } })
  await new TaskStartup({ decisions: g.make(), root: () => '/repo', lisp: () => g.lisp }).prepare(request())
  assert.equal(g.counts().enabled, true)
  const h = await setup(t); let attempts = 0
  const runtime = { ...h.lisp, selectTask: async () => { attempts++; if (attempts === 1) throw new Error('runtime unavailable') } }
  const options = { decisions: h.make(), root: () => '/repo', lisp: () => runtime,
    questions: { ask: async (q: any) => ({ answers: [{ id: q.questions[0].id, selected: [TASK_STARTUP_OPTIONS[0]] }] as const }) } }
  const retryable = new TaskStartup(options)
  await assert.rejects(retryable.prepare(request()), /runtime unavailable/)
  await retryable.prepare(request()); assert.equal(attempts, 2)
})

test('native question cancellation is durable and a changed root cannot consume an old answer', async t => {
  const f = await setup(t);let asks=0
  const create=()=>new TaskStartup({decisions:f.make(),root:()=>'/repo',lisp:()=>f.lisp,questions:{ask:async()=>{asks++;throw Object.assign(new Error('native cancel'),{code:'ASK_CANCELLED'})}}})
  await assert.rejects(create().prepare(request()),{code:'ASK_CANCELLED'})
  await assert.rejects(create().prepare(request()),{code:'ASK_CANCELLED'});assert.equal(asks,1)
  const g = await setup(t);let root='/repo'
  const startup=new TaskStartup({decisions:g.make(),root:()=>root,lisp:()=>g.lisp,questions:{ask:async q=>{
    root='/other';return{answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[0]]}]}
  }}})
  await assert.rejects(startup.prepare(request()),{code:'ASK_CANCELLED'})
  assert.equal(g.counts().activations,0)
  assert.equal(g.db.prepare('SELECT count(*) AS n FROM dsh_decision_bindings').get()!.n,0)
})

test('legacy bound requests keep their backend and mode; incompatible changes cannot dispatch', async t=>{
  const f=await setup(t),decisions=f.make(),id=dshTurnRequestId({dshSessionId:'session',turn:1})
  const original=await decisions.bind(id)
  const startup=new TaskStartup({decisions,root:()=>'/repo',lisp:()=>f.lisp,questions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[1]]}]})}})
  await startup.prepare(request());assert.deepEqual(await decisions.bind(id),original)
  const g=await setup(t),other=g.make();await other.bind(id)
  await assert.rejects(new TaskStartup({decisions:other,root:()=>'/repo',lisp:()=>g.lisp,questions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[3]]}]})}}).prepare(request()),/immutable decision binding/)
  assert.equal(g.counts().calls,0);assert.equal(g.counts().activations,0)
})

test('status separates project defaults from this request OFF without inference or new bindings',async t=>{
  const f=await setup(t),decisions=f.make()
  await new TaskStartup({decisions,root:()=>'/repo',lisp:()=>f.lisp,questions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[3]]}]})}}).prepare(request())
  let command:any;mountDecisionCommand({register:c=>{command=c;return()=>{}}},decisions)
  const before=f.db.prepare('SELECT count(*) AS n FROM dsh_decision_bindings').get()!.n
  const result=await command.handler({rawInput:'status',signal:signal(),agent:{session:{id:'session',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]}}})
  const view=JSON.parse(result.text);assert.equal(view.mode,'auto');assert.equal(view.requestSettings.mode,'off')
  assert.deepEqual(view.requestSettings.startup,{decision:false,lisp:false});assert.equal(f.counts().calls,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_bindings').get()!.n,before)
})

test('explicit startup settings do not wait for a headless question service',async t=>{
  const f=await setup(t,{startup:{decision:true,lisp:true}});let asks=0
  await new TaskStartup({decisions:f.make(),root:()=>'/repo',lisp:()=>f.lisp,questions:{ask:async()=>{asks++;return new Promise(()=>{})}}}).prepare(request())
  assert.equal(asks,0);assert.equal(f.counts().enabled,true)
})


test('a configured default preselects the card and still allows an override', async t => {
  const f = await setup(t); let asked: any
  const startup = new TaskStartup({ decisions: f.make(), root: () => '/repo', lisp: () => f.lisp,
    defaults: () => ({ decision: 'on', lisp: 'off' }),
    questions: { ask: async q => {
      asked = q.questions[0]
      // Only this option carries the native preset marker.
      assert.deepEqual(asked.options.map((o: any) => o.label), [
        'decision ON / Lisp ON', 'decision ON / Lisp OFF (Recommended)',
        'decision OFF / Lisp ON', 'decision OFF / Lisp OFF', '取消・作業を保持',
      ])
      // The human overrides the preset with a different pair.
      return { answers: [{ id: asked.id, selected: ['decision OFF / Lisp ON'] }] }
    } }
  })
  await startup.prepare(request())
  const bound = await f.make().bind(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.deepEqual(bound.startup, { decision: false, lisp: true }, 'the explicit answer wins over the preset')
  assert.equal(f.counts().enabled, true)
})

test('a configured default decides when no question service can ask', async t => {
  const f = await setup(t)
  const startup = new TaskStartup({ decisions: f.make(), root: () => '/repo', lisp: () => f.lisp,
    defaults: () => ({ decision: 'on', lisp: 'on' }) })
  await startup.prepare(request())
  const bound = await f.make().bind(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.deepEqual(bound.startup, { decision: true, lisp: true })
  assert.equal(f.counts().enabled, true, 'the configured Lisp default enables the selected route')
  // `ask` keeps the headless behaviour rather than inventing a preference.
  const g = await setup(t, { mode: 'off' })
  await new TaskStartup({ decisions: g.make(), root: () => '/repo', lisp: () => g.lisp,
    defaults: () => ({ decision: 'ask', lisp: 'ask' }) }).prepare(request())
  const kept = await g.make().bind(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.equal(kept.mode, 'off', 'ask preserves the configured mode')
  assert.equal(g.counts().enabled, false)
})

test('explicit manual OFF after startup ON overrides inherited continuation without changing the prior binding', async t => {
  const f=await setup(t), decisions=f.make(); let asks=0, override: {choice:'no';answerRef:string}|undefined
  const lisp={...f.lisp,manualOverride:()=>override}
  const startup=new TaskStartup({decisions,root:()=>'/repo',lisp:()=>lisp,questions:{ask:async q=>{
    asks++;return{answers:[{id:q.questions[0].id,selected:['decision OFF / Lisp ON']}]}
  }}})
  await startup.prepare(request())
  assert.equal(f.counts().enabled,true);assert.equal(f.counts().activations,1)
  override={choice:'no',answerRef:'manual-session:explicit-off'}
  await startup.prepare(request(2,'keep going'))
  assert.equal(asks,1,'continuation must retain the human command without another question')
  assert.equal(f.counts().enabled,false,'an inherited ON may not reactivate explicitly disabled Lisp')
  assert.equal(f.counts().activations,1)
  assert.equal((await decisions.bind(dshTurnRequestId({dshSessionId:'session',turn:1}))).startup!.lisp,true)
  assert.equal((await decisions.bind(dshTurnRequestId({dshSessionId:'session',turn:2}))).startup!.lisp,false)
})

test('native clarification reuses its exact original startup binding, not the latest task choice', async t => {
  const f=await setup(t),decisions=f.make();let asks=0
  const startup=new TaskStartup({decisions,root:()=>'/repo',lisp:()=>f.lisp,questions:{ask:async q=>{
    asks++;return {answers:[{id:q.questions[0].id,selected:[asks===1?TASK_STARTUP_OPTIONS[1]:TASK_STARTUP_OPTIONS[0]]}]}
  }}})
  await startup.prepare(request(1,'Edit README.md'))
  await startup.prepare(request(2,'An unrelated Lisp task'))
  assert.equal(f.counts().enabled,true);assert.equal(asks,2)
  await startup.prepare({...request(3,'Native confirmation answer'),clarificationFrom:{turn:1,task:'Edit README.md'}})
  assert.equal(asks,2);assert.equal(f.counts().enabled,false)
  const bound=await decisions.bind(dshTurnRequestId({dshSessionId:'session',turn:3}))
  assert.deepEqual(bound.startup,{decision:true,lisp:false})
  await startup.prepare({...request(4,'Unmatched original key'),clarificationFrom:{turn:1,task:'Other README.md request'}})
  assert.equal(asks,3,'unknown original key cannot borrow a mode binding')
})
