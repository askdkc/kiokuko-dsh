import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshPlugin from '../../../src/dsh/index.js'
import { DshPonytailModes } from '../../../src/dsh/commands.js'
import { DshToolPolicy } from '../../../src/dsh/tool-policy.js'
import { DshSessionBridge, mountDshSessionBridge } from '../../../src/dsh/session-bridge.js'

test('explicit host adapter mounts native dsh tools and commands and unloads them', async () => {
  const tools: any[] = []
  const commands: any[] = []
  const guards: Function[] = []
  const toolDisposers = new Map<object, () => void>()
  const commandDisposers = new Map<object, () => void>()
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
      register(definition: any) {
        tools.push(definition)
        const dispose = () => { const index = tools.indexOf(definition); if (index >= 0) tools.splice(index, 1) }
        toolDisposers.set(definition, dispose)
        return dispose
      },
      guard(guard: Function) {
        guards.push(guard)
        return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1) }
      },
    },
    toolPolicy: policy,
    toolHost: {
      bind: () => ({ runId: 'run-native', workspace: 'workspace-native', orchestrationId: 'orch-native', revision: 1, routeEpoch: 0, workUnitId: 'unit-native', leaseToken: 'lease-native' }),
      execute: async (operation: string) => { calls.push(operation); return { ok: true } },
    },
    commands: {
      register(definition: any) {
        commands.push(definition)
        const dispose = () => { const index = commands.indexOf(definition); if (index >= 0) commands.splice(index, 1) }
        commandDisposers.set(definition, dispose)
        return dispose
      },
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
  assert.deepEqual(workReport.output.schema, {})
  const denied = await (root.waterfall as unknown as (name: string, execution: unknown, next: () => Promise<unknown>) => Promise<unknown>)('tools/pre-execute', {
    callId: 'wrong-phase-call', name: 'enno_plan_submit', arguments: {}, agent: { id: 'native-agent' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(denied, { kind: 'deny', reason: 'Kiokuko dsh tool denied (wrong_directive)' })
  assert.equal(tools.some((tool) => tool.name === 'task_prepare'), false)
  await workReport.execute({ result: { outcome: 'completed', summary: 'done', mutated: false, changedPaths: [] } }, {
    callId: 'native-call', name: 'enno_work_report', arguments: {}, agent: { id: 'native-agent' }, signal: new AbortController().signal,
  })
  assert.deepEqual(calls, ['enno_work_report'])
  await plugin.dispose()
  assert.deepEqual(tools, [])
  assert.deepEqual(commands, [])
  assert.deepEqual(guards, [])
  await host.dispose()
})

test('native session event contract bridges committed events and deduplicates replay', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const batches: any[][] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async (_runId, events) => { batches.push([...events]) },
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, () => 'run-session-native')
  const session = { id: 'session-native' }
  listeners.get('session/created')!(session)
  const event = { type: 'assistant/message', seq: 7, time: 1_700_000_000_000, data: { text: 'hello' } }
  listeners.get('session/event')!(session, event)
  listeners.get('session/event')!(session, event)
  assert.equal(bridge.pendingCount, 1)
  await bridge.flush()
  assert.equal(batches.length, 1)
  assert.equal(batches[0]![0]!.sourceEventId, 'dsh:session-native:7')
  assert.equal(bridge.pendingCount, 0)
  dispose()
  await bridge.close()
  assert.deepEqual(bridge.observerErrors, [])
})
