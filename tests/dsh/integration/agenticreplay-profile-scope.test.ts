import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createDshAgenticReplayHost } from '../../../src/dsh/agenticreplay-host.js'
import { agenticReplayFixture, chunks, collect, request, response } from '../helpers/agenticreplay-fixture.js'

type Listener = (...args: any[]) => any
const observerNames = ['agent/pre-step', 'agent/session-start', 'session/disposed', 'llm/stream',
  'agent/error', 'tools/pre-execute', 'tools/execute', 'tools/result'].sort()

async function verifyRecordingScope(profile: string | undefined, scoped: boolean, askOnStart: boolean) {
  const f = await agenticReplayFixture({ askOnStart, shutdownDrainTimeoutMs: 3000 })
  // Own repository discovery even if a temporary-directory ancestor has a binding.
  await writeFile(join(f.root, '.kiokuko.json'), '{}\n')
  const session = { id: f.binding.sessionId, header: { cwd: f.root } }
  const agent = { id: 'native-agent', session }
  const listeners = new Map<string, Listener>()
  const scopes: string[] = []
  let rootAttempts = 0, asked = 0
  const register = (scope: string, name: string, listener: Listener, options: { global?: boolean }) => {
    assert.equal(options.global, true)
    scopes.push(scope)
    listeners.set(name, listener)
    return () => { listeners.delete(name) }
  }
  // Model the CLI activation guard: root.on delegates to forbidden root.events.on.
  const root = {
    on(name: string, listener: Listener, options: { global?: boolean }) {
      return this.events.on(name, listener, options)
    },
    events: {
      on(name: string, listener: Listener, options: { global?: boolean }) {
        rootAttempts++
        if (scoped) throw new Error(`${profile}: root.events.on is unavailable from a plugin activation`)
        return register('root', name, listener, options)
      },
    },
  }
  const ctx = {
    root,
    get: (name: string, strict: boolean) => {
      assert.equal(name, 'profileContext')
      assert.equal(strict, false)
      return profile === undefined ? undefined : { name: profile }
    },
    on(name: string, listener: Listener, options: { global?: boolean }) {
      assert.ok(scoped, 'Web observers must remain on the root through recorder drain')
      return register('plugin', name, listener, options)
    },
  }
  const makeHost = () => createDshAgenticReplayHost(ctx as never, f.config,
    { withDatabase: async (operation: any) => operation(f.database) } as never, {
      session: id => id === session.id ? session : undefined,
      agent: id => id === agent.id ? agent : undefined,
      logicalRun: () => undefined,
      questions: { ask: async () => {
        asked++
        return { answers: [{ id: 'kioku-agenticreplay-recording', selected: ['記録する'] }] }
      } },
    })
  let host = makeHost()
  try {
    assert.equal((await f.reader.list(f.binding)).length, 0, 'fixture starts without traces')
    // Reload the host against the same native session and persisted recording choice.
    for (let generation = 0; generation < 2; generation++) {
      assert.equal(host.recorder.status(session.id).capability, 'available')
      assert.deepEqual([...listeners.keys()].sort(), observerNames)
      assert.ok(scopes.every(scope => scope === (scoped ? 'plugin' : 'root')))
      if (scoped) assert.equal(rootAttempts, 0)
      else assert.equal(rootAttempts, observerNames.length * (generation + 1))
      const decision = Object.freeze({ kind: 'native-decision' })
      assert.equal(await listeners.get('agent/pre-step')!({ agent }, () => decision), decision)
      const binding = host.resolveModelBinding(session.id)
      assert.ok(binding)
      assert.deepEqual(binding, f.binding)
      assert.equal(host.canRecord(binding), true)
      assert.equal((await host.sessionRecordingStatus(binding)).sessionRecording, 'enabled')
      assert.deepEqual(await collect(listeners.get('llm/stream')!(
        { ...request, sessionId: session.id }, () => chunks(response()))), response())
      assert.ok(host.recorder.status(session.id).trace, JSON.stringify(host.recorder.status(session.id)))
      await host.shutdown()
      assert.equal(listeners.size, 0, 'shutdown disposes every observer')
      const rows = await f.reader.list(f.binding)
      assert.equal(rows.length, generation + 1)
      assert.ok(rows.every(row => row.state === 'completed' && row.event_count > 0))
      assert.equal(asked, askOnStart ? 1 : 0, 'saved choice survives host reload')
      if (generation === 0) host = makeHost()
    }
  } finally { await host.shutdown(); await f.dispose() }
}

for (const profile of ['dsh-cli', 'dsh-tui']) {
  for (const askOnStart of [false, true]) {
    test(`${profile} records and reloads with restricted root (askOnStart=${askOnStart})`, async () => {
      await verifyRecordingScope(profile, true, askOnStart)
    })
  }
}

for (const profile of ['dsh-web', undefined]) {
  test(`${profile ?? 'unspecified profile'} keeps recording observers on the root`, async () => {
    await verifyRecordingScope(profile, false, false)
  })
}
