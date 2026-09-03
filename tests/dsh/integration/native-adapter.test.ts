import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { DSH_MODEL_FACING_OPERATIONS } from '../../../src/dsh/tools.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/dsh/standard-skills.js'

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

test('native adapter mounts model tools and admits a grounded turn without redundant questions', async () => {
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
    sessions: {
      get(id?: string) { return id === fallbackSession.id ? fallbackSession : { id: 'native-agent', header: { cwd: f.root } } },
      async flush() {},
    },
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
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Treat the attached document as a research request.' }],
          source: { kind: 'plugin', plugin: 'file-reference', form: 'instructions' },
        },
        { role: 'user', content: [{ type: 'text', text: '@PLAN.md を実装' }], source: { kind: 'user' } },
      ],
      turn: 1, step: 1, signal: new AbortController().signal,
    })
    assert.equal(event.task, '@PLAN.md を実装')
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
    assert.deepEqual(questionAgents, [])
    assert.ok(decision.messages.length > 0)
    assert.match(decision.messages.map((message) => JSON.stringify(message)).join('\n'), /kiokuko-soul/u)
    assert.match(decision.messages.map((message) => JSON.stringify(message)).join('\n'), /@PLAN\.md を実装/u)
    assert.equal(decision.messages.every((message: any) => typeof message.id === 'string' && message.id.length > 0), true)
    assert.equal(decision.messages.every((message: any) => message.role === 'user'), true)
    const toolHost = adapter.host.toolHost!
    assert.ok(event.nativeSession)
    const nativeSession = event.nativeSession
    const currentToolBinding = toolHost.bind({
      callId: 'bound-call', name: 'enno_plan_submit', arguments: {},
      agent: { dshSessionId: 'native-session', nativeSession }, signal: event.signal,
    })
    soulModelInvocable = false
    await assert.rejects(toolHost.execute('enno_plan_submit', {}, {
      ...currentToolBinding,
      idempotencyKey: 'catalog-change-call',
    }, event.signal), /mandatory bundled Skill|catalog changed/iu)
    soulModelInvocable = true
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
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:1'), true)
    const firstActionRun = adapter.host.resolveSessionRunId!(event.nativeSession as { id: string })!
    const actionQuestionCount = questionIds.length
    const secondActionEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: '続けてください' }], source: { kind: 'user' } }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal(secondActionEvent.profileHints?.taskType, 'build')
    assert.equal((await adapter.host.intakeGate!.preStep(secondActionEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    assert.equal(adapter.host.resolveSessionRunId!(event.nativeSession as { id: string }), firstActionRun)
    assert.equal(questionIds.length, actionQuestionCount)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:1'), false)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:2'), true)
    const thirdActionEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: '@README.md もレビュー' }], source: { kind: 'user' } }],
      turn: 3, step: 1, signal: event.signal,
    })
    assert.equal(thirdActionEvent.profileHints, undefined)
    assert.equal((await adapter.host.intakeGate!.preStep(thirdActionEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    assert.equal(adapter.host.resolveSessionRunId!(event.nativeSession as { id: string }), firstActionRun)
    assert.equal(questionIds.length, actionQuestionCount)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:2'), false)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:3'), true)
    ;(root as any).emit('agent/error', { agent: event.nativeAgent, error: new Error('recoverable model turn failure') })
    assert.equal(
      await adapter.host.resolveIdleClose!('native-agent', 'native-session', event.nativeSession, event.nativeAgent),
      undefined,
      'a model-turn error must not terminalize an unfinished Enno run before a user can recover it',
    )
    const emptyRecoveryEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [],
      turn: 4, step: 1, signal: event.signal,
    })
    assert.equal(emptyRecoveryEvent.task, thirdActionEvent.task)
    assert.equal((await adapter.host.intakeGate!.preStep(emptyRecoveryEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    assert.equal(adapter.host.resolveSessionRunId!(event.nativeSession as { id: string }), firstActionRun)
    assert.equal(questionIds.length, actionQuestionCount)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:3'), false)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:4'), true)
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
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:native-agent:native-session:4'), true)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:fallback-agent:native-fallback:1'), true)
    const fallbackRun = adapter.host.resolveSessionRunId!(fallbackSession)!
    const blocked = openConnection(f.databasePath)
    try {
      blocked.prepare("UPDATE enno_contracts SET status = 'blocked', phase = NULL, blocker = 'test blocker' WHERE run_id = ?").run(fallbackRun)
      blocked.prepare("UPDATE ledger_runs SET status = 'failed' WHERE run_id = ?").run(fallbackRun)
    } finally {
      blocked.close()
    }
    const blockedClose = await adapter.host.resolveIdleClose!('fallback-agent', fallbackSession.id, fallbackSession, fallbackAgent)
    assert.deepEqual(blockedClose, { runId: fallbackRun, status: 'failed' })
    await adapter.host.lifecycle!.closeTurn(blockedClose!)
    assert.equal(adapter.host.resolveSessionRunId!(fallbackSession), undefined)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:fallback-agent:native-fallback:1'), false)
    const questionsBeforeRecovery = questionIds.length
    const recoveredEvent = await adapter.host.mapPreStep!({
      agent: fallbackAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: '@README.md をレビュー' }], source: { kind: 'user' } }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal((await adapter.host.intakeGate!.preStep(recoveredEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    const recoveredRun = adapter.host.resolveSessionRunId!(fallbackSession)!
    assert.notEqual(recoveredRun, fallbackRun)
    assert.equal(questionIds.length, questionsBeforeRecovery)
    const recoveredClose = await adapter.host.resolveSessionClose!(fallbackSession.id, fallbackSession)
    assert.deepEqual(recoveredClose, { runId: recoveredRun, status: 'cancelled' })
    await adapter.host.lifecycle!.closeTurn(recoveredClose!)
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
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:chat-agent:chat-session:1'), true)
    assert.deepEqual(questionIds.slice(questionsBeforeChat), ['taskType'])
    assert.equal(questionAgents.at(-1), chatAgent)
    assert.deepEqual(await adapter.host.ennoController!.handle({
      agent: { ...chatAgent, sessionId: chatSession.id, nativeAgent: chatAgent, nativeSession: chatSession },
      turn: 1,
      signal: event.signal,
    }), { kind: 'close', nextAction: 'complete' })
    assert.deepEqual(chatEffects, [])
    const firstChatRun = adapter.host.resolveSessionRunId!(chatSession)!
    ;(root as any).emit('session/event', chatSession, { type: 'assistant/message', seq: 1, time: 1, data: { text: 'first answer' } })
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)
    const firstChatStep = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected first-turn context.' }] }],
      turn: 1, step: 2, signal: event.signal,
    })
    assert.equal(firstChatStep.task, chatEvent.task)
    assert.equal(firstChatStep.profileHints, undefined)
    assert.deepEqual(await adapter.host.intakeGate!.preStep(firstChatStep, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
    assert.equal(adapter.host.resolveSessionRunId!(chatSession), firstChatRun)

    const questionsAfterFirstChat = questionIds.length
    ;(root as any).emit('session/event', chatSession, { type: 'user/message', seq: 2, time: 2, data: { text: 'What do you think about that?' } })
    const secondChatEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What do you think about that?' }] }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal(secondChatEvent.profileHints?.taskType, 'chat')
    const secondChatDecision = await adapter.host.intakeGate!.preStep(secondChatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(secondChatDecision.kind, 'enter')
    assert.equal(questionIds.length, questionsAfterFirstChat)
    const secondChatRun = adapter.host.resolveSessionRunId!(chatSession)!
    assert.equal(secondChatRun, firstChatRun)
    assert.deepEqual(await adapter.host.ennoController!.handle({
      agent: { ...chatAgent, sessionId: chatSession.id, nativeAgent: chatAgent, nativeSession: chatSession },
      turn: 2,
      signal: event.signal,
    }), { kind: 'close', nextAction: 'complete' })
    const secondChatStep = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected continuation context.' }] }],
      turn: 2, step: 2, signal: event.signal,
    })
    assert.equal(secondChatStep.task, secondChatEvent.task)
    assert.deepEqual(await adapter.host.intakeGate!.preStep(secondChatStep, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
    assert.equal(adapter.host.resolveSessionRunId!(chatSession), firstChatRun)
    assert.equal(questionIds.length, questionsAfterFirstChat)
    ;(root as any).emit('session/event', chatSession, { type: 'assistant/message', seq: 3, time: 3, data: { text: 'second answer' } })
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)

    ;(root as any).emit('session/event', chatSession, { type: 'user/message', seq: 4, time: 4, data: { text: 'And one more follow-up.' } })
    const thirdChatEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'And one more follow-up.' }] }],
      turn: 3, step: 1, signal: event.signal,
    })
    assert.equal(thirdChatEvent.profileHints?.taskType, 'chat')
    const thirdChatDecision = await adapter.host.intakeGate!.preStep(thirdChatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(thirdChatDecision.kind, 'enter')
    assert.equal(questionIds.length, questionsAfterFirstChat)
    const thirdChatRun = adapter.host.resolveSessionRunId!(chatSession)!
    assert.equal(thirdChatRun, secondChatRun)
    assert.deepEqual(await adapter.host.ennoController!.handle({
      agent: { ...chatAgent, sessionId: chatSession.id, nativeAgent: chatAgent, nativeSession: chatSession },
      turn: 3,
      signal: event.signal,
    }), { kind: 'close', nextAction: 'complete' })
    ;(root as any).emit('session/event', chatSession, { type: 'assistant/message', seq: 5, time: 5, data: { text: 'third answer' } })
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)
    await adapter.host.bridge!.flush()
    assert.deepEqual(adapter.host.bridge!.observerErrors, [])

    const afterChat = openConnection(f.databasePath)
    try {
      assert.equal(afterChat.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()!.count, ennoContractsBeforeChat)
      assert.equal(afterChat.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(thirdChatRun)?.status, 'active')
      assert.equal(afterChat.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND source_type = 'dsh-session'").get<{ count: number }>(thirdChatRun)!.count, 5)
    } finally {
      afterChat.close()
    }
    const questionsBeforePivot = questionIds.length
    ;(root as any).emit('session/event', chatSession, { type: 'user/message', seq: 6, time: 6, data: { text: '@PLAN.md を実装' } })
    const pivotEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: '@PLAN.md を実装' }], source: { kind: 'user' } }],
      turn: 4, step: 1, signal: event.signal,
    })
    assert.equal(pivotEvent.profileHints, undefined)
    assert.equal((await adapter.host.intakeGate!.preStep(pivotEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    const pivotRun = adapter.host.resolveSessionRunId!(chatSession)!
    assert.notEqual(pivotRun, thirdChatRun)
    assert.equal(questionIds.length, questionsBeforePivot)
    const afterPivot = openConnection(f.databasePath)
    try {
      assert.equal(afterPivot.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(thirdChatRun)?.status, 'completed')
      assert.equal(afterPivot.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(pivotRun)?.status, 'active')
    } finally {
      afterPivot.close()
    }
    const pivotClose = await adapter.host.resolveSessionClose!(chatSession.id, chatSession)
    assert.deepEqual(pivotClose, { runId: pivotRun, status: 'cancelled' })
    await adapter.host.lifecycle!.closeTurn(pivotClose!)
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)
    soulModelInvocable = false
    await assert.rejects(Promise.resolve(adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Injected continuation context.' }] }],
      turn: 1, step: 3, signal: event.signal,
    })), /incomplete|mandatory|catalog/u)

    soulModelInvocable = true
    const writingEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'gimme commit message.' }], source: { kind: 'user' } }],
      turn: 5, step: 1, signal: event.signal,
    })
    assert.equal((await adapter.host.intakeGate!.preStep(writingEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    const writingRun = adapter.host.resolveSessionRunId!(event.nativeSession as { id: string })!
    assert.notEqual(writingRun, firstActionRun)
    const afterWritingPivot = openConnection(f.databasePath)
    try {
      assert.equal(afterWritingPivot.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(firstActionRun)?.status, 'cancelled')
      assert.equal(afterWritingPivot.prepare('SELECT COUNT(*) AS count FROM enno_contracts WHERE run_id = ?').get<{ count: number }>(writingRun)?.count, 0)
    } finally {
      afterWritingPivot.close()
    }
    const writingClose = await adapter.host.resolveIdleClose!('native-agent', 'native-session', event.nativeSession, event.nativeAgent)
    assert.deepEqual(writingClose, { runId: writingRun, status: 'completed' })
    await adapter.host.lifecycle!.closeTurn(writingClose!)

    const coldSession = { id: 'cold-pivot-session', header: { cwd: f.root } }
    const seeded = openConnection(f.databasePath)
    let coldRun = ''
    try {
      const prepared = await prepareAgentTask(seeded, {
        requestId: 'cold-pivot-request',
        task: 'Fix the cold-resume defect',
        cwd: f.root,
        profileHints: { taskType: 'debug', target: 'src/index.ts', expected: 'tests pass', constraints: null },
        capabilities: STANDARD_SKILL_MANIFESTS.map(({ name }) => ({ kind: 'skill' as const, name })),
        dshSessionId: coldSession.id,
        skillDiscoveryMode: 'off',
      })
      coldRun = prepared.run.runId
    } finally {
      seeded.close()
    }
    const coldAgent = { id: 'cold-pivot-agent', session: coldSession }
    const coldWritingEvent = await adapter.host.mapPreStep!({
      agent: coldAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'gimme commit message.' }], source: { kind: 'user' } }],
      turn: 1, step: 1, signal: event.signal,
    })
    assert.equal((await adapter.host.intakeGate!.preStep(coldWritingEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    const coldWritingRun = adapter.host.resolveSessionRunId!(coldSession)!
    assert.notEqual(coldWritingRun, coldRun)
    const afterColdPivot = openConnection(f.databasePath)
    try {
      assert.equal(afterColdPivot.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(coldRun)?.status, 'cancelled')
      assert.equal(afterColdPivot.prepare('SELECT COUNT(*) AS count FROM enno_contracts WHERE run_id = ?').get<{ count: number }>(coldWritingRun)?.count, 0)
    } finally {
      afterColdPivot.close()
    }
  } finally {
    await disposeComposition()
    await adapter.dispose()
    await hostFiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})
