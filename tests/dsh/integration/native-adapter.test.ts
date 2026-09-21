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
import { mockModelRoutes, modelSelectionAnswer, openaiModels } from '../helpers/model-selection.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/dsh/standard-skills.js'
import { dshTurnBoundarySeq, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import { readExecutionSelection, writeExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { createLispCodingChoice, LISP_CODING_SERVICE } from '../../../src/dsh/lisp/coding-choice.js'
import { LISP_TOOLS } from '../../../src/dsh/lisp/contracts.js'
import { serveLaya } from '../helpers/laya.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'

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
  const guards: Array<(execution: any) => string | undefined> = []
  const sections = new Map<string, string>()
  const skillSnapshotOptions: unknown[] = []
  const toolSchemaScopes: unknown[] = []
  const questionAgents: unknown[] = []
  const questionIds: string[] = []
  const selectionQuestions: string[] = []
  let skipTaskType = false
  let executionCustom: string | undefined
  let soulModelInvocable = true
  const lispAgents = new Set<string>()
  const nativeSessions = new Map<string, ReturnType<typeof createNativeSession>>()
  const archivedSessions = new Map<string, {
    readonly id: string
    readonly header: { readonly cwd: string }
    readonly snapshotEvents: () => readonly DshLogEvent[]
  }>()
  function createNativeSession(id: string) {
    const events = Array.from({ length: 12 }, (_, index) => {
      const turn = index + 1
      const start = index * 4
      return [
        { type: 'turn/start', seq: start, time: start, data: { turn } },
        { type: 'user/message', seq: start + 1, time: start + 1, data: { id: `${id}-user-${turn}`, role: 'user', content: [{ type: 'text', text: `turn ${turn}` }], source: { kind: 'user' } }, surfaceOp: 'append' as const },
        { type: 'request/header', seq: start + 2, time: start + 2, data: { header: { config: { provider: 'test', model: 'test' } }, reason: index === 0 ? 'initial' : 'series' } },
        { type: 'turn/end', seq: start + 3, time: start + 3, data: { turn, reason: { kind: 'completed' } } },
      ]
    }).flat()
    const session = { id, header: { cwd: f.root }, snapshotEvents: () => events }
    nativeSessions.set(id, session)
    return session
  }
  const fallbackSession = createNativeSession('native-fallback')
  const primarySession = createNativeSession('native-session')
  function commitContext(session: ReturnType<typeof createNativeSession>, messages: readonly unknown[]) {
    const events = session.snapshotEvents() as DshLogEvent[]
    for (const data of messages) events.push({ type: 'user/message', seq: events.length, time: events.length, data, surfaceOp: 'append' })
  }
  const root = new Context()
  const services = {
    llm: { listProviders: () => [{ id: 'mock', name: 'Mock' }], listModels: async (provider: string) => openaiModels.map(id => ({ provider, id, name: id })) },
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
      guard(guard: (execution: any) => string | undefined) {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
      schemas(scope: unknown) {
        toolSchemaScopes.push(scope)
        if (lispAgents.has((scope as { id: string }).id)) return LISP_TOOLS.map(name => ({ name }))
        return DSH_MODEL_FACING_OPERATIONS.map((name, index) => ({
          name,
          ...(index === 0 ? { description: `Native tool summary.\n\n${'Detailed behavior. '.repeat(150)}` } : {}),
        }))
      },
    },
    commands: { register() { return () => undefined } },
    userQuestions: { async ask(request: { questions: readonly [{ id: string; options?: { label: string }[] }]; agent?: object }) {
      if (request.agent === undefined) throw new Error('no user-questions answerer accepted the request')
      if (request.questions[0].id === 'enno-execution-mode' && executionCustom !== undefined) {
        selectionQuestions.push(request.questions[0].id)
        return { answers: [{ id: request.questions[0].id, selected: [], custom: executionCustom }] }
      }
      const selection = modelSelectionAnswer(request.questions[0])
      if (selection) { selectionQuestions.push(request.questions[0].id); return { answers: [{ id: request.questions[0].id, selected: [selection] }] } }
      questionAgents.push(request.agent)
      const id = request.questions[0]!.id
      questionIds.push(id)
      if (id === 'taskType' && skipTaskType) return { answers: [{ id, selected: [] }] }
      const values: Record<string, string> = { taskType: 'build', target: 'src/index.ts', expected: 'tests pass' }
      return { answers: [{ id, selected: [values[id] ?? 'approve'] }] }
    } },
    sessions: {
      get(id?: string) { return id === undefined ? undefined : nativeSessions.get(id) },
      async flush() {},
    },
    agents: { get() { return { id: 'native-agent', inject() {} } } },
  }
  const hostFiber = root.plugin({ name: 'native-test-services', apply(ctx) {
    const disposers = Object.entries(services).map(([name, service]) => ctx.provide(name, service))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  } })
  await hostFiber
  const adapter = createDshHostAdapter(root, {
    modelRoutes: mockModelRoutes,
    repositoryRoot: f.root,
    databasePath: f.databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    sessionQuery: {
      async readSession(sessionId) {
        const source = nativeSessions.get(sessionId) ?? archivedSessions.get(sessionId)
        if (source === undefined) throw new Error(`unknown native session ${sessionId}`)
        return {
          session: { id: sessionId, createdAt: 1, cwd: f.root },
          inheritedEventCount: 0,
          events: source.snapshotEvents(),
        }
      },
    },
    llm: {
      async * stream() {
        yield { type: 'text-delta', index: 0, text: '{"schemaVersion":1,"memories":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const disposeComposition = await mountDshComposition(root, adapter.host)
  try {
    assert.equal(registered.length, 10)
    const archivedExportSession = createNativeSession('archived-export-session')
    nativeSessions.delete(archivedExportSession.id)
    archivedSessions.set(archivedExportSession.id, archivedExportSession)
    const archivedExport = await adapter.host.sessionExport!.open(archivedExportSession.id)
    assert.equal(archivedExport.status, 200)
    const archiveIterator = archivedExport.body[Symbol.asyncIterator]()
    const firstArchiveChunk = await archiveIterator.next()
    assert.equal(firstArchiveChunk.done, false)
    assert.equal(Buffer.from(firstArchiveChunk.value!).readUInt32LE(0), 0x04034b50)
    await archiveIterator.return?.()
    const oversizedArchive = {
      id: 'oversized-archived-export-session',
      header: { cwd: f.root },
      snapshotEvents: () => [{
        type: 'tool/result', seq: 0, time: 1,
        data: { text: 'x'.repeat(32 * 1024 * 1024) },
      }],
    }
    archivedSessions.set(oversizedArchive.id, oversizedArchive)
    await assert.rejects(adapter.host.sessionExport!.open(oversizedArchive.id), (error: any) => (
      error?.status === 413 && error?.code === 'legacy_log_too_large'
    ))

    const slashTask = 'Compare /api/v1 and /api/v2.\n\nDo not reinterpret /not-a-command.'
    const slashSession = createNativeSession('slash-session')
    const slashEvent = await adapter.host.mapPreStep!({
      agent: { id: 'slash-agent', session: slashSession },
      messages: [{ role: 'user', content: [{ type: 'text', text: slashTask }], source: { kind: 'user' } }],
      turn: 1, step: 1, signal: new AbortController().signal,
    })
    assert.equal(slashEvent.task, slashTask)

    const userTask = 'ABC\n\n@PLAN.md を実装'
    const event = await adapter.host.mapPreStep!({
      agent: { id: 'native-agent', session: primarySession },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Treat the attached document as a research request.' }],
          source: { kind: 'plugin', plugin: 'file-reference', form: 'instructions' },
        },
        { role: 'user', content: [{ type: 'text', text: userTask }], source: { kind: 'user' } },
      ],
      turn: 1, step: 1, signal: new AbortController().signal,
    })
    assert.equal(event.task, userTask)
    assert.equal((skillSnapshotOptions.at(-1) as any).scope, event.nativeAgent)
    assert.equal((skillSnapshotOptions.at(-1) as any).cwd, f.root)
    assert.equal((skillSnapshotOptions.at(-1) as any).signal, event.signal)
    assert.equal(toolSchemaScopes.at(-1), event.nativeAgent)
    let downstreamCalls = 0
    await assert.rejects(adapter.host.intakeGate!.preStep(event, async () => {
      downstreamCalls += 1
      const duringNativeFailure = openConnection(f.databasePath)
      try {
        assert.equal(duringNativeFailure.prepare(`
          SELECT COUNT(*) AS count FROM dsh_input_claim_backups
           WHERE dsh_session_id = ? AND native_turn = ?
        `).get<{ count: number }>('native-session', 1)?.count, 0)
      } finally {
        duringNativeFailure.close()
      }
      throw new Error('downstream pre-step failed')
    }), /downstream pre-step failed/u)
    const decision = await adapter.host.intakeGate!.preStep(event, async () => {
      downstreamCalls += 1
      const duringNativeEnter = openConnection(f.databasePath)
      try {
        assert.equal(duringNativeEnter.prepare(`
          SELECT COUNT(*) AS count FROM dsh_input_claim_backups
           WHERE dsh_session_id = ? AND native_turn = ?
        `).get<{ count: number }>('native-session', 1)?.count, 0)
      } finally {
        duringNativeEnter.close()
      }
      return { kind: 'enter', messages: [] }
    })
    assert.deepEqual(decision.kind, 'enter')
    assert.equal(downstreamCalls, 2)
    const afterNativeEnter = openConnection(f.databasePath)
    try {
      assert.equal(afterNativeEnter.prepare(`
        SELECT COUNT(*) AS count FROM dsh_input_claim_backups
         WHERE dsh_session_id = ? AND native_turn = ?
      `).get<{ count: number }>('native-session', 1)?.count, 1)
    } finally {
      afterNativeEnter.close()
    }
    assert.deepEqual(questionAgents, [])
    assert.deepEqual(selectionQuestions, ['enno-execution-mode', 'enno-model-source', 'enno-template', 'enno-model-review'])
    assert.ok(decision.messages.length > 0)
    // The host proposes messages; only the native loop's durable append proves delivery.
    commitContext(primarySession, decision.messages)
    assert.equal(decision.messages.some(message => JSON.stringify(message).includes('# Kiokuko SOUL router')), false)
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
    assert.throws(() => adapter.host.boundaryWorker!.kick('native-session', {
        id: 'native-agent', sessionId: 'native-session', nativeSession: { id: 'native-session' },
        steer: () => staleStops.push('steer'), cancel: (reason: string) => staleStops.push(reason),
      }), /identity changed/u)
    assert.deepEqual(staleStops, [])
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
    const idealTool = registered.find((definition) => definition.name === 'enno_ideal_submit')!
    const guardReason = (execution: any): string | undefined => (
      guards.map((guard) => guard(execution)).find((reason) => reason !== undefined)
    )
    let concludedInvalidIdeal = 0
    const invalidIdealExecution = {
      callId: 'invalid-ideal-turn-1',
      name: 'enno_ideal_submit',
      arguments: {},
      agent: event.nativeAgent,
      signal: event.signal,
      concludeTurn: () => { concludedInvalidIdeal += 1 },
    }
    assert.equal(guardReason(invalidIdealExecution), undefined)
    const invalidIdeal = await idealTool.execute({}, invalidIdealExecution)
    assert.equal(invalidIdeal.kind, 'retry')
    assert.match(invalidIdeal.reason.message, /ideal:missing_required_field/u)
    assert.equal(concludedInvalidIdeal, 1)
    assert.match(guardReason({ ...invalidIdealExecution, callId: 'sealed-ideal-turn-1' })!, /turn_sealed/u)
    const firstActionRun = adapter.host.resolveSessionRunId!(event.nativeSession as { id: string })!
    const actionQuestionCount = questionIds.length
    const secondActionEvent = await adapter.host.mapPreStep!({
      agent: event.nativeAgent as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: '続けてください' }], source: { kind: 'user' } }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal(secondActionEvent.profileHints?.taskType, 'build')
    const secondActionDecision = await adapter.host.intakeGate!.preStep(secondActionEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(secondActionDecision.kind, 'enter')
    assert.equal(secondActionDecision.messages.some(message => JSON.stringify(message).includes('DSH host completed the Akinator intake gate')), false,
      'a new turn must not resend unchanged context')
    assert.equal(guardReason({
      ...invalidIdealExecution,
      callId: 'retry-ideal-turn-2',
      agent: secondActionEvent.nativeAgent,
    }), undefined)
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
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fallback task.' }], source: { kind: 'user' } }],
      turn: 1, step: 1, signal: event.signal,
    })
    assert.equal(fallbackEvent.nativeSession, fallbackSession)
    const fallbackDecision = await adapter.host.intakeGate!.preStep(fallbackEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(fallbackDecision.kind, 'enter')
    commitContext(fallbackSession, fallbackDecision.messages)
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
    assert.deepEqual(blockedClose, { runId: fallbackRun, status: 'failed', terminalTurn: 1 })
    const questionsBeforeRecovery = questionIds.length
    const recoveredEvent = await adapter.host.mapPreStep!({
      agent: fallbackAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'OK. Done?' }], source: { kind: 'user' } }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal(recoveredEvent.profileHints?.taskType, 'build')
    assert.equal((await adapter.host.intakeGate!.preStep(recoveredEvent, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    const recoveredRun = adapter.host.resolveSessionRunId!(fallbackSession)!
    assert.notEqual(recoveredRun, fallbackRun)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:fallback-agent:native-fallback:1'), false)
    const recoveredNextStep = await adapter.host.mapPreStep!({
      agent: fallbackAgent, messages: [], turn: 2, step: 2, signal: event.signal,
    })
    assert.deepEqual(recoveredNextStep.profileHints, recoveredEvent.profileHints)
    assert.equal((await adapter.host.intakeGate!.prepare(recoveredNextStep)).prepared.run.runId, recoveredRun)
    assert.equal(questionIds.length, questionsBeforeRecovery)
    const recoveredClose = await adapter.host.resolveSessionClose!(fallbackSession.id, fallbackSession)
    assert.deepEqual(recoveredClose, { runId: recoveredRun, status: 'cancelled' })
    await adapter.host.lifecycle!.closeTurn(recoveredClose!)
    const discussionSession = createNativeSession('selection-discussion-session')
    const discussionAgent = { id: 'selection-discussion-agent', session: discussionSession }
    const questionsBeforeDiscussion = selectionQuestions.length
    executionCustom = 'ただのチャット\n実装は頼んでいない'
    const discussionEvent = await adapter.host.mapPreStep!({
      agent: discussionAgent, turn: 1, step: 1, signal: event.signal,
      messages: [{ id: 'discussion-original', role: 'user', content: [{ type: 'text', text: '実装の話をしているだけ' }], source: { kind: 'user' } }],
    })
    const discussionDecision = await adapter.host.intakeGate!.preStep(discussionEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(discussionDecision.kind, 'enter')
    assert.equal(selectionQuestions.length, questionsBeforeDiscussion + 1)
    assert.ok(JSON.stringify(discussionDecision.messages).includes('ただのチャット'))
    assert.ok(JSON.stringify(discussionDecision.messages).includes('実装は頼んでいない'))
    const discussionRun = adapter.host.resolveSessionRunId!(discussionSession)!
    const discussionDb = openConnection(f.databasePath)
    try {
      const value = JSON.parse(discussionDb.prepare('SELECT state_json FROM dsh_execution_selections WHERE run_id = ?').get<{ state_json: string }>(discussionRun)!.state_json)
      assert.equal(value.mode, 'pending')
      assert.equal(value.status, 'selecting')
      assert.equal(value.discussion.text, executionCustom)
      assert.equal(discussionDb.prepare('SELECT COUNT(*) AS count FROM enno_contracts WHERE run_id = ?').get<{ count: number }>(discussionRun)!.count, 0)
    } finally { discussionDb.close() }
    assert.ok(guards.some(guard => guard({ agent: discussionAgent, name: 'shell' })?.includes('実行方式は未確定')))
    commitContext(discussionSession, discussionDecision.messages)
    const discussionStep = await adapter.host.mapPreStep!({ agent: discussionAgent, turn: 1, step: 2, signal: event.signal, messages: [] })
    const repeatedDiscussion = await adapter.host.intakeGate!.preStep(discussionStep, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(repeatedDiscussion.kind, 'enter')
    assert.equal(JSON.stringify(repeatedDiscussion.messages).includes('ただのチャット'), false, 'native history already carries the answer')
    assert.equal(selectionQuestions.length, questionsBeforeDiscussion + 1)
    assert.equal(await adapter.host.resolveIdleClose!(discussionAgent.id, discussionSession.id, discussionSession, discussionAgent), undefined)
    const followupDiscussion = await adapter.host.mapPreStep!({ agent: discussionAgent, turn: 2, step: 1, signal: event.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'その話を続けよう' }], source: { kind: 'user' } }],
    })
    assert.equal(followupDiscussion.profileHints?.taskType, 'chat')
    assert.equal((await adapter.host.intakeGate!.preStep(followupDiscussion, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
    assert.equal(selectionQuestions.length, questionsBeforeDiscussion + 1)
    executionCustom = undefined
    const resumeDiscussion = await adapter.host.mapPreStep!({ agent: discussionAgent, turn: 3, step: 1, signal: event.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: '通常実行で続けて' }], source: { kind: 'user' } }],
    })
    const resumeDecision = await adapter.host.intakeGate!.preStep(resumeDiscussion, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(resumeDecision.kind, 'enter')
    assert.ok(JSON.stringify(resumeDecision.messages).includes('制限は解除'))
    assert.equal(adapter.host.resolveSessionRunId!(discussionSession), discussionRun)
    assert.equal(guards.some(guard => guard({ agent: discussionAgent, name: 'shell' })?.includes('実行方式は未確定')), false)
    const completedDiscussion = openConnection(f.databasePath)
    try {
      const value = JSON.parse(completedDiscussion.prepare('SELECT state_json FROM dsh_execution_selections WHERE run_id = ?').get<{ state_json: string }>(discussionRun)!.state_json)
      assert.equal(value.mode, 'normal')
      assert.equal(value.status, 'ready')
      assert.equal(value.discussion, undefined)
    } finally { completedDiscussion.close() }

    const coldDiscussionSession = createNativeSession('cold-discussion-session')
    const coldDiscussionDb = openConnection(f.databasePath)
    let coldDiscussionRun: string
    try {
      const prepared = await prepareAgentTask(coldDiscussionDb, { requestId: 'cold-discussion-request', task: 'Fix this', cwd: f.root,
        profileHints: { taskType: 'debug', target: 'src/index.ts', expected: 'Tests pass' },
        capabilities: event.capabilities.skills, dshSessionId: coldDiscussionSession.id, executionSelection: true, skillDiscoveryMode: 'off',
      })
      coldDiscussionRun = prepared.run.runId
      const saved = readExecutionSelection(coldDiscussionDb, coldDiscussionRun)!
      writeExecutionSelection(coldDiscussionDb, coldDiscussionRun, saved.revision, { ...saved.value,
        discussion: { questionId: 'enno-execution-mode', text: 'ただのチャット', turn: 1 },
      })
    } finally { coldDiscussionDb.close() }
    const selectionsBeforeColdDiscussion = selectionQuestions.length
    const coldDiscussionAgent = { id: 'cold-discussion-agent', session: coldDiscussionSession }
    const coldDiscussionEvent = await adapter.host.mapPreStep!({ agent: coldDiscussionAgent, turn: 2, step: 1, signal: event.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: '続けて' }], source: { kind: 'user' } }],
    })
    const coldDiscussionDecision = await adapter.host.intakeGate!.preStep(coldDiscussionEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(coldDiscussionDecision.kind, 'enter')
    assert.equal(adapter.host.resolveSessionRunId!(coldDiscussionSession), coldDiscussionRun)
    assert.equal(selectionQuestions.length, selectionsBeforeColdDiscussion)
    assert.ok(JSON.stringify(coldDiscussionDecision.messages).includes('ただのチャット'))

    const beforeChat = openConnection(f.databasePath)
    const ennoContractsBeforeChat = beforeChat.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()!.count
    beforeChat.close()
    skipTaskType = true
    const chatEffects: string[] = []
    const chatSession = createNativeSession('chat-session')
    const chatAgent = {
      id: 'chat-agent', session: chatSession,
      steer: () => chatEffects.push('steer'),
      cancel: (reason: unknown) => chatEffects.push(String(reason)),
    }
    const questionsBeforeChat = questionIds.length
    const chatEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Tell me something.' }], source: { kind: 'user' } }],
      turn: 1, step: 1, signal: event.signal,
    })
    const chatDecision = await adapter.host.intakeGate!.preStep(chatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(chatDecision.kind, 'enter')
    commitContext(chatSession, chatDecision.messages)
    assert.equal(adapter.host.ponytailModes!.isActive('dsh:chat-agent:chat-session:1'), true)
    assert.deepEqual(questionIds.slice(questionsBeforeChat), ['taskType'])
    assert.equal(questionAgents.at(-1), chatAgent)
    adapter.host.boundaryWorker!.kick(chatSession.id, chatAgent)
    await adapter.host.boundaryWorker!.whenIdle()
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
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What do you think about that?' }], source: { kind: 'user' } }],
      turn: 2, step: 1, signal: event.signal,
    })
    assert.equal(secondChatEvent.profileHints?.taskType, 'chat')
    const secondChatDecision = await adapter.host.intakeGate!.preStep(secondChatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(secondChatDecision.kind, 'enter')
    commitContext(chatSession, secondChatDecision.messages)
    assert.equal(questionIds.length, questionsAfterFirstChat)
    const secondChatRun = adapter.host.resolveSessionRunId!(chatSession)!
    assert.equal(secondChatRun, firstChatRun)
    adapter.host.boundaryWorker!.kick(chatSession.id, chatAgent)
    await adapter.host.boundaryWorker!.whenIdle()
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

    const technicalChat = 'まぁ、ローカルで実行環境が持てて、しかもevalで機能がいくらでもはやせるから、品質を落とさずにトークン量削減まで見えて来たよな'
    const selectionsBeforeTechnicalChat = selectionQuestions.length
    ;(root as any).emit('session/event', chatSession, { type: 'user/message', seq: 4, time: 4, data: { text: technicalChat } })
    const thirdChatEvent = await adapter.host.mapPreStep!({
      agent: chatAgent,
      messages: [{ role: 'user', content: [{ type: 'text', text: technicalChat }], source: { kind: 'user' } }],
      turn: 3, step: 1, signal: event.signal,
    })
    assert.equal(thirdChatEvent.profileHints?.taskType, 'chat')
    const thirdChatDecision = await adapter.host.intakeGate!.preStep(thirdChatEvent, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(thirdChatDecision.kind, 'enter')
    assert.equal(questionIds.length, questionsAfterFirstChat)
    const thirdChatRun = adapter.host.resolveSessionRunId!(chatSession)!
    assert.equal(selectionQuestions.length, selectionsBeforeTechnicalChat)
    assert.equal(thirdChatRun, secondChatRun)
    adapter.host.boundaryWorker!.kick(chatSession.id, chatAgent)
    await adapter.host.boundaryWorker!.whenIdle()
    ;(root as any).emit('session/event', chatSession, { type: 'assistant/message', seq: 5, time: 5, data: { text: 'third answer' } })
    assert.equal(await adapter.host.resolveIdleClose!('chat-agent', chatSession.id, chatSession, chatAgent), undefined)

    const afterChat = openConnection(f.databasePath)
    try {
      assert.equal(afterChat.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()!.count, ennoContractsBeforeChat)
      assert.equal(afterChat.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(thirdChatRun)?.status, 'active')
      assert.equal(afterChat.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND source_type = 'dsh-session'").get<{ count: number }>(thirdChatRun)!.count, 0)
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
    assert.deepEqual(writingClose, { runId: writingRun, status: 'completed', terminalTurn: 5 })
    await adapter.host.lifecycle!.closeTurn({
      ...writingClose!,
      sourceEndSeq: dshTurnBoundarySeq(primarySession, writingClose!.terminalTurn!, 'end'),
    })
    await adapter.host.memoryFinalizer!.whenIdle()
    const finalizedWriting = openConnection(f.databasePath)
    try {
      assert.equal(finalizedWriting.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id = ?').get<{ status: string }>(writingRun)?.status, 'completed')
    } finally {
      finalizedWriting.close()
    }

    const coldSession = createNativeSession('cold-pivot-session')
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
    let lispQuestions = 0
    let lispCustom: string | undefined
    const lispFiber = root.plugin({ name: 'lisp-coding-choice-fixture', apply(ctx) {
      return ctx.provide(LISP_CODING_SERVICE, createLispCodingChoice({
        questions: { ask: async request => {
          lispQuestions++
          return { answers: [{ id: request.questions[0].id, selected: lispCustom ? [] : ['Lispモードを使う（通常実行）'],
            ...(lispCustom ? { custom: lispCustom } : {}) }] }
        } },
        enabled: agent => lispAgents.has(agent.id), decided: async () => false, decline: async () => {},
        enable: async agent => { lispAgents.add(agent.id) },
      }))
    } })
    await lispFiber
    try {
      const lispSession = createNativeSession('lisp-coding-session')
      const lispAgent = { id: 'lisp-coding-agent', session: lispSession }
      const input = { agent: lispAgent, turn: 1, step: 1, signal: event.signal,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'src/index.ts を実装。tests pass' }], source: { kind: 'user' as const } }] }
      const selectionsBeforeLisp = selectionQuestions.length
      const mapped = await adapter.host.mapPreStep!(input)
      assert.equal(lispQuestions, 1)
      assert.deepEqual(mapped.capabilities.tools.map(tool => tool.name), [...LISP_TOOLS].sort())
      assert.equal((await adapter.host.intakeGate!.preStep(mapped, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
      assert.equal(selectionQuestions.length, selectionsBeforeLisp, 'Lisp choice already authorized normal execution')
      const db = openConnection(f.databasePath)
      try {
        const runId = adapter.host.resolveSessionRunId!(lispSession)!
        assert.equal(readExecutionSelection(db, runId)?.value.mode, 'normal')
        assert.equal(readExecutionSelection(db, runId)?.value.status, 'ready')
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enno_contracts WHERE run_id=?').get<{ count: number }>(runId)?.count, 0)
      } finally { db.close() }
      const repeated = await adapter.host.mapPreStep!({ ...input, step: 2 })
      assert.deepEqual(repeated.capabilities, mapped.capabilities)
      assert.equal((await adapter.host.intakeGate!.preStep(repeated, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
      assert.equal(lispQuestions, 1)

      lispCustom = 'ただのチャット。Lisp の用途を説明して'
      const discussionSession = createNativeSession('lisp-discussion-session')
      const discussionAgent = { id: 'lisp-discussion-agent', session: discussionSession }
      const discussion = await adapter.host.mapPreStep!({ ...input, agent: discussionAgent })
      assert.equal(discussion.profileHints?.taskType, 'chat')
      assert.equal(discussion.profileHints?.constraints, lispCustom)
      assert.equal(lispAgents.has(discussionAgent.id), false)
      const decision = await adapter.host.intakeGate!.preStep(discussion, async () => ({ kind: 'enter', messages: [] }))
      assert.equal(decision.kind, 'enter')
      assert.match(JSON.stringify(decision), /ただのチャット。Lisp の用途を説明して/u)
      assert.ok(guards.some(guard => guard({ agent: discussionAgent })?.includes('自由入力')))
      assert.equal(selectionQuestions.length, selectionsBeforeLisp)
    } finally { await lispFiber.dispose() }
  } finally {
    await disposeComposition.dispose()
    await adapter.dispose()
    await hostFiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})


test('full native adapter retains Laya configuration and reaches the direct socket provider', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(), ctx = new Context(), socket = await serveLaya(t)
  const adapter = createDshHostAdapter(ctx, { repositoryRoot: f.root, databasePath: f.databasePath,
    typedDecisions: TypedDecisionsConfig.parse({ 'laya-coreml': { socketPath: socket.path } }), memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, deepPlanning: { enabled: false }, orca: { enabled: false } })
  try {
    const decisions = adapter.host.decisions!
    assert.equal((decisions.status() as any).provider, 'typesafe'); assert.equal(socket.calls(), 0)
    await decisions.selectProvider('laya-coreml', new AbortController().signal)
    assert.equal((decisions.status() as any).provider, 'laya-coreml')
    assert.equal((await decisions.probe(new AbortController().signal)).state, 'ready'); assert.equal(socket.calls(), 3)
  } finally { await adapter.dispose(); await rm(f.root, { recursive: true, force: true }) }
})
