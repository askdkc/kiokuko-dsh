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
import { createDshIntakeAnswerer } from '../../../src/dsh/user-interaction.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'

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

test('pre-step uses grounded DSH context and asks only the unresolved task type', async () => {
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
      const values: Record<string, string> = { taskType: 'build' }
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
    assert.deepEqual(asked, ['taskType'])
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
      profileHints: { taskType: 'build' },
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
  const firstEvent = event(fixture.root, capabilities)
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

test('pre-step rejects unresolved intake without an answerer and rejects changed catalogs', async () => {
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
    assert.deepEqual(decision, { kind: 'reject' })
    assert.equal(nextCalls, 0)
    assert.throws(() => gate.assertTurnStoppingCatalog(capabilities, { ...capabilities, digest: 'f'.repeat(64) }), /changed/u)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('skipping task type enters ordinary chat without creating an Enno/Oduno contract', async () => {
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
      assert.ok(question.options?.some((option) => option.label === 'chat'))
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
    assert.equal(result.prepared.intake.profile.target, fixture.root)
    assert.equal(result.prepared.intake.profile.expected, 'Let us chat about SvelteKit.')
    assert.equal(result.prepared.intake.status, 'ready')
    assert.deepEqual(result.prepared.intake.missingFields, [])
    assert.equal(result.prepared.ennoOduno.applicable, false)
    assert.equal(result.prepared.ennoOduno.nextAction, 'complete')
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
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()?.count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_task_skill_discovery_attempts').get<{ count: number }>()?.count, 0)
    } finally {
      database.close()
    }
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cached preparation rejects a different native agent or session object', async () => {
  const fixture = await makeFixture()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root, databasePath: fixture.databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const capabilities = await catalog()
  const first = event(fixture.root, capabilities)
  const gate = new DshIntakeGate(runtime)
  try {
    assert.deepEqual(await gate.preStep(first, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
    await assert.rejects(
      gate.preStep({ ...first, nativeAgent: { id: 'replacement-agent' } }, async () => ({ kind: 'enter', messages: [] })),
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
