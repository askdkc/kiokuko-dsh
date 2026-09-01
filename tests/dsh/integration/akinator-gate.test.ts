import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeDatabase } from '../../../src/commands/init.js'
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
    agent: { id: 'agent-session' }, turn: 1, step: 1, task: 'Please help with this task', cwd: root,
    capabilities, skillDiscoveryMode: 'off', signal: new AbortController().signal,
  }
}

test('pre-step asks exact Akinator questions and never enters next while unresolved', async () => {
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
      const values: Record<string, string> = { taskType: 'build', target: 'src/index.ts', expected: 'focused tests pass' }
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
