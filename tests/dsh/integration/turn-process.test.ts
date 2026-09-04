import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
