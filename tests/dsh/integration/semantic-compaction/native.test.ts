import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SemanticCompactionCoordinator } from '../../../../src/dsh/semantic-compaction/coordinator.js'
import { renderHistoryResult } from '../../../../src/dsh/lisp/model-result.js'
import { history, decisions } from '../../helpers/semantic-compaction.js'
import { nativeMock } from '../../helpers/native-mock.js'

// This suite is mandatory: a missing pinned fixture is a failure, never a skip.
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)
const [cordis, llm, sessions, projection, prompt, tools, registry, loop, meter, compaction, pruner] = await Promise.all(['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'token-meter', 'compaction-basic', 'compaction-tool-result-pruner'].map(load))
const version = JSON.parse(await readFile(join(packages, '@deepseek-ai/dsh-compaction-basic/package.json'), 'utf8')).version
assert.equal(version, process.env.KIOKUKO_EXPECTED_DSH_VERSION ?? '0.1.5-rc.1')
const currentToolMessages = version.startsWith('0.1.7')

async function nativeFixture(enabled = true, text = 'Old file content. '.repeat(350), tool = 'read', options: { seed?: any[]; parentSession?: string; choose?: string; roleRatio?: number; contextWindow?: number; script?: (mock: any) => any[] } = {}) {
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  class Provider extends mock.MockAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: model === 'goki' ? 10000 : options.contextWindow ?? 1600 } } }
  }
  const provider = new Provider(options.script?.(mock) ?? Array.from({ length: 12 }, () => mock.textResponse('Required task and acceptance criteria retained.')))
  for (const plugin of [llm, sessions, projection, prompt, tools, registry, meter, pruner]) fibers.push(await ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  fibers.push(await ctx.plugin(compaction.default, { thresholdRatio: .8, retainTokens: 150, ...(options.roleRatio === undefined ? {} : { modelPolicies: [{ provider: 'mock', model: 'goki', thresholdRatio: options.roleRatio, retainTokens: 100 }] }) }))
  ctx.llm.registerAdapter(['mock'], provider)
  const d = decisions({ evaluate: async batch => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : q.id === 'timing' ? 'compact' : options.choose ?? 'shorten' })) }) })
  const coordinator = enabled ? new SemanticCompactionCoordinator(ctx, d.service, realpathSync(process.cwd())) : undefined
  const handle = await ctx.agents.create({ sessionId: sessions.SessionId('native-semantic'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: process.cwd(), ...(options.parentSession ? { parentSession: options.parentSession } : {}) }, ...(options.seed ? { seed: options.seed } : {}) })
  const agent = handle.agent
  if (!options.seed) {
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const event of history(text, tool)) {
      const data = structuredClone(event.data)
      if (event.type === 'assistant/message') { data.turn = 1; data.step = 1; data.stream = [] }
      if (event.type === 'tool/result' && currentToolMessages) {
        const result = data.message.content[0]
        data.message = { ...data.message, role: 'tool', toolCallId: result.toolCallId,
          content: result.content, isError: result.isError }
      }
      agent.session.append(event.type, data, { surfaceOp: 'append' })
    }
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
  }
  const run = async () => {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Continue; the old log is no longer needed.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const end = agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').at(-1)
    assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end))
  }
  return { ctx, agent, provider, coordinator, ...d, run, close: async () => { coordinator?.stop(); await coordinator?.drain(); await handle.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

for (const [language, text] of [['English', 'Old file content. '.repeat(350)], ['Japanese', '古い調査結果です🙂'.repeat(600)]] as const) test(`native ${language}: semantic replacement reduces the next request and survives reload`, async () => {
  const baseline = await nativeFixture(false, text)
  let baselinePressure: number
  try {
    baselinePressure = baseline.ctx.tokenMeter.measure(baseline.agent.session).totalTokens
    await baseline.run()
    if (!currentToolMessages) assert.ok(baseline.agent.session.snapshotEvents().some((e: any) => e.type === 'compaction/end'), 'stock fixture must summarize')
  } finally { await baseline.close() }
  const f = await nativeFixture(true, text)
  let seed: any[]
  try {
    const original = f.agent.session.snapshotEvents(), before = f.ctx.tokenMeter.measure(f.agent.session).totalTokens
    assert.equal(before, baselinePressure)
    await f.run()
    const events = f.agent.session.snapshotEvents(), outcome = (f.service.status() as any).semanticCompaction.last
    assert.equal(outcome.outcome, 'shortened', JSON.stringify(outcome))
    assert.ok(outcome.afterTokens < outcome.beforeTokens * .75)
    assert.ok(!events.some((e: any) => e.type === 'compaction/end'))
    assert.equal(f.provider.requests.length, 1, 'only the actual subsequent model request')
    const request = f.provider.requests[0]
    assert.ok(JSON.stringify(request.messages).includes('Kiokuko shortened earlier tool output'))
    assert.ok(JSON.stringify(request.messages).includes('acceptance criteria'))
    assert.ok(!JSON.stringify(request.messages).includes(text))
    assert.deepEqual(events.slice(0, original.length), original)
    seed = JSON.parse(JSON.stringify(events))
  } finally { await f.close() }
  const resumed = await nativeFixture(true, text, 'read', { seed: seed! })
  try { await resumed.run(); assert.ok(JSON.stringify(resumed.provider.requests[0].messages).includes('Kiokuko shortened earlier tool output')); assert.equal(resumed.calls.length, 0) }
  finally { await resumed.close() }
})

test('native Lisp projection preserves outcome metadata and an inspection reference into original stored data', async () => {
  const original = { ok: true, operationId: 'native-lisp-op', generation: 1, state: 'COMPLETED', changeSummary: { total: 0, states: {} }, value: { json: { code: 0, state: 'PASSED', stdout: 'old Lisp logs. '.repeat(440), stderr: '' } } }
  const f = await nativeFixture(true, JSON.stringify(original), 'lisp_eval')
  f.coordinator!.registerProjector('lisp_eval', renderHistoryResult)
  try {
    await f.run()
    const event = f.agent.session.snapshotEvents().filter((e: any) => e.type === 'tool/result').at(-1)
    const rendered = JSON.parse(event.data.message.role === 'tool' ? event.data.message.content[0].text : event.data.message.content[0].content[0].text)
    assert.equal(rendered.value.json.code, 0); assert.equal(rendered.value.json.state, 'PASSED'); assert.deepEqual(rendered.changeSummary, original.changeSummary)
    assert.equal(rendered.inspect.resultOperationId, original.operationId)
    assert.equal(rendered.inspect.pointer.split('/').slice(1).reduce((v: any, k: string) => v[k], original), original.value.json.stdout)
    assert.ok(!f.agent.session.snapshotEvents().some((e: any) => e.type === 'compaction/end'))
  } finally { await f.close() }
})

test('native insufficient reduction retains full output for the stock compactor', async () => {
  const f = await nativeFixture(true, undefined, 'read', { choose: 'keep' })
  try { await f.run(); assert.equal((f.service.status() as any).semanticCompaction.last.reason, 'insufficient_reduction'); if (!currentToolMessages) assert.ok(f.agent.session.snapshotEvents().some((e: any) => e.type === 'compaction/end')); assert.equal(f.agent.session.snapshotEvents().filter((e: any) => e.type === 'compaction/prune').length, 0) }
  finally { await f.close() }
})

for (const restored of [false, true]) test(`native Enno child ${restored ? 'restoration' : 'creation'} validates persisted authority without mutating work state`, async () => {
  let f = await nativeFixture(true, undefined, 'read', { parentSession: 'parent' })
  const { compactionEnno } = await import('../../helpers/compaction-enno.js')
  const state = await compactionEnno(f.agent)
  try {
    const { DshEnnoDelegation } = await import('../../../../src/dsh/enno-delegation.js')
    if (restored) { const seed = JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())); await f.close(); f = await nativeFixture(true, undefined, 'read', { parentSession: 'parent', seed }) }
    const delegation = restored ? new DshEnnoDelegation(state.runtime, undefined) : state.delegation
    let checks = 0
    f.coordinator!.attach(f.agent, async () => {
      const model = await delegation.restoreOrPersist(f.agent); checks++
      return { child: delegation.observationBinding(f.agent), childSessionId: f.agent.session.id, model, authority: await delegation.authorityFingerprint(f.agent) }
    })
    const before = state.snapshot()
    await f.run()
    assert.equal((f.service.status() as any).semanticCompaction.last.outcome, 'shortened')
    assert.equal(checks, 2); assert.equal(state.snapshot(), before)
    assert.ok(f.calls.filter(c => c.purpose === 'compaction').every(c => !JSON.stringify(c.state).includes('leaseToken')))
  } finally { await state.close(); await f.close() }
})

test('native Enno main role change uses the assembled route and exact policy override', async () => {
  const { installDshModelRouting } = await import('../../../../src/dsh/model-routing.js')
  for (const ratio of [.08, 1]) {
    const f = await nativeFixture(true, undefined, 'read', { roleRatio: ratio })
    const coordinator = f.coordinator!
    const dispose = installDshModelRouting(f.agent, async () => ({ provider: 'mock', model: 'goki' }), undefined,
      { prompts: () => undefined as any, assembled: assembly => { coordinator.recordRoute(f.agent, assembly.variables); return Promise.resolve(assembly) } })
    try {
      await f.run()
      assert.equal(f.provider.requests.at(-1).model, 'goki')
      const outcome = (f.service.status() as any).semanticCompaction.last
      assert.equal(outcome.outcome, ratio === 1 ? 'skipped' : 'shortened', JSON.stringify(outcome))
      assert.equal(outcome.reason, ratio === 1 ? 'low_pressure' : 'accepted')
    } finally { dispose(); coordinator.stop(); await coordinator.drain(); await f.close() }
  }
})

for (const trigger of ['manual', 'context-overflow']) test(`native ${trigger} bypasses semantic classifier`, async () => {
  const f = await nativeFixture(true)
  try {
    const signal = new AbortController().signal
    if (trigger === 'context-overflow') f.agent.session.append('turn/start', { turn: 2 })
    const result = trigger === 'manual' ? await f.ctx.compaction.compactNow(f.agent, signal) : await f.ctx.compaction.compactIfNeeded(f.agent, 'context-overflow', signal)
    if (trigger === 'context-overflow') f.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    assert.ok(result); assert.equal(f.calls.length, 0)
    assert.ok(f.agent.session.snapshotEvents().some((e: any) => e.type === 'compaction/end'))
  } finally { await f.close() }
})

for (const preemptive of [true, false]) test(`actual native TODO below-threshold Jev and overhead comparison (preemptive=${preemptive})`, async t => {
  const f = await nativeFixture(true, undefined, 'read', { contextWindow: 50000, script: mock => [
    mock.toolCallResponse('todo-1', 'todo_write', { todos: [{ content: 'Inspect', status: 'in_progress' }, { content: 'Implement', status: 'pending' }] }),
    mock.textResponse('Inspected the original output.'),
    mock.toolCallResponse('todo-2', 'todo_write', { todos: [{ content: 'Inspect', status: 'completed' }, { content: 'Implement', status: 'in_progress' }] }),
    mock.textResponse('Continue implementation.'),
  ] })
  f.service.semanticCompaction.preemptive = preemptive
  const todo = await f.ctx.plugin(await load('tool-todo'), { allowParallelInProgress: false })
  try {
    await f.run(); assert.equal(f.calls.filter(c => c.purpose === 'compaction').length, 0)
    await f.run()
    assert.equal(f.calls.filter(c => c.purpose === 'compaction').length, preemptive ? 1 : 0)
    const status = (f.service.status() as any).semanticCompaction, last = status.last
    assert.equal(last.trigger, preemptive ? 'todo_boundary' : 'pressure'); assert.equal(last.outcome, preemptive ? 'shortened' : 'skipped'); assert.ok(last.beforeTokens < 40000)
    assert.equal(status.metrics.calls, preemptive ? 1 : 0)
    t.diagnostic(JSON.stringify({ preemptive, modelRequests: f.provider.requests.length, requestBytes: f.provider.requests.reduce((n: number, r: any) => n + Buffer.byteLength(JSON.stringify({ messages: r.messages, tools: r.tools })), 0), decision: status.metrics }))
    assert.ok(!f.agent.session.snapshotEvents().some((e: any) => e.type === 'compaction/end'))
  } finally { await todo.dispose(); await f.close() }
})
