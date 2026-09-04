import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshSessionLogMirror } from '../../../src/dsh/session-log-mirror.js'
import type { DshDatabaseOperation, DshRuntime } from '../../../src/dsh/runtime.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-session-mirror-'))
  const core = openConnection(join(root, 'core.sqlite3'))
  migrateDatabase(core, join(process.cwd(), 'migrations'))
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
  }
  const mirror = new DshSessionLogMirror({ runtime, databasePath: join(root, 'mirror.sqlite3') })
  return {
    core,
    mirror,
    cleanup: async () => {
      await mirror.close()
      core.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('mirror preserves a larger-than-ledger event, backfills gaps, and streams ordered JSONL', async () => {
  const f = await fixture()
  try {
    const large = { type: 'tool/result', seq: 2, time: 3, data: { text: 'x'.repeat(70 * 1024) } }
    const session = {
      id: 'mirror-session',
      snapshotEvents: () => [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '/review\r\n@file\n@session' }] } },
        large,
      ],
    }
    const observed = await f.mirror.observe(session.id, large)
    assert.equal(observed.observedThrough, 2)
    assert.equal(observed.mirroredThrough, -1)
    assert.equal(observed.nativeDurableThrough, -1)
    assert.equal(observed.confirmedThrough, -1)

    const checkpoint = await f.mirror.checkpointAfterNativeFlush(session)
    assert.equal(checkpoint.health, 'healthy')
    assert.equal(checkpoint.observedThrough, 2)
    assert.equal(checkpoint.mirroredThrough, 2)
    assert.equal(checkpoint.nativeDurableThrough, 2)
    assert.equal(checkpoint.confirmedThrough, 2)

    const snapshot = await f.mirror.readSession(session.id)
    assert.deepEqual(snapshot.events.map((event) => event.seq), [0, 1, 2])
    assert.equal((snapshot.events[2]?.data as { text: string }).text.length, 70 * 1024)

    const chunks: Uint8Array[] = []
    let highWater = 0
    for await (const chunk of f.mirror.exportJsonl(session.id)) {
      chunks.push(chunk)
      highWater = Math.max(highWater, chunk.byteLength)
    }
    assert.ok(highWater <= 1024 * 1024)
    const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((event) => event.seq), [0, 1, 2])

    const health = f.core.prepare(`
      SELECT observed_through AS observedThrough, mirrored_through AS mirroredThrough,
             native_durable_through AS nativeDurableThrough, health
        FROM dsh_session_cache_health WHERE dsh_session_id = ?
    `).get<{ observedThrough: number; mirroredThrough: number; nativeDurableThrough: number; health: string }>(session.id)
    assert.deepEqual({ ...health }, { observedThrough: 2, mirroredThrough: 2, nativeDurableThrough: 2, health: 'healthy' })
  } finally {
    await f.cleanup()
  }
})

test('watermarks never confirm a sequence gap and a live snapshot repairs a conflicting cache row', async () => {
  const f = await fixture()
  try {
    const event0 = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const event1 = { type: 'user/message', seq: 1, time: 2, data: { text: 'authoritative' } }
    const event2 = { type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } }
    const gap = await f.mirror.observe('gap-session', event2)
    assert.equal(gap.observedThrough, 2)
    assert.equal(gap.mirroredThrough, -1)
    assert.equal(gap.confirmedThrough, -1)

    await f.mirror.observe('gap-session', event0)
    const partial = await f.mirror.checkpoint('gap-session')
    assert.equal(partial.mirroredThrough, 0)

    await f.mirror.observe('gap-session', { ...event1, data: { text: 'stale' } })
    const conflict = await f.mirror.observe('gap-session', event1)
    assert.equal(conflict.health, 'degraded')
    assert.equal(conflict.error?.code, 'INTEGRITY_ERROR')

    const repaired = await f.mirror.checkpointAfterNativeFlush({
      id: 'gap-session',
      snapshotEvents: () => [event0, event1, event2],
    })
    assert.equal(repaired.health, 'healthy')
    assert.equal(repaired.confirmedThrough, 2)
    assert.deepEqual((await f.mirror.readSession('gap-session')).events, [event0, event1, event2])
  } finally {
    await f.cleanup()
  }
})

test('cache startup and event conflicts degrade without throwing into the DSH event path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-session-mirror-failure-'))
  const core = openConnection(join(root, 'core.sqlite3'))
  migrateDatabase(core, join(process.cwd(), 'migrations'))
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
  }
  const unavailable = new DshSessionLogMirror({
    runtime,
    databasePath: join(root, 'unavailable.sqlite3'),
    openDatabase: () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }) },
  })
  try {
    const degraded = await unavailable.observe('failure-session', { type: 'user/message', seq: 0, time: 1, data: { text: 'kept by DSH' } })
    assert.equal(degraded.health, 'degraded')
    assert.equal(degraded.error?.code, 'SQLITE_IOERR')

    const healthy = new DshSessionLogMirror({ runtime, databasePath: join(root, 'conflict.sqlite3') })
    try {
      assert.equal((await healthy.observe('conflict-session', { type: 'a', seq: 0, time: 1 })).health, 'catching_up')
      const conflict = await healthy.observe('conflict-session', { type: 'b', seq: 0, time: 2 })
      assert.equal(conflict.health, 'degraded')
      assert.equal(conflict.error?.code, 'INTEGRITY_ERROR')
    } finally {
      await healthy.close()
    }
  } finally {
    await unavailable.close()
    core.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cache startup closes partial handles and retries after a transient failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-session-mirror-retry-'))
  const core = openConnection(join(root, 'core.sqlite3'))
  migrateDatabase(core, join(process.cwd(), 'migrations'))
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
  }
  let attempts = 0
  let closed = 0
  const realPath = join(root, 'mirror.sqlite3')
  const mirror = new DshSessionLogMirror({
    runtime,
    databasePath: realPath,
    openDatabase: (path) => {
      attempts += 1
      const database = openConnection(path)
      if (attempts === 1) {
        return {
          filePath: database.filePath,
          exec() { throw Object.assign(new Error('transient disk I/O error'), { code: 'SQLITE_IOERR' }) },
          prepare: database.prepare.bind(database),
          close() { closed += 1; database.close() },
        }
      }
      return database
    },
  })
  try {
    const degraded = await mirror.observe('retry-session', { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
    assert.equal(degraded.health, 'degraded')
    const recovered = await mirror.observe('retry-session', { type: 'turn/end', seq: 1, time: 2, data: { turn: 1 } })
    assert.equal(recovered.health, 'catching_up')
    assert.equal(attempts, 2)
    assert.equal(closed, 1)
  } finally {
    await mirror.close()
    core.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const injected of [
  { code: 'SQLITE_FULL', message: 'database or disk is full' },
  { code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' },
  { code: 'SQLITE_IOERR', message: 'disk I/O error' },
] as const) {
  test(`a ${injected.code} event write is contained as mirror health`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-session-mirror-write-failure-'))
    const core = openConnection(join(root, 'core.sqlite3'))
    migrateDatabase(core, join(process.cwd(), 'migrations'))
    const runtime: Pick<DshRuntime, 'withDatabase'> = {
      withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
    }
    const mirror = new DshSessionLogMirror({
      runtime,
      databasePath: join(root, 'mirror.sqlite3'),
      openDatabase: (path) => {
        const database = openConnection(path)
        return {
          filePath: database.filePath,
          exec: database.exec.bind(database),
          close: database.close.bind(database),
          prepare(sql) {
            const statement = database.prepare(sql)
            if (!sql.includes('INSERT INTO session_events')) return statement
            return {
              run() { throw Object.assign(new Error(injected.message), { code: injected.code }) },
              get: statement.get.bind(statement),
              all: statement.all.bind(statement),
            }
          },
        }
      },
    })
    try {
      const result = await mirror.observe(`${injected.code}-session`, {
        type: 'user/message', seq: 0, time: 1, data: { text: 'DSH retains this event' },
      })
      assert.equal(result.health, 'degraded')
      assert.equal(result.error?.code, injected.code)
      assert.equal(result.observedThrough, 0)
    } finally {
      await mirror.close()
      core.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('retention never evicts active, waiting, or unfinalized sessions and flags unsafe archives', async () => {
  const f = await fixture()
  try {
    const event = { type: 'turn/end', seq: 4, time: 1, data: { turn: 1 } }
    const completeSnapshot = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 0, data: { text: 'task' } },
      { type: 'assistant/message', seq: 2, time: 0, data: { text: 'result' } },
      { type: 'step/end', seq: 3, time: 0, data: { turn: 1 } },
      event,
    ]
    await f.mirror.observe('retained-session', event)
    await f.mirror.markUnfinalized('retained-session')
    assert.deepEqual(await f.mirror.evictFinalized(0), [])
    assert.equal((await f.mirror.readSession('retained-session')).events.length, 1)

    const unsafe = await f.mirror.markArchived('retained-session', 4)
    assert.equal(unsafe.health, 'archive_unsafe')
    await f.mirror.checkpointAfterNativeFlush({ id: 'retained-session', snapshotEvents: () => completeSnapshot })
    const safe = await f.mirror.markArchived('retained-session', 4)
    assert.equal(safe.confirmedThrough, 4)
    assert.equal(safe.health, 'healthy')

    await f.mirror.markFinalized('retained-session')
    assert.deepEqual(await f.mirror.evictFinalized(0), ['retained-session'])
    await assert.rejects(f.mirror.readSession('retained-session'), /absent/u)
  } finally {
    await f.cleanup()
  }
})
