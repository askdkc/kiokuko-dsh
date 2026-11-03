import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { OnDemandIntake } from '../../../src/dsh/on-demand-intake.js'
import { hasHumanInput } from '../../../src/dsh/answer-review/contracts.js'
import { hasRequestInput } from '../../../src/dsh/request-input.js'
import { requestIntentMessageRefs } from '../../../src/dsh/decisions/message-refs.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountNativeTools, executeNativeTool } from '../helpers/native-tools.js'

function goal(round: number) {
  return { id: `goal-${round}`, role: 'user',
    source: { kind: 'goal', goalId: 'native-goal', revision: 1, round },
    content: [{ type: 'text', text: `<goal_round>\nObjective: inspect the repository\nRound: ${round}/256\n</goal_round>` }] }
}

test('composition captures goal rounds and permits native tools without granting human approval', async () => {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, nativeTools] = await Promise.all([load('cordis'), load('dsh-tools')])
  const native = new cordis.Context()
  native.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
  const fibers: any[] = []
  await mountNativeTools(native, nativeTools, packages, fibers)
  let executed = 0
  for (const name of ['read', 'bash', 'get_goal', 'update_goal']) native.tools.register({ name,
    description: 'Request capture probe', parameters: {},
    output: { schema: {}, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: async () => { executed++; return 'native execution reached' } })
  const listeners = new Map<string, Function>()
  const context = { on(name: string, fn: Function) { listeners.set(name, fn); return () => listeners.delete(name) } } as unknown as Context
  const events: any[] = []
  const agent = { id: 'agent', session: { id: 'session', snapshotEvents: () => events } }
  const observed: string[] = []
  let preparations = 0
  const demand = new OnDemandIntake({
    validate: async () => {}, existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async () => { preparations++; return true }, ready: () => false,
    nativeOwnership: async () => 'unowned',
    requestContext: async (_input, task) => { observed.push(task); return undefined },
  })
  demand.mount(native, native.tools)
  const composition = await mountDshComposition(context, {
    intakeGate: { preStep() { throw new Error('goal bypassed request capture') } } as any,
    mapPreStep: () => { throw new Error('goal bypassed request capture') },
    onDemandIntake: demand,
  })
  try {
    for (const turn of [1, 2]) {
      events.push({ type: 'turn/start', data: { turn } })
      const messages = [goal(turn)]
      assert.equal(hasHumanInput(messages), false, 'goal input is not human approval')
      const input = { agent, turn, step: 1, messages, signal: new AbortController().signal }
      const result = await listeners.get('agent/pre-step')!(input, async () => ({ kind: 'enter', messages }))
      assert.equal(result.kind, 'enter')
      assert.equal(demand.pending(agent), true, 'native request is now bound')
      for (const name of ['read', 'bash', 'get_goal', 'update_goal']) {
        const result = await executeNativeTool(native, packages, { agent, name, arguments: {}, callId: `${turn}-${name}`, signal: input.signal })
        assert.notEqual(result.isError, true, JSON.stringify(result))
        assert.match(JSON.stringify(result.content), /native execution reached/)
      }
      const removeGuard = native.tools.guard(() => 'native policy denial')
      try {
        const denied = await executeNativeTool(native, packages, { agent, name: 'bash', arguments: {}, callId: `${turn}-denied`, signal: input.signal })
        assert.equal(denied.isError, true)
      } finally { removeGuard() }
      events.push({ type: 'turn/end', data: { turn } })
    }
    assert.deepEqual(observed, [goal(1).content[0]!.text, goal(2).content[0]!.text])
    assert.equal(preparations, 0, 'goal capture does not enroll optional owned work')
    assert.equal(executed, 8, 'denied native calls never execute')
  } finally { await composition.dispose(); await demand.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose() }
})

test('only structured native goal carriers count as requests; source-bound references retain their IDs', () => {
  const message = goal(1)
  assert.equal(hasRequestInput([message]), true)
  assert.equal(requestIntentMessageRefs([message], 'task')[0]?.id, message.id)
  assert.equal(hasHumanInput([message]), false)
  for (const source of [
    { kind: 'runtime-context' }, { kind: 'kiokuko-dsh' },
    { kind: 'goal' }, { ...message.source, round: 0 },
    { ...message.source, revision: -1 }, { ...message.source, goalId: '' },
  ]) assert.equal(hasRequestInput([{ ...message, source }]), false)
  assert.equal(hasRequestInput([{ ...message, role: 'assistant' }]), false)
})
