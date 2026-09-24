import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModelHandoff, handoffRange, handoffReceipt, pendingSelection, prefilteredSelection } from '../../../../src/dsh/model-handoff.js'
import { Config } from '../../../../src/dsh/config.js'
import { CoreConfig } from '../../../../src/dsh/core/host.js'
import { decisions } from '../../helpers/semantic-compaction.js'
import { compactionBatch } from '../../../../src/dsh/semantic-compaction/policy.js'
import { nativeMock } from '../../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)
const [cordis, llm, sessions, projection, prompt, tools, registry, loop, meter, compaction] = await Promise.all(
  ['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'token-meter', 'compaction-basic'].map(load))

test('native user model and reasoning switch delivers one durable compact checkpoint to the new request', async () => {
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  class ReasoningAdapter extends mock.MockAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    }
  }
  const adapter = new ReasoningAdapter([mock.textResponse('Goal, accepted constraints, completed work and next action.'), mock.textResponse('Continuing the task.')], ['old', 'new'])
  for (const plugin of [llm, sessions, projection, prompt, tools, registry, meter]) fibers.push(await ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  fibers.push(await ctx.plugin(compaction.default, { auto: false }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const d = decisions({ evaluate: async batch => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
    answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : 'shorten' })) }) })
  const handoff = new ModelHandoff(ctx, d.service, realpathSync(process.cwd()))
  const handle = await ctx.agents.create({ sessionId: sessions.SessionId('handoff-native'), agentOptions: { provider: 'mock', model: 'new', reasoningEffort: 'high' }, meta: { cwd: process.cwd() } })
  const agent = handle.agent, original = 'Earlier discussion and observations. '.repeat(300)
  try {
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (let index = 0; index < 6; index++) agent.session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: `Initial context ${index}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'old-call', role: 'assistant', content: [{ type: 'tool-call', id: 'old-read', name: 'read', arguments: '{"file_path":"old.log"}' }], source: { kind: 'model', provider: 'mock', model: 'old' } }, stream: [] }, { surfaceOp: 'append' })
    const call = agent.session.append('tool/call', { turn: 1, step: 1, callId: 'old-read', name: 'read', arguments: '{"file_path":"old.log"}' })
    agent.session.append('tool/result', { turn: 1, step: 1, message: { id: 'old-result', role: 'user', source: { kind: 'tool', callId: 'old-read' }, content: [{ type: 'tool-result', toolCallId: 'old-read', isError: false, content: [{ type: 'text', text: 'Old tool evidence. '.repeat(500) }] }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    for (let index = 0; index < 6; index++) agent.session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: `Intermediate context ${index}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    for (let index = 0; index < 3; index++) {
      const user = llm.createUserMessage({ content: [{ type: 'text', text: index === 0 ? original : `Later instruction ${index}` }], source: { kind: 'user' } })
      agent.session.append('user/message', user, { surfaceOp: 'append' })
      agent.session.append('assistant/message', { turn: 1, step: 1, message: { id: `answer-${index}`, role: 'assistant', content: [{ type: 'text', text: `Completed stage ${index}` }], source: { kind: 'model', provider: 'mock', model: 'old' } }, stream: [] }, { surfaceOp: 'append' })
    }
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('request/header', { header: { config: { provider: 'mock', model: 'old', reasoningEffort: 'low' } }, reason: 'initial' })
    agent.session.append('model/selection', { provider: 'mock', model: 'new', reasoningEffort: 'high' })
    const selection = pendingSelection(agent.session)
    assert.deepEqual(selection?.to, { provider: 'mock', model: 'new', reasoningEffort: 'high' })
    assert.ok(handoffRange(agent.session))
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Continue from the finished stage.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const summary = agent.session.snapshotEvents().filter((event: any) => event.type === 'compaction/summary')
    assert.equal(summary.length, 1)
    const request = adapter.requests.find(request => request.purpose !== 'compaction')
    assert.ok(request, JSON.stringify({ calls: adapter.requests.map(request => ({ purpose: request.purpose, model: request.model })),
      last: (d.service.status() as any).modelHandoff.last, turns: agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/end').map((event: any) => event.data) }))
    assert.equal(request.model, 'new')
    assert.equal(request.reasoningEffort, 'high')
    assert.match(JSON.stringify(request.messages), /Goal, accepted constraints/)
    assert.doesNotMatch(JSON.stringify(request.messages), /Earlier discussion and observations\. Earlier discussion/)
    assert.match(JSON.stringify(request.messages), /Completed stage 1/)
    assert.match(JSON.stringify(request.messages), /Completed stage 2/)
    assert.match(JSON.stringify(request.messages), /Continue from the finished stage/)
    assert.match(JSON.stringify(agent.session.snapshotEvents()), /Earlier discussion and observations/)
    assert.ok(d.calls.some(batch => batch.purpose === 'model-handoff'))
    assert.ok(agent.session.snapshotEvents().some((event: any) => event.type === 'compaction/prune'))
    const restored = handoffReceipt({ snapshotEvents: () => JSON.parse(JSON.stringify(agent.session.snapshotEvents())) } as any)
    assert.equal(restored?.version, 1)
    assert.equal(restored?.selectionSeq, selection?.seq)
    assert.equal(restored?.compactionId, summary[0].data.compactionId)
    assert.equal((d.service.status() as any).modelHandoff.last.outcome, 'summarized')
  } finally {
    handoff.stop(); await handle.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})

test('selection without a changed effective route has no handoff', () => {
  const session: any = { snapshotEvents: () => [{ type: 'request/header', seq: 0, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } } },
    { type: 'model/selection', seq: 1, data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
    { type: 'model/selection', seq: 2, data: { provider: 'p', model: 'm', reasoningEffort: 'high' } }] }
  assert.equal(pendingSelection(session), undefined)
})

test('only an explicit selection after an effective request initiates a handoff', () => {
  const previous = { provider: 'p', model: 'm', reasoningEffort: 'low' }
  const read = (selections: Record<string, string>[], withRequest = true) => pendingSelection({ snapshotEvents: () => [
    ...(withRequest ? [{ type: 'request/header', seq: 0, data: { header: { config: previous } } }] : []),
    ...selections.map((data, index) => ({ type: 'model/selection', seq: index + 1, data })),
  ] } as any)
  assert.equal(read([{ provider: 'p', model: 'other', reasoningEffort: 'low' }], false), undefined)
  assert.equal(read([previous]), undefined)
  assert.deepEqual(read([{ ...previous, model: 'other' }])?.to, { ...previous, model: 'other' })
  assert.deepEqual(read([{ ...previous, provider: 'other' }])?.to, { ...previous, provider: 'other' })
  assert.deepEqual(read([{ ...previous, reasoningEffort: 'high' }])?.to, { ...previous, reasoningEffort: 'high' })
  assert.equal(read([{ ...previous, model: 'other' }, previous]), undefined)
})

test('a new effective request closes the pending handoff window', () => {
  const old = { provider: 'p', model: 'old' }, next = { provider: 'p', model: 'new' }
  const session: any = { snapshotEvents: () => [
    { type: 'request/header', seq: 0, data: { header: { config: old } } },
    { type: 'model/selection', seq: 1, data: next },
    { type: 'request/header', seq: 2, data: { header: { config: next } } },
  ] }
  assert.equal(pendingSelection(session), undefined)
})

test('an unfinished native compaction is never reported as a completed handoff', () => {
  const events: any[] = [
    { type: 'request/header', seq: 0, data: { header: { config: { provider: 'p', model: 'old' } } } },
    { type: 'model/selection', seq: 1, data: { provider: 'p', model: 'new' } },
    { type: 'compaction/summary', seq: 2, data: { compactionId: 'c', shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1] } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'plugin', compactionId: 'c' } } },
  ]
  const session: any = { snapshotEvents: () => events }
  assert.equal(handoffReceipt(session), undefined)
  events.push({ type: 'compaction/end', seq: 4, data: { compactionId: 'c', error: 'failed' } })
  assert.equal(handoffReceipt(session), undefined)
  events[4].data = { compactionId: 'c' }
  assert.equal(handoffReceipt(session)?.compactionId, 'c')
})

test('handoff classification remains available when pressure compaction is off', async () => {
  const d = decisions({ mode: 'off' })
  const candidate: any = { id: 'candidate', tool: 'read', position: 1, event: { seq: 1 },
    original: { id: 'old', role: 'user', source: { kind: 'tool', callId: 'call' },
      content: [{ type: 'tool-result', toolCallId: 'call', isError: false, content: [{ type: 'text', text: 'Old evidence.' }] }] } }
  const batch = compactionBatch([], [], [candidate])
  const outcome = await d.service.evaluate('handoff-independent', { ...batch, purpose: 'model-handoff' }, new AbortController().signal)
  assert.equal(outcome.status, 'completed')
  assert.ok(d.calls.some(call => call.purpose === 'model-handoff'))
})

test('full plugin and modular core expose the same handoff configuration', () => {
  assert.deepEqual(Config.parse({}).modelHandoff, { mode: 'auto', budgetMs: 30000 })
  assert.deepEqual(CoreConfig.parse({}).modelHandoff, { mode: 'auto', budgetMs: 30000 })
  assert.deepEqual(Config.parse({ modelHandoff: { mode: 'off' } }).modelHandoff,
    CoreConfig.parse({ modelHandoff: { mode: 'off' } }).modelHandoff)
})

test('late auxiliary compaction output is discarded after cancellation', async () => {
  const listeners = new Map<string, (...args: any[]) => any>()
  const host: any = { get: () => undefined, on(name: string, listener: (...args: any[]) => any) {
    listeners.set(name, listener); return () => listeners.delete(name)
  } }
  const handoff = new ModelHandoff(host, decisions().service, realpathSync(process.cwd()))
  const controller = new AbortController()
  ;(handoff as any).active.set('session', { selectionSeq: 1, signal: controller.signal })
  let resolve!: (value: IteratorResult<any>) => void
  const late = new Promise<IteratorResult<any>>(done => { resolve = done })
  const stream = listeners.get('llm/stream')!({ purpose: 'compaction', sessionId: 'session' },
    () => ({ [Symbol.asyncIterator]: () => ({ next: () => late, return: async () => ({ done: true }) }) }))
  const next = stream[Symbol.asyncIterator]().next()
  controller.abort()
  await assert.rejects(next)
  resolve({ done: false, value: { type: 'text-delta', text: 'stale' } })
  handoff.stop()
})

test('a durable prefilter replacement prevents blind replay after reload', () => {
  const events: any[] = [
    { type: 'model/selection', seq: 1, data: { provider: 'p', model: 'new' } },
    { type: 'compaction/prune', seq: 2, data: { shadowedSeqs: [0] } },
    { type: 'tool/result', seq: 3, sourceEventSeqs: [0], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
  ]
  assert.equal(prefilteredSelection({ snapshotEvents: () => events } as any, 1), true)
  events.splice(2, 0, { type: 'request/header', seq: 5, data: {} })
  assert.equal(prefilteredSelection({ snapshotEvents: () => events } as any, 1), false)
})
