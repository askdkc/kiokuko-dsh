import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { initializeDatabase } from '../../../src/commands/init.js'
import { openConnection } from '../../../src/db/connection.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'
import { DshSessionBridge } from '../../../src/dsh/session-bridge.js'

test('resume replay is idempotent in the real Kiokuko ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-bridge-resume-'))
  await mkdir(join(root, 'src'))
  const databasePath = join(root, 'data.sqlite3')
  await initializeDatabase({ databasePath })
  const database = openConnection(databasePath)
  try {
    registerRepositoryAndLocation(database, {
      repositoryId: 'repo-dsh-bridge', workspace: 'workspace-dsh-bridge', displayName: 'dsh bridge test',
      canonicalRoot: realpathSync(root), remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1,
    })
    new LedgerStore(database).createRun({
      runId: 'run-dsh-bridge', workspace: 'workspace-dsh-bridge', protocolVersion: '1', client: { kind: 'dsh' },
      captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'bridge', query: 'bridge', profileHints: { taskType: null, target: null, expected: null, constraints: null } },
    })
  } finally {
    database.close()
  }
  const runtime = new DshRuntime({
    repositoryRoot: root, databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
  })
  const bridge = new DshSessionBridge({ runtime })
  bridge.bindSession('resume-session', 'run-dsh-bridge')
  bridge.observe({ sessionId: 'resume-session', runId: 'run-dsh-bridge', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } })
  await bridge.flush()
  bridge.observe({ sessionId: 'resume-session', runId: 'run-dsh-bridge', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } })
  await bridge.flush()
  const verified = openConnection(databasePath)
  try {
    const rows = new LedgerStore(verified).readEvents('run-dsh-bridge')
    assert.equal(rows.length, 1)
    assert.match(rows[0]?.source_event_id ?? '', /^dsh:resume-session:[^:]+:0$/u)
    assert.equal(new LedgerStore(verified).verifyChain('run-dsh-bridge'), true)
  } finally {
    verified.close()
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})
