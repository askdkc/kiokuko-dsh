import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshCapabilityCatalog } from '../../../src/dsh/capability-catalog.js'
import { DshIntakeGate, type DshPreStepEvent } from '../../../src/dsh/intake-gate.js'
import { nativeExecutionOwnership } from '../../../src/dsh/native-execution-ownership.js'
import { reconcileFailedPreparation } from '../../../src/dsh/failed-preparation.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { createDshIntakeAnswerer } from '../../../src/dsh/user-interaction.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'
import { layaConfig, layaReply, layaV1Reply, serveLaya } from '../helpers/laya.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentReferenceIds, unresolvedRequestIntent } from '../../../src/dsh/decisions/request-intent.js'

for (const kind of ['typesafe', 'nimble', 'laya-v1', 'laya-strict'] as const) test(`full gate ${kind}: a simple factual question enters without asking for its purpose`, { skip: process.platform === 'win32' && kind.startsWith('laya') }, async t => {
  const { TypedDecisionsConfig } = await import('../../../src/dsh/decisions/config.js')
  const { DecisionService, databaseDecisionStore } = await import('../../../src/dsh/decisions/service.js')
  const { TypeSafeDecisionProvider, NimbleDecisionProvider } = await import('../../../src/dsh/decisions/providers.js')
  const { LayaCoreMLDecisionProvider } = await import('../../../src/dsh/decisions/laya-coreml.js')
  const { LayaV1DecisionProvider } = await import('../../../src/dsh/decisions/laya-v1.js')
  const f = await makeFixture()
  const runtime = new DshRuntime({ repositoryRoot: f.root, databasePath: f.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'), embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const task = '富士山って日本で一番高い山？', requests: any[] = [], asked: string[] = []
  const choose = (id: string, choices: string[]) => id === 'task-type' ? 'chat' : choices.includes('none') ? 'none' : 'no'
  const socket = kind.startsWith('laya') ? await serveLaya(t, request => {
    if (request.questions?.['task-type']) requests.push(request)
    return kind === 'laya-v1' ? layaV1Reply(request, choose) : layaReply(request, choose)
  }) : undefined
  const config = kind === 'laya-strict' ? layaConfig(socket!.path) : TypedDecisionsConfig.parse(kind === 'laya-v1'
    ? { provider: 'laya-coreml', 'laya-coreml': { socketPath: socket!.path, protocol: 'v1', model: 'laya-rl-agent' } }
    : { provider: kind, nimble: { endpoint: 'http://localhost:8000/v1/systemone', model: 'fixture' } })
  const request: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options!.body))
    if (input.questions['task-type']) requests.push(input)
    return Response.json({ model: input.model, answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]: [string, any]) => {
      if (id === 'coding' && q.type === 'noul') return [id, { type: 'noul', noul: 0.1 }]
      const choice = choose(id, Object.keys(q.criteria))
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, c === choice ? 1 : 0])), confidence: 1 }]
    })) })
  }
  const provider = kind === 'laya-v1' ? new LayaV1DecisionProvider(config['laya-coreml']!) : kind === 'laya-strict' ? new LayaCoreMLDecisionProvider(config['laya-coreml'])
    : kind === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'host-key', request) : new NimbleDecisionProvider(config.nimble, async () => undefined, request)
  const service = new DecisionService(config, () => provider, databaseDecisionStore(runtime))
  const answerer = createDshIntakeAnswerer({ async ask(request) { asked.push(request.questions[0].id); return { answers: [{ id: request.questions[0].id, selected: ['質問、相談、会話'] }] } } })
  const gate = new DshIntakeGate(runtime, answerer, undefined, false, undefined, service)
  try {
    const input = { ...event(f.root, await catalog()), task }
    let nativeCalls = 0
    const result = await gate.preStep(input, async () => { nativeCalls++; return { kind: 'enter', messages: ['native'] } })
    assert.deepEqual(asked, [], 'purpose must be resolved before asking the user')
    assert.equal(result.kind, 'enter'); assert.equal(nativeCalls, 1)
    const prepared = await gate.prepare(input)
    assert.equal(prepared.admitted, true); assert.equal(prepared.prepared.intake.profile.taskType, 'chat')
    assert.equal(prepared.prepared.intake.status, 'ready'); assert.equal(prepared.prepared.intake.question, null)
    assert.equal(requests.length, 1, 'replayed pre-step must reuse classification')
    const sent = requests[0]
    assert.equal(kind.startsWith('laya') ? sent.state : sent.state.task, task)
    assert.match(sent.questions['task-type'].criteria.chat, /question/i)
  } finally { await runtime.close(); await rm(f.root, { recursive: true, force: true }) }
})

async function makeFixture(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-akinator-'))
  await mkdir(join(root, 'src'))
  execFileSync('git', ['init', '-q', root])
  const databasePath = join(root, 'data.sqlite3')
  await initializeDatabase({ databasePath })
  const database = openConnection(databasePath)
  try {
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-dsh-akinator', workspace: 'workspace-dsh-akinator', displayName: 'dsh Akinator test',
      canonicalRoot: realpathSync(root), remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1,
    })
  } finally {
    database.close()
  }
  return { root, databasePath }
}

test('resolved native work defaults to its canonical workspace while preserving explicit targets and unresolved intent', async () => {
  const f = await makeFixture()
  const runtime = new DshRuntime({ repositoryRoot: f.root, databasePath: f.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const capabilities = await catalog()
  const task = 'READMEの説明漏れを修正してください。'
  const context = createRequestIntentContext({ task, workspaceDirectory: realpathSync(f.root),
    messageRefs: [{ id: 'user-request', digest: 'a'.repeat(64) }] })!
  const resolved = bindMainModelRequestIntent({ relation: 'new', action: 'change', changeScope: 'document', evidenceRefs: requestIntentReferenceIds(context) }, context)!
  try {
    for (const [index, scenario] of ['workspace', 'explicit', 'unresolved', 'unknown change scope', 'answer'].entries()) {
      const requestIntent = scenario === 'unresolved' ? unresolvedRequestIntent(context, 'unclear')
        : scenario === 'unknown change scope' ? { ...resolved, changeScope: 'unknown' as const }
          : scenario === 'answer' ? { ...resolved, action: 'answer' as const } : resolved
      const result = await new DshIntakeGate(runtime).prepare({ ...event(f.root, capabilities), sessionId: `workspace-target-${index}`, task,
        requestIntent, requestIntentContext: context,
        profileHints: { taskType: scenario === 'answer' ? 'chat' : 'writing', expected: 'READMEに機能が説明されている。',
          ...(scenario === 'explicit' ? { target: 'README.md' } : {}) } })
      assert.equal(result.prepared.intake.profile.target, scenario === 'workspace' ? realpathSync(f.root)
        : scenario === 'explicit' ? 'README.md' : null, scenario)
      assert.equal(result.admitted, !['unresolved', 'unknown change scope'].includes(scenario), scenario)
    }
  } finally { await runtime.close(); await rm(f.root, { recursive: true, force: true }) }
})

async function catalog() {
  const provider = createStandardSkillProvider()
  try {
    const result = await provider.list({})
    const candidates = 'complete' in result ? result.candidates : result
    return createDshCapabilityCatalog(candidates.map(({ name, description }) => ({ kind: 'skill' as const, name, description })))
  } finally {
    provider.dispose()
  }
}

function event(root: string, capabilities: Awaited<ReturnType<typeof catalog>>): DshPreStepEvent {
  return {
    agent: { id: 'agent-session' }, sessionId: 'session-real', turn: 1, step: 1, task: 'Please help with this task', cwd: root,
    capabilities, skillDiscoveryMode: 'off', signal: new AbortController().signal,
  }
}

test('pre-step asks Akinator purpose, target and success criteria instead of silently filling them', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const asked: string[] = []
  const answerer = createDshIntakeAnswerer({
    async ask(request) {
      const question = request.questions[0]!
      asked.push(question.id)
      const values: Record<string, string> = { taskType: '1', target: 'src/parser.ts', expected: 'Parser handles empty input' }
      return { answers: [{ id: question.id, selected: [values[question.id]!] }] }
    },
  })
  const gate = new DshIntakeGate(runtime, answerer)
  const capabilities = await catalog()
  let nextCalls = 0
  try {
    const decision = await gate.preStep(event(fixture.root, capabilities), async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [] }
    })
    assert.deepEqual(asked, ['taskType', 'target', 'expected'])
    assert.equal(nextCalls, 1)
    assert.equal(decision.kind, 'enter')
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pre-step accepts and canonicalizes a multiline user task through run intake', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const gate = new DshIntakeGate(runtime)
  const task = 'ABC\n\nEFG\r\n\tWHAT?'
  try {
    const result = await gate.prepare({
      ...event(fixture.root, capabilities),
      task,
      profileHints: { taskType: 'build', target: 'README.md', expected: task },
    })

    assert.equal(result.admitted, true)
    assert.equal(result.prepared.intake.profile.expected, 'ABC\n\nEFG\n\tWHAT?')
    assert.equal(result.prepared.intake.status, 'ready')
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pre-step admits a session rooted at an unregistered non-Git directory', async () => {
  const fixture = await makeFixture()
  const sessionRoot = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-session-directory-'))
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const gate = new DshIntakeGate(runtime)
  try {
    const result = await gate.prepare({
      ...event(sessionRoot, capabilities),
      task: 'こんにちは',
      profileHints: { taskType: 'chat' },
    })
    assert.equal(result.admitted, true)
    assert.equal(result.prepared.project.repositoryRoot, realpathSync(sessionRoot))
    assert.equal(result.prepared.project.source, 'local-path')
    assert.equal(result.prepared.executionContext.cwdIsRepositoryRoot, true)
    await assert.rejects(access(join(sessionRoot, '.kiokuko.json')))
  } finally {
    await runtime.close()
    await rm(sessionRoot, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cancelled intake releases only its never-admitted reservation and permits a fresh turn', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({ repositoryRoot: fixture.root, databasePath: fixture.databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const cancelled = new Error('the user cancelled ask_user_question')
  let asks = 0
  const gate = new DshIntakeGate(runtime, createDshIntakeAnswerer({ async ask() { asks++; throw cancelled } }))
  const input = event(fixture.root, await catalog())
  try {
    await assert.rejects(gate.prepare(input), error => error === cancelled)
    assert.equal(asks, 1)
    await runtime.withDatabase(db => {
      assert.equal(nativeExecutionOwnership(db, input.sessionId), 'unowned', 'a rejected optional intake must not block native edit')
      assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_execution_owners').get<{ n: number }>()?.n, 0)
      const rows = db.prepare('SELECT status FROM ledger_runs WHERE dsh_session_id=?').all<{ status: string }>(input.sessionId)
      assert.deepEqual(rows.map(row => row.status), ['cancelled'], 'retain the cancelled preparation for audit, not a completed task')
    })
    await assert.rejects(gate.prepare(input), 'same-turn retry must not reopen the cancelled question')
    assert.equal(asks, 1)
    const next = await gate.prepare({ ...input, turn: 2,
      profileHints: { taskType: 'build', target: 'src/parser.ts', expected: 'Parser handles empty input' } })
    assert.equal(next.admitted, true, 'new human turn must not conflict with the abandoned reservation')
  } finally { await runtime.close(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('legacy preparation recovery requires one exact failed native call and invalidates on a later revision', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({ repositoryRoot: fixture.root, databasePath: fixture.databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const input = event(fixture.root, await catalog())
  try {
    const prepared = await new DshIntakeGate(runtime).prepare(input)
    assert.equal(prepared.admitted, false)
    const began = { seq: 1, type: 'turn/start', data: { turn: input.turn } }
    const call = { seq: 2, type: 'tool/call', data: { turn: input.turn, callId: 'prepare', name: 'prepare_requested_work' } }
    const result = { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: { turn: input.turn,
      message: { role: 'tool', toolCallId: 'prepare', isError: true } } }
    const denied = [
      [began, call],
      [call, result],
      [began, call, { ...result, sourceEventSeqs: [1] }],
      [began, call, { ...result, data: { ...result.data, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } }],
      [began, call, { ...result, data: { ...result.data, turn: input.turn + 1 } }],
      [began, call, { ...result, data: { ...result.data, message: { ...result.data.message, isError: false } } }],
      [began, { ...call, data: { ...call.data, name: 'edit' } }, result],
      [began, call, result, { ...call, seq: 4, data: { ...call.data, callId: 'other-attempt' } }],
    ]
    await runtime.withDatabase(db => {
      for (const events of denied) {
        reconcileFailedPreparation(db, input.sessionId, () => events)
        assert.equal(nativeExecutionOwnership(db, input.sessionId), 'owned', JSON.stringify(events))
      }
      reconcileFailedPreparation(db, 'another-session', () => [began, call, result])
      assert.equal(nativeExecutionOwnership(db, input.sessionId), 'owned')
      reconcileFailedPreparation(db, input.sessionId, () => [began, call, result])
      assert.equal(nativeExecutionOwnership(db, input.sessionId), 'unowned')
      reconcileFailedPreparation(db, input.sessionId, () => { throw new Error('idempotent release must not reread history') })
      db.prepare('UPDATE ledger_runs SET task_revision=task_revision+1 WHERE run_id=?').run(prepared.prepared.run.runId)
      assert.equal(nativeExecutionOwnership(db, input.sessionId), 'owned', 'a stale release proof never authorizes a changed task')
    })
  } finally { await runtime.close(); await rm(fixture.root, { recursive: true, force: true }) }
})

for (const boundary of ['active', 'stop', 'unknown-effect', 'replacement-owner'] as const)
  test(`failed intake cleanup preserves ${boundary} authority`, async () => {
    const fixture = await makeFixture()
    const runtime = new DshRuntime({ repositoryRoot: fixture.root, databasePath: fixture.databasePath,
      migrationsDirectory: join(process.cwd(), 'migrations'),
      embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
    const input = event(fixture.root, await catalog())
    const gate = new DshIntakeGate(runtime, createDshIntakeAnswerer({ async ask() {
      await runtime.withDatabase(db => {
        const owner = db.prepare('SELECT run_id FROM dsh_execution_owners WHERE dsh_session_id=?').get<{ run_id: string }>(input.sessionId)!
        if (boundary === 'active') db.prepare("UPDATE ledger_runs SET status='active' WHERE run_id=?").run(owner.run_id)
        else if (boundary === 'stop') db.prepare("UPDATE ledger_runs SET task_pending_stop_json='{}' WHERE run_id=?").run(owner.run_id)
        else if (boundary === 'replacement-owner') db.prepare("UPDATE dsh_execution_owners SET start_id='replacement' WHERE run_id=?").run(owner.run_id)
        else db.prepare("INSERT INTO dsh_owned_operations VALUES('unknown',?,?, 'generation','digest','unknown','{}',?)").run(owner.run_id, input.sessionId, new Date().toISOString())
      })
      throw new Error('preparation interrupted')
    } }))
    try {
      await assert.rejects(gate.prepare(input), /preparation interrupted/)
      await runtime.withDatabase(db => {
        assert.equal(nativeExecutionOwnership(db, input.sessionId), 'owned')
        assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_execution_owners').get<{ n: number }>()?.n, 1)
        assert.equal(db.prepare("SELECT count(*) AS n FROM ledger_runs WHERE json_extract(metadata_json,'$.failedPreparation') IS NOT NULL").get<{ n: number }>()?.n, 0)
      })
    } finally { await runtime.close(); await rm(fixture.root, { recursive: true, force: true }) }
  })

test('concurrent preparation of one turn shares a single question and result', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  let askCalls = 0
  let questionShown!: () => void
  let answerQuestion!: (value: string) => void
  const shown = new Promise<void>((resolve) => { questionShown = resolve })
  const answer = new Promise<string>((resolve) => { answerQuestion = resolve })
  const answerer = createDshIntakeAnswerer({
    async ask(request) {
      askCalls += 1
      assert.equal(request.questions[0]?.id, 'taskType')
      questionShown()
      return { answers: [{ id: 'taskType', selected: [await answer] }] }
    },
  })
  const gate = new DshIntakeGate(runtime, answerer)
  const capabilities = await catalog()
  const firstEvent = { ...event(fixture.root, capabilities), profileHints: { target: 'src/parser.ts', expected: 'Parser handles empty input' } }
  try {
    const first = gate.prepare(firstEvent)
    await shown
    const replay = gate.prepare({ ...firstEvent, step: 2 })
    answerQuestion('build')
    const [firstResult, replayResult] = await Promise.all([first, replay])
    assert.equal(askCalls, 1)
    assert.equal(firstResult.admitted, true)
    assert.equal(replayResult.admitted, true)
    assert.equal(replayResult.prepared.run.runId, firstResult.prepared.run.runId)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pre-step passes through unresolved intake without an answerer and rejects changed catalogs at the tool boundary', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const gate = new DshIntakeGate(runtime)
  let nextCalls = 0
  try {
    const decision = await gate.preStep(event(fixture.root, capabilities), async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [] }
    })
    assert.deepEqual(decision, { kind: 'enter', messages: [] })
    assert.equal(nextCalls, 1)
    assert.throws(() => gate.assertTurnStoppingCatalog(capabilities, { ...capabilities, digest: 'f'.repeat(64) }), /changed/u)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('skipping task type enters ordinary chat without creating a separate run', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const asked: string[] = []
  const answerer = createDshIntakeAnswerer({
    async ask(request) {
      const question = request.questions[0]!
      asked.push(question.id)
      assert.ok(question.options?.some((option) => option.label === '質問、相談、会話'))
      return { answers: [{ id: question.id, selected: [] }] }
    },
  })
  const gate = new DshIntakeGate(runtime, answerer)
  const capabilities = await catalog()
  let nextCalls = 0
  try {
    const result = await gate.prepare({ ...event(fixture.root, capabilities), task: 'Let us chat about SvelteKit.' })
    assert.equal(result.admitted, true)
    assert.equal(result.prepared.intake.profile.taskType, 'chat')
    assert.equal(result.prepared.intake.profile.target, null)
    assert.equal(result.prepared.intake.profile.expected, null)
    assert.equal(result.prepared.intake.status, 'ready')
    assert.deepEqual(result.prepared.intake.missingFields, [])
    assert.equal(result.prepared.skillDiscovery.attempted, false)
    assert.deepEqual(result.prepared.skillDiscovery.requirements, [])
    assert.deepEqual(asked, ['taskType'])
    const decision = await gate.preStep({ ...event(fixture.root, capabilities), task: 'Let us chat about SvelteKit.' }, async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [] }
    })
    assert.equal(decision.kind, 'enter')
    assert.equal(nextCalls, 1)
    const database = openConnection(fixture.databasePath)
    try {
            assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_task_skill_discovery_attempts').get<{ count: number }>()?.count, 0)
    } finally {
      database.close()
    }
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cached preparation mismatch is fail-open in pre-step but strict at the preparation boundary', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const first = event(fixture.root, capabilities)
  const gate = new DshIntakeGate(runtime)
  try {
    assert.deepEqual(await gate.preStep(first, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
    assert.deepEqual(
      await gate.preStep({ ...first, nativeAgent: { id: 'replacement-agent' } }, async () => ({ kind: 'enter', messages: ['native'] })),
      { kind: 'enter', messages: ['native'] },
    )
    await assert.rejects(
      gate.prepare({ ...first, nativeAgent: { id: 'replacement-agent' } }),
    )
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('pre-step rejects invisible agent identities before preparation', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const first = event(fixture.root, capabilities)
  try {
    await assert.rejects(new DshIntakeGate(runtime).prepare({ ...first, agent: { id: 'agent\u200b' } }), /agent identity is invalid/u)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

for (const kind of ['typesafe', 'nimble'] as const) test(`full gate ${kind}: provisional classification and selected Skills reach actual context`, async () => {
  const { TypedDecisionsConfig } = await import('../../../src/dsh/decisions/config.js')
  const { DecisionService, databaseDecisionStore } = await import('../../../src/dsh/decisions/service.js')
  const { TypeSafeDecisionProvider, NimbleDecisionProvider } = await import('../../../src/dsh/decisions/providers.js')
  const { injectDshContext } = await import('../../../src/dsh/context-injection.js')
  const f = await makeFixture(), runtime = new DshRuntime({ repositoryRoot: f.root, databasePath: f.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'), embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  try {
    const base = await catalog(), capabilities = createDshCapabilityCatalog([...base.skills, { kind: 'skill', name: 'z-fixture-selection', description: 'Inspect relevant evidence' }, ...base.tools])
    const config = TypedDecisionsConfig.parse({ provider: kind, nimble: { endpoint: 'http://localhost:8000/v1/systemone', model: 'fixture' } })
    let calls = 0
    const request: typeof fetch = async (_url, options) => {
      calls++; const input = JSON.parse(String(options!.body))
      return Response.json({ model: input.model, answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]: [string, any]) => {
        if (id === 'coding' && q.type === 'noul') return [id, { type: 'noul', noul: 0.1 }]
        const choice = id === 'task-type' ? 'research' : q.instructions.includes('fixture-selection') ? 'yes' : 'no'
        return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, c === choice ? 1 : 0])), confidence: 1 }]
      })) })
    }
    const provider = kind === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'host-key', request) : new NimbleDecisionProvider(config.nimble, async () => undefined, request)
    const service = new DecisionService(config, () => provider, databaseDecisionStore(runtime))
    const gate = new DshIntakeGate(runtime, undefined, undefined, false, undefined, service)
    const input = { ...event(f.root, capabilities), task: 'この資料を調べてください', profileHints: { target: 'README.md', expected: 'Report the relevant findings' } }
    const result = await gate.prepare(input)
    assert.equal(result.admitted, true); assert.equal(result.prepared.intake.profile.taskType, 'research')
    const messages = await injectDshContext({ prepared: result.prepared, task: input.task, routeSkillNames: ['kiokuko-single-purpose-functions'] })
    assert.ok(messages.some(m => m.name === 'z-fixture-selection' && m.content.includes('native Skill tool')))
    assert.ok(messages.some(m => m.name === 'kiokuko-single-purpose-functions'))
    assert.equal(calls, 2); await gate.prepare(input); assert.equal(calls, 2)
  } finally { await runtime.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('configured profile-memory mode reaches run creation instead of being forced off', async () => {
  const f = await makeFixture()
  const runtime = new DshRuntime({ repositoryRoot: f.root, databasePath: f.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'), embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const capabilities = await catalog()
  try {
    for (const [mode, expected] of [['off', 0], ['suggest', 1]] as const) {
      const gate = new DshIntakeGate(runtime, undefined, undefined, false, AkinatorMemoryConfig.parse({ mode, maxElapsedMs: 1000 }))
      const result = await gate.prepare({ ...event(f.root, capabilities), sessionId: `session-memory-${mode}` })
      const stored = await runtime.withDatabase(database => database
        .prepare('SELECT count(*) AS n FROM akinator_memory_resolutions WHERE run_id = ?')
        .get<{ n: number }>(result.prepared.run.runId))
      assert.equal(stored?.n, expected, mode === 'suggest' ? 'configured mode must reach run creation' : 'off must stay off')
    }
  } finally { await runtime.close(); await rm(f.root, { recursive: true, force: true }) }
})
