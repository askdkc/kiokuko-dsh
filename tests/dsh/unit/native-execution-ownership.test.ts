import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { existsSync } from 'node:fs'
import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'

test('ownership proof distinguishes completed history from holds, enrollment, uncertain effects and unavailable authority', { timeout: 30_000 }, async () => {
  assert.ok(existsSync(new URL('../../../src/dsh/native-execution-ownership.ts',import.meta.url)),'Host native ownership proof must be installed')
  const {nativeExecutionOwnership}=await import('../../../src/dsh/native-execution-ownership.js')
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'native-ownership-authority-')))
  const runtime = new DshCoreRuntime({ repositoryRoot: root, databasePath: join(root, 'authority.sqlite3'), autoRegisterRepository: true,
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 } })
  try {
    await runtime.start()
    await runtime.withDatabase(db => assert.equal(nativeExecutionOwnership(db, 'same-session'), 'unowned'))
    const task = await new CoreTasks(runtime).prepare({ requestId: 'prior-task', sessionId: 'same-session', turn: 1, task: 'こんにちは', cwd: root,
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }], signal: new AbortController().signal })
    await runtime.withDatabase(db => {
      assert.equal(nativeExecutionOwnership(db, task.sessionId, task.runId), 'owned')
      // Fixture-only terminal states. The public native test separately proves
      // the real completion/next-command path; these rows probe safety edges.
      const completed = () => db.prepare("UPDATE ledger_runs SET status='completed',task_state='Done',task_revision=task_revision+1,task_pending_stop_json=NULL,task_unresolved_json=NULL WHERE run_id=?").run(task.runId)
      completed()
      assert.equal(nativeExecutionOwnership(db, task.sessionId, task.runId), 'unowned')
      for (const state of ['ToDo', 'Working', 'Pending', 'Ignore']) {
        db.prepare('UPDATE ledger_runs SET task_state=? WHERE run_id=?').run(state, task.runId)
        assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', state)
      }
      completed()
      for (const field of ['task_pending_stop_json', 'task_unresolved_json']) {
        db.prepare(`UPDATE ledger_runs SET ${field}='{}' WHERE run_id=?`).run(task.runId)
        assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', field)
        completed()
      }
      db.prepare("INSERT INTO dsh_owned_operations VALUES('uncertain',?,?,?,'digest','unknown',?,'now')")
        .run(task.runId, task.sessionId, 'generation', JSON.stringify({ runId: task.runId, kind: 'kioku_exec', state: 'unknown' }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned')
      db.prepare("UPDATE dsh_owned_operations SET state='completed',receipt_json=? WHERE operation_id='uncertain'")
        .run(JSON.stringify({ runId: task.runId, kind: 'kioku_exec', state: 'completed', processStopped: false }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', 'completed receipt is not stop proof')
      db.prepare("UPDATE dsh_owned_operations SET receipt_json=? WHERE operation_id='uncertain'")
        .run(JSON.stringify({ runId: task.runId, kind: 'kioku_exec', state: 'completed', processStopped: true }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'unowned')
      initializeCodingWorkflow(db, { ...task, repositoryRoot: root, task: 'Explicit enrolled coding work' })
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', 'terminal ledger cannot bypass unfinished enrolled workflow')
      assert.throws(() => nativeExecutionOwnership(db, 'other-session', 'missing-live-owner'), /missing from authority storage/)
      db.exec('DROP TABLE dsh_coding_workflows')
      assert.throws(() => nativeExecutionOwnership(db, task.sessionId), /no such table/)
      db.exec('DROP TABLE dsh_execution_owners')
      assert.throws(() => nativeExecutionOwnership(db, task.sessionId), /no such table/)
    })
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})
