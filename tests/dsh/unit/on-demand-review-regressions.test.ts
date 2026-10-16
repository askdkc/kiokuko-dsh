import { ExecutionSelectionPending } from '../../../src/dsh/execution-pending.js'
/** Independent intake-boundary regressions using the actual published native tool registry.
 * Host admission is a dependency double; these tests do not claim model intent quality.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import nativeTest, { type TestContext } from 'node:test'
import { OnDemandIntake, TASK_PREPARE_TOOL, type DemandAgent, type DemandInput } from '../../../src/dsh/on-demand-intake.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds,
  type RequestIntentContext, type RequestIntentDecision, type RequestRelationship, type RequestAction } from '../../../src/dsh/decisions/request-intent.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeAvailable = ['cordis', 'dsh-tools'].every(name => existsSync(join(packages, '@deepseek-ai', name, 'lib/index.js')))
if (!nativeAvailable && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Review regressions require a pinned native DSH fixture')
const test = nativeAvailable ? nativeTest : nativeTest.skip
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const [cordis, nativeTools, nativeScope] = nativeAvailable ? await Promise.all([load('cordis'), load('dsh-tools'), load('dsh-scope')]) : [undefined, undefined, undefined]
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
async function fixture(t: TestContext, options: Partial<Dependencies> = {}, skillPlacement: 'global' | 'late' | 'agent' = 'global') {
  const ctx = new cordis.Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
  const fiber = ctx.plugin(nativeTools.default)
  await fiber
  const events = [event('turn/start', 1)]
  const session = { id: 'review-session', snapshotEvents: () => events }
  const agent = { id: 'review-agent', session }
  const admissions: DemandInput[] = [], advice: string[] = []
  let skillReads = 0
  const scope = skillPlacement === 'agent' ? nativeScope.createScope(ctx, agent) : undefined
  if (scope) (agent as any).ctx = scope.ctx
  const skillContext = scope?.ctx ?? ctx
  let releaseSkill = () => {}
  const installSkill = () => { releaseSkill = skillContext.get('tools').register({ name: 'skill', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: () => { skillReads++; return 'installed Skill body' },
  }) }
  if (skillPlacement === 'global') installSkill()
  let readyTurn: number | undefined, bodies = 0, call = 0
  const prepareRequests: Array<{ input: DemandInput; taskType: string; requestIntent?: RequestIntentDecision; context?: RequestIntentContext }> = []
  const intake = new OnDemandIntake({
    validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async (input, type, requestIntent, context) => {
      advice.push(type); admissions.push(input); prepareRequests.push({ input, taskType: type,
        ...(requestIntent === undefined ? {} : { requestIntent }), ...(context === undefined ? {} : { context }) })
      readyTurn = input.turn; return true
    },
    ready: (candidate, turn) => candidate === agent && readyTurn !== undefined && (turn === undefined || turn === readyTurn),
    ...options,
  })
  intake.mount(ctx, ctx.tools)
  if (skillPlacement !== 'global') installSkill()
  const releaseProbe = ctx.tools.register({ name: 'review_probe', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: () => { bodies++; return 'review body' },
  })
  t.after(async () => { await intake.dispose(); releaseProbe(); releaseSkill(); await scope?.dispose(); await fiber.dispose() })
  return {
    ctx, agent, session, events, intake, admissions, advice, prepareRequests,
    bodies: () => bodies,
    skillReads: () => skillReads,
    removeSkill() { releaseSkill(); releaseSkill = () => {} },
    rebindSkill() { releaseSkill(); releaseSkill = skillContext.get('tools').register({ name: 'skill', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: () => { skillReads++; return 'replacement' } }) },
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

function activeIntent(messages: readonly unknown[], task: string, relation: RequestRelationship, action: RequestAction) {
  const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task), activeGoal: {
    runId: 'run-current', workflowRevision: 4, goalId: 'goal-current', goalRevision: 2, scopeRevision: 3,
    ideal: 'Finish the parser task', target: 'src/parser.ts', outOfScope: ['Publishing'], constraints: ['Keep the public API stable'],
  }, proposals: [] })!
  const decision = bindMainModelRequestIntent({ relation, action, evidenceRefs: requestIntentReferenceIds(context) }, context)!
  return { context, decision }
}

test('automatic native read preparation can be acknowledged explicitly without another admission', async t => {
  const f = await fixture(t, { classify: async () => ({ taskType: 'research', deferInference: false }) })
  const release = f.ctx.tools.register({ name: 'read', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: () => 'source' })
  t.after(release)
  await f.capture()
  assert.equal((await f.execute('read')).isError, false)
  assert.equal(f.admissions.length, 1)
  assert.equal((await f.prepare()).isError, false)
  assert.equal((await f.prepare()).isError, false, 'a receipt may be requested more than once')
  assert.equal(f.admissions.length, 1)
  assert.equal((await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })).isError, true)
  assert.equal(f.admissions.length, 1, 'a conflicting receipt cannot replace the admitted request')
})

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

for (const placement of ['late', 'agent'] as const) test(`on-demand review: ${placement} Skill reader is pinned before execution preparation`, async t => {
  const f = await fixture(t, {}, placement)
  await f.capture([human('question', 'Explain the installed Skill without changing files.')])
  assert.equal((await f.execute('skill')).isError, false)
  assert.equal(f.skillReads(), 1)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
  const deny = f.ctx.tools.guard((execution: any) => execution.name === 'skill' ? 'native reader denial' : undefined)
  try { assert.equal((await f.execute('skill')).isError, true); assert.equal(f.skillReads(), 1) } finally { deny() }
  f.rebindSkill()
  assert.equal((await f.execute('skill')).isError, true)
  f.intake.finish(f.session, 1); f.events.push(event('turn/start', 2))
  await f.capture([human('next', 'Explain again.')], 2)
  assert.equal((await f.execute('skill')).isError, true, 'a later turn cannot adopt a replacement reader')
  assert.equal(f.skillReads(), 1)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: a reader registered after first capture cannot acquire a missing-reader exception', async t => {
  const f = await fixture(t, {}, 'late')
  f.removeSkill()
  await f.capture()
  f.rebindSkill()
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: startup reader replacement before first capture cannot inherit its exception', async t => {
  const f = await fixture(t)
  f.rebindSkill()
  await f.capture()
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: resumed native ownership still requires exact ready identity for explicit preparation', async t => {
  const message = human('original', 'Inspect src without changing any files.')
  const intent = activeIntent([message], 'Inspect src without changing any files.', 'same_scope_continuation', 'research')
  const f = await fixture(t, { existing: async () => true, interpret: async () => intent })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  const result = await f.execute('prepare_requested_work', { taskType: 'research' })
  assert.equal(result.isError, false)
  assert.equal(f.admissions.length, 0, 'acknowledging exact existing admission must not open another run')
  assert.equal((await f.execute()).isError, false)
  f.ready(2)
  assert.equal((await f.execute()).isError, true, 'existing ownership does not waive the current-turn guard')
})

test('on-demand review: a cold same-scope owner stays conversational until explicit preparation binds this turn', async t => {
  const message = human('cold-resume', 'Inspect src without changing any files.')
  const intent = activeIntent([message], 'Inspect src without changing any files.', 'same_scope_continuation', 'verify')
  const f = await fixture(t, { existing: async () => true, interpret: async () => intent })
  assert.equal(await f.capture([message]), true, 'durable existence alone does not bind the new native turn')
  assert.equal(f.admissions.length, 0)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.admissions.length, 1, 'explicit preparation establishes the exact current-turn owner')
})

test('on-demand review: exact request replay is separate from same-scope continuation', async t => {
  const message = human('replayed-request', 'Inspect src without changing any files.')
  let replayChecks = 0, continuationLookups = 0
  const f = await fixture(t, {
    replay: async input => {
      replayChecks++
      assert.equal(input.turn, 1)
      assert.deepEqual(input.messages, [message])
      return true
    },
    existing: async () => { continuationLookups++; return true },
  })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  assert.equal(replayChecks, 1)
  assert.equal(continuationLookups, 0)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'prepared')
  assert.equal(f.admissions.length, 0, 'an exact replay does not open a second run')
})

test('scope-changing preparation updates the exact existing request instead of acknowledging the old Goal', async t => {
  const message = human('scope-change', 'Add the new API endpoint to this parser task.')
  const task = 'Add the new API endpoint to this parser task.'
  const intent = activeIntent([message], task, 'scope_change', 'change')
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), true, 'scope changes remain conversational until the host admits their explicit preparation')
  assert.equal(f.admissions.length, 0, 'capturing a scope change must not claim the previous run')
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.admissions.length, 1)
  assert.equal(f.prepareRequests[0]?.requestIntent?.relation, 'scope_change')
  assert.equal(f.prepareRequests[0]?.context?.activeGoal?.scopeRevision, 3)
  assert.equal(f.bodies(), 0, 'scope preparation never executes a project tool')
})

test('same-scope continuation acknowledges the exact active run without creating a second one', async t => {
  const message = human('same-scope', 'Check the current parser tests.')
  const task = 'Check the current parser tests.'
  const intent = activeIntent([message], task, 'same_scope_continuation', 'verify')
  const f = await fixture(t, { existing: async () => true, interpret: async () => intent })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.admissions.length, 0)
  assert.equal(result.value.requestIntent.relation, 'same_scope_continuation')
})

test('unknown relationship cannot borrow an active Goal through a legacy taskType hint', async t => {
  const message = human('unknown-scope', 'Check that.')
  const task = 'Check that.'
  const intent = activeIntent([message], task, 'unknown', 'unknown')
  const f = await fixture(t, { existing: async () => true, interpret: async () => intent })
  f.ready(1)
  assert.equal(await f.capture([message]), true)
  assert.equal((await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

test('a new request never consults the existing-run continuation lookup', async t => {
  const message = human('new-scope', 'Start a separate parser benchmark.')
  const task = 'Start a separate parser benchmark.'
  const intent = activeIntent([message], task, 'new', 'change')
  let ownerLookups = 0
  const f = await fixture(t, { existing: async () => { ownerLookups++; return true }, interpret: async () => intent })
  f.ready(1)
  assert.equal(await f.capture([message]), true)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(ownerLookups, 0)
  assert.equal(f.admissions.length, 1)
  assert.equal(f.prepareRequests[0]?.requestIntent?.relation, 'new')
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

test('on-demand review: changing text under the same human message ID replaces preparation', async t => {
  const f = await fixture(t), messages = [human('same-id', 'Inspect src without changing files.')]
  await f.capture(messages)
  messages[0]!.content[0]!.text = 'Delete src instead.'
  await f.capture(messages)
  assert.equal((await f.prepare()).isError, false)
  assert.equal(f.intake.snapshot(f.session.id)?.task, 'Delete src instead.')
  assert.equal(f.admissions.length, 1)
  assert.equal(f.bodies(), 0, 'preparation does not itself execute deletion')
})

test('on-demand review: advancing the native turn cannot reuse an older ready owner', async t => {
  const f = await fixture(t)
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: a host-driven empty turn retires only the closed conversational binding', async t => {
  const advanced: number[] = []
  const f = await fixture(t, { advance: async input => { advanced.push(input.turn) } })
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/start', 2))
  assert.equal(await f.intake.capture({ agent: f.agent, turn: 2, step: 0, messages: [], signal: signal() }), false)
  assert.deepEqual(advanced, [1, 2], 'the host advances the policy boundary without inventing human input')
  assert.equal(f.intake.snapshot(f.session.id), undefined)
  assert.equal(f.admissions.length, 1)
})

test('on-demand review: a pending host confirmation yields the next human turn to native admission', async t => {
  const f = await fixture(t, { resumeConfirmation: async input => input.turn === 2 })
  await f.capture(); assert.equal((await f.prepare()).isError, false)
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/start', 2))
  assert.equal(await f.capture([human('confirmation-revision', 'Narrow the plan to src.')], 2), false)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(f.admissions.length, 1, 'native admission, not model-facing preparation, owns the pending confirmation')
})

test('same-turn steering prepares a fresh generation retaining the original request', async t => {
  const f = await fixture(t, { classify: async () => ({ taskType: 'build', deferInference: false }) })
  await f.capture([human('original', 'Fix the parser and run its tests.')])
  assert.equal((await f.execute()).isError, false)
  await f.capture([human('steering', 'Also cover empty input.')])
  assert.equal((await f.execute()).isError, false)
  assert.equal(f.admissions.length, 2)
  assert.equal(f.intake.snapshot(f.session.id)?.task, 'Fix the parser and run its tests.\nAlso cover empty input.')
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
  const message = human('original', 'Inspect src without changing any files.')
  const intent = activeIntent([message], 'Inspect src without changing any files.', 'same_scope_continuation', 'research')
  const f = await fixture(t, { existing: async () => true, interpret: async () => intent })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  assert.equal(f.intake.snapshot(f.session.id)?.task, 'Inspect src without changing any files.')
  assert.equal(f.intake.snapshot(f.session.id)?.memoryOwner, 'execution')
  assert.equal(f.intake.snapshot(f.session.id)?.requestIntent?.relation, 'same_scope_continuation')
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
  assert.equal((await f.prepare()).isError, false, 'a later receipt acknowledges the single admission')
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
for (const taskType of [undefined, 'chat', 'writing'] as const) for (const name of ['read', 'glob', 'grep']) {
  test(`automatic file preparation: ${name} preserves ${taskType ?? 'unclassified'} advice and the original request`, async t => {
    const f = await fixture(t, { classify: async () => ({ ...(taskType ? { taskType } : {}), deferInference: !taskType }) })
    const calls = webTool(t, f, name), messages = [human('original', 'Read PLAN.md and compare the alternatives. Do not modify files.')]
    await f.capture(messages)
    assert.equal((await f.execute(name, { file_path: 'PLAN.md' })).isError, false)
    assert.deepEqual(f.advice, [taskType === 'writing' ? 'writing' : 'research'])
    assert.deepEqual(f.admissions[0]!.messages, messages)
    assert.equal((await f.execute(name, { file_path: 'PLAN.md' })).isError, false)
    assert.equal(f.admissions.length, 1); assert.equal(calls.length, 2)
  })
}
test('automatic file preparation: concurrent file demands share one admission', async t => {
  const gate = deferred(); let preparations = 0
  const f = await fixture(t, { prepare: async () => { preparations++; await gate.promise; f.ready(1); return true } })
  const reads = webTool(t, f, 'read'), searches = webTool(t, f, 'grep')
  await f.capture()
  const first = f.execute('read'), second = f.execute('grep')
  await new Promise(resolve => setImmediate(resolve)); gate.resolve()
  assert.ok((await Promise.all([first, second])).every(result => !result.isError))
  assert.equal(preparations, 1); assert.equal(reads.length, 1); assert.equal(searches.length, 1)
})
test('automatic file preparation: foreign agent and pending memory cannot borrow read admission', async t => {
  const f = await fixture(t), calls = webTool(t, f, 'read')
  await f.capture()
  assert.equal((await f.execute('read', {}, { agent: { ...f.agent } })).isError, true)
  assert.equal(f.admissions.length, 0); assert.equal(calls.length, 0)
  t.after(f.ctx.tools.guard(() => 'resolve memory decisions before native work'))
  assert.equal((await f.execute('read')).isError, true)
  assert.equal(f.admissions.length, 1); assert.equal(calls.length, 0)
})
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


test('pending confirmation resumes only after the host admits the exact current native turn', async t => {
  const f = await fixture(t, { resumeConfirmation: async () => true })
  assert.equal(await f.capture([human('revision', 'Limit the plan to src and continue.')]), false)
  assert.equal(f.intake.pending(f.agent), false, 'host confirmation must not borrow retired conversational memory')
  assert.equal((await f.execute()).isError, true, 'a pending confirmation grants no execution')
  f.ready(1)
  assert.equal((await f.execute()).isError, false, 'host admission may resume its confirmation route without another preparation')
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute('review_probe', {}, { agent: { ...f.agent } })).isError, true)
  const deny = f.ctx.tools.guard(() => 'native denial')
  try { assert.equal((await f.execute()).isError, true) } finally { deny() }
  f.ready(2)
  assert.equal((await f.execute()).isError, true, 'the confirmation cannot authorize another turn')
})


test('declining execution selection keeps acknowledgement available without admitting tools or replaying preparation', async t => {
  let attempts = 0
  const f = await fixture(t, { prepare: async () => { attempts++; throw new ExecutionSelectionPending() } })
  await f.capture()
  assert.equal((await f.prepare()).isError, true)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(await f.capture(), true, 'the same human input can reach the next reasoning step')
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
  assert.equal((await f.prepare()).isError, true, 'the model cannot reopen a declined choice within the same turn')
  assert.equal(attempts, 1)
})

test('recoverable preparation failure preserves the request but retry must reacquire exact native admission', async t => {
  let attempts = 0, admitted = false
  const f = await fixture(t, { ready: () => admitted, prepare: async () => {
    attempts++
    if (attempts === 1) throw new Error('Optional preparation temporarily unavailable')
    admitted = true
    return true
  } })
  await f.capture()
  assert.equal((await f.prepare()).isError, true)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(await f.capture(), true, 'a recoverable error does not retire the human request')
  assert.equal((await f.execute()).isError, true, 'failure does not grant execution')
  assert.equal(f.bodies(), 0)
  assert.equal((await f.prepare()).isError, false, 'a fresh call can reattempt host admission')
  assert.equal(attempts, 2)
  assert.equal((await f.execute('review_probe', {}, { agent: { ...f.agent } })).isError, true)
  const deny = f.ctx.tools.guard(() => 'native denial after retry')
  try { assert.equal((await f.execute()).isError, true); assert.equal(f.bodies(), 0) } finally { deny() }
  assert.equal((await f.execute()).isError, false)
  assert.equal(f.bodies(), 1)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true, 'retried admission cannot authorize a newer turn')
  assert.equal(f.bodies(), 1)
})


for (const name of ['read','glob','grep','web_search','web_fetch'] as const) test(`unowned native ${name} needs no optional classifier but keeps native denial and current ownership`, async t => {
 let owner:'unowned'|'owned'='unowned', bodies=0
 const f=await fixture(t,{nativeOwnership:async()=>owner,classify:async()=>{throw new Error('optional classifier unavailable')}})
 const release=f.ctx.tools.register({name,parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:()=>{bodies++;return 'native evidence'}})
 t.after(release)
 await f.capture()
 assert.equal((await f.execute(name)).isError,false);assert.equal(bodies,1);assert.equal(f.admissions.length,0)
 const deny=f.ctx.tools.guard((execution:any)=>execution.name===name?'NATIVE_TEST_DENIED':undefined)
 assert.match(JSON.stringify(await f.execute(name)),/NATIVE_TEST_DENIED/);assert.equal(bodies,1);deny()
 owner='owned';assert.equal((await f.execute(name)).isError,true);assert.equal(bodies,1)
})
for (const change of ['arguments','stop','owner'] as const) test(`unowned native read rejects a ${change} change after native pre-execute`,async t=>{
 let owner:'unowned'|'owned'='unowned',bodies=0
 const f=await fixture(t,{nativeOwnership:async()=>owner})
 const release=f.ctx.tools.register({name:'read',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:()=>{bodies++;return 'private evidence'}})
 t.after(release);await f.capture()
 const mutate=f.ctx.tools.guard((execution:any)=>{if(execution.name==='read'){if(change==='stop')f.intake.stop();else if(change==='owner')owner='owned';else execution.arguments.changed=true}return undefined})
 t.after(mutate)
 assert.equal((await f.execute('read',{})).isError,true);assert.equal(bodies,0)
})

test('unowned preparation explains absent task and recovers without taskOperation', async t => {
  let classifications = 0, nativeBodies = 0, workflowBodies = 0
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    classify: async () => { classifications++; return { deferInference: true } },
  })
  for (const name of ['bash', 'coding_workflow']) t.after(f.ctx.tools.register({ name,
    parameters: { type: 'object' }, output: { schema: {}, render: () => [] },
    execute: () => { if (name === 'bash') nativeBodies++; else workflowBodies++; return 'body' },
  }))
  const task = 'Fix the shortcut rendering in the local UI; do not publish.'
  const messages = [human('repair-request', task)]
  await f.capture(messages)
  assert.equal(classifications, 0, 'unowned native work does not wait for optional classification')
  const denied = await f.execute('coding_workflow')
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /call prepare_requested_work/)
  const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task) })!
  const requestIntent = { relation: 'new', action: 'change', changeScope: 'implementation', evidenceRefs: requestIntentReferenceIds(context) }
  const prepare = (intent: object) => f.execute(TASK_PREPARE_TOOL, { requestIntent: intent })
  const invalid = await prepare({ ...requestIntent, taskOperation: 'start' })
  assert.equal(invalid.isError, true)
  assert.match(JSON.stringify(invalid), /No active SQLite task/)
  assert.match(JSON.stringify(invalid), /omit taskOperation/)
  assert.equal(f.admissions.length, 0)
  assert.equal(workflowBodies, 0)
  assert.equal((await f.execute('bash')).isError, false, 'invalid optional task operation cannot block unowned native Bash')
  assert.equal(nativeBodies, 1)
  const corrected = await prepare(requestIntent)
  assert.equal(corrected.isError, false, JSON.stringify(corrected))
  assert.equal(f.admissions.length, 1)
  assert.equal((f.admissions[0]?.messages[0] as any)?.id, 'repair-request')
  assert.equal(f.prepareRequests[0]?.requestIntent?.taskOperation, undefined)
  assert.equal((await f.execute('coding_workflow')).isError, false)
  assert.equal(workflowBodies, 1, 'only admitted coding workflow reaches its body')
})

for (const sample of [
  { state: 'ToDo', runStatus: 'intake', operation: 'resume', allowed: 'start, wait, ignore' },
  { state: 'Working', runStatus: 'active', operation: 'start', allowed: 'wait, complete, ignore' },
  { state: 'Pending', runStatus: 'active', operation: 'complete', allowed: 'resume, ignore' },
  { state: 'Done', runStatus: 'completed', operation: 'resume', allowed: 'resume' },
] as const) test(`preparation reports the current ${sample.state} task without executing invalid ${sample.operation}`, async t => {
  const task = 'Inspect the current task; do not publish.'
  const messages = [human('inspection-request', task)]
  const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task), activeTask: {
    taskId: 'synthetic-task', runId: 'synthetic-task', sessionId: 'review-session', sourceSessionId: 'review-session', repositoryRoot: '/synthetic',
    type: 'research', state: sample.state, revision: 4, generation: 7, runStatus: sample.runStatus,
    reason: 'Synthetic regression fixture', evidence: [], allowedOps: sample.allowed.split(', ') as any,
    request: task, resumedFromTerminal: false,
  } })!
  const requestIntent = { relation: 'same_scope_continuation', action: 'research', evidenceRefs: requestIntentReferenceIds(context) }
  const decision = bindMainModelRequestIntent(requestIntent, context)!
  const original = structuredClone(context)
  const f = await fixture(t, { interpret: async () => ({ context, decision }) })
  await f.capture(messages)
  const result = await f.execute(TASK_PREPARE_TOOL, { requestIntent: { ...requestIntent, taskOperation: sample.operation } })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), new RegExp(`state ${sample.state}`))
  assert.match(JSON.stringify(result), /revision 4, generation 7/)
  assert.ok(JSON.stringify(result).includes(`Allowed state operations: ${sample.allowed}.`))
  if (sample.state === 'Done') assert.match(JSON.stringify(result), /terminal resume requires an explicit operation/)
  assert.equal(f.admissions.length, 0)
  assert.deepEqual(context, original, 'a rejected advisory operation never mutates the task snapshot')
})
