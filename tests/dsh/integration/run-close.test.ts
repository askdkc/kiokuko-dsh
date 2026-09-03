import assert from 'node:assert/strict'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { DshRunLifecycle, DshSessionBridge } from '../../../src/dsh/session-bridge.js'

test('close status is immutable across concurrent and failed retries', async () => {
  let releaseFlush!: () => void
  const flushStarted = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  let closeCalls = 0
  let flushCalls = 0
  const bridge = {
    quiesceRun: () => 7,
    flush: async () => { flushCalls += 1; await flushStarted },
    sealRun: () => undefined,
    close: async () => undefined,
  }
  const lifecycle = new DshRunLifecycle({
    bridge,
    closeRun: async () => { closeCalls += 1 },
  })
  const first = lifecycle.closeTurn({ runId: 'immutable-run', status: 'completed' })
  await assert.rejects(
    lifecycle.closeTurn({ runId: 'immutable-run', status: 'failed' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  )
  releaseFlush()
  await first
  assert.equal(flushCalls, 1)
  assert.equal(closeCalls, 1)
  await lifecycle.closeTurn({ runId: 'immutable-run', status: 'completed' })
  assert.equal(closeCalls, 1)
  await lifecycle.dispose()
})

test('failed close permits only an exact-status retry and seals the bridge after success', async () => {
  let attempts = 0
  let sealed = false
  const bridge = {
    quiesceRun: () => 3,
    flush: async (target?: number) => { assert.equal(target, 3) },
    sealRun: () => { sealed = true },
    close: async () => undefined,
  }
  const lifecycle = new DshRunLifecycle({
    bridge,
    closeRun: async () => { attempts += 1; if (attempts === 1) throw new Error('close failed') },
  })
  await assert.rejects(lifecycle.closeTurn({ runId: 'retry-run', status: 'completed' }), /close failed/u)
  await assert.rejects(
    lifecycle.closeTurn({ runId: 'retry-run', status: 'cancelled' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  )
  await lifecycle.closeTurn({ runId: 'retry-run', status: 'completed' })
  assert.equal(attempts, 2)
  assert.equal(sealed, true)
  await lifecycle.dispose()
})

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
    assert.match(ledger.readEvents('run-dsh-close')[0]?.source_event_id ?? '', /^dsh:session-dsh-close:[^:]+:1$/u)
    assert.equal(ledger.readRun('run-dsh-close')?.status, 'completed')
    assert.notEqual(ledger.readRun('run-dsh-close')?.endedAt, null)
  } finally {
    await lifecycle.dispose()
    database.close()
  }
})

test('terminal close flushes only its own run and is not blocked by another run failure', async () => {
  const closed: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (runId) => {
      if (runId === 'unrelated-run') throw new Error('unrelated durability failure')
    },
  })
  bridge.bindSession('target-session', 'target-run')
  bridge.bindSession('unrelated-session', 'unrelated-run')
  bridge.observe({ sessionId: 'target-session', runId: 'target-run', event: { type: 'turn/end', seq: 1, time: 1, data: null } })
  bridge.observe({ sessionId: 'unrelated-session', runId: 'unrelated-run', event: { type: 'turn/end', seq: 1, time: 1, data: null } })
  const lifecycle = new DshRunLifecycle({ bridge, closeRun: ({ runId }) => { closed.push(runId) } })

  await lifecycle.closeTurn({ runId: 'target-run', status: 'completed' })
  assert.deepEqual(closed, ['target-run'])
  assert.equal(bridge.pendingCount, 1)
  await assert.rejects(bridge.flush(), /unrelated durability failure/u)
})
