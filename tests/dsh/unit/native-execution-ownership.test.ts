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
import { hasUnclassifiedNativeJobs, reportNativeJobClassification } from '../../../src/dsh/native-execution-ownership.js'

test('native jobs require exact session registration; activity alone never grants managed authority', () => {
  const job = { id: 'bash-one', kind: 'bash', status: 'running', owner: 'session', startedAt: 123 }
  const data = { jobId: job.id, kind: 'bash', owner: 'session', startedAt: 123, toolCall: { callId: 'nested', rootCallId: 'root' } }
  const classify = (value = job, registrations: any[] = [data]) => hasUnclassifiedNativeJobs([value], {
    id: 'session', snapshotEvents: () => registrations.map(data => ({ type: 'job/registered', data })),
  })
  assert.equal(classify(), false)
  assert.equal(classify({ ...job, status: 'stopping' }), false)
  for (const value of [{ ...job, owner: 'foreign' }, { ...job, kind: 'managed' }, { ...job, status: 'unknown' }]) assert.equal(classify(value), true)
  for (const registrations of [[], [data, data], [{ ...data, owner: 'foreign' }], [{ ...data, startedAt: 124 }], [{ ...data, toolCall: undefined }]]) assert.equal(classify(job, registrations), true)
  for (const status of ['completed', 'failed', 'killed']) assert.equal(classify({ ...job, status }, []), false)
})

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
      const taskRow = db.prepare('SELECT task_generation,task_revision,task_repository_root FROM ledger_runs WHERE run_id=?').get<any>(task.runId)!
      const binding = { sessionId: task.sessionId, generation: 'generation', taskAuthority: { taskId: task.runId, sessionId: task.sessionId, repositoryRoot: taskRow.task_repository_root, generation: taskRow.task_generation, revision: taskRow.task_revision } }
      db.prepare("INSERT INTO dsh_owned_operations VALUES('uncertain',?,?,?,'digest','unknown',?,'now')")
        .run(task.runId, task.sessionId, 'generation', JSON.stringify({ ...binding, runId: task.runId, kind: 'kioku_exec', state: 'unknown' }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned')
      db.prepare("UPDATE dsh_owned_operations SET state='completed',receipt_json=? WHERE operation_id='uncertain'")
        .run(JSON.stringify({ ...binding, runId: task.runId, kind: 'kioku_exec', state: 'completed', processStopped: false }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', 'completed receipt is not stop proof')
      db.prepare("UPDATE dsh_owned_operations SET receipt_json=? WHERE operation_id='uncertain'")
        .run(JSON.stringify({ ...binding, runId: task.runId, kind: 'kioku_exec', state: 'completed', processStopped: true }))
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'unowned')
      const child = { ...binding, runId: task.runId, kind: 'native_child', state: 'completed' };
      const setChild = (state: string, receipt: unknown) => db.prepare("UPDATE dsh_owned_operations SET state=?,receipt_json=? WHERE operation_id='uncertain'").run(state, JSON.stringify(receipt));
      setChild('completed', child);
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'unowned', 'completed child is history');
      for (const [state, receipt] of [
        ['completed', { ...child, sessionId: 'foreign' }],
        ['completed', { ...child, generation: 'stale' }],
        ['completed', { ...child, taskAuthority: { ...binding.taskAuthority, generation: binding.taskAuthority.generation + 1 } }],
        ['completed', { ...child, taskAuthority: { ...binding.taskAuthority, taskId: 'foreign' } }],
        ['completed', { ...child, taskAuthority: undefined }],
        ['started', child], ['unknown', child], ['completed', { ...child, state: 'started' }],
        ['completed', { ...child, runId: 'foreign-run' }], ['completed', { ...child, kind: 'unknown' }],
        ['completed', null], ['completed', []],
      ] as const) {
        setChild(state, receipt);
        assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned');
      }
      assert.throws(() => db.prepare("UPDATE dsh_owned_operations SET receipt_json='broken' WHERE operation_id='uncertain'").run(), /json_valid/);
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned');
      setChild('completed', child);
      initializeCodingWorkflow(db, { ...task, repositoryRoot: root, task: 'Explicit enrolled coding work' })
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'unowned', 'an optional unfinished record cannot claim authority over a completed task')
      const row = db.prepare('SELECT snapshot_json FROM dsh_coding_workflows WHERE run_id=?').get<{snapshot_json: string}>(task.runId)!
      db.prepare('UPDATE dsh_coding_workflows SET snapshot_json=? WHERE run_id=?')
        .run(JSON.stringify({ ...JSON.parse(row.snapshot_json), protocol: { phase: 'write-tests' } }), task.runId)
      assert.equal(nativeExecutionOwnership(db, task.sessionId), 'owned', 'an unfinished protected enrollment still owns the native route')
      assert.throws(() => nativeExecutionOwnership(db, 'other-session', 'missing-live-owner'), /missing from authority storage/)
      db.exec('DROP TABLE dsh_coding_workflows')
      assert.throws(() => nativeExecutionOwnership(db, task.sessionId), /no such table/)
      db.exec('DROP TABLE dsh_execution_owners')
      assert.throws(() => nativeExecutionOwnership(db, task.sessionId), /no such table/)
    })
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})


test('native job diagnostics preserve classification, precedence and short circuit with fixed reasons', () => {
  const job = { id: 'secret-job', kind: 'bash', status: 'running', owner: 'secret-session', startedAt: 123 }
  const data = { jobId: job.id, kind: 'bash', owner: job.owner, startedAt: 123, toolCall: { callId: '', rootCallId: '' }, command: 'secret-command', token: 'secret-token' }
  const cases: [Partial<typeof job>, any[], string | undefined][] = [
    [{}, [data], undefined], [{ status: 'stopping' }, [data], undefined],
    [{ status: 'unknown', kind: 'other' }, [], 'job_status_unknown'],
    [{ kind: 'other', owner: 'other' }, [], 'job_kind_not_bash'],
    [{ owner: 'other' }, [], 'job_owner_mismatch'],
    [{}, [], 'registration_missing'], [{}, [data, data], 'registration_ambiguous'],
    [{}, [{ ...data, owner: 'other' }], 'registration_owner_mismatch'],
    [{}, [{ ...data, kind: 'other' }], 'registration_kind_not_bash'],
    [{}, [{ ...data, startedAt: 124 }], 'registration_started_at_mismatch'],
    [{}, [{ ...data, toolCall: null }], 'tool_call_id_invalid'],
    [{}, [{ ...data, toolCall: { callId: 1, rootCallId: 'root' } }], 'tool_call_id_invalid'],
    [{}, [{ ...data, toolCall: { callId: 'call' } }], 'root_call_id_invalid'],
    ...['completed', 'killed', 'failed'].map(status => [{ status, kind: 'other' }, [], undefined] as [Partial<typeof job>, any[], undefined]),
  ]
  for (const [patch, registrations, expected] of cases) {
    const reasons: string[] = []
    const session = { id: job.owner, snapshotEvents: () => registrations.map(data => ({ type: 'job/registered', data })) }
    const jobs = [{ ...job, ...patch }]
    assert.equal(hasUnclassifiedNativeJobs(jobs, session, reason => reasons.push(reason)), expected !== undefined)
    assert.deepEqual(reasons, expected ? [expected] : [])
    assert.equal(hasUnclassifiedNativeJobs(jobs, session, () => { throw new Error('secret-error') }), expected !== undefined)
  }
  assert.equal(hasUnclassifiedNativeJobs([], { id: job.owner }), false)
  const reasons: string[] = []
  assert.equal(hasUnclassifiedNativeJobs([job, { ...job, status: 'unknown' }], { id: job.owner }, reason => reasons.push(reason)), true)
  assert.deepEqual(reasons, ['registration_missing'])
})

test('host diagnostic is opt-in and emits only the fixed schema and reason', t => {
  const original = process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => lines.push(line))
  try {
    for (const value of [undefined, '0', 'true']) {
      if (value === undefined) delete process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG
      else process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG = value
      reportNativeJobClassification('registration_missing')
    }
    assert.deepEqual(lines, [])
    process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG = '1'
    const job = { id: 'secret-job', kind: 'bash', status: 'running', owner: 'secret-session', startedAt: 123, command: 'secret-command', token: 'secret-token' }
    assert.equal(hasUnclassifiedNativeJobs([job], { id: job.owner }, reportNativeJobClassification), true)
    assert.deepEqual(lines, ['[kiokuko-dsh] {"schema":"kiokuko.native-ownership.v1","reason":"registration_missing"}'])
  } finally {
    if (original === undefined) delete process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG
    else process.env.KIOKUKO_NATIVE_OWNERSHIP_DEBUG = original
  }
})
