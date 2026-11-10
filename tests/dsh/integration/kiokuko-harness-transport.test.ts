import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, createUserMessage, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { KiokukoAgentFactory } from '../../../src/dsh/harness/factory.js'
import { mountNativeTools } from '../helpers/native-tools.js'

const message = 'Codex WebSocket failure\n{"configuredTransport":"auto","phase":"after_message_stream_start","eventsEmitted":true,"requestBytes":859451,"code":1012}'
const failure: LlmFailure = { code: 'PI_AI_ERROR', message, providerRetryAfterMs: 17 }
// Existing diagnostic projection flattens newlines; keep that redaction contract.
const expectedFailure = { ...failure, message: message.replace('\n', ' '), code: 'TRANSPORT' }
const policy = { mode: 'normal' as const, maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }

// Real factory and native executor; existing helper supports both installed Tools APIs.
async function fixture(stream: (options: any) => AsyncGenerator<StreamChunk>) {
  const ctx = new Context(), fibers: any[] = []
  for (const plugin of [Llm, Sessions, Projections, Agents, SystemPrompt]) fibers.push(await ctx.plugin(plugin))
  await mountNativeTools(ctx, Tools, resolve('node_modules'), fibers)
  ctx.llm.registerAdapter(['transport-fixture'], new class extends LlmAdapter {
    override providerRetryPolicy() { return policy }
    stream(options: any) { return stream(options) }
  }())
  let factory!: KiokukoAgentFactory
  fibers.push(await ctx.plugin({ name: 'transport-factory-contract', inject: ['agents', 'sessions', 'llm', 'tools', 'systemPrompt'],
    apply(scope: Context) {
      factory = new KiokukoAgentFactory(scope, { provider: 'transport-fixture', model: 'contract-model' })
      scope.agents.setFactory(factory)
    },
  }))
  return { ctx, async close() { await factory.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await ctx.fiber.dispose() } }
}
function* toolCall(id: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as any, name: 'transport_probe', arguments: JSON.stringify({ id }) } }
}
for (const decision of ['retry', 'decline', 'exhausted'] as const) {
  test(`Codex post-stream failure reaches host transport policy: ${decision}`, async () => {
    let requests = 0, retries = 0
    const executions: string[] = [], failures: LlmFailure[] = [], policies: unknown[] = [], histories: unknown[] = []
    const f = await fixture(async function* (options) {
      requests++; histories.push(options.messages)
      if (requests === 1) {
        yield* toolCall('settled-call')
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (requests === 2 || decision === 'exhausted') {
        yield* toolCall('failed-stream-call')
        yield { type: 'finish', reason: { kind: 'error', failure } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered from recorded results.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })
    try {
      f.ctx.tools.register({ name: 'transport_probe', description: 'Record a settled tool call.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async (args: { id: string }) => { executions.push(args.id); return args.id },
      })
      // Code-sensitive host policy double; factory must not create its own retry loop.
      f.ctx.on('agent/request-error', async (event, next) => {
        failures.push(event.failure); policies.push(event.retryPolicy)
        if (decision !== 'decline' && event.retryPolicy?.mode === 'normal' && event.retryPolicy.retryableCodes.includes(event.failure.code) && retries < event.retryPolicy.maxRetries) {
          retries++; return { kind: 'retry' }
        }
        return next()
      })
      const { agent } = await f.ctx.agents.create({ sessionId: SessionId(`transport-policy-${decision}`) })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish the work without repeating completed effects.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents(), failedAttempts = decision === 'exhausted' ? 2 : 1
      assert.deepEqual(failures, Array.from({ length: failedAttempts }, () => expectedFailure))
      assert.deepEqual(policies, Array.from({ length: failedAttempts }, () => policy))
      assert.equal(requests, decision === 'decline' ? 2 : 3)
      assert.equal(retries, decision === 'decline' ? 0 : 1)
      assert.deepEqual(executions, ['settled-call'], 'failed streamed calls and settled effects must not execute on retry')
      assert.equal(events.filter(e => e.type === 'tool/call').length, 1)
      assert.equal(events.filter(e => e.type === 'tool/result').length, 1)
      assert.equal(events.filter(e => e.type === 'assistant/attempt').length, failedAttempts)
      assert.equal(events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
      const end = events.filter(e => e.type === 'turn/end').at(-1)!.data.reason
      assert.equal(end.kind, decision === 'retry' ? 'completed' : 'error')
      if (end.kind === 'error') assert.deepEqual(end.error, expectedFailure)
      if (decision !== 'decline') {
        assert.ok(JSON.stringify(histories[2]).includes('settled-call'))
        assert.ok(!JSON.stringify(histories[2]).includes('failed-stream-call'), 'failed stream stays outside replayable history')
      }
      assert.deepEqual(failure, { code: 'PI_AI_ERROR', message, providerRetryAfterMs: 17 }, 'adapter-owned failure is not mutated')
    } finally { await f.close() }
  })
}
for (const scenario of [
  { name: 'unrelated pi-ai error', kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Unrecognized provider failure' } },
  { name: 'explicit authentication code', kind: 'error', failure: { code: 'AUTH', message } },
  { name: 'provider aborted finish', kind: 'aborted', failure },
] as const) {
  test(`transport normalization preserves ${scenario.name}`, async () => {
    let requests = 0
    const failures: LlmFailure[] = []
    const f = await fixture(async function* () { requests++; yield { type: 'finish', reason: { kind: scenario.kind, failure: scenario.failure } } })
    try {
      f.ctx.on('agent/request-error', async (event, next) => {
        failures.push(event.failure)
        if (event.failure.code === 'TRANSPORT' && requests < 2) return { kind: 'retry' }
        return next()
      })
      const { agent } = await f.ctx.agents.create({ sessionId: SessionId(`transport-control-${scenario.name.replaceAll(' ', '-')}`) })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect this request.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const expected = { ...scenario.failure, message: scenario.failure.message.replace('\n', ' ') }
      assert.deepEqual(failures, [expected]); assert.equal(requests, 1)
      const end = agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!.data.reason
      assert.equal(end.kind, 'error')
      if (end.kind === 'error') assert.deepEqual(end.error, expected)
    } finally { await f.close() }
  })
}
test('native cancellation bypasses transport retry and keeps interrupted stream', async () => {
  let agent: any, requests = 0, recoveries = 0
  const f = await fixture(async function* () {
    requests++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Interrupted prefix' }
    agent.cancel({ kind: 'user' })
    yield { type: 'finish', reason: { kind: 'error', failure } }
  })
  try {
    f.ctx.on('agent/request-error', async () => { recoveries++; return { kind: 'retry' } })
    agent = (await f.ctx.agents.create({ sessionId: SessionId('transport-native-cancel') })).agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Begin the request.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    assert.equal(requests, 1); assert.equal(recoveries, 0)
    assert.deepEqual(events.filter((e: any) => e.type === 'turn/end').at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } })
    assert.ok(events.some((e: any) => e.type === 'assistant/message' && e.data.interrupted))
    assert.equal(events.filter((e: any) => e.type === 'tool/call').length, 0)
  } finally { await f.close() }
})
