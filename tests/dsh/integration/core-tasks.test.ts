import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-core-tasks-')))
  const runtime = new DshCoreRuntime({ repositoryRoot: root, databasePath: join(root, 'memory.sqlite3'), autoRegisterRepository: true,
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 } })
  await runtime.start()
  const input = { requestId: 'request-one', sessionId: 'session', turn: 1, task: 'こんにちは', cwd: root,
    capabilities: [{ kind: 'skill' as const, name: 'kiokuko-soul' }], signal: new AbortController().signal }
  const state = () => runtime.withDatabase(db => ({
    runs: db.prepare('SELECT run_id,status,ended_at FROM ledger_runs ORDER BY run_id').all(),
    owners: db.prepare('SELECT * FROM dsh_execution_owners').all(),
  }))
  return { runtime, input, state, async cleanup() { await runtime.close(); await rm(root, { recursive: true, force: true }) } }
}

test('task finalization preserves identity, terminal outcomes and a later request owner', async () => {
  const f = await fixture(), tasks = new CoreTasks(f.runtime)
  try {
    const task = await tasks.prepare(f.input)
    assert.equal(task.admitted, true)
    const before = await f.state()
    for (const changed of [{ requestId: 'other' }, { sessionId: 'other' }, { workspace: 'other' }, { runId: 'other' }]) {
      await assert.rejects(tasks.finish({ ...task, ...changed }, 'cancelled'), /identity mismatch|owner mismatch/)
      assert.deepEqual(await f.state(), before)
    }
    await tasks.finish(task, 'interrupted')
    const interrupted = await f.state()
    assert.equal(interrupted.runs[0]?.status, 'interrupted')
    assert.equal(typeof interrupted.runs[0]?.ended_at, 'string')
    assert.deepEqual(interrupted.owners, [])
    await tasks.finish(task, 'completed')
    assert.deepEqual(await f.state(), interrupted, 'late completion must preserve the interrupted outcome')

    const next = await tasks.prepare({ ...f.input, requestId: 'request-two', turn: 2 })
    const withNext = await f.state()
    await assert.rejects(tasks.finish(task, 'cancelled'), /owner mismatch/)
    assert.deepEqual(await f.state(), withNext, 'stale finalization cannot release a later request')
    await tasks.finish(next, 'completed')
  } finally { await f.cleanup() }
})

test('pending intake can be cancelled but cannot be marked completed', async () => {
  const f = await fixture(), tasks = new CoreTasks(f.runtime)
  try {
    const task = await tasks.prepare({ ...f.input, task: 'Do that please' })
    assert.equal(task.admitted, false)
    const before = await f.state()
    await assert.rejects(tasks.finish(task, 'completed'), /not admitted/)
    assert.deepEqual(await f.state(), before)
    await tasks.finish(task, 'cancelled')
    const after = await f.state()
    assert.equal(after.runs[0]?.status, 'cancelled')
    assert.deepEqual(after.owners, [])
  } finally { await f.cleanup() }
})

test('preparation retains both failures and rolls back terminalization if owner release fails', async () => {
  const f = await fixture(), failure = new Error('Question service unavailable')
  const tasks = new CoreTasks(f.runtime, { async ask() { throw failure } })
  try {
    await f.runtime.withDatabase(db => db.exec("CREATE TRIGGER prevent_owner_release BEFORE DELETE ON dsh_execution_owners BEGIN SELECT RAISE(ABORT, 'Owner release failed'); END"))
    await assert.rejects(tasks.prepare({ ...f.input, task: 'Do that please' }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors[0], failure)
      assert.match(String(error.errors[1]), /Owner release failed/)
      return true
    })
    const after = await f.state()
    assert.equal(after.runs[0]?.status, 'intake', 'run transition and owner deletion must roll back together')
    assert.equal(after.runs[0]?.ended_at, null)
    assert.equal(after.owners.length, 1)
    assert.equal(after.owners[0]?.run_id, after.runs[0]?.run_id)
  } finally { await f.cleanup() }
})
