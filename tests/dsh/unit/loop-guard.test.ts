import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileOutboxObservations, readPendingOutbox, reserveOutboxDelivery } from '../../../src/dsh/turn-process.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { claimAutomaticContinuationInTransaction } from '../../../src/dsh/loop-guard.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'

function seedRun(database: NodeSqliteAdapter) {
  database.prepare("INSERT INTO repositories VALUES ('project:test','test','test',NULL,1,0,'now','now')").run()
  database.prepare(`INSERT INTO ledger_runs
    (run_id, workspace, dsh_session_id, protocol_version, capture_profile, coverage_json, status, metadata_json, started_at, created_at, updated_at)
    VALUES ('run', 'project:test', 'session', '1', 'test', '{}', 'active', '{}', 'now', 'now', 'now')`).run()
}

test('observed progress keeps delivering; repeated observations get one replan across claims', () => {
  const database = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  try {
    migrateDatabase(database)
    seedRun(database)
    const claim = (id: number, progress: number, instruction = 'continue') => {
      const input = {
        runId: 'run', dshSessionId: 'session', claimId: canonicalContentHash(id),
        instructionDigest: canonicalContentHash(instruction), progressDigest: canonicalContentHash(progress),
      }
      return withImmediateTransaction(database, () => claimAutomaticContinuationInTransaction(database, input))
    }
    for (let i = 1; i <= 5; i++) assert.equal(claim(i, i).decision, 'deliver')
    assert.equal(claim(6, 5, 'worded differently').decision, 'replan')
    assert.equal(claim(6, 5).replayed, true)
    assert.equal(claim(7, 5).decision, 'blocked')
    assert.equal(claim(8, 4).decision, 'replan', 'returning to earlier evidence is not progress')
    assert.equal(claim(9, 4).decision, 'blocked')
    assert.equal(claim(10, 6).decision, 'deliver')
  } finally { database.close() }
})

test('upgrade preserves old delivery history and does not retry a reserved native dispatch', () => {
  const previous = mkdtempSync(join(tmpdir(), 'continuation-v1-'))
  const database = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  try {
    for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql') && name < '052_'))
      copyFileSync(join('migrations', name), join(previous, name))
    migrateDatabase(database, previous)
    seedRun(database)
    const receipt = 'a'.repeat(64), continuation = 'b'.repeat(64), job = 'c'.repeat(64), digest = 'd'.repeat(64)
    database.prepare(`INSERT INTO dsh_turn_intents
      (receipt_id,run_id,dsh_session_id,native_turn,phase,contract_revision,input_digest,operation,idempotency_key,continuation_id,boundary_job_id,created_at)
      VALUES (?,'run','session',1,'planning',1,?,'plan_submit','original',?,?,'now')`).run(receipt, digest, continuation, job)
    database.prepare(`INSERT INTO dsh_turn_receipts
      (receipt_id,run_id,dsh_session_id,native_turn,phase,contract_revision,input_digest,outcome_kind,created_at)
      VALUES (?,'run','session',1,'planning',1,?,'applied','now')`).run(receipt, digest)
    database.prepare(`INSERT INTO dsh_continuation_outbox
      (continuation_id,receipt_id,run_id,dsh_session_id,causal_revision,message_json,status,created_at,updated_at)
      VALUES (?,?,'run','session',1,'{}','pending','now','now')`).run(continuation, receipt)
    database.prepare(`INSERT INTO dsh_boundary_jobs
      (job_id,receipt_id,run_id,kind,status,available_at,created_at,updated_at)
      VALUES (?,?,'run','delivery','waiting_user','now','now','now')`).run(job, receipt)
    database.prepare(`INSERT INTO dsh_loop_guard_states
      (run_id,dsh_session_id,instruction_digest,automatic_count,status,blocked_claim_id,created_at,updated_at)
      VALUES ('run','session',?,3,'waiting_user',?,'now','now')`).run(digest, continuation)
    database.prepare(`INSERT INTO dsh_loop_guard_claims
      (claim_id,run_id,dsh_session_id,instruction_digest,generation,ordinal,decision,created_at)
      VALUES (?,'run','session',?,0,4,'wait_user','now')`).run(continuation, digest)
    assert.deepEqual(migrateDatabase(database).applied, [52, 53, 54, 55, 56])
    assert.equal(database.prepare('SELECT decision FROM dsh_loop_guard_claims').get()?.decision, 'wait_user')
    assert.equal(database.prepare('SELECT status FROM dsh_boundary_jobs').get()?.status, 'pending')
    assert.equal(reserveOutboxDelivery(database, continuation, 'then'), true)
    assert.equal(reserveOutboxDelivery(database, continuation, 'later'), false)
    assert.equal(readPendingOutbox(database, 'session')[0]?.deliveryReserved, true)
    const message = { id: continuation, source: { kind: 'plugin:kiokuko-dsh', form: 'instructions' },
      content: [{ type: 'text', text: 'Continue the retained task.' }] }
    database.prepare('UPDATE dsh_continuation_outbox SET message_json=?').run(JSON.stringify(message))
    const observation = { type: 'user/message', seq: 42, data: { ...message, turn: 2 } }
    assert.equal(reconcileOutboxObservations(database, 'foreign-session', [observation]), 0)
    assert.equal(reconcileOutboxObservations(database, 'session', [{ ...observation, data: { ...message, content: [] } }]), 0)
    assert.equal(reconcileOutboxObservations(database, 'session', []), 0)
    assert.equal(readPendingOutbox(database, 'session')[0]?.deliveryReserved, true, 'absence never permits resend')
    assert.equal(reconcileOutboxObservations(database, 'session', [observation]), 1)
    assert.equal(reconcileOutboxObservations(database, 'session', [observation]), 0)
    assert.equal(readPendingOutbox(database, 'session').length, 0)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { database.close(); rmSync(previous, { recursive: true, force: true }) }
})
