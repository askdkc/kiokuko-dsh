import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshPlugin from '../../../src/dsh/index.js'
import { DshPonytailModes } from '../../../src/dsh/commands.js'
import { DshToolPolicy } from '../../../src/dsh/tool-policy.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'

test('explicit host adapter mounts native DSH tools and commands and unloads them', async () => {
  const tools: any[] = []
  const commands: any[] = []
  const guards: Function[] = []
  const modes = new DshPonytailModes()
  modes.begin('request-native')
  const policy = new DshToolPolicy({
    phase: 'goki', runId: 'run-native', workspace: 'workspace-native', orchestrationId: 'orch-native',
    revision: 1, routeEpoch: 0, dshSessionId: 'native-agent', workUnitId: 'unit-native', leaseToken: 'lease-native',
    currentWorkUnitId: 'unit-native', nextAction: 'execute_work_unit',
  })
  const calls: string[] = []
  const composition = {
    tools: {
      register(definition: any) { tools.push(definition); return () => { const index = tools.indexOf(definition); if (index >= 0) tools.splice(index, 1) } },
      guard(guard: Function) { guards.push(guard); return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1) } },
    },
    toolPolicy: policy,
    toolHost: {
      bind: () => ({ runId: 'run-native', workspace: 'workspace-native', orchestrationId: 'orch-native', revision: 1, routeEpoch: 0, workUnitId: 'unit-native', leaseToken: 'lease-native' }),
      execute: async (operation: string) => { calls.push(operation); return { ok: true } },
    },
    commands: {
      register(definition: any) { commands.push(definition); return () => { const index = commands.indexOf(definition); if (index >= 0) commands.splice(index, 1) } },
    },
    ponytailModes: modes,
  }
  const root = new Context()
  const host = await root.plugin({ name: 'native-host', apply: (ctx: Context) => ctx.provide('kiokukoDsh', composition) })
  const plugin = root.plugin(dshPlugin, { enabled: true })
  await host
  await plugin

  assert.equal(tools.length, 7)
  assert.equal(commands.length, 1)
  assert.deepEqual(await commands[0].handler({ rawInput: 'ultra', signal: new AbortController().signal }), {
    kind: 'success', text: 'Ponytail mode set to ultra for the active request.',
  })
  const workReport = tools.find((tool) => tool.name === 'enno_work_report')
  assert.ok(workReport)
  const denied = await (root.waterfall as unknown as (name: string, execution: unknown, next: () => Promise<unknown>) => Promise<unknown>)('tools/pre-execute', {
    callId: 'wrong-phase-call', name: 'enno_plan_submit', arguments: {}, agent: { id: 'native-agent', session: { id: 'native-agent' } }, signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(denied, { kind: 'deny', reason: 'Kiokuko dsh tool denied (wrong_directive)' })
  await workReport.execute({ result: { outcome: 'completed', summary: 'done', mutated: false, changedPaths: [] } }, {
    callId: 'native-call', name: 'enno_work_report', arguments: {}, agent: { id: 'native-agent', session: { id: 'native-agent' } }, signal: new AbortController().signal,
  })
  assert.deepEqual(calls, ['enno_work_report'])
  await plugin.dispose()
  assert.deepEqual(tools, [])
  assert.deepEqual(commands, [])
  assert.deepEqual(guards, [])
  await host.dispose()
})

test('turn-stopping and idle callbacks only kick the durable boundary worker', async () => {
  const listeners = new Map<string, (payload: any) => void>()
  const kicks: Array<{ sessionId: string | undefined; agent: object | undefined }> = []
  let disposed = 0
  const context = {
    on(name: string, listener: (payload: any) => void) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  } as unknown as Context
  const worker = {
    kick(sessionId?: string, agent?: object) { kicks.push({ sessionId, agent }) },
    async whenIdle() {},
    async dispose() { disposed += 1 },
  }
  const composition = await mountDshComposition(context, { boundaryWorker: worker })
  const agent = { id: 'agent', session: { id: 'session' }, steer() {} }
  listeners.get('agent/turn-stopping')?.({ agent, turn: 1, signal: new AbortController().signal })
  listeners.get('agent/idle')?.({ agent, turn: 1, signal: new AbortController().signal })
  assert.deepEqual(kicks, [
    { sessionId: undefined, agent: undefined },
    { sessionId: 'session', agent },
    { sessionId: 'session', agent },
  ])
  await composition.dispose()
  assert.equal(disposed, 1)
  assert.equal(listeners.size, 0)
})

test('failed optional native task mapping preserves the original step and calls downstream once', async () => {
  const listeners = new Map<string, Function>()
  const context = { on(name: string, fn: Function) { listeners.set(name, fn); return () => listeners.delete(name) } } as unknown as Context
  const composition = await mountDshComposition(context, {
    intakeGate: { preStep() { throw new Error('mapping did not succeed') } } as any,
    mapPreStep: () => { throw new Error('optional DB or task projection unavailable') },
  })
  try {
    const input = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '原文\n日本語と添付' }, { type: 'image', url: 'fixture' }], source: { kind: 'user' } }] }
    let calls = 0
    const run = listeners.get('agent/pre-step')!
    assert.equal(await run({}, async () => { calls++; return input }), input)
    assert.equal(calls, 1)
    const nativeFailure = new Error('native downstream failure')
    await assert.rejects(run({}, async () => { calls++; throw nativeFailure }), nativeFailure)
    assert.equal(calls, 2, 'a downstream failure must not cause a second execution')
  } finally { await composition.dispose() }
})
