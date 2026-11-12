import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'

// Use the installed native Goal domain/driver, not a mock rejection hook.
async function fixture() {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
  const [goals, driver, goalTools] = await Promise.all(['dsh-goal', 'dsh-goal-round-driver', 'dsh-tool-goal'].map(load))
  const harness = await import(new URL('../helpers/kiokuko-driver.mjs', import.meta.url).href)
  const ctx = new Context(), requests: any[] = [], errors: unknown[] = []
  for (const plugin of [Llm, Sessions, Projections, Agents, SystemPrompt, Tools, NativeExecutor, harness.default, goals.default, driver, goalTools]) {
    await ctx.plugin(plugin)
  }
  ctx.on('agent/error', event => errors.push(event.error))
  ctx.llm.registerAdapter(['goal-lifecycle'], new class extends LlmAdapter {
    async *stream(options: any) {
      requests.push(options)
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'REQUEST_EXECUTED' } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }
  }())
  const create = (id: string, seed?: readonly import('@deepseek-ai/dsh-session').SessionEvent[]) => ctx.agents.create({ sessionId: SessionId(id),
    agentOptions: { provider: 'goal-lifecycle', model: 'fixture' }, ...(seed ? { seed } : {}) })
  return { ctx, goals: ctx.get('goals') as any, requests, errors, create,
    async close() { await ctx.kiokukoHarness.dispose(); await ctx.fiber.dispose() } }
}

const human = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const round = (goalId: string, revision: number) => createUserMessage({
  source: { kind: 'goal', goalId, revision, round: 1 } as any,
  content: [{ type: 'text', text: 'Continue the previous goal.' }],
})

for (const delivery of ['followup', 'steer', 'later'] as const) test(`rejected stale goal does not strand a human ${delivery}`, { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    f.ctx.systemPrompt.context({ name: 'retained-goal-context', order: 0, text: 'Retain this context for the next real request.' })
    const { agent } = await f.create(`stale-goal-${delivery}`)
    const stale = round('previous-goal', 1)
    const request = human('Perform the next independent request.')
    agent.followup(stale)
    if (delivery === 'later') {
      await agent.whenIdle()
      assert.equal(f.requests.length, 0)
      assert.equal(agent.inbox.nextTurn.length, 0, 'Rejected automatic work must be removed even without pending human input')
    }
    agent[delivery === 'later' ? 'followup' : delivery](request)
    await agent.whenIdle()
    assert.equal(f.requests.length, 1, 'The next request must reach the provider without another click or Stop')
    assert.deepEqual(agent.inbox.nextTurn, [])
    assert.deepEqual(agent.inbox.nextStep, [])
    const admitted = agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id)
    assert.equal(admitted.filter(id => id === request.id).length, 1)
    assert.equal(admitted.includes(stale.id), false)
    assert.deepEqual(f.errors, [])
    agent.followup(human('Perform one more request.'))
    await agent.whenIdle()
    assert.equal(f.requests.length, 2, 'A rejected goal must not poison later turns either')
  } finally { await f.close() }
})

test('completed goal is cleared after its autonomous closing answer, preserving its durable history', { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    const { agent } = await f.create('goal-completes')
    let step = 0
    let closed!: () => void
    const closing = new Promise<void>(resolve => { closed = resolve })
    f.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/message'
        && event.data.message.content.some(b => b.type === 'text' && b.text === 'GOAL_CLOSING_ANSWER')) closed()
    })
    f.ctx.on('llm/stream', async function* (_request, _next) {
      step++
      if (step === 1 || step === 3) {
        const goal = f.goals.get(agent)
        const call = step === 1
          ? { name: 'create_goal', arguments: JSON.stringify({ objective: 'Finish the bounded fixture work.', max_goal_rounds: 3 }) }
          : { name: 'update_goal', arguments: JSON.stringify({ goal_id: goal.id, revision: goal.revision, action: 'complete' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `goal-tool-${step}` as any, ...call } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: step === 2 ? 'Continue in the next goal round.' : 'GOAL_CLOSING_ANSWER' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })
    agent.followup(human('Finish the bounded fixture work.'))
    await closing
    await agent.whenIdle()
    assert.equal(step, 4, 'Completion must retain the autonomous wrap-up step')
    assert.equal(f.goals.get(agent), undefined, 'A completed Goal must no longer be current')
    const events = agent.session.snapshotEvents() as any[]
    assert.deepEqual(events.filter(e => e.type === 'goal/change').map(e => e.data.operation), ['create', 'complete', 'clear'])
    assert.equal(events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 0)
    assert.deepEqual(f.errors, [])
    agent.followup(human('A new independent request after completion.'))
    await agent.whenIdle()
    assert.equal(step, 5)
  } finally { await f.close() }
})

test('restored completed goal and queued obsolete round are retired without losing the next request', { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    const original = await f.create('restored-goal')
    const goal = f.goals.create(original.agent, { objective: 'Already finished before restart.' })
    f.goals.complete(original.agent, goal)
    const stale = round(goal.id, goal.revision)
    original.agent.inbox.append('next-turn', stale)
    const seed = structuredClone(original.agent.session.snapshotEvents())
    await original.dispose()
    const { agent } = await f.create('restored-goal', seed)
    assert.equal(f.goals.get(agent), undefined, 'Restore must retire the recorded completion before accepting work')
    agent.followup(human('Work on the next request after restart.'))
    await agent.whenIdle()
    assert.equal(f.requests.length, 1)
    assert.equal(agent.inbox.nextTurn.length, 0)
    const changes = (agent.session.snapshotEvents() as any[]).filter(e => e.type === 'goal/change')
    assert.deepEqual(changes.map(e => e.data.operation), ['create', 'complete', 'clear'])
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('a reserved round invalidated during admission cannot block new input or clear the revised goal', { timeout: 10_000 }, async () => {
  const f = await fixture()
  try {
    const { agent } = await f.create('revised-goal-race')
    let revised: any, first = true, answered!: () => void
    const answer = new Promise<void>(resolve => { answered = resolve })
    f.ctx.on('llm/stream', async function* (_request, next) {
      if (first) { first = false; f.goals.create(agent, { objective: 'Original work.', maxGoalRounds: 3 }) }
      yield* next()
    })
    f.ctx.on('agent/inbox/claimed', ({ message }) => {
      if ((message.source as { kind: string }).kind !== 'goal' || revised) return
      const current = f.goals.get(agent)
      f.goals.edit(agent, current, { objective: 'Revised unfinished work.' })
      revised = f.goals.disarm(agent)
      agent.followup(human('Handle this new request instead of the obsolete round.'))
    })
    f.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/message' && f.requests.length === 2) answered()
    })
    agent.followup(human('Begin the original work.'))
    await answer
    await agent.whenIdle()
    assert.equal(f.requests.length, 2)
    assert.deepEqual(f.goals.get(agent), revised, 'Cleanup must not mutate a different revision or mark unfinished work complete')
    assert.equal(agent.inbox.nextTurn.length, 0)
    assert.equal((agent.session.snapshotEvents() as any[]).filter(e => e.type === 'goal/change' && e.data.operation === 'clear').length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

for (const phase of ['active', 'paused', 'blocked'] as const) test(`ordinary turn completion preserves an unfinished ${phase} goal`, async () => {
  const f = await fixture()
  try {
    const { agent } = await f.create(`preserve-${phase}`)
    const goal = f.goals.create(agent, { objective: 'Unfinished work', maxGoalRounds: 3 })
    if (phase === 'paused') f.goals.pause(agent, goal)
    else if (phase === 'blocked') f.goals.block(agent, goal, { code: 'fixture', message: 'Needs an external dependency' })
    else f.goals.disarm(agent)
    const before = f.goals.get(agent)
    agent.followup(human('Answer this separate question without resuming the goal.'))
    await agent.whenIdle()
    assert.equal(f.requests.length, 1)
    assert.deepEqual(f.goals.get(agent), before)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
