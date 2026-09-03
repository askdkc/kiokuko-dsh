import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { initializeDatabase } from '../../../src/commands/init.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { DSH_MODEL_FACING_OPERATIONS } from '../../../src/dsh/tools.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/setup/standard-skills.js'

async function fixture(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-native-adapter-'))
  await mkdir(join(root, 'src'))
  execFileSync('git', ['init', '-q', root])
  const databasePath = join(root, 'data.sqlite3')
  await initializeDatabase({ databasePath })
  const database = openConnection(databasePath)
  try {
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-native-adapter', workspace: 'workspace-native-adapter', displayName: 'native adapter',
      canonicalRoot: realpathSync(root), remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1,
    })
  } finally {
    database.close()
  }
  return { root, databasePath }
}

test('native adapter mounts model tools and admits a real Akinator turn', async () => {
  const f = await fixture()
  const registered: any[] = []
  const sections = new Map<string, string>()
  const skillSnapshotOptions: unknown[] = []
  const toolSchemaScopes: unknown[] = []
  const questionAgents: unknown[] = []
  const questionIds: string[] = []
  let skipTaskType = false
  let soulModelInvocable = true
  const fallbackSession = { id: 'native-fallback', header: { cwd: f.root } }
  const root = new Context()
  const services = {
    skills: {
      registerProvider(create: (control: { signal: AbortSignal }) => unknown) { create({ signal: new AbortController().signal }); return () => undefined },
      async snapshot(options: unknown) {
        skillSnapshotOptions.push(options)
        return {
          skills: STANDARD_SKILL_MANIFESTS.map(({ name }) => ({
            name,
            ...(name === 'kiokuko-soul' && !soulModelInvocable ? { invocation: { modelInvocable: false } } : {}),
          })),
          complete: true,
        }
      },
    },

    systemPrompt: { getSectionOrder: () => 0, section(input: { name: string; text: string }) { sections.set(input.name, input.text); return () => sections.delete(input.name) } },
    tools: {
      register(definition: any) { registered.push(definition); return () => undefined },
      guard() { return () => undefined },
      schemas(scope: unknown) {
        toolSchemaScopes.push(scope)
        return DSH_MODEL_FACING_OPERATIONS.map((name, index) => ({
          name,
          ...(index === 0 ? { description: `Native tool summary.\n\n${'Detailed behavior. '.repeat(150)}` } : {}),
        }))
      },
    },
    commands: { register() { return () => undefined } },
    userQuestions: { async ask(request: { questions: readonly [{ id: string }]; agent?: object }) {
      if (request.agent === undefined) throw new Error('no user-questions answerer accepted the request')
      questionAgents.push(request.agent)
      const id = request.questions[0]!.id
      questionIds.push(id)
      if (id === 'taskType' && skipTaskType) return { answers: [{ id, selected: [] }] }
      const values: Record<string, string> = { taskType: 'build', target: 'src/index.ts', expected: 'tests pass' }
      return { answers: [{ id, selected: [values[id] ?? 'approve'] }] }
    } },
    sessions: { get(id?: string) { return id === fallbackSession.id ? fallbackSession : { id: 'native-agent', header: { cwd: f.root } } } },
    agents: { get() { return { id: 'native-agent', inject() {} } } },
  }
  const hostFiber = root.plugin({ name: 'native-test-services', apply(ctx) {
    const disposers = Object.entries(services).map(([name, service]) => ctx.provide(name, service))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  } })
  await hostFiber
  const adapter = createDshHostAdapter(root, { repositoryRoot: f.root, databasePath: f.databasePath, migrationsDirectory: join(process.cwd(), 'migrations') })
  const disposeComposition = await mountDshComposition(root, adapter.host)
  try {
    assert.equal(registered.length, 7)
    const event = await adapter.host.mapPreStep!({
      agent: { id: 'native-agent', session: { id: 'native-session', header: { cwd: f.root } } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Implement the requested build change.' }] }],
      turn: 1, step: 1, signal: new AbortController().signal,
    })
    assert.equal((skillSnapshotOptions[0] as any).scope, event.nativeAgent)
    assert.equal((skillSnapshotOptions[0] as any).cwd, f.root)
    assert.equal((skillSnapshotOptions[0] as any).signal, event.signal)
    assert.equal(toolSchemaScopes[0], event.nativeAgent)
    let downstreamCalls = 0
    await assert.rejects(adapter.host.intakeGate!.preStep(event, async () => {
      downstreamCalls += 1
      throw new Error('downstream pre-step failed')
    }), /downstream pre-step failed/u)
    const decision = await adapter.host.intakeGate!.preStep(event, async () => {
      downstreamCalls += 1
      return { kind: 'enter', messages: [] }
    })
    assert.deepEqual(decision.kind, 'enter')
    assert.equal(downstreamCalls, 2)
    assert.ok(questionAgents.length > 0)
    assert.equal(questionAgents.every((agent) => agent === event.nativeAgent), true)
    assert.ok(decision.messages.length > 0)
    assert.match(decision.messages.map((message) => JSON.stringify(message)).join('\n'), /kiokuko-soul/u)
    assert.match(decision.messages.map((message) => JSON.stringify(message)).join('\n'), /Implement the requested build change/u)
    assert.equal(decision.messages.every((message: any) => typeof message.id === 'string' && message.id.length > 0), true)
    assert.equal(decision.messages.every((message: any) => message.role === 'user'), true)
    const toolHost = adapter.host.toolHost!
    assert.ok(event.nativeSession)
    const nativeSession = event.nativeSession
    assert.doesNotThrow(() => toolHost.bind({
      callId: 'bound-call', name: 'enno_plan_submit', arguments: {},
      agent: { dshSessionId: 'native-session', nativeSession }, signal: event.signal,
    }))
    assert.throws(() => toolHost.bind({
      callId: 'stale-session-call', name: 'enno_plan_submit', arguments: {},
      agent: { dshSessionId: 'native-session', nativeSession: { id: 'native-session' } }, signal: event.signal,
    }), /native session identity is stale/u)
    const staleStops: string[] = []
    const staleStop = await adapter.host.ennoController!.handle({
      agent: {
        id: 'native-agent', sessionId: 'native-session', nativeSession: { id: 'native-session' },
        steer: () => staleStops.push('steer'), cancel: (reason) => staleStops.push(reason),
      },
      turn: 1,
      signal: event.signal,
    })
    assert.deepEqual(staleStop, { kind: 'abort', reason: 'state_unavailable' })
    assert.deepEqual(staleStops, ['kiokuko dsh Enno continuation stopped: state_unavailable'])
    const replay = await adapter.host.intakeGate!.preStep(event, async () => {
      downstreamCalls += 1
      return { kind: 'enter', messages: [] }
    })
    assert.deepEqual(replay.kind, 'enter')
    assert.equal(downstreamCalls, 3)
    assert.deepEqual(replay.messages, [])
    const nextStepEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected continuation context.' }] }],
      turn: 1, step: 2, signal: event.signal,
    })
    assert.equal(nextStepEvent.task, event.task)
    const nextStep = await adapter.host.intakeGate!.preStep(nextStepEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.deepEqual(nextStep.kind, 'enter')
    assert.deepEqual(nextStep.messages, [])
    adapter.host.ponytailModes!.end('dsh:native-agent:native-session:1')
    const fallbackAgent = { id: 'fallback-agent', sessionId: fallbackSession.id }
    const fallbackEvent = await adapter.host.mapPreStep!({
      agent: fallbackAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fallback task.' }] }],
      turn: 1, step: 1, signal: event.signal,
    })
    assert.equal(fallbackEvent.nativeSession, fallbackSession)
    const fallbackDecision = await adapter.host.intakeGate!.preStep(fallbackEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(fallbackDecision.kind, 'enter')
    const fallbackNextEvent = await adapter.host.mapPreStep!({
      agent: fallbackAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected fallback context.' }] }],
      turn: 1, step: 2, signal: event.signal,
    })
    assert.equal(fallbackNextEvent.task, fallbackEvent.task)
    assert.deepEqual(await adapter.host.intakeGate!.preStep(fallbackNextEvent, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
    adapter.host.ponytailModes!.end('dsh:fallback-agent:native-fallback:1')
    const beforeChat = openConnection(f.databasePath)
    const ennoContractsBeforeChat = beforeChat.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()!.count
    beforeChat.close()
    skipTaskType = true
    const chatEffects: string[] = []
    const chatSession = { id: 'chat-session', header: { cwd: f.root } }
    const chatAgent = {
      id: 'chat-agent', session: chatSession,
      steer: () => chatEffects.push('steer'),
      cancel: (reason: unknown) => chatEffects.push(String(reason)),
    }
    const questionsBeforeChat = questionIds.length
    const chatEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Tell me something.' }] }],
      turn: 1, step: 1, signal: event.signal,
    })
    const chatDecision = await adapter.host.intakeGate!.preStep(chatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(chatDecision.kind, 'enter')
    assert.deepEqual(questionIds.slice(questionsBeforeChat), ['taskType'])
    assert.equal(questionAgents.at(-1), chatAgent)
    assert.deepEqual(await adapter.host.ennoController!.handle({
      agent: { ...chatAgent, sessionId: chatSession.id, nativeAgent: chatAgent, nativeSession: chatSession },
      turn: 1,
      signal: event.signal,
    }), { kind: 'close', nextAction: 'complete' })
    assert.deepEqual(chatEffects, [])
    const chatClose = await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent)
    assert.equal(chatClose?.status, 'completed')
    await adapter.host.lifecycle!.closeTurn(chatClose!)
    const afterChat = openConnection(f.databasePath)
    try {
      assert.equal(afterChat.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()!.count, ennoContractsBeforeChat)
      assert.equal(afterChat.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>((chatClose!).runId)?.status, 'completed')
    } finally {
      afterChat.close()
    }
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)
    soulModelInvocable = false
    await assert.rejects(Promise.resolve(adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected continuation context.' }] }],
      turn: 1, step: 3, signal: event.signal,
    })), /incomplete|mandatory|catalog/u)
  } finally {
    await disposeComposition()
    await adapter.dispose()
    await hostFiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})
