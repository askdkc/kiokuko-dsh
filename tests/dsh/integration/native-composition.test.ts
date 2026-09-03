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
    callId: 'wrong-phase-call', name: 'enno_plan_submit', arguments: {}, agent: { id: 'native-agent', session: { id: 'native-agent' } }, signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(denied, { kind: 'deny', reason: 'Kiokuko dsh tool denied (wrong_directive)' })
  assert.equal(tools.some((tool) => tool.name === 'task_prepare'), false)
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
  assert.match(batches[0]![0]!.sourceEventId, /^dsh:session-native:[^:]+:7$/u)
  assert.equal(bridge.pendingCount, 0)
  dispose()
  await bridge.close()
  assert.deepEqual(bridge.observerErrors, [])
})

test('native bridge retains the pre-binding turn prefix and attaches it to the exact run', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const batches: Array<{ runId: string; sequences: number[] }> = []
  let activeRun: string | undefined
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async (runId, events) => {
      batches.push({ runId, sequences: events.map((event) => event.sourceSequence!) })
    },
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, () => activeRun)
  const session = { id: 'late-bound-session', header: { createdAt: 1 } }
  listeners.get('session/created')!(session)
  listeners.get('session/event')!(session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  assert.equal(bridge.pendingCount, 0)

  activeRun = 'late-bound-run'
  listeners.get('session/event')!(session, { type: 'user/message', seq: 1, time: 1, data: { text: 'task' } })
  await bridge.flush()

  assert.deepEqual(batches, [{ runId: 'late-bound-run', sequences: [0, 1] }])
  dispose()
  await bridge.close()
})

test('native session observer contains identity conflicts without throwing from session/event', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async () => undefined,
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, () => 'run-same')
  const first = { id: 'session-same', header: { createdAt: 1 } }
  const replacement = { id: 'session-same', header: { createdAt: 2 } }
  listeners.get('session/created')!(first)
  listeners.get('session/event')!(first, { type: 'turn/start', seq: 0, time: 0, data: null })
  assert.doesNotThrow(() => listeners.get('session/event')!(replacement, { type: 'turn/start', seq: 0, time: 0, data: null }))
  assert.equal(bridge.observerErrors.length, 1)
  await assert.rejects(bridge.flush(), /session identity changed/u)
  dispose()
})

test('late disposal of an older native session cannot unbind a rebound session', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async () => undefined,
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, (session) => session.id === 'session-reused' ? session.header?.createdAt === 2 ? 'run-two' : 'run-one' : undefined)
  const first = { id: 'session-reused', header: { createdAt: 1 } }
  const replacement = { id: 'session-reused', header: { createdAt: 2 } }
  listeners.get('session/created')!(first)
  listeners.get('session/event')!(first, { type: 'turn/start', seq: 0, time: 0, data: null })
  listeners.get('session/event')!(replacement, { type: 'turn/start', seq: 0, time: 0, data: null })
  listeners.get('session/disposed')!(first)
  assert.equal(bridge.bindingOf('session-reused'), 'run-two')
  listeners.get('session/event')!(replacement, { type: 'turn/end', seq: 1, time: 1, data: null })
  assert.equal(bridge.pendingCount, 3)
  assert.equal(bridge.observerErrors.length, 1)
  dispose()
  await assert.rejects(bridge.close(), /stale session disposal ignored/u)
})

test('events after native session disposal fail closed until a new created event binds it', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async () => undefined,
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, () => 'run-disposed')
  const session = { id: 'session-disposed', header: { createdAt: 1 } }
  listeners.get('session/created')!(session)
  listeners.get('session/disposed')!(session)
  listeners.get('session/event')!(session, { type: 'late/event', seq: 0, time: 0, data: null })
  assert.equal(bridge.pendingCount, 0)
  assert.equal(bridge.observerErrors.length, 1)
  await assert.rejects(bridge.flush(), /after disposal/u)
  dispose()
})

test('a sealed turn run releases observer bookkeeping before the next persistent-session turn', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const batches: string[] = []
  let activeRun: string | undefined = 'turn-one'
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async (runId) => { batches.push(runId) },
  })
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, () => activeRun)
  const session = { id: 'persistent-session', header: { createdAt: 1 } }
  listeners.get('session/created')!(session)
  listeners.get('session/event')!(session, { type: 'turn/end', seq: 1, time: 1, data: null })
  await bridge.flush()
  bridge.sealRun('turn-one')
  activeRun = undefined
  listeners.get('session/event')!(session, { type: 'user/message', seq: 2, time: 2, data: { text: 'next turn' } })
  assert.deepEqual(bridge.observerErrors, [])
  activeRun = 'turn-two'
  listeners.get('session/event')!(session, { type: 'assistant/message', seq: 3, time: 3, data: { text: 'continued' } })
  await bridge.flush()
  assert.deepEqual(batches, ['turn-one', 'turn-two'])
  assert.equal(bridge.bindingOf(session.id), 'turn-two')
  dispose()
  await bridge.close()
})

test('a stale native session object cannot be rebound through a current run resolver', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T>() => undefined as T },
    appendBatch: async () => undefined,
  })
  const first = { id: 'session-stale', header: { createdAt: 1 } }
  const replacement = { id: 'session-stale', header: { createdAt: 2 } }
  let active: object = first
  const dispose = mountDshSessionBridge({
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }, bridge, (session) => session === active ? session === first ? 'run-old' : 'run-new' : undefined)
  listeners.get('session/created')!(first)
  listeners.get('session/event')!(first, { type: 'turn/start', seq: 0, time: 0, data: null })
  active = replacement
  listeners.get('session/event')!(replacement, { type: 'turn/start', seq: 0, time: 1, data: null })
  listeners.get('session/event')!(first, { type: 'late/event', seq: 1, time: 2, data: null })
  assert.equal(bridge.pendingCount, 2)
  assert.equal(bridge.observerErrors.length, 1)
  dispose()
  await assert.rejects(bridge.close(), /active run binding/u)
})
