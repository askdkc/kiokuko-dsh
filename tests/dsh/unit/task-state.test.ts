import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { loadMigrationSnapshot, migrateDatabase } from '../../../src/db/migrate.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { TASK_TYPES, type TaskType } from '../../../src/ledger/types.js'
import { bindTaskRepository, readTaskSnapshot, findSessionTask, transitionTask, validateTaskOperation,
  captureTaskLease, authorizeTaskLease, recordTaskEvidence, requestTaskStop, confirmTaskStop, transferTaskOwner,
  taskCanExecute, isTaskTerminal, recordTaskUnresolved, clearTaskUnresolved, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'

function fixture(legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-state-'))), path = join(root, 'state.sqlite3')
  let db = openConnection(path)
  if (legacy) {
    const directory = join(root, 'old-migrations'); mkdirSync(directory)
    for (const item of loadMigrationSnapshot().migrations.filter(item => item.version < 40)) writeFileSync(join(directory, item.name), item.sql)
    migrateDatabase(db, directory)
  } else migrateDatabase(db)
  let sequence = 0
  const create = (type: TaskType = 'research', explicit = true, ready = true) => {
    const id = `task-${++sequence}`, sessionId = `session-${id}`
    const opened = new DshRunIntakeService(db, { akinatorMemory: AkinatorMemoryConfig.parse({ mode: 'off' }) }).openRun({
      idempotencyKey: id, dshSessionId: sessionId, request: { apiVersion: '1', workspace: 'project:task-test',
        task: { title: `Inspect ${type}`, query: `Inspect ${type} without changing its scope`,
          profileHints: { taskType: type, target: ready ? '.' : null, expected: ready ? 'Report observed results' : null, constraints: null } },
        captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
        metadata: explicit ? { taskStateExplicit: true } : {},
      } })
    const identity = { taskId: opened.runId, sessionId, repositoryRoot: root }
    return { ...identity, opened }
  }
  return { root, get db() { return db }, create,
    reopen() { db.close(); db = openConnection(path); migrateDatabase(db) },
    close() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}
function start(f: ReturnType<typeof fixture>, identity: ReturnType<ReturnType<typeof fixture>['create']>) {
  const task = bindTaskRepository(f.db, identity)
  return transitionTask(f.db, identity, { operation: 'start', operationId: 'start', expectedRevision: task.revision, reason: 'Start the admitted task' })
}
function proof(f: ReturnType<typeof fixture>, task: TaskSnapshot, kind: 'verification' | 'stopped', ref = `${kind}-${task.generation}`) {
  recordTaskEvidence(f.db, task, { ref, kind, generation: task.generation, verified: true, details: { source: 'test host observation' } })
  return ref
}

test('all task types use the same ledger run and intake, without manufacturing coding workflows', () => {
  const f = fixture()
  try {
    for (const type of TASK_TYPES) {
      const identity = f.create(type), task = bindTaskRepository(f.db, identity)
      assert.equal(task.taskId, identity.opened.runId); assert.equal(task.runId, task.taskId)
      assert.equal(task.type, type); assert.equal(task.state, 'ToDo'); assert.match(task.request!, /without changing its scope/)
      assert.equal(start(f, identity).state, 'Working')
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get()!.n, TASK_TYPES.length)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM run_intakes').get()!.n, TASK_TYPES.length)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_coding_workflows').get()!.n, 0)
  } finally { f.close() }
})

test('state transition table and terminal explicit-resume rules are shared by pure validation', () => {
  const f = fixture()
  try {
    const identity = f.create(), original = bindTaskRepository(f.db, identity)
    const allowed = { ToDo: ['start','wait','ignore'], Working: ['wait','complete','ignore'], Pending: ['resume','ignore'], Done: ['resume'], Ignore: ['resume'] }
    for (const state of Object.keys(allowed) as Array<keyof typeof allowed>) for (const operation of ['start','wait','resume','complete','ignore'] as const) {
      const snapshot = { ...original, state }, input = { operation, operationId: `${state}-${operation}`, expectedRevision: snapshot.revision, reason: 'explicit operation', explicit: true }
      if (allowed[state].includes(operation)) assert.equal(validateTaskOperation(snapshot, input).operation, operation)
      else assert.throws(() => validateTaskOperation(snapshot, input), /not allowed/)
    }
    assert.throws(() => validateTaskOperation({ ...original, state: 'Ignore' }, { operation: 'resume', operationId: 'r', expectedRevision: original.revision, reason: 'automatic' }), /explicit resume/)
  } finally { f.close() }
})

test('CAS, owner binding, readiness and operation replay reject changed or stale inputs', () => {
  const f = fixture()
  try {
    const identity = f.create(), initial = bindTaskRepository(f.db, identity)
    const input = { operation: 'start' as const, operationId: 'op', expectedRevision: initial.revision, reason: 'User requested start' }
    const working = transitionTask(f.db, identity, input)
    assert.deepEqual(transitionTask(f.db, identity, input), working)
    assert.throws(() => transitionTask(f.db, identity, { ...input, reason: 'different' }), /different request/)
    assert.throws(() => requestTaskStop(f.db, identity, { ...input, operation: 'ignore', expectedRevision: working.revision }), /different request/)
    assert.throws(() => transitionTask(f.db, identity, { ...input, operationId: 'stale' }), /Stale task/)
    assert.throws(() => captureTaskLease(f.db, { ...identity, sessionId: 'foreign' }), /owner/)
    assert.throws(() => captureTaskLease(f.db, { ...identity, repositoryRoot: '/foreign' }), /repository/)
    const incomplete = f.create('build', true, false), pending = bindTaskRepository(f.db, incomplete)
    assert.throws(() => transitionTask(f.db, incomplete, { ...input, expectedRevision: pending.revision }), /existing intake/)
  } finally { f.close() }
})

test('stop request survives restart, invalidates every lease and requires a current host stop receipt', () => {
  const f = fixture()
  try {
    const identity = f.create(), working = start(f, identity), lease = captureTaskLease(f.db, identity)
    f.db.prepare('INSERT INTO dsh_execution_owners VALUES(?,?,?,?,?)').run(identity.sessionId, 'project:task-test', 'normal', 'start', identity.taskId)
    assert.throws(() => transitionTask(f.db, identity, { operation: 'ignore', operationId: 'unconfirmed', expectedRevision: working.revision, reason: 'Stop now' }), /stop receipt/)
    const input = { operation: 'ignore' as const, operationId: 'stop', expectedRevision: working.revision, reason: 'User explicitly ignores this task' }
    const stopping = requestTaskStop(f.db, identity, input)
    assert.equal(stopping.state, 'Working'); assert.equal(stopping.pendingStop?.operationId, 'stop'); assert.deepEqual(stopping.allowedOps, [])
    assert.deepEqual(requestTaskStop(f.db, identity, input), stopping)
    assert.throws(() => authorizeTaskLease(f.db, lease), /stale or stopped/)
    assert.throws(() => captureTaskLease(f.db, identity), /not Working/)
    f.reopen()
    assert.deepEqual(readTaskSnapshot(f.db, identity), stopping)
    assert.throws(() => confirmTaskStop(f.db, identity, { operationId: 'stop', expectedRevision: stopping.revision, evidenceRef: 'model says stopped' }), /not been confirmed/)
    assert.throws(() => recordTaskEvidence(f.db, identity, { ref: 'late', kind: 'verification', generation: working.generation, verified: true }), /old task generation/)
    const evidenceRef = proof(f, stopping, 'stopped'), ignored = confirmTaskStop(f.db, identity, { operationId: 'stop', expectedRevision: stopping.revision, evidenceRef })
    assert.equal(ignored.state, 'Ignore'); assert.equal(ignored.runStatus, working.runStatus); assert.equal(isTaskTerminal(ignored), true)
    assert.equal(f.db.prepare('SELECT 1 FROM dsh_execution_owners WHERE run_id=?').get(identity.taskId), undefined)
    assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs WHERE run_id=?').get(identity.taskId)!.dsh_session_id, identity.sessionId)
    assert.equal(findSessionTask(f.db, identity), undefined)
    assert.equal(findSessionTask(f.db, identity, { includeLatestTerminal: true })?.state, 'Ignore')
    assert.throws(() => authorizeTaskLease(f.db, lease), /stale or stopped/)
  } finally { f.close() }
})

test('Done requires host evidence; failed, cancelled and interrupted retain their distinct outcomes after explicit resume', () => {
  const f = fixture()
  try {
    const identity = f.create(), working = start(f, identity)
    assert.throws(() => transitionTask(f.db, identity, { operation: 'complete', operationId: 'done', expectedRevision: working.revision, reason: 'Model claims success', evidence: ['fake'] }), /host-observed/)
    const ref = proof(f, working, 'verification')
    const done = transitionTask(f.db, identity, { operation: 'complete', operationId: 'done', expectedRevision: working.revision, reason: 'Observed result', evidence: [ref] })
    assert.equal(done.state, 'Done')
    for (const status of ['failed','cancelled','interrupted'] as const) {
      const owner = f.create(), current = start(f, owner), lease = captureTaskLease(f.db, owner)
      new LedgerStore(f.db).updateRunStatus(owner.taskId, status)
      const failed = readTaskSnapshot(f.db, owner)
      assert.equal(failed.state, 'Pending'); assert.equal(failed.runStatus, status)
      assert.throws(() => authorizeTaskLease(f.db, lease), /stale or stopped/)
      const input = { operation: 'resume' as const, operationId: 'resume', expectedRevision: failed.revision, reason: 'User explicitly resumes' }
      assert.throws(() => transitionTask(f.db, owner, input), /explicit resume/)
      const resumed = transitionTask(f.db, owner, { ...input, explicit: true })
      assert.equal(resumed.runStatus, 'active'); assert.equal(resumed.previousOutcome?.status, status)
      assert.ok(resumed.previousOutcome?.endedAt); assert.equal(resumed.state, 'Working'); assert.ok(resumed.generation > current.generation)
      assert.equal(taskCanExecute(resumed), true)
      new LedgerStore(f.db).appendBatch(owner.taskId, { events: [{ eventType: 'step.started', actor: 'host', payload: { generation: resumed.generation } }] })
    }
  } finally { f.close() }
})

test('trusted owner handoff keeps source provenance and atomically invalidates old native ownership', () => {
  const f = fixture()
  try {
    const identity = f.create(), working = start(f, identity), lease = captureTaskLease(f.db, identity)
    f.db.prepare('INSERT INTO dsh_execution_owners VALUES(?,?,?,?,?)').run(identity.sessionId, 'project:task-test', 'normal', 'start', identity.taskId)
    const handoff = { sessionId: 'next-native-session', operationId: 'handoff', expectedRevision: working.revision,
      expectedGeneration: working.generation, reason: 'Native model switch', evidence: [] as string[] }
    assert.throws(() => transferTaskOwner(f.db, identity, handoff), /Stop current task/)
    handoff.evidence.push(proof(f, working, 'stopped'))
    const transferred = transferTaskOwner(f.db, identity, handoff)
    assert.equal(transferred.taskId, identity.taskId); assert.equal(transferred.sourceSessionId, identity.sessionId)
    assert.equal(transferred.sessionId, handoff.sessionId)
    assert.equal(f.db.prepare('SELECT dsh_session_id FROM ledger_runs WHERE run_id=?').get(identity.taskId)!.dsh_session_id, identity.sessionId)
    assert.equal(f.db.prepare('SELECT dsh_session_id FROM dsh_execution_owners WHERE run_id=?').get(identity.taskId)!.dsh_session_id, handoff.sessionId)
    assert.throws(() => authorizeTaskLease(f.db, lease), /owner/)
    assert.deepEqual(transferTaskOwner(f.db, identity, handoff), transferred)
    assert.throws(() => transferTaskOwner(f.db, identity, { ...handoff, sessionId: 'another' }), /different request/)
  } finally { f.close() }
})

test('unresolved decisions preserve active work and bind to the exact request without changing task revision', () => {
  const f = fixture()
  try {
    const identity = f.create(), current = start(f, identity), lease = captureTaskLease(f.db, identity)
    const input = { operationId: 'unresolved', expectedRevision: current.revision, requestId: 'request-new',
      contextDigest: 'a'.repeat(64), reason: 'Decision provider unavailable' }
    const recorded = recordTaskUnresolved(f.db, identity, input)
    assert.equal(recorded.state, 'Working'); assert.equal(recorded.revision, current.revision); assert.equal(recorded.generation, current.generation)
    assert.equal(recorded.unresolved?.requestId, input.requestId); assert.equal(authorizeTaskLease(f.db, lease).state, 'Working')
    assert.throws(() => clearTaskUnresolved(f.db, identity, { ...input, requestId: 'another' }), /identity changed/)
    assert.equal(clearTaskUnresolved(f.db, identity, input).unresolved, undefined)
  } finally { f.close() }
})

test('a host verification label cannot bypass unfinished coding criteria', () => {
  const f = fixture()
  try {
    const identity = f.create('build'), current = start(f, identity)
    initializeCodingWorkflow(f.db, { runId: identity.taskId, sessionId: identity.sessionId, repositoryRoot: identity.repositoryRoot,
      requestId: 'coding-request', task: current.request! })
    const ref = proof(f, current, 'verification')
    assert.throws(() => transitionTask(f.db, identity, { operation: 'complete', operationId: 'false-complete',
      expectedRevision: current.revision, reason: 'Host label lacks actual coding checks', evidence: [ref] }), /criteria are not verified/)
    assert.equal(readTaskSnapshot(f.db, identity).state, 'Working')
  } finally { f.close() }
})

test('migration backfills existing outcomes while a new legacy status-only completion does not invent verification', () => {
  const f = fixture(true)
  try {
    const owners = ['active','completed','failed','cancelled','interrupted'].map(status => {
      const owner = f.create('research', false)
      if (status !== 'active') f.db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(status, owner.taskId)
      return { owner, status }
    })
    migrateDatabase(f.db)
    for (const { owner, status } of owners) {
      const task = bindTaskRepository(f.db, owner)
      assert.equal(task.runStatus, status)
      assert.equal(task.state, status === 'active' ? 'Working' : status === 'completed' ? 'Done' : 'Pending')
    }
    const fresh = f.create('research', false)
    bindTaskRepository(f.db, fresh)
    f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(fresh.taskId)
    assert.equal(readTaskSnapshot(f.db, fresh).state, 'Pending')
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.close() }
})
