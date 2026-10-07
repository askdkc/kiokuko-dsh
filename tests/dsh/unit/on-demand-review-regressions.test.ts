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
  const admissions: DemandInput[] = []
  let readyTurn: number | undefined, bodies = 0, call = 0
  const intake = new OnDemandIntake({
    validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async input => { admissions.push(input); readyTurn = input.turn; return true },
    ready: (candidate, turn) => candidate === agent && readyTurn !== undefined && (turn === undefined || turn === readyTurn),
    ...options,
  })
  intake.mount(ctx, ctx.tools)
  const releaseProbe = ctx.tools.register({ name: 'review_probe', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: () => { bodies++; return 'review body' },
  })
  t.after(async () => { await intake.dispose(); releaseProbe(); await fiber.dispose() })
  return {
    ctx, agent, session, events, intake, admissions,
    bodies: () => bodies,
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
  assert.equal(f.intake.snapshot(f.session.id), undefined)
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
