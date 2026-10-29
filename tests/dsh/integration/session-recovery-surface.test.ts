import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountDshComposition } from '../../../src/dsh/composition.js'

test('an interrupted native chat exposes a real recovery command without replaying tools', async () => {
  const ctx = new Context()
  const definitions = new Map<string, any>()
  const commands = { register(definition: any) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the local package' }] } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'lost-call', name: 'bash' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
  let followups = 0
  const session = { id: 'recovery-source', header: { cwd: '/tmp' }, snapshotEvents: () => events }
  const agent = { id: session.id, status: 'idle', session, model: { current: () => ({ provider: 'fixture', model: 'fixture' }) }, followup() { followups++ } }
  ctx.provide('commands', commands as never)
  ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture' }], resolveCallConfig: async (selection: unknown) => selection } as never)
  const composition = await mountDshComposition(ctx, { commands } as never)
  try {
    assert.ok(definitions.has('kioku-recover'), 'interrupted chats need a discoverable native recovery action')
    const result = await definitions.get('kioku-recover').handler({ agent, rawInput: 'status' })
    assert.equal(result.kind, 'success')
    const status = JSON.parse(result.text)
    assert.equal(status.interrupted, true)
    assert.equal(status.canContinue, true)
    assert.deepEqual(status.unknownCalls, [{ id: 'lost-call', name: 'bash' }])
    assert.equal(followups, 0, 'status never sends a model request or repeats an old operation')
  } finally { await composition.dispose(); await ctx.fiber.dispose() }
})
