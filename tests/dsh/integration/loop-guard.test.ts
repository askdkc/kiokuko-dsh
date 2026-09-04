import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import {
  claimBoundaryEffectInTransaction,
  claimAutomaticContinuationInTransaction,
  claimLoopRecoveryQuestionInTransaction,
  resetLoopGuardForUserInTransaction,
} from '../../../src/dsh/loop-guard.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { claimBoundaryJobInTransaction, completeBoundaryJobInTransaction, prepareTurnIntent } from '../../../src/dsh/turn-process.js'
import { submitOdunoIdeal } from '../../../src/enno-oduno/service.js'

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Focuses functions.' },
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-loop-guard-'))
  await mkdir(join(root, 'src'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(database, {
    requestId: 'loop-guard-request', cwd: root, task: 'Bound automatic continuation',
    profileHints: { taskType: 'build', target: 'src/loop.ts', expected: 'bounded', constraints: null },
    capabilities, dshSessionId: 'loop-session', skillDiscoveryMode: 'off',
  })
  return {
    database,
    runId: prepared.run.runId,
    prepared,
    cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('three unique automatic continuations are allowed and the fourth waits for the user', async () => {
  const f = await fixture()
  try {
    const instructionDigest = canonicalContentHash({ revision: 1, nextAction: 'submit_ideal' })
    const decisions = [1, 2, 3, 4].map((ordinal) => claimAutomaticContinuationInTransaction(f.database, {
      claimId: canonicalContentHash({ kind: 'delivery', ordinal }),
      runId: f.runId,
      dshSessionId: 'loop-session',
      instructionDigest,
      now: `2026-01-01T00:00:0${ordinal}.000Z`,
    }))
    assert.deepEqual(decisions.map(({ decision }) => decision), ['deliver', 'deliver', 'deliver', 'wait_user'])
    assert.deepEqual(decisions.map(({ ordinal }) => ordinal), [1, 2, 3, 4])

    const replay = claimAutomaticContinuationInTransaction(f.database, {
      claimId: canonicalContentHash({ kind: 'delivery', ordinal: 4 }),
      runId: f.runId,
      dshSessionId: 'loop-session',
      instructionDigest,
    })
    assert.equal(replay.decision, 'wait_user')
    assert.equal(replay.replayed, true)
    assert.equal(claimLoopRecoveryQuestionInTransaction(f.database, replay.claimId), true)
    assert.equal(claimLoopRecoveryQuestionInTransaction(f.database, replay.claimId), false)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_loop_guard_claims').get<{ count: number }>()?.count, 4)
    const state = f.database.prepare('SELECT automatic_count AS count, status FROM dsh_loop_guard_states')
      .get<{ count: number; status: string }>()
    assert.equal(state?.count, 3)
    assert.equal(state?.status, 'waiting_user')
  } finally {
    await f.cleanup()
  }
})

test('a stateful boundary effect waits before the fourth execution without progress', async () => {
  const f = await fixture()
  try {
    const idempotencyKey = 'loop-effect-ideal'
    prepareTurnIntent(f.database, {
      runId: f.runId, dshSessionId: 'loop-session', nativeTurn: 1,
      phase: 'ideal', contractRevision: 1, inputDigest: canonicalContentHash({ ideal: true }),
      operation: 'ideal_submit', idempotencyKey,
    })
    submitOdunoIdeal(f.database, {
      runId: f.runId,
      workspace: f.prepared.project.workspace,
      orchestrationId: f.prepared.intake.sessionId,
      expectedRevision: 1,
      idempotencyKey,
      ideal: {
        objective: 'Bound stateful effects', principles: ['Stop without progress'],
        skillContributions: [], successSignals: ['fourth waits'],
      },
    })
    const progressDigest = canonicalContentHash({ unchanged: true })
    const decisions: string[] = []
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = claimBoundaryJobInTransaction(
        f.database,
        `owner-${attempt}`,
        `2099-01-01T00:00:0${attempt}.000Z`,
        'loop-session',
      )
      assert.ok(job)
      const claim = claimBoundaryEffectInTransaction(f.database, job, progressDigest)
      decisions.push(claim.decision)
      completeBoundaryJobInTransaction(
        f.database,
        job,
        claim.decision === 'wait_user'
          ? { kind: 'waiting_user' }
          : { kind: 'completed', nextKind: 'classify_boundary' },
      )
    }
    assert.deepEqual(decisions, ['deliver', 'deliver', 'deliver', 'wait_user'])
  } finally {
    await f.cleanup()
  }
})

test('authoritative progress and explicit user input reset the loop generation', async () => {
  const f = await fixture()
  try {
    const firstDigest = canonicalContentHash({ revision: 1 })
    const secondDigest = canonicalContentHash({ revision: 2 })
    for (const ordinal of [1, 2, 3]) {
      claimAutomaticContinuationInTransaction(f.database, {
        claimId: canonicalContentHash({ first: ordinal }), runId: f.runId,
        dshSessionId: 'loop-session', instructionDigest: firstDigest,
      })
    }
    const progressed = claimAutomaticContinuationInTransaction(f.database, {
      claimId: canonicalContentHash({ progressed: true }), runId: f.runId,
      dshSessionId: 'loop-session', instructionDigest: secondDigest,
    })
    assert.equal(progressed.decision, 'deliver')
    assert.equal(progressed.ordinal, 1)

    resetLoopGuardForUserInTransaction(f.database, {
      runId: f.runId, dshSessionId: 'loop-session', resolution: 'manual_user',
    })
    const afterUser = claimAutomaticContinuationInTransaction(f.database, {
      claimId: canonicalContentHash({ afterUser: true }), runId: f.runId,
      dshSessionId: 'loop-session', instructionDigest: secondDigest,
    })
    assert.equal(afterUser.decision, 'deliver')
    assert.equal(afterUser.ordinal, 1)
  } finally {
    await f.cleanup()
  }
})
