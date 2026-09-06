import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import {
  commitExpectedFailure,
  enqueueUnsubmittedTurn,
  prepareTurnIntent,
  readPendingOutbox,
  readTurnSeal,
} from '../../../src/dsh/turn-process.js'
import { KiokukoError } from '../../../src/errors.js'

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work to Kiokuko Skills.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Shapes focused functions.' },
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-turn-process-'))
  await mkdir(join(root, 'src'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(database, {
    requestId: 'turn-process-request',
    cwd: root,
    task: 'Implement one durable phase per turn',
    profileHints: { taskType: 'build', target: 'src/process.ts', expected: 'focused turns', constraints: null },
    capabilities,
    dshSessionId: 'turn-process-session',
    skillDiscoveryMode: 'off',
  })
  return {
    root,
    database,
    prepared,
    cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('Enno completion atomically creates the turn receipt, handoff, boundary job, outbox, and seal', async () => {
  const f = await fixture()
  try {
    const identity = {
      runId: f.prepared.run.runId,
      workspace: f.prepared.project.workspace,
      orchestrationId: f.prepared.intake.sessionId,
    }
    const idempotencyKey = 'turn-process-ideal'
    const inputDigest = canonicalContentHash({ objective: 'one phase' })
    const intent = prepareTurnIntent(f.database, {
      runId: identity.runId,
      dshSessionId: 'turn-process-session',
      nativeTurn: 1,
      phase: 'ideal',
      contractRevision: 1,
      inputDigest,
      operation: 'ideal_submit',
      idempotencyKey,
    })

    submitOdunoIdeal(f.database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey,
      ideal: {
        objective: 'Keep one phase per model turn',
        principles: ['Commit the handoff atomically'],
        skillContributions: [],
        successSignals: ['the next action is planning'],
      },
    })

    const seal = readTurnSeal(f.database, 'turn-process-session', 1)
    assert.equal(seal?.receiptId, intent.receiptId)
    assert.equal(seal?.outcomeKind, 'applied')
    assert.equal(seal?.nextAction, 'submit_plan')
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_turn_handoffs').get<{ count: number }>()?.count, 1)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_boundary_jobs').get<{ count: number }>()?.count, 1)
    const outbox = readPendingOutbox(f.database, 'turn-process-session')
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.continuationId, intent.continuationId)
    assert.equal(outbox[0]?.messageForm, 'continuation')
    assert.deepEqual((outbox[0]?.message as { source?: unknown }).source, {
      kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
    })

    // Enno replay does not duplicate any process effect.
    submitOdunoIdeal(f.database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey,
      ideal: {
        objective: 'Keep one phase per model turn',
        principles: ['Commit the handoff atomically'],
        skillContributions: [],
        successSignals: ['the next action is planning'],
      },
    })
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_turn_receipts').get<{ count: number }>()?.count, 1)
  } finally {
    await f.cleanup()
  }
})

test('outbox migration normalizes pending legacy messages and preserves dispatched payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-outbox-form-migration-'))
  const version6Directory = join(root, 'v6')
  await mkdir(version6Directory)
  for (const name of [
    '001_baseline.sql',
    '002_dsh_memory_finalization.sql',
    '003_dsh_turn_process.sql',
    '004_dsh_loop_guard.sql',
    '005_dsh_completion_recovery.sql',
    '006_dsh_execution_support.sql',
  ]) await copyFile(join(process.cwd(), 'migrations', name), join(version6Directory, name))
  const database = openConnection(join(root, 'data.sqlite3'))
  try {
    migrateDatabase(database, version6Directory)
    const prepared = await prepareAgentTask(database, {
      requestId: 'outbox-form-migration',
      cwd: root,
      task: 'Test outbox form migration',
      profileHints: { taskType: 'build', target: 'src/process.ts', expected: 'safe migration', constraints: null },
      capabilities,
      dshSessionId: 'outbox-form-session',
      skillDiscoveryMode: 'off',
    })
    const common = {
      runId: prepared.run.runId,
      dshSessionId: 'outbox-form-session',
      phase: 'ideal' as const,
      contractRevision: 1,
      operation: 'ideal_submit' as const,
      error: new KiokukoError('VALIDATION_ERROR', 'legacy outbox test'),
    }
    const recovery = commitExpectedFailure(database, {
      ...common,
      nativeTurn: 1,
      idempotencyKey: 'legacy-recovery',
      inputDigest: canonicalContentHash({ turn: 1 }),
    })
    const dispatched = commitExpectedFailure(database, {
      ...common,
      nativeTurn: 2,
      idempotencyKey: 'legacy-continuation',
      inputDigest: canonicalContentHash({ turn: 2 }),
    })
    const legacyMessage = (id: string, form: 'continuation' | 'loop-recovery') => JSON.stringify({
      id,
      role: 'user',
      content: [{ type: 'text', text: 'legacy message' }],
      source: { kind: 'plugin', plugin: 'kiokuko-dsh', form, deliveryId: id },
    })
    const dispatchedRow = database.prepare(`
      SELECT continuation_id AS continuationId FROM dsh_continuation_outbox
       WHERE dsh_session_id = ? ORDER BY continuation_id LIMIT 1 OFFSET 1
    `).get<{ continuationId: string }>('outbox-form-session')
    if (dispatchedRow === undefined) throw new Error('missing dispatched outbox fixture')
    const pendingRow = database.prepare(`
      SELECT continuation_id AS continuationId FROM dsh_continuation_outbox
       WHERE dsh_session_id = ? ORDER BY continuation_id LIMIT 1
    `).get<{ continuationId: string }>('outbox-form-session')
    if (pendingRow === undefined) throw new Error('missing pending outbox fixture')
    const oldDispatchedMessage = legacyMessage(dispatchedRow.continuationId, 'continuation')
    database.prepare(`UPDATE dsh_continuation_outbox SET message_json = ?, status = 'dispatched'
      WHERE continuation_id = ?`).run(oldDispatchedMessage, dispatchedRow.continuationId)
    database.prepare(`UPDATE dsh_continuation_outbox SET message_json = ?, status = 'pending'
      WHERE continuation_id = ?`).run(legacyMessage(pendingRow.continuationId, 'loop-recovery'), pendingRow.continuationId)

    assert.deepEqual(migrateDatabase(database, join(process.cwd(), 'migrations')).applied, [7])
    const pending = database.prepare(`
      SELECT message_form AS messageForm, message_json AS messageJson
        FROM dsh_continuation_outbox WHERE continuation_id = ?
    `).get<{ messageForm: string; messageJson: string }>(pendingRow.continuationId)
    const retained = database.prepare(`
      SELECT message_form AS messageForm, message_json AS messageJson
        FROM dsh_continuation_outbox WHERE continuation_id = ?
    `).get<{ messageForm: string; messageJson: string }>(dispatchedRow.continuationId)
    assert.equal(pending?.messageForm, 'loop-recovery')
    assert.deepEqual(JSON.parse(pending?.messageJson ?? '{}').source, {
      kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
    })
    assert.equal(retained?.messageForm, 'continuation')
    assert.equal(retained?.messageJson, oldDispatchedMessage)
    assert.throws(() => database.prepare(`UPDATE dsh_continuation_outbox SET message_form = 'invalid'`).run(), /CHECK/u)
    assert.equal(recovery.kind, 'retry')
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unsubmitted and expected-failure continuations emit schema-safe plugin sources', async () => {
  const f = await fixture()
  try {
    enqueueUnsubmittedTurn(f.database, {
      runId: f.prepared.run.runId,
      dshSessionId: 'emit-session',
      nativeTurn: 1,
      phase: 'ideal',
      contractRevision: 1,
      workUnitId: 'unit',
      inputDigest: canonicalContentHash({ turn: 1 }),
      operation: 'ideal_submit',
      idempotencyKey: 'emit-unsubmitted',
      nextAction: 'submit_plan',
    })
    commitExpectedFailure(f.database, {
      runId: f.prepared.run.runId,
      dshSessionId: 'emit-session',
      nativeTurn: 2,
      phase: 'ideal',
      contractRevision: 1,
      operation: 'ideal_submit',
      error: new KiokukoError('VALIDATION_ERROR', 'emit test rejection'),
      inputDigest: canonicalContentHash({ turn: 2 }),
      idempotencyKey: 'emit-failure',
    })
    const outbox = readPendingOutbox(f.database, 'emit-session')
    assert.equal(outbox.length, 2)
    for (const item of outbox) {
      assert.deepEqual((item.message as { source?: unknown }).source, {
        kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
      })
      assert.equal(Object.hasOwn((item.message as Record<string, unknown>)['source'] as object, 'deliveryId'), false)
      assert.equal(item.messageForm, 'continuation')
    }
  } finally {
    await f.cleanup()
  }
})

test('predictable failures become retry then Akinator clarification without a tool transport error', async () => {
  const f = await fixture()
  try {
    const common = {
      runId: f.prepared.run.runId,
      dshSessionId: 'turn-process-session',
      phase: 'ideal' as const,
      contractRevision: 1,
      operation: 'ideal_submit' as const,
      error: new KiokukoError('VALIDATION_ERROR', 'objective is incomplete'),
      inputDigest: canonicalContentHash({ invalid: 'same-input' }),
    }
    const first = commitExpectedFailure(f.database, {
      ...common, nativeTurn: 1, idempotencyKey: 'invalid-ideal-1',
    })
    assert.equal(first.kind, 'retry')
    const second = commitExpectedFailure(f.database, {
      ...common, nativeTurn: 2, idempotencyKey: 'invalid-ideal-2',
    })
    assert.equal(second.kind, 'clarify')
    if (second.kind === 'clarify') assert.equal(second.question.id, 'expected')
    assert.equal(f.database.prepare('SELECT failure_count AS count FROM dsh_temporary_memories').get<{ count: number }>()?.count, 2)
    assert.equal(readTurnSeal(f.database, 'turn-process-session', 1)?.outcomeKind, 'retry')
    assert.equal(readTurnSeal(f.database, 'turn-process-session', 2)?.outcomeKind, 'clarify')

    const changed = commitExpectedFailure(f.database, {
      ...common,
      nativeTurn: 3,
      inputDigest: canonicalContentHash({ invalid: 'user-corrected-input' }),
      idempotencyKey: 'invalid-ideal-corrected',
    })
    assert.equal(changed.kind, 'retry')
  } finally {
    await f.cleanup()
  }
})
