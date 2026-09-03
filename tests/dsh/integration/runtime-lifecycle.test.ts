import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { mountDshRuntime } from '../../../src/dsh/index.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'

async function makeRegisteredDatabase(): Promise<{
  root: string
  databasePath: string
  migrationsDirectory: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-runtime-root-'))
  await mkdir(join(root, 'src'))
  const databasePath = join(root, 'data.sqlite3')
  const database = openConnection(databasePath)
  try {
    const migrationsDirectory = join(process.cwd(), 'migrations')
    migrateDatabase(database, migrationsDirectory)
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-dsh-runtime',
      workspace: 'workspace-dsh-runtime',
      displayName: 'dsh runtime test',
      canonicalRoot: realpathSync(root),
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    })
    return { root, databasePath, migrationsDirectory }
  } finally {
    database.close()
  }
}

test('runtime supports two agent turns and drains queued writes before closing the database', async () => {
  const fixture = await makeRegisteredDatabase()
  const events: string[] = []
  let releaseWrite!: () => void
  const writeReady = new Promise<void>((resolve) => { releaseWrite = resolve })
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root,
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  try {
    const first = await runtime.openAgent({ dshSessionId: 'session-a', turn: 1 })
    const second = await runtime.openAgent({ dshSessionId: 'session-b', turn: 1 })
    assert.equal(first.workspace, 'workspace-dsh-runtime')
    assert.equal(second.repositoryId, 'repo-dsh-runtime')
    assert.equal(runtime.activeAgentCount, 2)
    const queued = runtime.enqueueWrite(async () => {
      events.push('write-start')
      await writeReady
      events.push('write-end')
    })
    const closing = runtime.close().then(() => events.push('closed'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ['write-start'])
    releaseWrite()
    await queued
    await closing
    assert.deepEqual(events, ['write-start', 'write-end', 'closed'])
    assert.equal(runtime.activeAgentCount, 0)
    await assert.rejects(runtime.start(), /runtime is closed/u)
  } finally {
    await runtime.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('runtime rejects an unregistered repository and cleans up initialization failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-unregistered-'))
  const databasePath = join(root, 'data.sqlite3')
  const database = openConnection(databasePath)
  try {
    migrateDatabase(database, join(process.cwd(), 'migrations'))
  } finally {
    database.close()
  }
  const runtime = new DshRuntime({
    repositoryRoot: root,
    databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  await assert.rejects(runtime.start(), /not registered/u)
  await runtime.close()
  await assert.rejects(runtime.withDatabase(() => undefined), /runtime is closed/u)
  await rm(root, { recursive: true, force: true })

  const failed = new DshRuntime({
    repositoryRoot: process.cwd(),
    initializeDatabase: async () => { throw new Error('database unavailable') },
  })
  await assert.rejects(failed.start(), /database unavailable/u)
  await failed.close()
})

test('runtime auto-registers an ordinary directory without writing repository metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-directory-root-'))
  const databasePath = join(root, 'data.sqlite3')
  const runtime = new DshRuntime({
    repositoryRoot: root,
    databasePath,
    migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
    autoRegisterRepository: true,
  })
  try {
    await runtime.start()
    const agent = await runtime.openAgent({ dshSessionId: 'ordinary-directory', turn: 1 })
    assert.match(agent.repositoryId, /^repo_local_[0-9a-f]{12}$/u)
    assert.equal(agent.workspace.startsWith('project:'), true)
    await assert.rejects(access(join(root, '.kiokuko.json')))
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime HMR-style dispose is idempotent and does not retain a live handle', async () => {
  const fixture = await makeRegisteredDatabase()
  const runtime = new DshRuntime({
    repositoryRoot: fixture.root,
    databasePath: fixture.databasePath,
    migrationsDirectory: fixture.migrationsDirectory,
    embeddingConfig: {
      mode: 'off',
      provider: 'openai-compatible',
      allowRemote: false,
      vectorBackend: 'auto',
      timeoutMs: 1000,
      batchSize: 1,
    },
  })
  await runtime.start()
  const context = new Context()
  const fiber = context.plugin({
    apply(pluginContext: Context) {
      mountDshRuntime(pluginContext, runtime)
    },
  })
  await fiber
  await fiber.dispose()
  await Promise.all([runtime.close(), runtime.close()])
  await rm(fixture.root, { recursive: true, force: true })
  assert.equal(runtime.activeAgentCount, 0)
  await assert.rejects(runtime.start(), /runtime is closed/u)
})
