import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks, type CoreTask } from '../../../src/dsh/core/tasks.js'
import { authorizeTaskLease, captureTaskLease, readTaskSnapshot, transitionTask } from '../../../src/dsh/task-state.js'
import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { claimExecutionOwner } from '../../../src/dsh/orchestration/execution-owner.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-core-tasks-')))
  const createRuntime = () => new DshCoreRuntime({ repositoryRoot: root, databasePath: join(root, 'memory.sqlite3'), autoRegisterRepository: true,
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 } })
  let runtime = createRuntime()
  await runtime.start()
  const input = { requestId: 'request-one', sessionId: 'session', turn: 1, task: 'こんにちは', cwd: root,
    capabilities: [{ kind: 'skill' as const, name: 'kiokuko-soul' }], signal: new AbortController().signal }
  const state = () => runtime.withDatabase(db => ({
    runs: db.prepare('SELECT * FROM ledger_runs ORDER BY run_id').all(),
    owners: db.prepare('SELECT * FROM dsh_execution_owners ORDER BY dsh_session_id').all(),
    workflows: db.prepare('SELECT * FROM dsh_coding_workflows ORDER BY run_id').all(),
    codingOperations: db.prepare('SELECT * FROM dsh_coding_operations ORDER BY workflow_id,call_id').all(),
  }))
  return { get runtime() { return runtime }, input, state,
    async restart() { await runtime.close(); runtime = createRuntime(); await runtime.start() },
    async cleanup() { await runtime.close(); await rm(root, { recursive: true, force: true }) } }
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


const operations = {
  finish: (tasks: CoreTasks, task: CoreTask) => tasks.finish(task, 'cancelled'),
  refresh: (tasks: CoreTasks, task: CoreTask) => tasks.refresh(task, 'Refresh the current task', new AbortController().signal),
  checkpoint: (tasks: CoreTasks, task: CoreTask) => tasks.checkpoint(task, { outcome: 'interrupted' }, new AbortController().signal),
}

for (const [name, operate] of Object.entries(operations)) {
  test(`${name} rejects each substituted lease identity before effects`, async () => {
    const f = await fixture(), tasks = new CoreTasks(f.runtime)
    try {
      const task = await tasks.prepare(f.input)
      assert.ok(task.authority)
      await f.runtime.withDatabase(db => initializeCodingWorkflow(db, { ...task,
        repositoryRoot: task.authority!.repositoryRoot, task: 'Inspect the current coding goal' }))
      const before = await f.state()
      for (const changed of [{ taskId: 'other-task' }, { sessionId: 'other-session' }, { repositoryRoot: join(f.input.cwd, 'other-root') }]) {
        await assert.rejects(operate(tasks, { ...task, authority: { ...task.authority, ...changed } }), /identity mismatch/)
        assert.deepEqual(await f.state(), before)
      }
    } finally { await f.cleanup() }
  })

  test(`${name} rejects a valid live lease belonging to another task`, async () => {
    const f = await fixture(), tasks = new CoreTasks(f.runtime)
    try {
      const task = await tasks.prepare(f.input)
      const other = await tasks.prepare({ ...f.input, requestId: 'foreign-request', sessionId: 'foreign-session' })
      assert.ok(other.authority)
      await f.runtime.withDatabase(db => authorizeTaskLease(db, other.authority!))
      const before = await f.state()
      await assert.rejects(operate(tasks, { ...task, authority: other.authority }), /identity mismatch/)
      assert.deepEqual(await f.state(), before, 'neither task may be changed by a substituted live lease')
    } finally { await f.cleanup() }
  })
}

test('terminal retries preserve coding state and outcome across a fresh runtime', async () => {
  const f = await fixture()
  let tasks = new CoreTasks(f.runtime)
  try {
    const task = await tasks.prepare(f.input)
    assert.ok(task.authority)
    await f.runtime.withDatabase(db => initializeCodingWorkflow(db, { ...task,
      repositoryRoot: task.authority!.repositoryRoot, task: 'Inspect the current coding goal' }))
    await tasks.finish(task, 'interrupted')
    const interrupted = await f.state()
    assert.equal(interrupted.runs[0]?.status, 'interrupted')
    assert.deepEqual(interrupted.owners, [])
    assert.equal(interrupted.workflows.length, 1)
    await f.restart()
    tasks = new CoreTasks(f.runtime)
    assert.deepEqual(await f.state(), interrupted)
    for (const outcome of ['completed', 'cancelled', 'failed', 'interrupted'] as const) {
      await assert.doesNotReject(tasks.finish(task, outcome))
      assert.deepEqual(await f.state(), interrupted, 'a retry must not synchronize, stop or otherwise alter coding state')
    }
    await assert.rejects(tasks.finish({ ...task, requestId: 'changed-after-release' }, 'completed'), /identity mismatch/)
    assert.deepEqual(await f.state(), interrupted)
  } finally { await f.cleanup() }
})

test('explicit resume revokes the old finish lease before and after the resumed execution ends', async () => {
  const f = await fixture(), tasks = new CoreTasks(f.runtime)
  try {
    const task = await tasks.prepare(f.input)
    assert.ok(task.authority)
    await tasks.finish(task, 'interrupted')
    const authority = await f.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      const stopped = readTaskSnapshot(db, task.authority!)
      const resumed = transitionTask(db, stopped, { operation: 'resume', operationId: 'explicit-resume',
        expectedRevision: stopped.revision, expectedGeneration: stopped.generation,
        explicit: true, reason: 'The user explicitly resumed this same task', evidence: [] })
      assert.equal(resumed.state, 'Working')
      assert.equal(resumed.runStatus, 'active')
      assert.ok(resumed.generation > task.authority!.generation)
      claimExecutionOwner(db, { sessionId: task.sessionId, workspace: task.workspace,
        mode: 'normal', startId: task.requestId, runId: task.runId })
      return captureTaskLease(db, resumed)
    }))
    const running = await f.state()
    for (const operate of Object.values(operations)) {
      await assert.rejects(operate(tasks, task), /stale or stopped/)
      assert.deepEqual(await f.state(), running, 'the old lease cannot alter the resumed execution')
    }
    const resumed = { ...task, authority }
    await tasks.finish(resumed, 'interrupted')
    const ended = await f.state()
    await assert.rejects(tasks.finish(task, 'cancelled'), /stale or stopped/)
    assert.deepEqual(await f.state(), ended, 'a second terminal outcome must not make the first lease valid again')
    await assert.doesNotReject(tasks.finish(resumed, 'completed'))
    assert.deepEqual(await f.state(), ended)
  } finally { await f.cleanup() }
})

test('finalization rolls back coding state, task authority and owner release together', async () => {
  const f = await fixture(), tasks = new CoreTasks(f.runtime)
  try {
    const task = await tasks.prepare(f.input)
    assert.ok(task.authority)
    await f.runtime.withDatabase(db => {
      initializeCodingWorkflow(db, { ...task, repositoryRoot: task.authority!.repositoryRoot,
        task: 'Inspect the current coding goal' })
      db.exec("CREATE TRIGGER prevent_owner_release BEFORE DELETE ON dsh_execution_owners BEGIN SELECT RAISE(ABORT, 'Owner release failed'); END")
    })
    const before = await f.state()
    await assert.rejects(tasks.finish(task, 'cancelled'), /Owner release failed/)
    assert.deepEqual(await f.state(), before)
    await f.runtime.withDatabase(db => {
      authorizeTaskLease(db, task.authority!)
      db.exec('DROP TRIGGER prevent_owner_release')
    })
    await tasks.finish(task, 'cancelled')
    const cancelled = await f.state()
    assert.equal(cancelled.runs[0]?.status, 'cancelled')
    assert.deepEqual(cancelled.owners, [])
    assert.equal(JSON.parse(String(cancelled.workflows[0]?.snapshot_json)).state, 'cancelled')
  } finally { await f.cleanup() }
})
