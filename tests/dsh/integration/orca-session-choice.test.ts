import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createDshOrcaHost } from '../../../src/dsh/orca-host.js'
import { mountDshOrcaCommand } from '../../../src/dsh/orca-command-surface.js'
import { DshOrcaSessionChoices } from '../../../src/dsh/orca-session-choice.js'
import type { DshNativeCommandDefinition } from '../../../src/dsh/commands.js'
import type { DshUserQuestionAnswer, DshUserQuestions } from '../../../src/dsh/user-interaction.js'
import { orcaFixture, collect, chunks, request, response } from '../helpers/orca-fixture.js'

const answer = (value: string, id = 'kioku-orca-recording'): DshUserQuestionAnswer => ({ answers: [{ id, selected: value ? [value] : [] }] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
async function fixture(questions?: DshUserQuestions, interactive = true, askOnStart = true) {
  const f = await orcaFixture({ askOnStart })
  const session = { id: f.binding.sessionId, header: { cwd: f.root } }
  const agent = { id: 'native-agent', session }
  const listeners = new Map<string, (...args: any[]) => any>()
  const ctx = { on: (name: string, listener: (...args: any[]) => any) => { listeners.set(name, listener); return () => listeners.delete(name) } }
  const makeHost = () => createDshOrcaHost(ctx as never, f.config, { withDatabase: async (op: any) => op(f.database) } as never, {
    session: id => id === session.id ? session : undefined,
    agent: id => id === agent.id ? agent : undefined, logicalRun: () => undefined, ...(questions ? { questions } : {}),
    interactive: () => interactive,
  })
  let host = makeHost()
  let command!: DshNativeCommandDefinition
  const mount = () => mountDshOrcaCommand({ commands: { register: definition => { command = definition; return () => {} } } }, true, host)
  mount()
  const signal = new AbortController().signal
  return { ...f, agent, session, listeners, get host() { return host },
    step: (next = () => 'native-decision', stepSignal = signal) => listeners.get('agent/pre-step')!({ agent, signal: stepSignal }, next),
    stream: () => collect(listeners.get('llm/stream')!({ ...request, sessionId: session.id }, () => chunks(response()))),
    async command(rawInput: string) {
      const result = await command.handler({ agent, rawInput, signal })
      assert.equal(result.kind, 'success', result.text)
      return JSON.parse(result.text!)
    },
    async reload() { await host.shutdown(); host = makeHost(); mount() },
    async dispose() { await host.shutdown(); await f.dispose() },
  }
}

test('first-step recording choice gates early model/tool observations, deduplicates, and survives reload', async () => {
  const entered = deferred<void>(), reply = deferred<DshUserQuestionAnswer>()
  let asked = 0
  const f = await fixture({ ask: async input => {
    asked++
    assert.equal(input.agent, f.agent)
    assert.deepEqual(input.questions[0].options?.map(o => o.label), ['記録する', '記録しない'])
    entered.resolve()
    return reply.promise
  } })
  try {
    const step = f.step(), duplicate = f.step()
    await entered.promise
    assert.deepEqual(await f.stream(), response())
    const early = { token: Symbol(), callId: 'early', rootCallId: 'early', name: 'read', arguments: {}, agent: f.agent }
    await f.listeners.get('tools/pre-execute')!(early, async () => ({ kind: 'allow' }))
    f.listeners.get('tools/result')!(early, { isError: false, content: [] })
    await assert.rejects(access(join(f.root, '.orca')))
    assert.equal((await f.reader.list(f.binding)).length, 0)
    reply.resolve(answer('記録する'))
    assert.equal(await step, 'native-decision')
    assert.equal(await duplicate, 'native-decision')
    await f.step()
    assert.equal(asked, 1)
    assert.equal((await f.command('status --json')).sessionRecording, 'enabled')
    await f.stream()
    await f.reload()
    await f.step()
    assert.equal(asked, 1)
    await f.stream()
    await f.command('stop')
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(r => r.state === 'completed' && r.event_count > 0))
  } finally { await f.dispose() }
})

test('the default configuration records each chat without asking, while a saved refusal still wins', async () => {
  let asked = 0
  const f = await fixture({ ask: async () => { asked++; return answer('記録しない') } }, true, false)
  try {
    await f.step()
    assert.equal(asked, 0, 'the default configuration asks no recording question')
    assert.equal((await f.command('status --json')).sessionRecording, 'enabled')
    await f.stream()
    await f.command('stop')
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'completed')
    await f.reload(); await f.step(); await f.stream()
    assert.equal(asked, 0)
    assert.equal((await f.command('status --json')).sessionRecording, 'disabled')
    assert.equal((await f.reader.list(f.binding)).length, 1)
  } finally { await f.dispose() }
})

test('declining persists without traces, commands override the choice, and stop survives reload', async () => {
  let asked = 0
  const f = await fixture({ ask: async () => { asked++; return answer('記録しない') } })
  try {
    await f.step(); await f.stream(); await f.reload(); await f.step(); await f.stream()
    assert.equal(asked, 1)
    assert.equal((await f.command('status --json')).sessionRecording, 'disabled')
    await assert.rejects(access(join(f.root, '.orca')))
    await f.command('start'); await f.stream(); await f.command('stop')
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'completed')
    await f.reload(); await f.step(); await f.stream()
    assert.equal(asked, 1)
    assert.equal((await f.command('status --json')).sessionRecording, 'disabled')
    assert.equal((await f.reader.list(f.binding)).length, 1)
  } finally { await f.dispose() }
})

for (const mode of ['missing', 'rejected', 'skipped', 'wrong-id', 'invalid'] as const) test(`recording question ${mode} never blocks native work or authorizes capture`, async () => {
  let asked = 0
  const f = await fixture(mode === 'missing' ? undefined : { ask: async () => {
    asked++
    if (mode === 'rejected') throw new Error('UI unavailable')
    return mode === 'wrong-id' ? answer('記録する', 'wrong') : answer(mode === 'invalid' ? 'maybe' : '')
  } })
  try {
    assert.equal(await f.step(), 'native-decision')
    await f.step(); await f.stream()
    assert.equal(asked, mode === 'missing' ? 0 : 1)
    assert.equal((await f.command('status --json')).sessionRecording, 'awaiting_choice')
    await assert.rejects(access(join(f.root, '.orca')))
    await f.command('start'); await f.stream(); await f.command('stop')
    assert.equal((await f.reader.list(f.binding)).length, 1)
  } finally { await f.dispose() }
})

for (const action of ['start', 'stop', 'abort', 'shutdown'] as const) test(`${action} supersedes an unanswered question and ignores late approval`, async () => {
  const entered = deferred<void>(), reply = deferred<DshUserQuestionAnswer>()
  const f = await fixture({ ask: async () => { entered.resolve(); return reply.promise } })
  const controller = new AbortController()
  try {
    const step = f.step(undefined, controller.signal)
    await entered.promise
    if (action === 'abort') controller.abort()
    else if (action === 'shutdown') await f.host.shutdown()
    else await f.command(action)
    await step
    reply.resolve(answer(action === 'start' ? '記録しない' : '記録する'))
    await Promise.resolve()
    if (action !== 'shutdown') {
      await f.stream()
      assert.equal((await f.command('status --json')).sessionRecording, action === 'start' ? 'enabled' : action === 'stop' ? 'disabled' : 'awaiting_choice')
    }
    await f.host.shutdown()
    assert.equal((await f.reader.list(f.binding)).length, action === 'start' ? 1 : 0)
  } finally { await f.dispose() }
})

test('session choices cannot cross session, workspace, cwd or storage identities', async () => {
  const f = await orcaFixture()
  try {
    f.store.saveRecordingChoice(f.binding, true)
    assert.equal(f.store.recordingChoice(f.binding), true)
    for (const key of ['sessionId', 'workspaceRoot', 'sessionCwd', 'storeRoot'] as const) {
      assert.equal(f.store.recordingChoice({ ...f.binding, [key]: `${f.binding[key]}-different` }), undefined)
    }
    const choices = new DshOrcaSessionChoices(f.withIndex, { ask: async () => answer('２') })
    const second = { ...f.binding, sessionId: 'second' }
    await choices.prepare(second, { id: 'second-agent' }, new AbortController().signal, () => true)
    assert.equal(f.store.recordingChoice(second), false)
    assert.equal(f.store.recordingChoice(f.binding), true)
    await choices.shutdown()
  } finally { await f.dispose() }
})

test('failed preference storage stays non-recording and visible; explicit start can recover', async () => {
  const f = await orcaFixture()
  let fail = true
  const choices = new DshOrcaSessionChoices(async op => { if (fail) throw new Error('database unavailable'); return f.withIndex(op) },
    { ask: async () => answer('記録する') })
  try {
    await choices.prepare(f.binding, { id: 'agent' }, new AbortController().signal, () => true)
    assert.equal(choices.allows(f.binding), false)
    assert.equal((await choices.status(f.binding)).selectionError, 'recording_choice_persistence_failed')
    await assert.rejects(choices.set(f.binding, true), /recording_choice_persistence_failed/)
    assert.equal(choices.allows(f.binding), false)
    fail = false
    await choices.set(f.binding, true)
    assert.equal(choices.allows(f.binding), true)
    const silent = new DshOrcaSessionChoices(async () => { throw new Error('database unavailable') }, undefined, false)
    await silent.prepare(f.binding, { id: 'agent' }, new AbortController().signal, () => true)
    assert.equal(silent.allows(f.binding), false, 'a failed default must not record without the saved choice')
    assert.equal((await silent.status(f.binding)).selectionError, 'recording_choice_persistence_failed')
    await silent.shutdown()
  } finally { await choices.shutdown(); await f.dispose() }
})

test('disposed or replaced native identities cannot adopt a late recording answer', async () => {
  for (const disposed of [true, false]) {
    const entered = deferred<void>(), reply = deferred<DshUserQuestionAnswer>()
    const f = await fixture({ ask: async () => { entered.resolve(); return reply.promise } })
    try {
      const step = f.step()
      await entered.promise
      if (disposed) f.listeners.get('session/disposed')!(f.session)
      else Object.assign(f.agent, { session: { ...f.session } })
      reply.resolve(answer('記録する'))
      await step
      assert.equal(f.store.recordingChoice(f.binding), undefined)
      await assert.rejects(access(join(f.root, '.orca')))
    } finally { await f.dispose() }
  }
})

test('managed children do not interrupt work with recording questions or inherit another session choice', async () => {
  let asked = 0
  const f = await fixture({ ask: async () => { asked++; return answer('記録する') } }, false)
  try {
    f.store.saveRecordingChoice({ ...f.binding, sessionId: 'parent' }, true)
    await f.step(); await f.stream()
    assert.equal(asked, 0)
    await assert.rejects(access(join(f.root, '.orca')))
    await f.command('start'); await f.stream(); await f.reload(); await f.step(); await f.stream()
    assert.equal(asked, 0)
    assert.equal((await f.command('status --json')).sessionRecording, 'enabled')
  } finally { await f.dispose() }
})

test('managed children record without asking when the configuration records by default', async () => {
  let asked = 0
  const f = await fixture({ ask: async () => { asked++; return answer('記録しない') } }, false, false)
  try {
    await f.step()
    assert.equal(asked, 0, 'managed children are never asked')
    assert.equal((await f.command('status --json')).sessionRecording, 'enabled')
    await f.stream()
    await f.command('stop')
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'completed')
  } finally { await f.dispose() }
})
