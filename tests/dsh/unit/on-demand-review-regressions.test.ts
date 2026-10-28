import { executionRequestAction } from '../../../src/dsh/coding-workflow/intent.js'
import { ExecutionSelectionPending } from '../../../src/dsh/execution-pending.js'
import { mountOwnedExecution } from '../../../src/dsh/owned-execution.js'
/** Independent intake-boundary regressions using the actual published native tool registry.
 * Host admission is a dependency double; these tests do not claim model intent quality.
 */
import { planPreparation } from '../helpers/plan-script.js'
import { nativeMock } from '../helpers/native-mock.js'
import { mountNativeTools, executeNativeTool } from '../helpers/native-tools.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import nativeTest, { type TestContext } from 'node:test'
import {
  OnDemandIntake,
  TASK_PREPARE_TOOL,
  type DemandAgent,
  type DemandInput,
} from '../../../src/dsh/on-demand-intake.js'
import {
  bindMainModelRequestIntent,
  createRequestIntentContext,
  requestIntentMessageRefs,
  requestIntentReferenceIds,
  unresolvedRequestIntent,
  type RequestIntentContext,
  type RequestIntentDecision,
  type RequestRelationship,
  type RequestAction,
} from '../../../src/dsh/decisions/request-intent.js'

const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeAvailable = ['cordis', 'dsh-tools'].every((name) =>
  existsSync(join(packages, '@deepseek-ai', name, 'lib/index.js')),
)
if (!nativeAvailable && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')
  throw new Error('Review regressions require a pinned native DSH fixture')
const test = nativeAvailable ? nativeTest : nativeTest.skip
const load = (name: string) =>
  import(
    pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href
  )
const [cordis, nativeTools, nativeScope] = nativeAvailable
  ? await Promise.all([load('cordis'), load('dsh-tools'), load('dsh-scope')])
  : [undefined, undefined, undefined]
const signal = () => new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function human(id: string, text: string) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}
function event(type: string, turn: number) {
  return {
    type,
    seq: turn * 2 + (type === 'turn/end' ? 1 : 0),
    time: 0,
    data: { turn },
  }
}
type Dependencies = ConstructorParameters<typeof OnDemandIntake>[0]
async function fixture(
  t: TestContext,
  options: Partial<Dependencies> = {},
  skillPlacement: 'global' | 'late' | 'agent' = 'global',
) {
  const ctx = new cordis.Context()
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  const fibers: any[] = []
  await mountNativeTools(ctx, nativeTools, packages, fibers)
  const events = [event('turn/start', 1)]
  const session = { id: 'review-session', snapshotEvents: () => events }
  const agent = { id: 'review-agent', session }
  const admissions: DemandInput[] = [],
    advice: string[] = []
  let skillReads = 0
  const scope =
    skillPlacement === 'agent' ? nativeScope.createScope(ctx, agent) : undefined
  if (scope) (agent as any).ctx = scope.ctx
  const skillContext = scope?.ctx ?? ctx
  let releaseSkill = () => {}
  const installSkill = () => {
    releaseSkill = skillContext.get('tools').register({
      name: 'skill',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [
          { type: 'text', text: value },
        ],
      },
      execute: () => {
        skillReads++
        return 'installed Skill body'
      },
    })
  }
  if (skillPlacement === 'global') installSkill()
  let readyTurn: number | undefined,
    bodies = 0,
    call = 0
  const prepareRequests: Array<{
    input: DemandInput
    taskType: string
    requestIntent?: RequestIntentDecision
    context?: RequestIntentContext
  }> = []
  const intake = new OnDemandIntake({
    validate: async (input) => {
      assert.equal(input.agent, agent)
      assert.equal(input.agent.session, session)
    },
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async (input, type, requestIntent, context) => {
      advice.push(type)
      admissions.push(input)
      prepareRequests.push({
        input,
        taskType: type,
        ...(requestIntent === undefined ? {} : { requestIntent }),
        ...(context === undefined ? {} : { context }),
      })
      readyTurn = input.turn
      return true
    },
    ready: (candidate, turn) =>
      candidate === agent &&
      readyTurn !== undefined &&
      (turn === undefined || turn === readyTurn),
    ...options,
  })
  intake.mount(ctx, ctx.tools)
  if (skillPlacement !== 'global') installSkill()
  const releaseProbe = ctx.tools.register({
    name: 'review_probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [
        { type: 'text', text: value },
      ],
    },
    execute: () => {
      bodies++
      return 'review body'
    },
  })
  t.after(async () => {
    await intake.dispose()
    releaseProbe()
    releaseSkill()
    await scope?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return {
    ctx,
    agent,
    session,
    events,
    intake,
    admissions,
    advice,
    prepareRequests,
    bodies: () => bodies,
    skillReads: () => skillReads,
    removeSkill() {
      releaseSkill()
      releaseSkill = () => {}
    },
    rebindSkill() {
      releaseSkill()
      releaseSkill = skillContext.get('tools').register({
        name: 'skill',
        parameters: { type: 'object' },
        output: { schema: {}, render: () => [] },
        execute: () => {
          skillReads++
          return 'replacement'
        },
      })
    },
    ready(turn: number) {
      readyTurn = turn
    },
    capture(
      messages = [human('original', 'Inspect src without changing any files.')],
      turn = 1,
    ) {
      return intake.capture({
        agent,
        turn,
        step: 0,
        messages,
        signal: signal(),
      })
    },
    execute(
      name = 'review_probe',
      args: unknown = {},
      overrides: Record<string, unknown> = {},
    ) {
      return executeNativeTool(ctx, packages, {
        callId: `review-${++call}`,
        name,
        arguments: args,
        agent,
        signal: signal(),
        ...overrides,
      })
    },
    prepare() {
      return this.execute(TASK_PREPARE_TOOL, { taskType: 'research' })
    },
  }
}

function activeIntent(
  messages: readonly unknown[],
  task: string,
  relation: RequestRelationship,
  action: RequestAction,
  changeScope: 'implementation' | 'document' | 'unknown' = 'unknown',
) {
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs(messages, task),
    activeGoal: {
      runId: 'run-current',
      workflowRevision: 4,
      goalId: 'goal-current',
      goalRevision: 2,
      scopeRevision: 3,
      ideal: 'Finish the parser task',
      target: 'src/parser.ts',
      outOfScope: ['Publishing'],
      constraints: ['Keep the public API stable'],
    },
    proposals: [],
  })!
  const decision = bindMainModelRequestIntent(
    {
      relation,
      action,
      changeScope,
      evidenceRefs: requestIntentReferenceIds(context),
    },
    context,
  )!
  return { context, decision }
}

test('native evidence read leaves intent uncommitted; explicit preparation stays immutable', async (t) => {
  const f = await fixture(t, {
    classify: async () => ({ taskType: 'research', deferInference: false }),
  })
  const release = f.ctx.tools.register({
    name: 'read',
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: () => 'source',
  })
  t.after(release)
  await f.capture()
  assert.equal((await f.execute('read')).isError, false)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal((await f.prepare()).isError, false)
  assert.equal(
    (await f.prepare()).isError,
    false,
    'a receipt may be requested more than once',
  )
  assert.equal(f.admissions.length, 1)
  assert.equal(
    (await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })).isError,
    true,
  )
  assert.equal(
    f.admissions.length,
    1,
    'a conflicting receipt cannot replace the admitted request',
  )
})

test('on-demand review: installed Skill reads need no execution intake and cannot authorize work', async (t) => {
  const f = await fixture(t)
  await f.capture([human('question', 'Explain the installed Skill.')])
  assert.equal((await f.execute('skill')).isError, false)
  assert.equal(f.skillReads(), 1)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
  f.rebindSkill()
  assert.equal(
    (await f.execute('skill')).isError,
    true,
    'a replacement with the same name cannot borrow the native reader exception',
  )
  assert.equal(f.skillReads(), 1)
})

test('on-demand review: conversational Skill reads preserve native denial and exact agent scope', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal(
    (await f.execute('skill', {}, { agent: { ...f.agent } })).isError,
    true,
  )
  const release = f.ctx.on(
    'tools/pre-execute',
    async (_execution: unknown, _next: unknown) => ({
      kind: 'deny',
      reason: 'native denial',
    }),
  )
  t.after(release)
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

for (const placement of ['late', 'agent'] as const)
  test(`on-demand review: ${placement} Skill reader is pinned before execution preparation`, async (t) => {
    const f = await fixture(t, {}, placement)
    await f.capture([
      human('question', 'Explain the installed Skill without changing files.'),
    ])
    assert.equal((await f.execute('skill')).isError, false)
    assert.equal(f.skillReads(), 1)
    assert.equal(f.admissions.length, 0)
    assert.equal((await f.execute()).isError, true)
    assert.equal(f.bodies(), 0)
    const deny = f.ctx.tools.guard((execution: any) =>
      execution.name === 'skill' ? 'native reader denial' : undefined,
    )
    try {
      assert.equal((await f.execute('skill')).isError, true)
      assert.equal(f.skillReads(), 1)
    } finally {
      deny()
    }
    f.rebindSkill()
    assert.equal((await f.execute('skill')).isError, true)
    f.intake.finish(f.session, 1)
    f.events.push(event('turn/start', 2))
    await f.capture([human('next', 'Explain again.')], 2)
    assert.equal(
      (await f.execute('skill')).isError,
      true,
      'a later turn cannot adopt a replacement reader',
    )
    assert.equal(f.skillReads(), 1)
    assert.equal(f.admissions.length, 0)
  })

test('on-demand review: a reader registered after first capture cannot acquire a missing-reader exception', async (t) => {
  const f = await fixture(t, {}, 'late')
  f.removeSkill()
  await f.capture()
  f.rebindSkill()
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: startup reader replacement before first capture cannot inherit its exception', async (t) => {
  const f = await fixture(t)
  f.rebindSkill()
  await f.capture()
  assert.equal((await f.execute('skill')).isError, true)
  assert.equal(f.skillReads(), 0)
  assert.equal(f.admissions.length, 0)
})

test('on-demand review: resumed native ownership still requires exact ready identity for explicit preparation', async (t) => {
  const message = human('original', 'Inspect src without changing any files.')
  const intent = activeIntent(
    [message],
    'Inspect src without changing any files.',
    'same_scope_continuation',
    'research',
  )
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  const result = await f.execute('prepare_requested_work', {
    taskType: 'research',
  })
  assert.equal(result.isError, false)
  assert.equal(
    f.admissions.length,
    0,
    'acknowledging exact existing admission must not open another run',
  )
  assert.equal((await f.execute()).isError, false)
  f.ready(2)
  assert.equal(
    (await f.execute()).isError,
    true,
    'existing ownership does not waive the current-turn guard',
  )
})

test('on-demand review: a cold same-scope owner stays conversational until explicit preparation binds this turn', async (t) => {
  const message = human(
    'cold-resume',
    'Inspect src without changing any files.',
  )
  const intent = activeIntent(
    [message],
    'Inspect src without changing any files.',
    'same_scope_continuation',
    'verify',
  )
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  assert.equal(
    await f.capture([message]),
    true,
    'durable existence alone does not bind the new native turn',
  )
  assert.equal(f.admissions.length, 0)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(
    f.admissions.length,
    1,
    'explicit preparation establishes the exact current-turn owner',
  )
})

test('on-demand review: exact request replay is separate from same-scope continuation', async (t) => {
  const message = human(
    'replayed-request',
    'Inspect src without changing any files.',
  )
  let replayChecks = 0,
    continuationLookups = 0
  const f = await fixture(t, {
    replay: async (input) => {
      replayChecks++
      assert.equal(input.turn, 1)
      assert.deepEqual(input.messages, [message])
      return true
    },
    existing: async () => {
      continuationLookups++
      return true
    },
  })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  assert.equal(replayChecks, 1)
  assert.equal(continuationLookups, 0)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'prepared')
  assert.equal(
    f.admissions.length,
    0,
    'an exact replay does not open a second run',
  )
})

test('scope-changing preparation updates the exact existing request instead of acknowledging the old Goal', async (t) => {
  const message = human(
    'scope-change',
    'Add the new API endpoint to this parser task.',
  )
  const task = 'Add the new API endpoint to this parser task.'
  const intent = activeIntent(
    [message],
    task,
    'scope_change',
    'change',
    'implementation',
  )
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(
    await f.capture([message]),
    true,
    'scope changes remain conversational until the host admits their explicit preparation',
  )
  assert.equal(
    f.admissions.length,
    0,
    'capturing a scope change must not claim the previous run',
  )
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.admissions.length, 1)
  assert.equal(f.prepareRequests[0]?.requestIntent?.relation, 'scope_change')
  assert.equal(f.prepareRequests[0]?.context?.activeGoal?.scopeRevision, 3)
  assert.equal(f.bodies(), 0, 'scope preparation never executes a project tool')
})

test('same-scope continuation acknowledges the exact active run without creating a second one', async (t) => {
  const message = human('same-scope', 'Check the current parser tests.')
  const task = 'Check the current parser tests.'
  const intent = activeIntent(
    [message],
    task,
    'same_scope_continuation',
    'verify',
  )
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.admissions.length, 0)
  assert.equal(result.value.requestIntent.relation, 'same_scope_continuation')
})

test('unknown relationship cannot borrow an active Goal through a legacy taskType hint', async (t) => {
  const message = human('unknown-scope', 'Check that.')
  const task = 'Check that.'
  const intent = activeIntent([message], task, 'unknown', 'unknown')
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), true)
  const waiting = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(waiting.isError, false)
  assert.equal(waiting.value.prepared, false)
  assert.equal(waiting.value.status, 'awaiting_clarification')
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

test('a new request never consults the existing-run continuation lookup', async (t) => {
  const message = human('new-scope', 'Start a separate parser benchmark.')
  const task = 'Start a separate parser benchmark.'
  const intent = activeIntent(
    [message],
    task,
    'new',
    'change',
    'implementation',
  )
  let ownerLookups = 0
  const f = await fixture(t, {
    existing: async () => {
      ownerLookups++
      return true
    },
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), true)
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(ownerLookups, 0)
  assert.equal(f.admissions.length, 1)
  assert.equal(f.prepareRequests[0]?.requestIntent?.relation, 'new')
})

test('on-demand review: admission receives an immutable snapshot of the complete original human batch', async (t) => {
  const f = await fixture(t)
  const messages = [
    human('first', 'Do not modify files.'),
    human('second', 'Inspect src and compare the two approaches.'),
  ]
  const expected = structuredClone(messages)
  await f.capture(messages)
  messages[0]!.content[0]!.text = 'Replace every file.'
  assert.equal((await f.prepare()).isError, false)
  assert.deepEqual(f.admissions[0]!.messages, expected)
  assert.equal(
    f.intake.snapshot(f.session.id)?.task,
    'Do not modify files.\nInspect src and compare the two approaches.',
  )
})

test('on-demand review: changing text under the same human message ID replaces preparation', async (t) => {
  const f = await fixture(t),
    messages = [human('same-id', 'Inspect src without changing files.')]
  await f.capture(messages)
  messages[0]!.content[0]!.text = 'Delete src instead.'
  await f.capture(messages)
  assert.equal((await f.prepare()).isError, false)
  assert.equal(f.intake.snapshot(f.session.id)?.task, 'Delete src instead.')
  assert.equal(f.admissions.length, 1)
  assert.equal(f.bodies(), 0, 'preparation does not itself execute deletion')
})

test('on-demand review: advancing the native turn cannot reuse an older ready owner', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: a host-driven empty turn retires only the closed conversational binding', async (t) => {
  const advanced: number[] = []
  const f = await fixture(t, {
    advance: async (input) => {
      advanced.push(input.turn)
    },
  })
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/start', 2))
  assert.equal(
    await f.intake.capture({
      agent: f.agent,
      turn: 2,
      step: 0,
      messages: [],
      signal: signal(),
    }),
    false,
  )
  assert.deepEqual(
    advanced,
    [1, 2],
    'the host advances the policy boundary without inventing human input',
  )
  assert.equal(f.intake.snapshot(f.session.id), undefined)
  assert.equal(f.admissions.length, 1)
})

test('on-demand review: a pending host confirmation yields the next human turn to native admission', async (t) => {
  const f = await fixture(t, {
    resumeConfirmation: async (input) => input.turn === 2,
  })
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/start', 2))
  assert.equal(
    await f.capture(
      [human('confirmation-revision', 'Narrow the plan to src.')],
      2,
    ),
    false,
  )
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(
    f.admissions.length,
    1,
    'native admission, not model-facing preparation, owns the pending confirmation',
  )
})

test('same-turn steering prepares a fresh generation retaining the original request', async (t) => {
  const f = await fixture(t, {
    classify: async () => ({ taskType: 'build', deferInference: false }),
  })
  await f.capture([human('original', 'Fix the parser and run its tests.')])
  assert.equal((await f.execute()).isError, false)
  await f.capture([human('steering', 'Also cover empty input.')])
  assert.equal((await f.execute()).isError, false)
  assert.equal(f.admissions.length, 2)
  assert.equal(
    f.intake.snapshot(f.session.id)?.task,
    'Fix the parser and run its tests.\nAlso cover empty input.',
  )
})

test('on-demand review: finish between the native monotonic guard and dispatch prevents the body', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on(
    'tools/execute',
    async (execution: any, next: () => Promise<unknown>) => {
      if (execution.name === 'review_probe') {
        await Promise.resolve()
        f.intake.finish(f.session, 1)
      }
      return next()
    },
  )
  t.after(release)
  assert.equal(
    (await f.execute()).isError,
    true,
    'native dispatch must not start a body after its original request closed',
  )
  assert.equal(f.bodies(), 0)
})

test('on-demand review: stop between the native monotonic guard and dispatch prevents the body', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on(
    'tools/execute',
    async (execution: any, next: () => Promise<unknown>) => {
      if (execution.name === 'review_probe') {
        await Promise.resolve()
        f.intake.stop()
      }
      return next()
    },
  )
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: a newer captured turn revokes an older execution already past its guard', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on(
    'tools/execute',
    async (execution: any, next: () => Promise<unknown>) => {
      if (execution.name === 'review_probe') {
        f.events.push(event('turn/start', 2))
        await f.capture(
          [
            human(
              'replacement',
              'Explain the current result without running tools.',
            ),
          ],
          2,
        )
      }
      return next()
    },
  )
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: shutdown cancels and drains an in-flight host preparation', async (t) => {
  const started = deferred(),
    release = deferred()
  let preparationSignal: AbortSignal | undefined,
    settled = false
  const f = await fixture(t, {
    prepare: async (input) => {
      preparationSignal = input.signal
      started.resolve()
      await release.promise
      settled = true
      input.signal.throwIfAborted()
      return true
    },
  })
  await f.capture()
  const pending = f.prepare()
  await started.promise
  f.intake.stop()
  const draining = f.intake.drain()
  try {
    assert.equal(preparationSignal!.aborted, true)
    assert.equal(settled, false)
  } finally {
    release.resolve()
  }
  await draining
  assert.equal(settled, true)
  assert.equal((await pending).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: an existing owner must match the exact open native turn', async (t) => {
  const message = human('original', 'Inspect src without changing any files.')
  const intent = activeIntent(
    [message],
    'Inspect src without changing any files.',
    'same_scope_continuation',
    'research',
  )
  const f = await fixture(t, {
    existing: async () => true,
    interpret: async () => intent,
  })
  f.ready(1)
  assert.equal(await f.capture([message]), false)
  assert.equal(
    f.intake.snapshot(f.session.id)?.task,
    'Inspect src without changing any files.',
  )
  assert.equal(f.intake.snapshot(f.session.id)?.memoryOwner, 'execution')
  assert.equal(
    f.intake.snapshot(f.session.id)?.requestIntent?.relation,
    'same_scope_continuation',
  )
  assert.equal((await f.execute()).isError, false)
  f.events.push(event('turn/end', 1))
  assert.equal((await f.execute()).isError, true)
  f.events.push(event('turn/start', 2))
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 1)
})

test('on-demand review: exact agent retirement permits a fresh registered identity without reviving the old one', async (t) => {
  let registered: DemandAgent | undefined
  const f = await fixture(t, {
    validate: async (input) => {
      assert.equal(input.agent, registered)
      assert.equal(input.agent.session, registered?.session)
    },
    ready: (agent, turn) => agent === registered && turn === 1,
  })
  registered = f.agent
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  f.intake.retire({ ...f.agent })
  assert.equal(
    f.intake.snapshot(f.session.id)?.status,
    'prepared',
    'same-ID impostor cannot retire a live request',
  )
  f.intake.retire(f.agent)
  registered = undefined
  assert.equal(f.intake.snapshot(f.session.id), undefined)
  assert.equal((await f.execute()).isError, true)
  const replacement = {
    id: f.agent.id,
    session: {
      id: f.session.id,
      snapshotEvents: () => [event('turn/start', 1)],
    },
  }
  registered = replacement
  assert.equal(
    await f.intake.capture({
      agent: replacement,
      turn: 1,
      step: 0,
      messages: [human('reopened', 'Inspect src without modifying it.')],
      signal: signal(),
    }),
    true,
  )
  assert.equal(
    (await f.execute()).isError,
    true,
    'old object cannot consume the reopened session scope',
  )
  assert.equal(
    (
      await f.execute(
        TASK_PREPARE_TOOL,
        { taskType: 'research' },
        { agent: replacement },
      )
    ).isError,
    false,
  )
  assert.equal(f.bodies(), 0)
})

test('on-demand review: validated child bypass preserves downstream denial and rejects same-ID impostors', async (t) => {
  const child = {
    id: 'child',
    session: {
      id: 'child-session',
      snapshotEvents: () => [event('turn/start', 1)],
    },
  }
  const f = await fixture(t, { nativeChild: (agent) => agent === child })
  assert.equal(
    await f.intake.capture({
      agent: child,
      turn: 1,
      step: 0,
      messages: [],
      signal: signal(),
    }),
    false,
  )
  assert.equal(
    (await f.execute('review_probe', {}, { agent: child })).isError,
    false,
  )
  const release = f.ctx.on(
    'tools/pre-execute',
    (_execution: unknown, _next: unknown) => ({
      kind: 'deny',
      reason: 'child lease denied',
    }),
  )
  t.after(release)
  assert.equal(
    (await f.execute('review_probe', {}, { agent: child })).isError,
    true,
  )
  assert.equal(
    (await f.execute('review_probe', {}, { agent: { ...child } })).isError,
    true,
  )
  assert.equal(f.bodies(), 1)
})

for (const decision of ['deny', 'cancel'] as const)
  test(`on-demand review: downstream ${decision} still blocks direct and nested native execution`, async (t) => {
    const f = await fixture(t)
    await f.capture()
    assert.equal((await f.prepare()).isError, false)
    const release = f.ctx.on(
      'tools/pre-execute',
      (execution: any, next: () => Promise<unknown>) =>
        execution.name === 'review_probe'
          ? decision === 'cancel'
            ? { kind: 'cancel' }
            : { kind: 'deny', reason: 'downstream policy denied' }
          : next(),
    )
    t.after(release)
    assert.equal((await f.execute()).isError, true)
    assert.equal(
      (await f.execute('review_probe', {}, { parent: Symbol('nested-parent') }))
        .isError,
      true,
    )
    assert.equal(f.bodies(), 0)
  })

test('on-demand review: approval resolved after closure cannot revive the admitted request', async (t) => {
  const requested = deferred(),
    answer = deferred()
  const f = await fixture(t)
  f.ctx.provide('approval', {
    request: async () => {
      requested.resolve()
      await answer.promise
      return 'allowed-once'
    },
  })
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.on(
    'tools/pre-execute',
    (execution: any, next: () => Promise<unknown>) =>
      execution.name === 'review_probe'
        ? { kind: 'ask', reason: 'native approval' }
        : next(),
  )
  t.after(release)
  const execution = f.execute()
  await requested.promise
  f.intake.finish(f.session, 1)
  answer.resolve()
  assert.equal((await execution).isError, true)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: concurrent preparation is consumed once and never replaces the advisory type', async (t) => {
  const started = deferred(),
    release = deferred()
  let prepared = 0
  const f = await fixture(t, {
    prepare: async () => {
      prepared++
      started.resolve()
      await release.promise
      return true
    },
  })
  f.ready(1)
  await f.capture()
  const first = f.prepare()
  await started.promise
  try {
    assert.equal(
      (await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })).isError,
      true,
    )
    assert.equal(prepared, 1)
  } finally {
    release.resolve()
  }
  assert.equal((await first).isError, false)
  assert.equal(f.intake.snapshot(f.session.id)?.taskType, 'research')
  assert.equal(
    (await f.prepare()).isError,
    false,
    'a later receipt acknowledges the single admission',
  )
  assert.equal(prepared, 1)
})

test('on-demand review: direct, nested, and agentless execution cannot run before preparation', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.execute()).isError, true)
  assert.equal(
    (await f.execute('review_probe', {}, { parent: Symbol('nested-parent') }))
      .isError,
    true,
  )
  assert.equal(
    (await f.execute('review_probe', {}, { agent: undefined })).isError,
    true,
  )
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

test('on-demand review: successful preparation cannot override a native monotonic denial', async (t) => {
  const f = await fixture(t)
  await f.capture()
  assert.equal((await f.prepare()).isError, false)
  const release = f.ctx.tools.guard((execution: any) =>
    execution.name === 'review_probe'
      ? 'native operation is not authorized'
      : undefined,
  )
  t.after(release)
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
})

for (const task of ['それを消して？', 'Delete that.'])
  test(`on-demand review: advisory type cannot resolve a known missing destructive target: ${task}`, async (t) => {
    const f = await fixture(t)
    await f.capture([human('original', task)])
    const waiting = await f.prepare()
    assert.equal(waiting.isError, false)
    assert.equal(waiting.value.status, 'awaiting_clarification')
    assert.equal(waiting.value.prepared, false)
    assert.match(waiting.value.question, /対象/)
    assert.equal(
      f.admissions.length,
      0,
      'reject before the host can default the target to cwd',
    )
    assert.equal((await f.execute()).isError, true)
    assert.equal(f.bodies(), 0)
  })

test('on-demand review: automatic classifier advice cannot resolve a known missing destructive target', async (t) => {
  const f = await fixture(t, {
    classify: async () => ({ taskType: 'research', deferInference: false }),
  })
  await f.capture([human('original', 'それを消して？')])
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
})

function webTool(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  name = 'web_search',
) {
  const calls: any[] = []
  const release = f.ctx.tools.register({
    name,
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: (args: unknown, execution: any) => {
      calls.push({ args, execution })
      return 'web result'
    },
  })
  t.after(release)
  ;(calls as any).release = release
  return calls
}
for (const taskType of [undefined, 'chat', 'writing'] as const)
  for (const name of ['read', 'glob', 'grep']) {
    test(`native file evidence: ${name} preserves ${taskType ?? 'unclassified'} advice and the original request`, async (t) => {
      const f = await fixture(t, {
        classify: async () => ({
          ...(taskType ? { taskType } : {}),
          deferInference: !taskType,
        }),
      })
      const calls = webTool(t, f, name),
        messages = [
          human(
            'original',
            'Read PLAN.md and compare the alternatives. Do not modify files.',
          ),
        ]
      await f.capture(messages)
      assert.equal(
        (await f.execute(name, { file_path: 'PLAN.md' })).isError,
        false,
      )
      assert.deepEqual(f.advice, [])
      assert.equal(
        f.intake.snapshot(f.session.id)?.task,
        messages[0]!.content[0]!.text,
      )
      assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
      assert.equal(
        (await f.execute(name, { file_path: 'PLAN.md' })).isError,
        false,
      )
      assert.equal(f.admissions.length, 0)
      assert.equal(calls.length, 2)
    })
  }
test('native file evidence: concurrent file demands need no execution admission', async (t) => {
  const gate = deferred()
  let preparations = 0
  const f = await fixture(t, {
    prepare: async () => {
      preparations++
      await gate.promise
      f.ready(1)
      return true
    },
  })
  const reads = webTool(t, f, 'read'),
    searches = webTool(t, f, 'grep')
  await f.capture()
  const first = f.execute('read'),
    second = f.execute('grep')
  await new Promise((resolve) => setImmediate(resolve))
  gate.resolve()
  assert.ok(
    (await Promise.all([first, second])).every((result) => !result.isError),
  )
  assert.equal(preparations, 0)
  assert.equal(reads.length, 1)
  assert.equal(searches.length, 1)
})
test('native file evidence: foreign agent and pending memory cannot borrow read admission', async (t) => {
  const f = await fixture(t),
    calls = webTool(t, f, 'read')
  await f.capture()
  assert.equal(
    (await f.execute('read', {}, { agent: { ...f.agent } })).isError,
    true,
  )
  assert.equal(f.admissions.length, 0)
  assert.equal(calls.length, 0)
  t.after(
    f.ctx.tools.guard(() => 'resolve memory decisions before native work'),
  )
  assert.equal((await f.execute('read')).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(calls.length, 0)
})
for (const taskType of [undefined, 'chat', 'debug'] as const)
  for (const name of ['web_search', 'web_fetch']) {
    test(`native web evidence: ${name} with ${taskType ?? 'unclassified'} advice`, async (t) => {
      const f = await fixture(t, {
        classify: async () => ({
          ...(taskType ? { taskType } : {}),
          deferInference: !taskType,
        }),
      })
      const calls = webTool(t, f, name),
        messages = [
          human(
            'original',
            'vmware toolsの最新の脆弱性でクリティカルレベルのものある？',
          ),
        ]
      await f.capture(messages)
      const args =
        name === 'web_search'
          ? { queries: ['VMware Tools critical CVE'] }
          : { url: 'https://example.com/advisory' }
      assert.equal(
        (await f.execute(name, args, { callId: 'original-call' })).isError,
        false,
      )
      assert.deepEqual(f.advice, [])
      assert.equal(
        f.intake.snapshot(f.session.id)?.task,
        messages[0]!.content[0]!.text,
      )
      assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].args, args)
      assert.equal(calls[0].execution.callId, 'original-call')
      assert.equal(calls[0].execution.agent, f.agent)
      assert.equal((await f.execute(name, args)).isError, false)
      assert.equal(f.admissions.length, 0)
      assert.equal(calls.length, 2)
    })
  }
for (const task of [
  'それを検索して',
  'search that',
  'look up it',
  'それを消して？',
  'Delete that.',
  'search A or B, I am undecided',
]) {
  test(`native web evidence: missing scope stops ${task}`, async (t) => {
    const f = await fixture(t),
      calls = webTool(t, f)
    await f.capture([human('original', task)])
    assert.equal(
      (await f.execute('web_search', { queries: ['invented target'] })).isError,
      true,
    )
    assert.equal(f.admissions.length, 0)
    assert.equal(calls.length, 0)
  })
}
test('native web evidence: concurrent web calls need no pending admission', async (t) => {
  const gate = deferred()
  let preparations = 0
  const f = await fixture(t, {
    prepare: async () => {
      preparations++
      await gate.promise
      f.ready(1)
      return true
    },
  })
  const calls = webTool(t, f)
  await f.capture()
  const first = f.execute('web_search'),
    second = f.execute('web_search')
  await new Promise((resolve) => setImmediate(resolve))
  gate.resolve()
  assert.ok(
    (await Promise.all([first, second])).every((result) => !result.isError),
  )
  assert.equal(preparations, 0)
  assert.equal(calls.length, 2)
})
for (const failure of ['deny', 'cancel', 'closed'] as const) {
  test(`native web evidence: ${failure} prevents web body`, async (t) => {
    const f = await fixture(t)
    const calls = webTool(t, f)
    if (failure === 'deny' || failure === 'cancel')
      t.after(
        f.ctx.on('tools/pre-execute', async () => ({
          kind: failure,
          reason: 'native policy',
        })),
      )
    if (failure === 'closed')
      t.after(
        f.ctx.on(
          'tools/execute',
          async (_execution: any, next: () => Promise<unknown>) => {
            f.intake.finish(f.session, 1)
            return next()
          },
        ),
      )
    await f.capture()
    assert.equal((await f.execute('web_search')).isError, true)
    assert.equal(calls.length, 0)
  })
}

for (const invalidation of ['definition', 'turn', 'cancel'] as const)
  test(
    `native web evidence: ${invalidation} before dispatch revokes evidence read`,
    { timeout: 5000 },
    async (t) => {
      const started = deferred(),
        gate = deferred()
      const f = await fixture(t)
      t.after(
        f.ctx.on(
          'tools/pre-execute',
          async (execution: any, next: () => Promise<unknown>) => {
            if (execution.name === 'web_search') {
              started.resolve()
              await gate.promise
            }
            return next()
          },
        ),
      )
      const calls = webTool(t, f),
        controller = new AbortController()
      await f.capture()
      const pending = f.execute('web_search', {}, { signal: controller.signal })
      await started.promise
      if (invalidation === 'cancel') controller.abort()
      if (invalidation === 'turn') f.events.push(event('turn/start', 2))
      if (invalidation === 'definition') {
        // Replacement must not inherit the definition checked before admission.
        ;(calls as any).release()
        t.after(
          f.ctx.tools.register({
            name: 'web_search',
            parameters: {},
            output: { schema: {}, render: () => [] },
            execute: () => {
              calls.push('replacement')
              return 'replacement'
            },
          }),
        )
      }
      gate.resolve()
      assert.equal((await pending).isError, true)
      assert.equal(calls.length, 0)
    },
  )

test('native web evidence: downstream native guard remains authoritative without admission', async (t) => {
  const f = await fixture(t),
    calls = webTool(t, f)
  t.after(
    f.ctx.tools.guard(() => 'resolve memory decisions before native work'),
  )
  await f.capture()
  assert.equal((await f.execute('web_search')).isError, true)
  assert.equal(f.admissions.length, 0)
  assert.equal(calls.length, 0)
})

test('pending confirmation resumes only after the host admits the exact current native turn', async (t) => {
  const f = await fixture(t, { resumeConfirmation: async () => true })
  assert.equal(
    await f.capture([human('revision', 'Limit the plan to src and continue.')]),
    false,
  )
  assert.equal(
    f.intake.pending(f.agent),
    false,
    'host confirmation must not borrow retired conversational memory',
  )
  assert.equal(
    (await f.execute()).isError,
    true,
    'a pending confirmation grants no execution',
  )
  f.ready(1)
  assert.equal(
    (await f.execute()).isError,
    false,
    'host admission may resume its confirmation route without another preparation',
  )
  assert.equal(f.admissions.length, 0)
  assert.equal(
    (await f.execute('review_probe', {}, { agent: { ...f.agent } })).isError,
    true,
  )
  const deny = f.ctx.tools.guard(() => 'native denial')
  try {
    assert.equal((await f.execute()).isError, true)
  } finally {
    deny()
  }
  f.ready(2)
  assert.equal(
    (await f.execute()).isError,
    true,
    'the confirmation cannot authorize another turn',
  )
})

test('declining execution selection keeps acknowledgement available without admitting tools or replaying preparation', async (t) => {
  let attempts = 0
  const f = await fixture(t, {
    prepare: async () => {
      attempts++
      throw new ExecutionSelectionPending()
    },
  })
  await f.capture()
  assert.equal((await f.prepare()).isError, true)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(
    await f.capture(),
    true,
    'the same human input can reach the next reasoning step',
  )
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.bodies(), 0)
  assert.equal(
    (await f.prepare()).isError,
    true,
    'the model cannot reopen a declined choice within the same turn',
  )
  assert.equal(attempts, 1)
})

test('recoverable preparation failure preserves the request but retry must reacquire exact native admission', async (t) => {
  let attempts = 0,
    admitted = false
  const f = await fixture(t, {
    ready: () => admitted,
    prepare: async () => {
      attempts++
      if (attempts === 1)
        throw new Error('Optional preparation temporarily unavailable')
      admitted = true
      return true
    },
  })
  await f.capture()
  assert.equal((await f.prepare()).isError, true)
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
  assert.equal(
    await f.capture(),
    true,
    'a recoverable error does not retire the human request',
  )
  assert.equal(
    (await f.execute()).isError,
    true,
    'failure does not grant execution',
  )
  assert.equal(f.bodies(), 0)
  assert.equal(
    (await f.prepare()).isError,
    false,
    'a fresh call can reattempt host admission',
  )
  assert.equal(attempts, 2)
  assert.equal(
    (await f.execute('review_probe', {}, { agent: { ...f.agent } })).isError,
    true,
  )
  const deny = f.ctx.tools.guard(() => 'native denial after retry')
  try {
    assert.equal((await f.execute()).isError, true)
    assert.equal(f.bodies(), 0)
  } finally {
    deny()
  }
  assert.equal((await f.execute()).isError, false)
  assert.equal(f.bodies(), 1)
  f.events.push(event('turn/start', 2))
  assert.equal(
    (await f.execute()).isError,
    true,
    'retried admission cannot authorize a newer turn',
  )
  assert.equal(f.bodies(), 1)
})

for (const name of ['read', 'glob', 'grep', 'web_search', 'web_fetch'] as const)
  test(`unowned native ${name} needs no optional classifier but keeps native denial and current ownership`, async (t) => {
    let owner: 'unowned' | 'owned' = 'unowned',
      bodies = 0
    const f = await fixture(t, {
      nativeOwnership: async () => owner,
      classify: async () => {
        throw new Error('optional classifier unavailable')
      },
    })
    const release = f.ctx.tools.register({
      name,
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: () => {
        bodies++
        return 'native evidence'
      },
    })
    t.after(release)
    await f.capture()
    assert.equal((await f.execute(name)).isError, false)
    assert.equal(bodies, 1)
    assert.equal(f.admissions.length, 0)
    const deny = f.ctx.tools.guard((execution: any) =>
      execution.name === name ? 'NATIVE_TEST_DENIED' : undefined,
    )
    assert.match(JSON.stringify(await f.execute(name)), /NATIVE_TEST_DENIED/)
    assert.equal(bodies, 1)
    deny()
    owner = 'owned'
    assert.equal((await f.execute(name)).isError, true)
    assert.equal(bodies, 1)
  })
for (const change of ['arguments', 'stop', 'owner'] as const)
  test(`unowned native read rejects a ${change} change after native pre-execute`, async (t) => {
    let owner: 'unowned' | 'owned' = 'unowned',
      bodies = 0
    const f = await fixture(t, { nativeOwnership: async () => owner })
    const release = f.ctx.tools.register({
      name: 'read',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: () => {
        bodies++
        return 'private evidence'
      },
    })
    t.after(release)
    await f.capture()
    const mutate = f.ctx.tools.guard((execution: any) => {
      if (execution.name === 'read') {
        if (change === 'stop') f.intake.stop()
        else if (change === 'owner') owner = 'owned'
        else execution.arguments.changed = true
      }
      return undefined
    })
    t.after(mutate)
    assert.equal((await f.execute('read', {})).isError, true)
    assert.equal(bodies, 0)
  })

test('unowned preparation explains absent task and recovers without taskOperation', async (t) => {
  let classifications = 0,
    nativeBodies = 0,
    workflowBodies = 0
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    classify: async () => {
      classifications++
      return { deferInference: true }
    },
  })
  for (const name of ['bash', 'coding_workflow'])
    t.after(
      f.ctx.tools.register({
        name,
        parameters: { type: 'object' },
        output: { schema: {}, render: () => [] },
        execute: () => {
          if (name === 'bash') nativeBodies++
          else workflowBodies++
          return 'body'
        },
      }),
    )
  const task = 'Fix the shortcut rendering in the local UI; do not publish.'
  const messages = [human('repair-request', task)]
  await f.capture(messages)
  assert.equal(
    classifications,
    0,
    'unowned native work does not wait for optional classification',
  )
  const denied = await f.execute('coding_workflow')
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /call prepare_requested_work/)
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs(messages, task),
  })!
  const requestIntent = {
    relation: 'new',
    action: 'change',
    changeScope: 'implementation',
    evidenceRefs: requestIntentReferenceIds(context),
  }
  const prepare = (intent: object) =>
    f.execute(TASK_PREPARE_TOOL, { requestIntent: intent })
  const invalid = await prepare({ ...requestIntent, taskOperation: 'start' })
  assert.equal(invalid.isError, true)
  assert.match(JSON.stringify(invalid), /No active SQLite task/)
  assert.match(JSON.stringify(invalid), /omit taskOperation/)
  assert.equal(f.admissions.length, 0)
  assert.equal(workflowBodies, 0)
  assert.equal(
    (await f.execute('bash')).isError,
    false,
    'invalid optional task operation cannot block unowned native Bash',
  )
  assert.equal(nativeBodies, 1)
  const corrected = await prepare(requestIntent)
  assert.equal(corrected.isError, false, JSON.stringify(corrected))
  assert.equal(f.admissions.length, 1)
  assert.equal((f.admissions[0]?.messages[0] as any)?.id, 'repair-request')
  assert.equal(f.prepareRequests[0]?.requestIntent?.taskOperation, undefined)
  assert.equal((await f.execute('coding_workflow')).isError, false)
  assert.equal(
    workflowBodies,
    1,
    'only admitted coding workflow reaches its body',
  )
})

for (const sample of [
  {
    state: 'ToDo',
    runStatus: 'intake',
    operation: 'resume',
    allowed: 'start, wait, ignore',
  },
  {
    state: 'Working',
    runStatus: 'active',
    operation: 'start',
    allowed: 'wait, complete, ignore',
  },
  {
    state: 'Pending',
    runStatus: 'active',
    operation: 'complete',
    allowed: 'resume, ignore',
  },
  {
    state: 'Done',
    runStatus: 'completed',
    operation: 'resume',
    allowed: 'resume',
  },
] as const)
  test(`preparation reports the current ${sample.state} task without executing invalid ${sample.operation}`, async (t) => {
    const task = 'Inspect the current task; do not publish.'
    const messages = [human('inspection-request', task)]
    const context = createRequestIntentContext({
      task,
      messageRefs: requestIntentMessageRefs(messages, task),
      activeTask: {
        taskId: 'synthetic-task',
        runId: 'synthetic-task',
        sessionId: 'review-session',
        sourceSessionId: 'review-session',
        repositoryRoot: '/synthetic',
        type: 'research',
        state: sample.state,
        revision: 4,
        generation: 7,
        runStatus: sample.runStatus,
        reason: 'Synthetic regression fixture',
        evidence: [],
        allowedOps: sample.allowed.split(', ') as any,
        request: task,
        resumedFromTerminal: false,
      },
    })!
    const requestIntent = {
      relation: 'same_scope_continuation',
      action: 'research',
      evidenceRefs: requestIntentReferenceIds(context),
    }
    const decision = bindMainModelRequestIntent(requestIntent, context)!
    const original = structuredClone(context)
    const f = await fixture(t, {
      interpret: async () => ({ context, decision }),
    })
    await f.capture(messages)
    const result = await f.execute(TASK_PREPARE_TOOL, {
      requestIntent: { ...requestIntent, taskOperation: sample.operation },
    })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), new RegExp(`state ${sample.state}`))
    assert.match(JSON.stringify(result), /revision 4, generation 7/)
    assert.ok(
      JSON.stringify(result).includes(
        `Allowed state operations: ${sample.allowed}.`,
      ),
    )
    if (sample.state === 'Done')
      assert.match(
        JSON.stringify(result),
        /terminal resume requires an explicit operation/,
      )
    assert.equal(f.admissions.length, 0)
    assert.deepEqual(
      context,
      original,
      'a rejected advisory operation never mutates the task snapshot',
    )
  })

test('unowned native coding preparation receives the exact request-intent context before the callback', async (t) => {
  let captured: { task: string; context?: RequestIntentContext } | undefined
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    classify: async () => {
      throw new Error('optional classifier unavailable')
    },
    prepareNativeCoding: async (_input, task, context) => {
      captured = { task, ...(context === undefined ? {} : { context }) }
    },
  })
  const task =
    'Okay okay, improve this source base. What do you do to make that happen?'
  const messages = [human('improve-request', task)]
  await f.capture(messages)
  assert.ok(captured)
  const context = captured.context
  assert.ok(context)
  assert.equal(captured.task, task)
  assert.equal(context.task, task)
  assert.deepEqual(
    context.messageRefs,
    requestIntentMessageRefs(messages, task),
  )
  const state = f.intake.snapshot(f.session.id)!
  assert.equal(state.requestIntent?.source, 'unresolved')
  assert.equal(state.requestIntent?.unresolvedReason, 'native_unowned_request')
  assert.equal(state.status, 'answer')
  assert.equal(f.admissions.length, 0)
})

test('ordinary native Bash remains available with owned metadata and deferred optional intake', async (t) => {
  const f = await fixture(t, {
    nativeOwnership: async () => 'owned',
    classify: async () => ({ deferInference: true }),
  })
  let bodies = 0,
    databaseCalls = 0
  t.after(
    f.ctx.tools.register({
      name: 'bash',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: () => {
        bodies++
        return 'native command body'
      },
    }),
  )
  await f.capture([
    human(
      'native-command',
      'Inspect the current project and run the normal command.',
    ),
  ])
  const first = await f.execute('bash', { command: 'pwd' })
  assert.equal(first.isError, false, JSON.stringify(first))
  t.after(
    await mountOwnedExecution(
      { tools: f.ctx.tools, on: f.ctx.on.bind(f.ctx) },
      {
        runtime: {
          withDatabase: async () => {
            databaseCalls++
            throw new Error(
              'Optional workflow storage must not admit native Bash',
            )
          },
        } as any,
        resolve: () => undefined,
        nativeCommand: (execution) => f.intake.nativeCommand(execution as any),
      },
    ),
  )
  assert.equal(
    (await f.execute('bash', { command: 'git status --short' })).isError,
    false,
  )
  assert.equal(f.admissions.length, 0)
  assert.equal(databaseCalls, 0)
  const deny = f.ctx.tools.guard(() => 'Native policy denied')
  assert.equal((await f.execute('bash', { command: 'pwd' })).isError, true)
  deny()
  const mutate = f.ctx.tools.guard((execution: any) => {
    execution.arguments.command = 'changed after native admission'
    return undefined
  })
  t.after(mutate)
  assert.equal((await f.execute('bash', { command: 'pwd' })).isError, true)
  mutate()
  assert.equal(
    (await f.execute('kioku_exec', { command: 'pwd' })).isError,
    true,
    'Kiokuko-owned execution keeps its own authority',
  )
  f.intake.stop()
  assert.equal((await f.execute('bash', { command: 'pwd' })).isError, true)
  assert.equal(bodies, 2)
})

for (const reason of [
  'decision_service_disabled',
  'proposal_reference_uncertain',
] as const)
  test(`current-source interpretation after evidence read: ${reason}`, async (t) => {
    const messages = [
      human(
        'current-implementation',
        'Implement src/main.rs as described. 通常実行で。',
      ),
    ]
    const task = messages[0]!.content[0]!.text
    const context = createRequestIntentContext({
      task,
      messageRefs: requestIntentMessageRefs(messages, task),
      proposals: [
        {
          id: 'same-session-proposal',
          revision: null,
          digest: 'a'.repeat(64),
          text: 'Implement the Rust command.',
        },
      ],
    })!
    const f = await fixture(t, {
      nativeOwnership: async () => 'owned',
      classify: async () => ({ taskType: 'writing', deferInference: false }),
      interpret: async () => ({
        context,
        decision: unresolvedRequestIntent(context, reason),
      }),
    })
    const calls = webTool(t, f, 'read')
    await f.capture(messages)
    const before = f.intake.snapshot(f.session.id)
    assert.equal(
      (await f.execute('read', { path: 'src/main.rs' })).isError,
      false,
    )
    assert.equal(calls.length, 1)
    assert.equal(f.admissions.length, 0)
    assert.deepEqual(
      f.intake.snapshot(f.session.id),
      before,
      'evidence cannot commit the advisory writing classification',
    )
    const requestIntent = {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context).filter(
        (ref) => !ref.startsWith('proposal:'),
      ),
    }
    const stale = {
      ...requestIntent,
      evidenceRefs: ['message:foreign-request'],
    }
    assert.equal(
      (await f.execute(TASK_PREPARE_TOOL, { requestIntent: stale })).isError,
      true,
    )
    assert.equal(f.admissions.length, 0)
    assert.equal(
      (await f.execute(TASK_PREPARE_TOOL, { requestIntent })).isError,
      false,
    )
    assert.equal(f.admissions.length, 1)
    assert.equal(f.advice[0], 'build')
    assert.equal(
      (await f.execute(TASK_PREPARE_TOOL, { requestIntent })).isError,
      false,
      'exact same-turn retry stays idempotent',
    )
    assert.equal(f.admissions.length, 1)
    assert.equal(
      (await f.execute(TASK_PREPARE_TOOL, { taskType: 'writing' })).isError,
      true,
      'explicit prepared intent cannot be changed back',
    )
  })
for (const unavailable of ['admission', 'readiness'] as const)
  test(`native evidence is independent of optional ${unavailable}`, async (t) => {
    const f = await fixture(
      t,
      unavailable === 'admission'
        ? {
            prepare: async () => {
              throw new Error('optional admission unavailable')
            },
          }
        : { ready: () => false },
    )
    const calls = webTool(t, f, 'read')
    await f.capture()
    assert.equal((await f.execute('read')).isError, false)
    assert.equal(calls.length, 1)
    assert.equal(f.admissions.length, 0)
  })
test('owned-context native evidence rejects changed arguments before dispatch', async (t) => {
  const f = await fixture(t, { nativeOwnership: async () => 'owned' }),
    calls: unknown[] = []
  let mutationReached = false
  t.after(
    f.ctx.tools.register({
      name: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      output: { schema: {}, render: () => [] },
      execute: (args: unknown) => {
        calls.push(args)
        return 'source'
      },
    }),
  )
  await f.capture()
  t.after(
    f.ctx.tools.guard((execution: any) => {
      if (execution.name === 'read') {
        mutationReached = true
        execution.arguments.path = 'other-source'
      }
      return undefined
    }),
  )
  assert.equal((await f.execute('read', { path: 'src/main.rs' })).isError, true)
  assert.equal(
    mutationReached,
    true,
    'the original valid request reaches the native guard before its declared path changes',
  )
  assert.equal(calls.length, 0)
  assert.equal(f.admissions.length, 0)
})

for (const relation of [
  'new',
  'same_scope_continuation',
  'scope_change',
] as const)
  test(`unknown change scope cannot borrow existing authority (${relation})`, async (t) => {
    const task = 'Continue changing the current artifact.'
    const message = human('unknown-change-scope', task)
    const intent = activeIntent([message], task, relation, 'change')
    let ownerLookups = 0
    const f = await fixture(t, {
      existing: async () => {
        ownerLookups++
        return true
      },
      interpret: async () => intent,
    })
    f.ready(1)
    assert.equal(await f.capture([message]), true)
    for (const args of [
      { taskType: 'build' },
      {
        requestIntent: {
          relation,
          action: 'change',
          evidenceRefs: requestIntentReferenceIds(intent.context),
        },
      },
    ]) {
      const result = await f.execute(TASK_PREPARE_TOOL, args)
      assert.equal(result.isError, false)
      assert.equal(result.value.prepared, false)
      assert.equal(
        result.value.status,
        'requestIntent' in args
          ? 'request_interpretation_required'
          : 'awaiting_clarification',
      )
    }
    assert.equal(ownerLookups, 0)
    assert.equal(f.admissions.length, 0)
    assert.equal(f.bodies(), 0)
  })

// A real native tool result carries waiting state; only the question service is doubled.
test('clarification deduplicates semantic retries and never turns dismissal into admission', async (t) => {
  const task = 'Inspect the requested artifact.',
    message = human('clarification-original', task)
  const intent = activeIntent([message], task, 'unknown', 'unknown')
  let asks = 0,
    followups = 0
  const f = await fixture(t, {
    interpret: async () => intent,
    questions: {
      async ask(request) {
        asks++
        return { answers: [{ id: request.questions[0].id, selected: [] }] }
      },
    },
  })
  ;(f.agent as any).followup = () => {
    followups++
  }
  await f.capture([message])
  const first = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'unknown',
      action: 'unknown',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  const second = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'unknown',
      action: 'unknown',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  for (const result of [first, second]) {
    assert.equal(result.isError, false)
    assert.equal(result.value.prepared, false)
    assert.equal(result.value.status, 'awaiting_clarification')
  }
  assert.equal(first.value.questionId, second.value.questionId)
  assert.equal(asks, 1)
  assert.equal(followups, 0)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
  assert.equal(
    (
      await f.execute(
        TASK_PREPARE_TOOL,
        { taskType: 'review' },
        { agent: { ...f.agent } },
      )
    ).isError,
    true,
  )
  assert.equal(asks, 1, 'another agent cannot reuse the pending question')
  assert.equal(f.intake.awaitingClarification(f.agent), true)
  f.events.push({
    ...event('turn/end', 1),
    data: { turn: 1, reason: { kind: 'aborted' } },
  } as any)
  f.intake.finish(f.session, 1)
  assert.equal(
    f.intake.awaitingClarification(f.agent),
    false,
    'Stop after dismissal must not suppress cancellation cleanup',
  )
})

test('Stop during clarification revalidation cannot enqueue a late human followup', async (t) => {
  const task = 'Inspect the requested artifact.',
    message = human('clarification-stop', task)
  const intent = activeIntent([message], task, 'unknown', 'unknown')
  let calls = 0,
    followups = 0,
    release!: () => void,
    entered!: () => void
  const blocked = new Promise<void>((resolve) => {
      release = resolve
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve
    })
  const f = await fixture(t, {
    interpret: async () => {
      if (++calls > 1) {
        entered()
        await blocked
      }
      return intent
    },
    questions: {
      async ask(request) {
        return {
          answers: [
            {
              id: request.questions[0].id,
              selected: [],
              custom: 'Only inspect PLAN.md.',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = () => {
    followups++
  }
  await f.capture([message])
  const controller = new AbortController()
  const pending = f.execute(
    TASK_PREPARE_TOOL,
    { taskType: 'review' },
    { signal: controller.signal },
  )
  await ready
  controller.abort(new Error('Human Stop'))
  release()
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(followups, 0)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
  assert.equal(f.intake.awaitingClarification(f.agent), false)
})

test('clarification without a context never reuses another human request question', async (t) => {
  let asks = 0
  const f = await fixture(t, {
    questions: {
      async ask(request) {
        asks++
        return { answers: [{ id: request.questions[0].id, selected: [] }] }
      },
    },
  })
  ;(f.agent as any).followup = () => {
    throw new Error('Dismissal must not enqueue')
  }
  await f.capture([human('first-unknown-target', 'Delete that.')])
  const first = await f.prepare()
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/end', 1), event('turn/start', 2))
  await f.capture([human('second-unknown-target', 'Send that.')], 2)
  const second = await f.prepare()
  assert.equal(first.value.status, 'awaiting_clarification')
  assert.equal(second.value.status, 'awaiting_clarification')
  assert.notEqual(first.value.questionId, second.value.questionId)
  assert.equal(asks, 2)
  assert.equal(f.admissions.length, 0)
})

test('a Pending task asks for an explicit transition without starting or duplicating work', async (t) => {
  const task = 'Continue the current inspection.',
    message = human('pending-authority', task)
  const activeTask = {
    taskId: 'pending-task',
    runId: 'pending-task',
    sessionId: 'review-session',
    sourceSessionId: 'review-session',
    repositoryRoot: '/repo',
    type: 'research' as const,
    state: 'Pending' as const,
    revision: 4,
    generation: 7,
    runStatus: 'active' as const,
    reason: 'Waiting for information',
    evidence: [],
    allowedOps: ['resume', 'ignore'] as const,
    request: 'Inspect PLAN.md',
    resumedFromTerminal: false,
  }
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs([message], task),
    activeTask: { ...activeTask, allowedOps: [...activeTask.allowedOps] },
  })!
  const decision = bindMainModelRequestIntent(
    {
      relation: 'same_scope_continuation',
      action: 'verify',
      evidenceRefs: requestIntentReferenceIds(context),
    },
    context,
  )!
  let asks = 0
  const f = await fixture(t, {
    interpret: async () => ({ context, decision }),
    questions: {
      async ask(request) {
        asks++
        assert.match(request.questions[0].question, /Pending/)
        return { answers: [{ id: request.questions[0].id, selected: [] }] }
      },
    },
  })
  ;(f.agent as any).followup = () => {
    throw new Error('An unanswered question is not a transition')
  }
  await f.capture([message])
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'awaiting_clarification')
  assert.equal(asks, 1)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.bodies(), 0)
  assert.equal(context.activeTask!.state, 'Pending')
  assert.equal(context.activeTask!.revision, 4)
  assert.equal(context.activeTask!.generation, 7)
})

// Assessment dependency doubles exercise native question/dispatch authority, not Rust or model quality.
for (const outcome of ['clarify'] as const)
  test(`independent assessment ${outcome} asks once and does not admit the candidate`, async (t) => {
    const task = 'Implement the change in src/parser.ts.',
      message = human(`assessment-${outcome}`, task),
      intent = activeIntent(
        [message],
        task,
        'same_scope_continuation',
        'change',
        'implementation',
      )
    let asks = 0,
      assessments = 0
    const f = await fixture(t, {
      interpret: async () => intent,
      assess: async () => {
        assessments++
        return {
          semantic: 'contradicted',
          semanticInputDigest: 'a'.repeat(64),
          detector: {
            state: 'unavailable',
            reason: 'artifact_unavailable',
            elapsedMs: 0,
          },
          outcome,
        }
      },
      questions: {
        async ask(r) {
          asks++
          return { answers: [{ id: r.questions[0].id, selected: [] }] }
        },
      },
    })
    ;(f.agent as any).followup = () => assert.fail('Dismissal is not an answer')
    await f.capture([message])
    const args = {
      requestIntent: {
        relation: 'same_scope_continuation',
        action: 'change',
        changeScope: 'implementation',
        evidenceRefs: requestIntentReferenceIds(intent.context),
      },
    }
    const first = await f.execute(TASK_PREPARE_TOOL, args),
      second = await f.execute(TASK_PREPARE_TOOL, args)
    assert.equal(first.isError, false)
    assert.equal(first.value.status, 'awaiting_clarification')
    assert.equal(second.value.questionId, first.value.questionId)
    assert.equal(asks, 1)
    assert.equal(assessments, 1)
    assert.equal(f.admissions.length, 0)
    assert.equal(f.bodies(), 0)
  })
test('ordinary explanation does not require Rust, provider availability or optional Lisp answers', async (t) => {
  const task = 'Explain the current parser design.',
    message = human('explain-no-optional-state', task),
    intent = activeIntent([message], task, 'same_scope_continuation', 'answer')
  const f = await fixture(t, {
    interpret: async () => intent,
    assess: async () =>
      assert.fail('Explanations do not invoke the execution judge'),
  })
  assert.equal(await f.capture([message]), true)
  assert.equal(f.admissions.length, 0)
})
test('accepted native clarification creates a fresh source revision and preserves the latest explicit answer', async (t) => {
  const task = 'Only explain src/parser.ts; do not change it.',
    message = human('superseded-prohibition', task)
  const original = activeIntent(
    [message],
    task,
    'same_scope_continuation',
    'change',
    'implementation',
  )
  let asks = 0
  const followups: any[] = []
  const f = await fixture(t, {
    interpret: async () => original,
    assess: async () => ({
      semantic: 'contradicted',
      semanticInputDigest: 'b'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'clarify',
    }),
    questions: {
      async ask(r) {
        asks++
        return {
          answers: [
            {
              id: r.questions[0].id,
              selected: [],
              custom:
                'I now explicitly request the implementation in src/parser.ts. Replace the earlier explanation-only instruction for this file.',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = (m: any) => followups.push(m)
  await f.capture([message])
  const args = {
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(original.context),
    },
  }
  const result = await f.execute(TASK_PREPARE_TOOL, args)
  assert.equal(result.value.status, 'clarification_answer_queued')
  assert.equal(result.value.nextAction, 'await_queued_answer_capture')
  assert.equal(typeof result.value.answerRef, 'string')
  const repeated = await f.execute(TASK_PREPARE_TOOL, args)
  assert.equal(repeated.value.answerRef, result.value.answerRef)
  assert.equal(asks, 1)
  assert.equal(followups.length, 1)
  assert.equal(f.admissions.length, 0)
  const fresh = followups[0]
  assert.equal(result.value.answerRef, fresh.id)
  assert.notEqual(fresh.id, message.id)
  assert.equal(fresh.source.kind, 'user')
  assert.match(fresh.content[0].text, /Latest native user answer/)
  assert.match(fresh.content[0].text, /source revision request-clarification-/)
  assert.match(fresh.content[0].text, /Replace the earlier explanation-only/)
  assert.match(fresh.content[0].text, /Preserve unrelated constraints/)
})
test('a foreign question answer cannot become a source revision', async (t) => {
  const task = 'Implement src/parser.ts.',
    message = human('foreign-answer-check', task),
    intent = activeIntent(
      [message],
      task,
      'same_scope_continuation',
      'change',
      'implementation',
    )
  let followups = 0
  const f = await fixture(t, {
    interpret: async () => intent,
    assess: async () => ({
      semantic: 'contradicted',
      semanticInputDigest: 'c'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'clarify',
    }),
    questions: {
      async ask() {
        return {
          answers: [
            {
              id: 'a-question-from-another-session',
              selected: [],
              custom: 'Proceed',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = () => followups++
  await f.capture([message])
  const r = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  assert.equal(r.value.status, 'awaiting_clarification')
  assert.equal(followups, 0)
  assert.equal(f.admissions.length, 0)
})

test('unavailable assessment reports infrastructure failure without asking the human to repair a missing binary', async (t) => {
  const task = 'Implement src/parser.ts.',
    message = human('unavailable-not-an-answer', task),
    intent = activeIntent(
      [message],
      task,
      'same_scope_continuation',
      'change',
      'implementation',
    )
  const f = await fixture(t, {
    interpret: async () => intent,
    assess: async () => ({
      semantic: 'supported',
      semanticInputDigest: 'd'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'unavailable',
    }),
    questions: {
      async ask() {
        assert.fail('Infrastructure failure is not a semantic question')
      },
    },
  })
  await f.capture([message])
  const r = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  assert.equal(r.value.status, 'assessment_unavailable')
  assert.equal(r.value.detector, 'artifact_unavailable')
  assert.equal(r.value.nextAction, 'report_assessment_unavailable')
  assert.equal(r.value.preparedExecutionAllowed, false)
  assert.equal(f.intake.awaitingClarification(f.agent), false)
  assert.equal(f.admissions.length, 0)
  const blocked = await f.execute('review_probe')
  assert.equal(blocked.isError, true)
  assert.match(JSON.stringify(blocked), /assessment_unavailable/)
  assert.doesNotMatch(JSON.stringify(blocked), /Awaiting user clarification/)
  assert.equal(f.bodies(), 0)
})

for (const cancelled of [true, false])
  test(`native choice ${cancelled ? 'cancellation closes' : 'provider failure retains'} its capture without starting effects`, async (t) => {
    let calls = 0
    const f = await fixture(t, {
      nativeOwnership: async () => 'unowned',
      prepareNativeCoding: async () => {
        if (calls++ === 0)
          throw Object.assign(
            new Error(cancelled ? 'cancelled' : 'provider failed'),
            cancelled ? { code: 'ASK_CANCELLED' } : {},
          )
      },
    })
    await assert.rejects(
      f.capture([human('implementation', 'Implement parser.ts')]),
      cancelled ? /cancelled/u : /provider failed/u,
    )
    assert.equal(
      f.intake.snapshot(f.session.id)?.status,
      cancelled ? 'closed' : 'stale',
    )
    assert.equal(f.bodies(), 0)
    if (cancelled) {
      f.events.push(event('turn/end', 1), event('turn/start', 2))
      await f.capture([human('conversation', 'Explain the parser')], 2)
      assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
      assert.equal(f.bodies(), 0)
    } else
      await assert.rejects(
        f.capture([human('conversation', 'Explain the parser')], 2),
        /Previous on-demand turn has not ended/u,
      )
  })

test('only a current cancelled Lisp capture invokes native user cancellation, preserving its inbox', async (t) => {
  const calls: unknown[] = []
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    prepareNativeCoding: async () => {
      throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
    },
  })
  Object.assign(f.agent, {
    cancel: (cause: unknown, options: unknown) =>
      calls.push({ cause, options }),
  })
  await assert.rejects(
    f.capture([human('cancel', 'Implement parser.ts')]),
    /cancelled/u,
  )
  assert.deepEqual(calls, [
    { cause: { kind: 'user' }, options: { keepInbox: true } },
  ])
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'closed')
})
test('late cancellation from superseded preparation cannot abort the replacement native turn', async (t) => {
  const started = deferred(),
    release = deferred(),
    calls: unknown[] = []
  let attempts = 0
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    prepareNativeCoding: async () => {
      if (attempts++ === 0) {
        started.resolve()
        await release.promise
        throw Object.assign(new Error('old cancelled'), {
          code: 'ASK_CANCELLED',
        })
      }
    },
  })
  Object.assign(f.agent, { cancel: (cause: unknown) => calls.push(cause) })
  const old = f.capture([human('old', 'Implement old.ts')]),
    rejected = assert.rejects(old, /old cancelled/u)
  await started.promise
  await f.capture([human('new', 'Explain the current source')])
  release.resolve()
  await rejected
  assert.deepEqual(calls, [])
  assert.equal(f.intake.snapshot(f.session.id)?.status, 'answer')
})

test('an observed same-scope clarification answer is returned with fresh evidence instead of repeatedly asking or granting execution', async (t) => {
  const task = 'Only explain src/parser.ts; preserve the public API.',
    message = human('bounded-original', task)
  let messages: any[] = [message],
    intent = activeIntent(
      messages,
      task,
      'same_scope_continuation',
      'change',
      'implementation',
    )
  let asks = 0
  const followups: any[] = []
  const f = await fixture(t, {
    interpret: async () => intent,
    assess: async () => ({
      semantic: 'contradicted',
      semanticInputDigest: 'b'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'clarify',
    }),
    questions: {
      async ask(r) {
        asks++
        return {
          answers: [
            {
              id: r.questions[0].id,
              selected: [],
              custom:
                'I explicitly request implementation in src/parser.ts while preserving the public API.',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = (m: any) => followups.push(m)
  const args = () => ({
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  await f.capture(messages, 1)
  const first = await f.execute(TASK_PREPARE_TOOL, args())
  assert.equal(first.value.status, 'clarification_answer_queued')
  messages = [message, followups[0]]
  intent = activeIntent(
    messages,
    task + '\n' + followups[0].content[0].text,
    'same_scope_continuation',
    'change',
    'implementation',
  )
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/end', 1), event('turn/start', 2))
  await f.capture(messages, 2)
  const repeated = await f.execute(TASK_PREPARE_TOOL, args())
  assert.equal(repeated.value.status, 'assessment_rejected')
  assert.equal(repeated.value.prepared, false)
  assert.equal(f.admissions.length, 0)
  assert.equal(asks, 1)
  assert.equal(followups.length, 1)
  assert.ok(repeated.value.currentReferences.length > 0)
  const nextText = 'Also preserve the CLI output format.',
    next = human('new-human-scope', nextText)
  messages = [...messages, next]
  intent = activeIntent(
    messages,
    task + '\n' + followups[0].content[0].text + '\n' + nextText,
    'same_scope_continuation',
    'change',
    'implementation',
  )
  f.intake.finish(f.session, 2)
  f.events.push(event('turn/end', 2), event('turn/start', 3))
  await f.capture(messages, 3)
  const changed = await f.execute(TASK_PREPARE_TOOL, args())
  assert.equal(changed.value.status, 'clarification_answer_queued')
  assert.equal(asks, 2)
  assert.equal(f.admissions.length, 0)
  assert.equal(followups[1].content[0].text.split(task).length - 1, 1)
  assert.match(
    followups[1].content[0].text,
    /Also preserve the CLI output format/,
  )
})

test('KDSH-REVIEW-GATE-RECOVERY-001: unresolved preparation is not a receipt and a corrected current intent recovers in the same turn', async (t) => {
  let context: RequestIntentContext | undefined,
    writes = 0
  const f = await fixture(t, {
    interpret: async (input, task) => {
      context = createRequestIntentContext({
        task,
        messageRefs: requestIntentMessageRefs(input.messages, task),
      })!
      return {
        context,
        decision: unresolvedRequestIntent(context, 'decision_service_disabled'),
      }
    },
  })
  t.after(
    f.ctx.tools.register({
      name: 'write',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: () => {
        writes++
        return 'written'
      },
    }),
  )
  t.after(
    f.ctx.tools.guard((execution: any) => {
      if (execution.name !== 'write') return undefined
      const prepared = f.prepareRequests.at(-1)
      try {
        executionRequestAction(
          prepared?.requestIntent,
          prepared?.context,
          execution.name,
        )
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    }),
  )
  await f.capture([
    human('review-original', 'Review src/parser.ts without changing files.'),
  ])
  const prepared = await f.execute(TASK_PREPARE_TOOL, { taskType: 'review' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.prepared, false)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute('write')).isError, true)
  const corrected = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'new',
      action: 'verify',
      evidenceRefs: requestIntentReferenceIds(context!),
    },
  })
  assert.equal(corrected.isError, false)
  assert.equal(corrected.value.prepared, true)
  assert.equal(f.admissions.length, 1)
  assert.equal(
    (await f.execute('write')).isError,
    true,
    'verification still grants no artifact edits',
  )
  const deny = f.ctx.tools.guard(() => 'Native policy denied')
  assert.equal((await f.execute('review_probe')).isError, true)
  deny()
  assert.equal(writes, 0)
})

// Same repeated research request as the Web Plan fixture. A scripted adapter must
// interpret each fresh human turn just like the real main model; taskType is not intent.
test('Web Plan scripted research binds each current turn without bypassing unresolved-intent guards', async (t) => {
  const task =
    'Plan the repository workflow using Lisp. Do not implement changes. 通常実行で。'
  const mock = nativeMock({ LlmAdapter: class {} })
  let context: RequestIntentContext
  const f = await fixture(t, {
    interpret: async (input, originalTask) => {
      context = createRequestIntentContext({
        task: originalTask,
        messageRefs: requestIntentMessageRefs(input.messages, originalTask),
        ...(input.turn === 1
          ? {}
          : {
              activeTask: {
                taskId: 'plan-research',
                runId: 'plan-research',
                sessionId: 'review-session',
                sourceSessionId: 'review-session',
                repositoryRoot: '/fixture',
                type: 'research',
                state: 'Working',
                revision: input.turn,
                generation: 1,
                runStatus: 'active',
                reason: 'Plan research fixture',
                evidence: [],
                allowedOps: ['wait', 'complete', 'ignore'],
                request: task,
                resumedFromTerminal: false,
              },
            }),
      })!
      return {
        context,
        decision: unresolvedRequestIntent(context, 'decision_service_disabled'),
      }
    },
  })
  let previousRefs: string[] | undefined
  for (const [index, mode] of ['question', 'keep', 'approve'].entries()) {
    const turn = index + 1
    const messages = [human(`plan-${mode}`, task)]
    if (turn > 1) {
      f.intake.finish(f.session, turn - 1)
      f.events.push(event('turn/end', turn - 1), event('turn/start', turn))
    }
    await f.capture(messages, turn)
    if (turn > 1) {
      const legacy = await f.execute(TASK_PREPARE_TOOL, {
        taskType: 'research',
      })
      assert.equal(legacy.isError, false)
      assert.equal(
        legacy.value.prepared,
        false,
        'an active research task cannot borrow a legacy taskType',
      )
      assert.equal(legacy.value.status, 'request_interpretation_required')
      assert.equal(
        f.intake.awaitingClarification(f.agent),
        false,
        'the main model must interpret the new turn before asking the human',
      )
    }
    const projected = await f.intake.answerMessages(
      { agent: f.agent, turn, step: 0, messages, signal: signal() },
      messages,
    )
    const request = {
      messages: projected,
      tools: [{ name: TASK_PREPARE_TOOL }],
    }
    const id = `prepare-${mode}`
    const [prepare, consume] = mock.prepareWork(
      [mock.textResponse('Plan consumer')],
      'research',
      id,
      planPreparation(mock, id, mode),
    )
    const block = prepare(request).find(
      (chunk: any) => chunk.type === 'block-end',
    ).block
    const args = JSON.parse(block.arguments)
    assert.deepEqual(
      args.requestIntent.evidenceRefs,
      requestIntentReferenceIds(context!),
    )
    if (previousRefs) {
      const stale = await f.execute(TASK_PREPARE_TOOL, {
        ...args,
        requestIntent: { ...args.requestIntent, evidenceRefs: previousRefs },
      })
      assert.equal(
        stale.isError,
        true,
        'repeated human text does not permit previous-turn references',
      )
      assert.equal(f.admissions.length, index)
    }
    const result = await f.execute(TASK_PREPARE_TOOL, args)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.prepared, true)
    assert.equal(result.value.permissions, 'unchanged_native_policy')
    assert.equal(result.value.requestIntent.action, 'research')
    assert.equal(
      result.value.requestIntent.relation,
      mode === 'question' ? 'new' : 'same_scope_continuation',
    )
    consume({
      messages: [
        {
          role: 'tool',
          toolCallId: id,
          isError: result.isError,
          content: result.content,
        },
      ],
    })
    previousRefs = args.requestIntent.evidenceRefs
    assert.equal(f.admissions.length, turn)
    assert.equal(
      f.bodies(),
      0,
      'preparation itself executes no project effects',
    )
  }
})

nativeTest(
  'Web Plan scripted preparation rejects unknown stages and missing current host evidence',
  () => {
    const mock = nativeMock({ LlmAdapter: class {} })
    assert.throws(
      () => planPreparation(mock, 'prepare', 'unexpected'),
      /unknown Plan fixture mode/,
    )
    for (const mode of ['question', 'keep', 'approve']) {
      assert.throws(
        () => planPreparation(mock, 'prepare', mode)({ messages: [] }),
        /current host evidence/,
      )
      assert.throws(
        () =>
          planPreparation(
            mock,
            'prepare',
            mode,
          )({
            messages: [
              {
                source: {
                  sections: [
                    {
                      name: 'on-demand-intake',
                      text: 'Current request references and same-session work (host-bound, advisory only):\nnot-json',
                    },
                  ],
                },
              },
            ],
          }),
        SyntaxError,
      )
    }
  },
)

test('native clarification tool remains available before preparation without admitting effects', async (t) => {
  const f = await fixture(t)
  let questions = 0
  const definition = {
    name: 'ask_user_question',
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: () => {
      questions++
      return { answers: [] }
    },
  }
  const release = f.ctx.tools.register(definition)
  t.after(release)
  await f.capture()
  assert.equal(
    (
      await f.execute('ask_user_question', {
        questions: [{ id: 'scope', question: 'Which file?' }],
      })
    ).isError,
    false,
  )
  assert.equal(questions, 1)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute('review_probe')).isError, true)
  assert.equal(
    (await f.execute('ask_user_question', {}, { parent: {} })).isError,
    true,
  )
  release()
  t.after(
    f.ctx.tools.register({
      ...definition,
      execute: () => {
        questions++
        return {}
      },
    }),
  )
  assert.equal(
    (await f.execute('ask_user_question', {})).isError,
    true,
    'replacement implementation must not inherit conversation capability',
  )
  assert.equal(questions, 1)
})

test('real native question entry delegates to the user surface before optional preparation', async (t) => {
  const f = await fixture(t)
  let asked = 0
  f.ctx.provide('userQuestions', {
    async ask(request: any) {
      asked++
      assert.equal(request.agent, f.agent)
      return { answers: [{ id: 'target', selected: [], custom: 'PLAN.md' }] }
    },
  })
  const built = join(packages, '@deepseek-ai/dsh-tool-ask-user/lib/index.js')
  const tool = await import(
    pathToFileURL(
      existsSync(built)
        ? built
        : join(packages, '@deepseek-ai/dsh-tool-ask-user/src/index.ts'),
    ).href
  )
  const fiber = await f.ctx.plugin(tool, { mode: 'legacy' })
  t.after(() => fiber.dispose())
  await f.capture()
  const result = await f.execute('ask_user_question', {
    questions: [{ id: 'target', question: 'Which file?' }],
  })
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, {
    answers: [{ id: 'target', selected: [], custom: 'PLAN.md' }],
  })
  assert.equal(asked, 1)
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute('review_probe')).isError, true)
})

test('only branded coding status is conversational; workflow effects and spoofed status retain admission', async (t) => {
  const { mountCodingWorkflow } =
    await import('../../../src/dsh/coding-workflow/host.js')
  const f = await fixture(t)
  let reads = 0
  const release = mountCodingWorkflow(f.ctx, {
    runtime: {
      async withDatabase() {
        reads++
        throw new Error('observational status reached')
      },
    } as any,
    resolve: () => ({
      agent: f.agent,
      runId: 'run',
      sessionId: f.session.id,
      repositoryRoot: '/tmp',
    }),
    lisp: () => undefined,
  })
  t.after(release)
  await f.capture()
  const status = await f.execute('coding_workflow', { action: 'status' })
  assert.match(JSON.stringify(status), /observational status reached/)
  assert.equal(reads, 1)
  assert.equal(f.admissions.length, 0)
  for (const args of [{ action: 'next' }, { action: 'status', extra: true }]) {
    const blocked = await f.execute('coding_workflow', args)
    assert.equal(blocked.isError, true)
    assert.match(JSON.stringify(blocked), /Before tool-backed work/)
  }
  const readsBeforeReplacement = reads
  release()
  t.after(
    f.ctx.tools.register({
      name: 'coding_workflow',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: () => {
        reads++
        return {}
      },
    }),
  )
  assert.equal(
    (await f.execute('coding_workflow', { action: 'status' })).isError,
    true,
  )
  assert.equal(reads, readsBeforeReplacement)
})

for (const boundary of ['deny', 'cancel', 'argument-change', 'stop'] as const)
  test(`clarification control preserves native ${boundary} boundary`, async (t) => {
    const f = await fixture(t)
    let calls = 0
    t.after(
      f.ctx.tools.register({
        name: 'ask_user_question',
        parameters: { type: 'object' },
        output: { schema: {}, render: () => [] },
        execute: () => {
          calls++
          return {}
        },
      }),
    )
    await f.capture()
    if (boundary === 'stop') f.intake.stop()
    else
      t.after(
        f.ctx.on(
          'tools/pre-execute',
          async (execution: any, next: () => Promise<any>) => {
            if (execution.name !== 'ask_user_question') return next()
            if (boundary === 'argument-change') {
              execution.arguments = { changed: true }
              return next()
            }
            return { kind: boundary, reason: 'native policy' }
          },
        ),
      )
    assert.equal((await f.execute('ask_user_question', {})).isError, true)
    assert.equal(calls, 0)
    assert.equal(f.admissions.length, 0)
  })

test('native boundary task proof belongs to the exact captured session and turn', async (t) => {
  const task = 'Continue the current task.',
    message = human('boundary-task', task)
  const original = activeIntent(
    [message],
    task,
    'same_scope_continuation',
    'verify',
  )
  const context = createRequestIntentContext({
    ...original.context,
    activeTask: {
      taskId: 'boundary-task',
      runId: 'boundary-task',
      sessionId: 'review-session',
      sourceSessionId: 'review-session',
      repositoryRoot: '/tmp',
      type: 'research',
      state: 'Working',
      runStatus: 'active',
      revision: 4,
      generation: 7,
      allowedOps: ['wait'],
      reason: 'Started',
      evidence: [],
      request: task,
      resumedFromTerminal: false,
    },
  })!
  const f = await fixture(t, {
    interpret: async () => ({
      context,
      decision: unresolvedRequestIntent(context, 'fixture'),
    }),
  })
  await f.capture([message])
  assert.deepEqual(f.intake.boundaryTask(f.session, 1)?.expected, {
    taskId: 'boundary-task',
    revision: 4,
    generation: 7,
  })
  assert.equal(f.intake.boundaryTask({ id: f.session.id }, 1), undefined)
  assert.equal(f.intake.boundaryTask(f.session, 2), undefined)
})

test('plan handoff keeps the same host context while accepting a native clarification answer', async (t) => {
  const task =
    'Implement the previously presented plan; preserve unrelated files.'
  const message = human('implement-plan', task)
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs([message], task),
    proposals: [
      {
        id: 'native-plan',
        revision: null,
        digest: 'a'.repeat(64),
        text: '# PLAN.md\nImplement src/parser.ts. Preserve unrelated files.',
      },
    ],
  })!
  const intent = {
    context,
    decision: unresolvedRequestIntent(context, 'proposal_reference_uncertain'),
  }
  const followups: any[] = []
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    requestContext: async () => context,
    interpret: async () => intent,
    assess: async () => ({
      semantic: 'contradicted',
      semanticInputDigest: 'b'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'clarify',
    }),
    questions: {
      async ask(r) {
        return {
          answers: [
            {
              id: r.questions[0].id,
              selected: [],
              custom:
                'Implement the presented src/parser.ts plan, keeping all other files unchanged.',
            },
          ],
        }
      },
    },
  } as Partial<Dependencies>)
  ;(f.agent as any).followup = (message: any) => followups.push(message)
  await f.capture([message])
  const result = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'new',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context),
    },
  })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.status, 'clarification_answer_queued')
  assert.equal(
    followups.length,
    1,
    'the actual native answer must not be discarded as an artificial context change',
  )
  assert.equal(f.admissions.length, 0)
})

test('an unresolved legacy taskType cannot produce a prepared receipt over an existing proposal', async (t) => {
  const task = 'Implement that plan',
    message = human('legacy-proposal', task)
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs([message], task),
    proposals: [
      {
        id: 'plan',
        revision: null,
        digest: 'c'.repeat(64),
        text: '# Plan\nThe target remains unclear.',
      },
    ],
  })!
  const f = await fixture(t, {
    interpret: async () => ({
      context,
      decision: unresolvedRequestIntent(
        context,
        'proposal_reference_uncertain',
      ),
    }),
  })
  await f.capture([message])
  const result = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(result.value.prepared, false)
  assert.equal(f.admissions.length, 0)
})

test('a rejected candidate after an answered clarification reports the conflict instead of requesting an identical resubmission', async (t) => {
  const task = 'Only explain src/parser.ts; preserve the public API.',
    message = human('conflict-source', task)
  let messages: any[] = [message],
    intent = activeIntent(
      messages,
      task,
      'same_scope_continuation',
      'change',
      'implementation',
    )
  let asks = 0
  const followups: any[] = []
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    requestContext: async () => intent.context,
    interpret: async () => intent,
    assess: async () => ({
      semantic: 'contradicted',
      semanticInputDigest: 'd'.repeat(64),
      detector: {
        state: 'unavailable',
        reason: 'artifact_unavailable',
        elapsedMs: 0,
      },
      outcome: 'clarify',
    }),
    questions: {
      async ask(r) {
        asks++
        return {
          answers: [
            {
              id: r.questions[0].id,
              selected: [],
              custom: 'Explain it only. Do not change files.',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = (message: any) => followups.push(message)
  const args = () => ({
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  await f.capture(messages)
  assert.equal(
    (await f.execute(TASK_PREPARE_TOOL, args())).value.status,
    'clarification_answer_queued',
  )
  messages = [message, followups[0]]
  intent = activeIntent(
    messages,
    task + '\n' + followups[0].content[0].text,
    'same_scope_continuation',
    'change',
    'implementation',
  )
  f.intake.finish(f.session, 1)
  f.events.push(event('turn/end', 1), event('turn/start', 2))
  await f.capture(messages, 2)
  const rejected = await f.execute(TASK_PREPARE_TOOL, args())
  assert.equal(rejected.value.status, 'assessment_rejected')
  assert.equal(rejected.value.prepared, false)
  assert.equal(
    f.intake.awaitingClarification(f.agent),
    false,
    'a captured answer is no longer a pending question',
  )
  assert.equal(
    rejected.value.nextAction,
    'revise_request_intent_or_report_conflict',
  )
  assert.equal(
    (await f.execute(TASK_PREPARE_TOOL, args())).value.status,
    'assessment_rejected',
  )
  assert.equal(asks, 1)
  assert.equal(f.admissions.length, 0)
})

test('ordinary chat coding status is observational without manufacturing a native task', async (t) => {
  const { mountCodingWorkflow } =
    await import('../../../src/dsh/coding-workflow/host.js')
  const f = await fixture(t)
  t.after(
    mountCodingWorkflow(f.ctx, {
      runtime: {
        withDatabase: () =>
          assert.fail('no owner means no task storage lookup'),
      } as any,
      resolve: () => undefined,
      lisp: () => undefined,
    }),
  )
  await f.capture([
    human('ordinary-question', 'Explain this project; do not make changes.'),
  ])
  const result = await f.execute('coding_workflow', { action: 'status' })
  assert.equal(result.isError, false)
  assert.equal(result.value.applicable, false)
  assert.equal(result.value.reason, 'no_active_native_task')
  assert.equal(
    (await f.execute('coding_workflow', { action: 'next' })).isError,
    true,
  )
  assert.equal(f.admissions.length, 0)
})

test('an unavailable assessment can recover on the next explicit preparation without a new turn', async (t) => {
  const task = 'Implement src/parser.ts; preserve other files.',
    message = human('retry-assessment', task)
  const intent = activeIntent(
    [message],
    task,
    'same_scope_continuation',
    'change',
    'implementation',
  )
  let calls = 0
  const f = await fixture(t, {
    interpret: async () => ({
      ...intent,
      decision: unresolvedRequestIntent(intent.context, 'fixture'),
    }),
    assess: async () => ({
      semantic: 'supported',
      semanticInputDigest: 'e'.repeat(64),
      detector: { state: 'unavailable', reason: 'timeout', elapsedMs: 0 },
      outcome: ++calls === 1 ? 'unavailable' : 'consistent',
    }),
  })
  await f.capture([message])
  const args = {
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  }
  assert.equal(
    (await f.execute(TASK_PREPARE_TOOL, args)).value.status,
    'assessment_unavailable',
  )
  assert.equal(f.admissions.length, 0)
  assert.equal((await f.execute(TASK_PREPARE_TOOL, args)).value.prepared, true)
  assert.equal(calls, 2)
  assert.equal(f.admissions.length, 1)
})

test('question transport failure is explicit and retryable, without a pending clarification lock', async (t) => {
  const task = 'Inspect the requested artifact.',
    message = human('retry-question', task)
  const intent = activeIntent([message], task, 'unknown', 'unknown')
  let calls = 0
  const followups: any[] = []
  const f = await fixture(t, {
    interpret: async () => intent,
    questions: {
      async ask(request) {
        if (++calls === 1) throw new Error('isolated network failure')
        return {
          answers: [
            {
              id: request.questions[0].id,
              selected: [],
              custom: 'Inspect src/parser.ts without changing files.',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = (message: any) => followups.push(message)
  await f.capture([message])
  const result = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'unknown',
      action: 'unknown',
      evidenceRefs: requestIntentReferenceIds(intent.context),
    },
  })
  assert.equal(result.value.status, 'clarification_unavailable')
  assert.equal(f.intake.awaitingClarification(f.agent), false)
  assert.equal(
    (
      await f.execute(TASK_PREPARE_TOOL, {
        requestIntent: {
          relation: 'unknown',
          action: 'unknown',
          evidenceRefs: requestIntentReferenceIds(intent.context),
        },
      })
    ).value.status,
    'clarification_answer_queued',
  )
  assert.equal(calls, 2)
  assert.equal(followups.length, 1)
  assert.equal(f.admissions.length, 0)
})

test('legacy taskType returns the current interpretation contract to the model without asking the human to restate a clear request', async (t) => {
  const task = 'Implement src/parser.ts and preserve other files.',
    message = human('clear-legacy', task)
  const context = createRequestIntentContext({
    task,
    messageRefs: requestIntentMessageRefs([message], task),
  })!
  const f = await fixture(t, {
    nativeOwnership: async () => 'unowned',
    requestContext: async () => context,
    interpret: async () => ({
      context,
      decision: unresolvedRequestIntent(context, 'decision_service_disabled'),
    }),
    questions: {
      async ask() {
        assert.fail(
          'The model must interpret the captured clear request before asking the human',
        )
      },
    },
  })
  ;(f.agent as any).followup = () => assert.fail('No fabricated native answer')
  await f.capture([message])
  const pending = await f.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
  assert.equal(pending.isError, false)
  assert.equal(pending.value.status, 'request_interpretation_required')
  assert.equal(pending.value.prepared, false)
  assert.equal(pending.value.nextAction, 'submit_current_request_intent')
  assert.equal(f.intake.awaitingClarification(f.agent), false)
  assert.equal(f.admissions.length, 0)
  const prepared = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      relation: 'new',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context),
    },
  })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.prepared, true)
  assert.equal(f.admissions.length, 1)
})

test('multinguin recurrence: inconclusive assessment returns the submitted candidate for model repair without reasking the human', async (t) => {
  const message = human('finish-project', 'finish this project')
  const context = createRequestIntentContext({
    task: 'finish this project',
    messageRefs: requestIntentMessageRefs([message], 'finish this project'),
    activeGoal: {
      runId: 'current-project',
      target: 'PLAN.md implementation',
      ideal: 'Finish the approved extension implementation',
      outOfScope: ['store publication'],
      constraints: ['Preserve native permissions'],
    },
    proposals: [
      {
        id: 'approved-plan',
        revision: null,
        digest: 'b'.repeat(64),
        text: 'Implement the Chrome/Brave extension in the approved PLAN.md scope; do not publish.',
      },
    ],
  })!
  let asks = 0
  const f = await fixture(t, {
    interpret: async () => ({
      context,
      decision: unresolvedRequestIntent(
        context,
        'proposal_reference_uncertain',
      ),
    }),
    assess: async (_input, _context, candidate) =>
      ({
        semantic: candidate.evidence.proposalRefs.length
          ? 'supported'
          : 'insufficient',
        semanticIssues: candidate.evidence.proposalRefs.length
          ? []
          : ['reference'],
        semanticInputDigest: 'c'.repeat(64),
        detector: {
          state: 'available',
          result: {
            status: candidate.evidence.proposalRefs.length
              ? 'entailed'
              : 'undetermined',
            complete: true,
          },
          elapsedMs: 0,
        },
        outcome: candidate.evidence.proposalRefs.length
          ? 'consistent'
          : 'clarify',
      }) as any,
    questions: {
      async ask(request) {
        asks++
        return {
          answers: [
            {
              id: request.questions[0].id,
              selected: [],
              custom: 'PLAN.mdの内容を網羅',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = () =>
    assert.fail('An internal inference failure must not queue a human answer')
  await f.capture([message])
  const args = {
    requestIntent: {
      relation: 'same_scope_continuation',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context).filter(
        (ref) => !ref.startsWith('proposal:'),
      ),
    },
  }
  for (let i = 0; i < 2; i++) {
    const result = await f.execute(TASK_PREPARE_TOOL, args)
    assert.equal(result.value.status, 'assessment_rejected')
    assert.equal(result.value.prepared, false)
    assert.equal(result.value.requestIntent.action, 'change')
    assert.equal(result.value.requestIntent.changeScope, 'implementation')
    assert.equal(
      result.value.nextAction,
      'revise_request_intent_or_report_conflict',
    )
    assert.equal(f.admissions.length, 0)
    assert.equal(f.intake.awaitingClarification(f.agent), false)
  }
  assert.equal(asks, 0)
  const repaired = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      ...args.requestIntent,
      evidenceRefs: requestIntentReferenceIds(context),
    },
  })
  assert.equal(repaired.value.prepared, true)
  assert.equal(f.admissions.length, 1)
  assert.equal(asks, 0)
})

test('a missing main-model artifact scope requires model interpretation, not an automatic human question', async (t) => {
  const message = human(
    'clear-implementation',
    'Implement src/parser.ts; preserve the API and do not publish.',
  )
  const context = createRequestIntentContext({
    task: message.content[0]!.text,
    messageRefs: requestIntentMessageRefs([message], message.content[0]!.text),
  })!
  let asks = 0
  const f = await fixture(t, {
    interpret: async () => ({
      context,
      decision: unresolvedRequestIntent(
        context,
        'proposal_reference_uncertain',
      ),
    }),
    questions: {
      async ask(request) {
        asks++
        return {
          answers: [
            {
              id: request.questions[0].id,
              selected: [],
              custom: 'Implement src/parser.ts',
            },
          ],
        }
      },
    },
  })
  ;(f.agent as any).followup = () =>
    assert.fail('Missing classifier fields must not become human input')
  await f.capture([message])
  const requestIntent = {
    relation: 'new',
    action: 'change',
    changeScope: 'unknown',
    evidenceRefs: requestIntentReferenceIds(context),
  }
  const unresolved = await f.execute(TASK_PREPARE_TOOL, { requestIntent })
  assert.equal(unresolved.isError, false)
  assert.equal(unresolved.value.status, 'request_interpretation_required')
  assert.deepEqual(unresolved.value.requestInterpretation.missingFields, [
    'requestIntent.changeScope',
  ])
  assert.equal(asks, 0)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.intake.awaitingClarification(f.agent), false)
  const repaired = await f.execute(TASK_PREPARE_TOOL, {
    requestIntent: {
      ...requestIntent,
      changeScope: 'implementation',
    },
  })
  assert.equal(repaired.value.prepared, true)
})
