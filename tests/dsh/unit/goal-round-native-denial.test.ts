import { mountNativeTools, executeNativeTool } from '../helpers/native-tools.js'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import nativeTest from 'node:test'
import {
  OnDemandIntake,
  TASK_PREPARE_TOOL,
  type DemandInput,
} from '../../../src/dsh/on-demand-intake.js'

/**
 * Goal-round continuation turns emit inbox input whose source kind is 'goal'
 * (the DSH goal-round driver), never source kind 'user'. Composition's capture
 * trigger must treat them the same way as ordinary human batches; otherwise
 * every native tool is denied with 'No current native request for tool
 * execution' for the whole turn, exactly as the attached failing session shows.
 */

const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeAvailable = ['cordis', 'dsh-tools'].every((name) =>
  existsSync(join(packages, '@deepseek-ai', name, 'lib/index.js')),
)
const test = nativeAvailable ? nativeTest : nativeTest.skip
const load = (name: string) =>
  import(
    pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href
  )
const [cordis, nativeTools] = nativeAvailable
  ? await Promise.all([load('cordis'), load('dsh-tools')])
  : [undefined, undefined]
const signal = () => new AbortController().signal

function goalRound(round: number) {
  return {
    id: `goal-round-${round}`,
    role: 'user',
    source: { kind: 'goal', goalId: 'goal-repro', revision: 1, round },
    content: [
      {
        type: 'text',
        text: `<goal_round>\nObjective: "reproduce the denial storm"\nRound: ${round}/256\n</goal_round>`,
      },
    ],
  }
}

function human(id: string, text: string) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

type Dependencies = ConstructorParameters<typeof OnDemandIntake>[0]

/** Mirror the exact composition condition on this fixture. */
export const routeThroughComposition = async (
  intake: OnDemandIntake,
  agent: unknown,
  input: DemandInput,
): Promise<unknown> => {
  const messages = input.messages as any[]
  const humanPresent = messages.some(
    (message: any) =>
      message?.role === 'user' &&
      (!message.source || message.source instanceof Object === false || !message.source.kind || message.source.kind === 'user'),
  )
  const goalRoundPresent = messages.some(
    (message: any) =>
      message?.source?.kind === 'goal' && message.source.round > 0,
  )
  if (
    humanPresent ||
    goalRoundPresent ||
    intake.pending(input.agent as any) ||
    intake.continuing(input.agent as any)
  ) {
    return await intake.capture(input)
  }
  return undefined
}

async function makeFixture(t: nativeTest.TestContext, options: Partial<Dependencies> = {}) {
  const ctx = new cordis!.Context()
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  const fibers: any[] = []
  await mountNativeTools(ctx, nativeTools, packages, fibers)
  const events = [event('turn/start', 1)]
  const session = { id: 'goal-round-session', snapshotEvents: () => events }
  const agent = { id: 'goal-round-agent', session }
  let readyTurn: number | undefined
  const admissions: DemandInput[] = []
  const preparedTypes: string[] = []
  const intake = new OnDemandIntake({
    validate: async (input) => {
      assert.equal(input.agent, agent)
      assert.equal(input.agent.session, session)
    },
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async (input, type) => {
      preparedTypes.push(type)
      admissions.push(input)
      readyTurn = input.turn
      return true
    },
    ready: (candidate, turn) =>
      candidate === agent &&
      readyTurn !== undefined &&
      (turn === undefined || turn === readyTurn),
    nativeOwnership: async () => 'unowned',
    ...options,
  })
  intake.mount(ctx, ctx.tools)
  t.after(async () => {
    await intake.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return {
    ctx,
    agent,
    session,
    events,
    intake,
    admissions,
    preparedTypes,
    capture(messages: unknown[], turn = 1) {
      const input = {
        agent,
        turn,
        step: 0,
        messages,
        signal: signal(),
      } as unknown as DemandInput
      return routeThroughComposition(intake, agent, input)
    },
    execute(name: string, args: unknown = {}) {
      return executeNativeTool(ctx, packages, {
        callId: `call-${name}`,
        name,
        arguments: args,
        agent,
        signal: signal(),
      })
    },
    prepare() {
      return this.execute(TASK_PREPARE_TOOL, { taskType: 'build' })
    },
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

test('goal-round-only turn binds the intake like an ordinary human turn', async (t) => {
  const f = await makeFixture(t)
  const outcome = await f.capture([goalRound(1)])
  assert.equal(outcome, true)
  const read = await f.execute('glob', { pattern: '*.md' })
  assert.equal(read.isError, false)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.preparedTypes.length, 0)
})

test('goal rounds after a human request rebind the newest turn', async (t) => {
  const f = await makeFixture(t)
  await f.capture([human('original', 'Prepare repository work and continue.')])
  const outcome = await f.capture([goalRound(2)], 2)
  assert.equal(outcome, true)
  const read = await f.execute('read', { file_path: 'README.md' })
  assert.equal(read.isError, false)
  assert.equal(f.admissions.length, 0)
})

test('goal-round capture still requires explicit preparation for owned work', async (t) => {
  const f = await makeFixture(t)
  await f.capture([goalRound(1)])
  const denied = await f.execute('ask_user_question', {
    questions: [{ id: 'q1', question: 'Pick one' }],
  })
  assert.equal(denied.isError, true)
})

test('goal-round models can submit the advisory preparation carrier', async (t) => {
  const f = await makeFixture(t)
  await f.capture([goalRound(1)])
  const prepared = await f.prepare()
  assert.equal(prepared.isError, false)
  assert.equal(f.preparedTypes[0], 'build')
})
