import assert from 'node:assert/strict'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { DshRunLifecycle, DshSessionBridge } from '../../../src/dsh/session-bridge.js'

test('turn/end is flushed to the ledger before terminal run close', async () => {
  const database = openConnection(':memory:')
  migrateDatabase(database, 'migrations')
  const ledger = new LedgerStore(database)
  ledger.createRun({
    runId: 'run-dsh-close', workspace: 'workspace-dsh-close', protocolVersion: '1', client: { kind: 'dsh' },
    captureProfile: 'minimal',
    coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'close', query: 'close', profileHints: { taskType: null, target: null, expected: null, constraints: null } },
  })
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(operation: DshDatabaseOperation<T>) => await operation(database, undefined as never) },
  })
  bridge.bindSession('session-dsh-close', 'run-dsh-close')
  bridge.observe({
    sessionId: 'session-dsh-close', runId: 'run-dsh-close',
    event: { type: 'turn/end', seq: 1, time: 0, data: { reason: 'completed' } },
  })
  const lifecycle = new DshRunLifecycle({
    bridge,
    closeRun: ({ runId, status }) => { ledger.updateRunStatus(runId, status) },
  })

  try {
    await lifecycle.closeTurn({ runId: 'run-dsh-close', status: 'completed' })
    assert.equal(bridge.pendingCount, 0)
    assert.equal(ledger.readEvents('run-dsh-close').length, 1)
    assert.equal(ledger.readEvents('run-dsh-close')[0]?.source_event_id, 'dsh:session-dsh-close:1')
    assert.equal(ledger.readRun('run-dsh-close')?.status, 'completed')
    assert.notEqual(ledger.readRun('run-dsh-close')?.endedAt, null)
  } finally {
    await lifecycle.dispose()
    database.close()
  }
})
