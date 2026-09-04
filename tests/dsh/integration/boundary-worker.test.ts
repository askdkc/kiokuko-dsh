import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DshBoundaryWorker } from '../../../src/dsh/boundary-worker.js'
import { prepareTurnIntent, replacePendingOutboxMessageInTransaction } from '../../../src/dsh/turn-process.js'
import { submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import type { DshDatabaseOperation, DshRuntime } from '../../../src/dsh/runtime.js'

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Focuses functions.' },
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-boundary-worker-'))
  await mkdir(join(root, 'src'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(database, {
    requestId: 'boundary-worker-request', cwd: root, task: 'Test durable boundary stages',
    profileHints: { taskType: 'build', target: 'src/process.ts', expected: 'stages', constraints: null },
    capabilities, dshSessionId: 'boundary-session', skillDiscoveryMode: 'off',
  })
  const idempotencyKey = 'boundary-ideal'
  prepareTurnIntent(database, {
    runId: prepared.run.runId, dshSessionId: 'boundary-session', nativeTurn: 1,
    phase: 'ideal', contractRevision: 1, inputDigest: canonicalContentHash({ ideal: 1 }),
    operation: 'ideal_submit', idempotencyKey,
  })
  submitOdunoIdeal(database, {
    runId: prepared.run.runId, workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId, expectedRevision: 1, idempotencyKey,
    ideal: { objective: 'One stage per job', principles: ['Keep every stage bounded'], skillContributions: [], successSignals: ['ordered'] },
  })
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(database, undefined as never),
  }
  return { root, database, runtime, cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) } }
}

test('one kick drains classified context and durable delivery as separate exactly-once jobs', async () => {
  const f = await fixture()
  const order: string[] = []
  const worker = new DshBoundaryWorker({
    runtime: f.runtime,
    process: async (job) => {
      order.push(job.kind)
      if (job.kind === 'classify_boundary') return { kind: 'completed', nextKind: 'context' }
      if (job.kind === 'context') return { kind: 'completed', nextKind: 'delivery' }
      throw new Error(`unexpected stage ${job.kind}`)
    },
    flush: async () => { order.push('flush') },
    dispatch: async (_job, item) => { order.push(`dispatch:${item.continuationId}`) },
  })
  try {
    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.deepEqual(order.slice(0, 3), ['classify_boundary', 'context', 'flush'])
    assert.match(order[3] ?? '', /^dispatch:[0-9a-f]{64}$/u)
    const jobs = f.database.prepare('SELECT kind, status FROM dsh_boundary_jobs ORDER BY created_at, kind').all<{ kind: string; status: string }>()
    assert.deepEqual(jobs.map((job) => job.status), ['completed', 'completed', 'completed'])
    assert.equal(f.database.prepare('SELECT status FROM dsh_continuation_outbox').get<{ status: string }>()?.status, 'dispatched')

    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.equal(order.length, 4)
  } finally {
    await worker.dispose()
    await f.cleanup()
  }
})

test('native durability failure prevents continuation dispatch and leaves a retryable delivery job', async () => {
  const f = await fixture()
  let dispatched = false
  const worker = new DshBoundaryWorker({
    runtime: f.runtime,
    process: async (job) => job.kind === 'classify_boundary'
      ? { kind: 'completed', nextKind: 'delivery' }
      : { kind: 'completed' },
    flush: async () => { throw Object.assign(new Error('native flush failed'), { code: 'NATIVE_FLUSH_FAILED' }) },
    dispatch: async () => { dispatched = true },
  })
  try {
    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.equal(dispatched, false)
    assert.equal(f.database.prepare("SELECT status FROM dsh_boundary_jobs WHERE kind = 'delivery'").get<{ status: string }>()?.status, 'failed_retryable')
    assert.equal(f.database.prepare('SELECT status FROM dsh_continuation_outbox').get<{ status: string }>()?.status, 'pending')
  } finally {
    await worker.dispose()
    await f.cleanup()
  }
})

test('dispatch-before-observed crash survives worker restart with the same deterministic delivery id', async () => {
  const f = await fixture()
  const deliveries: string[] = []
  const firstWorker = new DshBoundaryWorker({
    runtime: f.runtime,
    process: async (job) => job.kind === 'classify_boundary'
      ? { kind: 'completed', nextKind: 'delivery' }
      : { kind: 'completed' },
    flush: async () => undefined,
    dispatch: async (_job, item) => {
      deliveries.push(item.continuationId)
      if (deliveries.length === 1) throw Object.assign(new Error('crash after native enqueue'), { code: 'CRASH_CUT' })
    },
  })
  let restartedWorker: DshBoundaryWorker | undefined
  try {
    firstWorker.kick('boundary-session')
    await firstWorker.whenIdle()
    assert.equal(f.database.prepare('SELECT status FROM dsh_continuation_outbox').get<{ status: string }>()?.status, 'pending')
    await firstWorker.dispose()
    await new Promise((resolve) => setTimeout(resolve, 650))
    restartedWorker = new DshBoundaryWorker({
      runtime: f.runtime,
      process: async () => { throw new Error('delivery retry must not repeat an earlier boundary stage') },
      flush: async () => undefined,
      dispatch: async (_job, item) => { deliveries.push(item.continuationId) },
    })
    restartedWorker.kick('boundary-session')
    await restartedWorker.whenIdle()
    assert.equal(deliveries.length, 2)
    assert.equal(deliveries[0], deliveries[1])
    assert.equal(f.database.prepare('SELECT status FROM dsh_continuation_outbox').get<{ status: string }>()?.status, 'dispatched')
  } finally {
    await firstWorker.dispose()
    await restartedWorker?.dispose()
    await f.cleanup()
  }
})

test('a boundary job stops after three failures and does not schedule a fourth automatic attempt', async () => {
  const f = await fixture()
  let clock = Date.parse('2099-01-01T00:00:00.000Z')
  let flushes = 0
  let waitingNotifications = 0
  const worker = new DshBoundaryWorker({
    runtime: f.runtime,
    now: () => new Date(clock).toISOString(),
    process: async (job) => job.kind === 'classify_boundary'
      ? { kind: 'completed', nextKind: 'delivery' }
      : { kind: 'completed' },
    flush: async () => { flushes += 1; throw new Error('persistent native failure') },
    dispatch: async () => undefined,
    onWaitingUser: async () => { waitingNotifications += 1; return false },
  })
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      worker.kick('boundary-session')
      await worker.whenIdle()
      clock += 120_000
    }
    assert.equal(flushes, 3)
    assert.equal(waitingNotifications, 1)
    assert.equal(
      f.database.prepare("SELECT status FROM dsh_boundary_jobs WHERE kind = 'delivery'").get<{ status: string }>()?.status,
      'waiting_user',
    )
    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.equal(flushes, 3)
  } finally {
    await worker.dispose()
    await f.cleanup()
  }
})

test('the delivery guard can stop before flush and native dispatch', async () => {
  const f = await fixture()
  let flushed = false
  let dispatched = false
  const worker = new DshBoundaryWorker({
    runtime: f.runtime,
    process: async (job) => job.kind === 'classify_boundary'
      ? { kind: 'completed', nextKind: 'delivery' }
      : { kind: 'completed' },
    beforeDelivery: async () => 'waiting_user' as const,
    flush: async () => { flushed = true },
    dispatch: async () => { dispatched = true },
  })
  try {
    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.equal(flushed, false)
    assert.equal(dispatched, false)
    assert.equal(
      f.database.prepare("SELECT status FROM dsh_boundary_jobs WHERE kind = 'delivery'").get<{ status: string }>()?.status,
      'waiting_user',
    )
    assert.equal(f.database.prepare('SELECT status FROM dsh_continuation_outbox').get<{ status: string }>()?.status, 'pending')
  } finally {
    await worker.dispose()
    await f.cleanup()
  }
})

test('delivery re-reads a user recovery message written by the guard', async () => {
  const f = await fixture()
  let delivered: unknown
  const worker = new DshBoundaryWorker({
    runtime: f.runtime,
    process: async (job) => job.kind === 'classify_boundary'
      ? { kind: 'completed', nextKind: 'delivery' }
      : { kind: 'completed' },
    beforeDelivery: async (job, item) => {
      replacePendingOutboxMessageInTransaction(f.database, job.receiptId, {
        id: item.continuationId,
        role: 'user',
        content: [{ type: 'text', text: 'explicit recovery instruction' }],
        source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'loop-recovery', deliveryId: item.continuationId },
      })
      return 'deliver' as const
    },
    flush: async () => undefined,
    dispatch: async (_job, item) => { delivered = item.message },
  })
  try {
    worker.kick('boundary-session')
    await worker.whenIdle()
    assert.match(JSON.stringify(delivered), /explicit recovery instruction/u)
  } finally {
    await worker.dispose()
    await f.cleanup()
  }
})
