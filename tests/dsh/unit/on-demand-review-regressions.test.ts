/** Independent intake-boundary regressions using the actual published native tool registry.
 * Host admission is a dependency double; these tests do not claim model intent quality.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import nativeTest, { type TestContext } from 'node:test'
import { OnDemandIntake, TASK_PREPARE_TOOL, type DemandAgent, type DemandInput } from '../../../src/dsh/on-demand-intake.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime-current/node_modules')
const nativeAvailable = ['cordis', 'dsh-tools'].every(name => existsSync(join(packages, '@deepseek-ai', name, 'lib/index.js')))
if (!nativeAvailable && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Review regressions require a pinned native DSH fixture')
const test = nativeAvailable ? nativeTest : nativeTest.skip
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const [cordis, nativeTools] = nativeAvailable ? await Promise.all([load('cordis'), load('dsh-tools')]) : [undefined, undefined]
const signal = () => new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function human(id: string, text: string) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
function event(type: string, turn: number) {
  return { type, seq: turn * 2 + (type === 'turn/end' ? 1 : 0), time: 0, data: { turn } }
}
type Dependencies = ConstructorParameters<typeof OnDemandIntake>[0]
async function fixture(t: TestContext, options: Partial<Dependencies> = {}) {
  const ctx = new cordis.Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
  const fiber = ctx.plugin(nativeTools.default)
  await fiber
  const events = [event('turn/start', 1)]
  const session = { id: 'review-session', snapshotEvents: () => events }
  const agent = { id: 'review-agent', session }
  const admissions: DemandInput[] = [], advice: string[] = []
  let skillReads = 0
  let releaseSkill = ctx.tools.register({ name: 'skill', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: () => { skillReads++; return 'installed Skill body' },
  })
  let readyTurn: number | undefined, bodies = 0, call = 0
  const intake = new OnDemandIntake({
    validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async (input, type) => { advice.push(type); admissions.push(input); readyTurn = input.turn; return true },
    ready: (candidate, turn) => candidate === agent && readyTurn !== undefined && (turn === undefined || turn === readyTurn),
    ...options,
  })
  intake.mount(ctx, ctx.tools)
  const releaseProbe = ctx.tools.register({ name: 'review_probe', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: () => { bodies++; return 'review body' },
  })
  t.after(async () => { await intake.dispose(); releaseProbe(); releaseSkill(); await fiber.dispose() })
  return {
    ctx, agent, session, events, intake, admissions, advice,
    bodies: () => bodies,
    skillReads: () => skillReads,
    rebindSkill() { releaseSkill(); releaseSkill = ctx.tools.register({ name: 'skill', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: () => { skillReads++; return 'replacement' } }) },
    ready(turn: number) { readyTurn = turn },
    capture(messages = [human('original', 'Inspect src without changing any files.')], turn = 1) {
      return intake.capture({ agent, turn, step: 0, messages, signal: signal() })
    },
    execute(name = 'review_probe', args: unknown = {}, overrides: Record<string, unknown> = {}) {
      return ctx.tools.execute({ callId: `review-${++call}`, name, arguments: args, agent, signal: signal(), ...overrides })
    },
    prepare() { return this.execute(TASK_PREPARE_TOOL, { taskType: 'research' }) },
  }
}

test('on-demand review: installed Skill reads need no execution intake and cannot authorize work', async t => {
  const f = await fixture(t)
  await f.capture([human('question', 'Explain the installed Skill.')])
  assert.equal((await f.execute('skill')).isError, false)
  assert.equal(f.skillReads(), 1)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
  f.rebindSkill()
  assert.equal((await f.execute('skill')).isError, true, 'a replacement with the same name cannot borrow the native reader exception')
  assert.equal(f.skillReads(), 1)
})

test('on-demand review: conversational Skill reads preserve native denial and exact agent scope', async t => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.execute('skill', {}, { agent: { ...f.agent } })).isError, true)
  const release = f.ctx.on('tools/pre-execute', async (_execution: unknown, _next: unknown) => ({ kind: 'deny', reason: 'native denial' }))
  t.after(release)
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: resumed native ownership still requires exact ready identity for explicit preparation', async t => {
  const f = await fixture(t, { existing: async () => true })
  f.ready(1)
  assert.equal(await f.capture(), false)
  const result = await f.execute('prepare_requested_work', { taskType: 'research' })
  assert.equal(result.isError, false)
  assert.equal(f.admissions.length, 0, 'acknowledging exact existing admission must not open another run')
  assert.equal((await f.execute()).isError, false)
  f.ready(2)
  assert.equal((await f.execute()).isError, true, 'existing ownership does not waive the current-turn guard')
})

test('on-demand review: admission receives an immutable snapshot of the complete original human batch', async t => {
  const f = await fixture(t)
  const messages = [human('first', 'Do not modify files.'), human('second', 'Inspect src and compare the two approaches.')]
  const expected = structuredClone(messages)
  await f.capture(messages)
  messages[0]!.content[0]!.text = 'Replace every file.'
  assert.equal((await f.prepare()).isError, false)
  assert.deepEqual(f.admissions[0]!.messages, expected)
  assert.equal(f.intake.snapshot(f.session.id)?.task, 'Do not modify files.\nInspect src and compare the two approaches.')
})

test('on-demand review: changing text under the same human message ID invalidates preparation', async t => {
  const f = await fixture(t), messages = [human('same-id', 'Inspect src without changing files.')]
  await f.capture(messages)
  messages[0]!.content[0]!.text = 'Delete src instead.'
  await f.capture(messages)
  assert.equal((await f.prepare()).isError, true)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: advancing the native turn cannot reuse an older ready owner', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: finish between the native monotonic guard and dispatch prevents the body', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
    if (execution.name === 'review_probe') { await Promise.resolve(); f.intake.finish(f.session, 1) }
    return next()
  })
  t.after(release)
  assert.equal((await f.execute()).isError, true, 'native dispatch must not start a body after its original request closed')
  assert.equal(f.bodies(), 0)
})

test('on-demand review: stop between the native monotonic guard and dispatch prevents the body', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
    if (execution.name === 'review_probe') { await Promise.resolve(); f.intake.stop() }
    return next()
  })
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: a newer captured turn revokes an older execution already past its guard', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
    if (execution.name === 'review_probe') {
      f.events.push(event('turn/start', 2))
      await f.capture([human('replacement', 'Explain the current result without running tools.')], 2)
    }
    return next()
  })
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: shutdown cancels and drains an in-flight host preparation', async t => {
  const started = deferred(), release = deferred()
  let preparationSignal: AbortSignal | undefined, settled = false
  const f = await fixture(t, { prepare: async input => {
    preparationSignal = input.signal; started.resolve()
    await release.promise; settled = true
    input.signal.throwIfAborted()
    return true
  } })
  await f.capture()
  const pending = f.prepare()
  await started.promise
  f.intake.stop()
  const draining = f.intake.drain()
  try {
    assert.equal(preparationSignal!.aborted, true)
    assert.equal(settled, false)
  } finally { release.resolve() }
  await draining
  assert.equal(settled, true)
  assert.equal((await pending).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: an existing owner must match the exact open native turn', async t => {
  const f = await fixture(t, { existing: async () => true })
  f.ready(1)
  assert.equal(await f.capture(), false)
  assert.deepEqual(f.intake.snapshot(f.session.id), { task: 'Inspect src without changing any files.', taskType: null, status: 'prepared', turn: 1 })
  assert.equal((await f.execute()).isError, false)
  f.events.push(event('turn/end', 1))
  assert.equal((await f.execute()).isError, true)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 1)
})

test('on-demand review: exact agent retirement permits a fresh registered identity without reviving the old one', async t => {
  let registered: DemandAgent | undefined
  const f = await fixture(t, {
    validate: async input => { assert.equal(input.agent, registered); assert.equal(input.agent.session, registered?.session) },
    ready: (agent, turn) => agent === registered && turn === 1,
  })
  registered = f.agent
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  f.intake.retire({ ...f.agent })
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'prepared', 'same-ID impostor cannot retire a live request')
  f.intake.retire(f.agent); registered = undefined
  assert.equal(f.intake.snapshot(f.session.id), undefined)
  assert.equal((await f.execute()).isError, true)
  const replacement = { id: f.agent.id, session: { id: f.session.id, snapshotEvents: () => [event('turn/start', 1)] } }
  registered = replacement
  assert.equal(await f.intake.capture({ agent: replacement, turn: 1, step: 0,
    messages: [human('reopened', 'Inspect src without modifying it.')], signal: signal() }), true)
  assert.equal((await f.execute()).isError, true, 'old object cannot consume the reopened session scope')
  assert.equal((await f.execute(TASK_PREPARE_TOOL, { taskType: 'research' }, { agent: replacement })).isError, false)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: validated child bypass preserves downstream denial and rejects same-ID impostors', async t => {
  const child = { id: 'child', session: { id: 'child-session', snapshotEvents: () => [event('turn/start', 1)] } }
  const f = await fixture(t, { nativeChild: agent => agent === child })
  assert.equal(await f.intake.capture({ agent: child, turn: 1, step: 0, messages: [], signal: signal() }), false)
  assert.equal((await f.execute('review_probe', {}, { agent: child })).isError, false)
  const release = f.ctx.on('tools/pre-execute', (_execution: unknown, _next: unknown) => ({ kind: 'deny', reason: 'child lease denied' }))
  t.after(release)
  assert.equal((await f.execute('review_probe', {}, { agent: child })).isError, true)
  assert.equal((await f.execute('review_probe', {}, { agent: { ...child } })).isError, true)
  assert.equal(f.bodies(), 1)
})

for (const decision of ['deny', 'cancel'] as const) test(`on-demand review: downstream ${decision} still blocks direct and nested native execution`, async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on('tools/pre-execute', (execution: any, next: () => Promise<unknown>) => execution.name === 'review_probe'
    ? decision === 'cancel' ? { kind: 'cancel' } : { kind: 'deny', reason: 'downstream policy denied' } : next())
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal((await f.execute('review_probe', {}, { parent: Symbol('nested-parent') })).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: approval resolved after closure cannot revive the admitted request', async t => {
  const requested = deferred(), answer = deferred()
  const f = await fixture(t)
  f.ctx.provide('approval', { request: async () => { requested.resolve(); await answer.promise; return 'allowed-once' } })
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on('tools/pre-execute', (execution: any, next: () => Promise<unknown>) => execution.name === 'review_probe'
    ? { kind: 'ask', reason: 'native approval' } : next())
  t.after(release)
  const execution = f.execute()
  await requested.promise
  f.intake.finish(f.session, 1); answer.resolve()
  assert.equal((await execution).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: concurrent preparation is consumed once and never replaces the advisory type', async t => {
  const started = deferred(), release = deferred()
  let prepared = 0
  const f = await fixture(t, { prepare: async () => { prepared++; started.resolve(); await release.promise; return true } })
  f.ready(1)
  await f.capture()
  const first = f.prepare()
  await started.promise
  try {
    assert.equal((await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })).isError, true)
    assert.equal(prepared, 1)
  } finally { release.resolve() }
  assert.equal((await first).isError, false)
  assert.equal(f.intake.snapshot(f.session.id)?.taskType, 'research')
  assert.equal((await f.prepare()).isError, true)
  assert.equal(prepared, 1)
})

test('on-demand review: direct, nested, and agentless execution cannot run before preparation', async t => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.execute()).isError, true)
  assert.equal((await f.execute('review_probe', {}, { parent: Symbol('nested-parent') })).isError, true)
  assert.equal((await f.execute('review_probe', {}, { agent: undefined })).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: successful preparation cannot override a native monotonic denial', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.tools.guard((execution: any) => execution.name === 'review_probe' ? 'native operation is not authorized' : undefined)
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

for (const task of ['それを消して？', 'Delete that.']) test(`on-demand review: advisory type cannot resolve a known missing destructive target: ${task}`, async t => {
  const f = await fixture(t)
  await f.capture([human('original', task)])
  assert.equal((await f.prepare()).isError, true, 'a model-generated research hint cannot establish the missing deletion target')
  assert.equal(f.admissions.length, 0, 'reject before the host can default the target to cwd')
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: automatic classifier advice cannot resolve a known missing destructive target', async t => {
  const f = await fixture(t, { classify: async () => ({ taskType: 'research', deferInference: false }) })
  await f.capture([human('original', 'それを消して？')])
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

function webTool(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, name = 'web_search') {
  const calls: any[] = []
  const release = f.ctx.tools.register({ name, parameters: { type: 'object' }, output: { schema: {}, render: () => [] },
    execute: (args: unknown, execution: any) => { calls.push({ args, execution }); return 'web result' } })
  t.after(release)
  ;(calls as any).release = release
  return calls
}
for (const taskType of [undefined, 'chat', 'debug'] as const) for (const name of ['web_search', 'web_fetch']) {
  test(`automatic web preparation: ${name} with ${taskType ?? 'unclassified'} advice`, async t => {
    const f = await fixture(t, { classify: async () => ({ ...(taskType ? { taskType } : {}), deferInference: !taskType }) })
    const calls = webTool(t, f, name), messages = [human('original', 'vmware toolsの最新の脆弱性でクリティカルレベルのものある？')]
    await f.capture(messages)
    const args = name === 'web_search' ? { queries: ['VMware Tools critical CVE'] } : { url: 'https://example.com/advisory' }
    assert.equal((await f.execute(name, args, { callId: 'original-call' })).isError, false)
    assert.deepEqual(f.advice, [taskType === 'debug' ? 'debug' : 'research'])
    assert.deepEqual(f.admissions[0]!.messages, messages)
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, args)
    assert.equal(calls[0].execution.callId, 'original-call'); assert.equal(calls[0].execution.agent, f.agent)
    assert.equal((await f.execute(name, args)).isError, false)
    assert.equal(f.admissions.length, 1); assert.equal(calls.length, 2)
  })
}
for (const task of ['それを検索して', 'search that', 'look up it', 'それを消して？', 'Delete that.', 'search A or B, I am undecided']) {
  test(`automatic web preparation: missing scope stops ${task}`, async t => {
    const f = await fixture(t), calls = webTool(t, f)
    await f.capture([human('original', task)])
    assert.equal((await f.execute('web_search', { queries: ['invented target'] })).isError, true)
    assert.equal(f.admissions.length, 0); assert.equal(calls.length, 0)
  })
}
test('automatic web preparation: concurrent web calls share one pending admission', async t => {
  const gate = deferred(); let preparations = 0
  const f = await fixture(t, { prepare: async () => { preparations++; await gate.promise; f.ready(1); return true } })
  const calls = webTool(t, f)
  await f.capture()
  const first = f.execute('web_search'), second = f.execute('web_search')
  await new Promise(resolve => setImmediate(resolve)); gate.resolve()
  assert.ok((await Promise.all([first, second])).every(result => !result.isError))
  assert.equal(preparations, 1); assert.equal(calls.length, 2)
})
for (const failure of ['admission', 'readiness', 'deny', 'cancel', 'closed'] as const) {
  test(`automatic web preparation: ${failure} prevents web body`, async t => {
    const f = await fixture(t, failure === 'admission' ? { prepare: async () => false } : failure === 'readiness' ? { ready: () => false } : {})
    const calls = webTool(t, f)
    if (failure === 'deny' || failure === 'cancel') t.after(f.ctx.on('tools/pre-execute', async () => ({ kind: failure, reason: 'native policy' })))
    if (failure === 'closed') t.after(f.ctx.on('tools/execute', async (_execution: any, next: () => Promise<unknown>) => { f.intake.finish(f.session, 1); return next() }))
    await f.capture()
    assert.equal((await f.execute('web_search')).isError, true); assert.equal(calls.length, 0)
  })
}

for (const invalidation of ['definition', 'turn', 'cancel'] as const) test(`automatic web preparation: ${invalidation} during admission revokes dispatch`, async t => {
  const started = deferred(), gate = deferred()
  const f = await fixture(t, { prepare: async () => { started.resolve(); await gate.promise; f.ready(1); return true } })
  const calls = webTool(t, f), controller = new AbortController()
  await f.capture()
  const pending = f.execute('web_search', {}, { signal: controller.signal })
  await started.promise
  if (invalidation === 'cancel') controller.abort()
  if (invalidation === 'turn') f.events.push(event('turn/start', 2))
  if (invalidation === 'definition') {
    // Replacement must not inherit the definition checked before admission.
    ;(calls as any).release()
    t.after(f.ctx.tools.register({ name: 'web_search', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => { calls.push('replacement'); return 'replacement' } }))
  }
  gate.resolve()
  assert.equal((await pending).isError, true); assert.equal(calls.length, 0)
})

test('automatic web preparation: pending memory guard remains authoritative after admission', async t => {
  const f = await fixture(t), calls = webTool(t, f)
  t.after(f.ctx.tools.guard(() => 'resolve memory decisions before native work'))
  await f.capture()
  assert.equal((await f.execute('web_search')).isError, true)
  assert.equal(f.admissions.length, 1); assert.equal(calls.length, 0)
})
