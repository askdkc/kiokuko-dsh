import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { verificationBoundaryKey } from '../../../../src/dsh/verification-identity.js'
import { answerEnno, finishEnno, prepareEnnoVerification, reportEnnoWork, submitEnnoPlan, submitOdunoIdeal, submitOdunoMeditation } from '../../../../src/enno-oduno/service.js'
import { readEnnoSnapshot } from '../../../../src/enno-oduno/store.js'

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Focuses functions.' },
]

async function fixture(command: string, maxAttempts = 8) {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-final-evidence-'))
  const repository = join(root, 'repo')
  await mkdir(repository)
  await writeFile(join(repository, 'source.txt'), 'original')
  execFileSync('git', ['init', '-q', repository])
  // Keep Kiokuko's own DB outside the repository under verification.
  const database = openConnection(join(root, 'state.sqlite3'))
  const cleanup = async () => { database.close(); await rm(root, { recursive: true, force: true }) }
  try {
    migrateDatabase(database, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(database, {
      requestId: 'final-evidence', cwd: repository, task: 'Implement and verify source.txt',
      profileHints: { taskType: 'build', target: 'source.txt', expected: 'verified output', constraints: null },
      capabilities, dshSessionId: 'evidence-session', skillDiscoveryMode: 'off',
    })
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId }
    const snapshot = () => readEnnoSnapshot(database, identity)
    submitOdunoIdeal(database, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal',
      ideal: { objective: 'Verify the implementation', principles: ['Require fresh evidence'], skillContributions: [], successSignals: ['verified'] } })
    const plan = await submitEnnoPlan(database, { ...identity, expectedRevision: 1, idempotencyKey: 'plan',
      scope: ['source.txt'], exclusions: [], acceptanceCriteria: [{ id: 'verified', description: 'Fresh evidence exists' }],
      workPlan: { objective: 'Verify source', units: [{
        id: 'work', objective: 'Implement source', scope: ['source.txt'], dependencies: [], routes: ['code'],
        skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify behavior' }],
        acceptanceCriteria: ['Verified'], focusedVerifiers: [{ id: 'focused', kind: 'test', executable: process.execPath,
          args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000 }],
      }] },
      skillRequirements: [], finalVerifiers: [{ id: 'final-build', kind: 'build', executable: process.execPath,
        args: ['--eval', command], cwd: '.', timeoutMs: 5_000 }], maxAttempts, capabilities,
      provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' },
    })
    const approved = plan.ennoOduno.nextAction === 'ask_user_confirmation'
      ? answerEnno(database, { ...identity, expectedRevision: 2, idempotencyKey: 'approve', action: 'approve' }) : plan
    const lease = approved.executionLease!
    const report = await reportEnnoWork(database, { ...identity, expectedRevision: 2, idempotencyKey: 'work',
      workUnitId: 'work', leaseToken: lease.leaseToken, routeEpoch: lease.routeEpoch,
      result: { outcome: 'completed', summary: 'Implemented', mutated: false, changedPaths: [] },
    }, { descendantSettleMs: 0 })
    assert.equal(report.ennoOduno.nextAction, 'run_final_verification')
    const input = () => ({ ...identity, expectedRevision: snapshot().revision, idempotencyKey: verificationBoundaryKey(snapshot()) })
    return { database, repository, identity, snapshot, input, cleanup }
  } catch (error) { await cleanup(); throw error }
}

for (const [label, command] of [
  ['build artifact', 'require("node:fs").writeFileSync("source.elc", "compiled")'],
  ['source edit', 'require("node:fs").writeFileSync("source.txt", "changed")'],
  ['temporary edit restored', 'const fs = require("node:fs"); fs.writeFileSync("source.txt", "changed"); setTimeout(() => fs.writeFileSync("source.txt", "original"), 100)'],
]) {
  test(`final verification hands ${label} to planning instead of looping on a completed receipt`, async () => {
    const f = await fixture(command!)
    try {
      const input = f.input()
      const response = await prepareEnnoVerification(f.database, input, { descendantSettleMs: 50 })
      assert.equal(response.verifierResults?.[0]?.status, 'passed', 'exit 0 alone is not sufficient')
      assert.equal(response.verifierResults?.[0]?.changedDuringVerification, true)
      assert.equal(response.ennoOduno.nextAction, 'submit_plan')
      assert.equal(response.ennoOduno.contractRevision, 3)
      assert.equal(f.snapshot().finalEvidenceReady, false)
      assert.equal(f.snapshot().attempts, 2)
      assert.match(JSON.stringify(response.ennoOduno.directive), /Repository changes were observed/)
      assert.deepEqual(await prepareEnnoVerification(f.database, input), response)
      assert.equal(f.snapshot().attempts, 2, 'receipt replay must not charge another attempt')
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM enno_verifier_runs WHERE work_unit_id IS NULL').get()?.n, 1)
      await assert.rejects(finishEnno(f.database, { ...f.identity, expectedRevision: 2, idempotencyKey: 'unsafe-finish',
        review: { decision: 'accept', summary: 'Do not accept stale evidence' } }))
      if (label === 'build artifact') assert.equal(await readFile(join(f.repository, 'source.elc'), 'utf8'), 'compiled')
    } finally { await f.cleanup() }
  })
}

test('external edits require a new verification identity even without a contract revision change', async () => {
  const f = await fixture('process.exit(0)')
  try {
    const first = f.input()
    const response = await prepareEnnoVerification(f.database, first, { descendantSettleMs: 0 })
    assert.equal(response.ennoOduno.nextAction, 'submit_final_review')
    assert.equal(f.input().idempotencyKey, first.idempotencyKey)
    const current = f.snapshot()
    assert.notEqual(verificationBoundaryKey({ ...current, mutationRevision: current.mutationRevision + 1 }), first.idempotencyKey)
    assert.notEqual(verificationBoundaryKey({ ...current, contract: { ...current.contract,
      finalVerifiers: [{ ...current.contract.finalVerifiers[0]!, args: ['--eval', 'process.exit(1)'] }],
    } }), first.idempotencyKey)
    await writeFile(join(f.repository, 'source.txt'), 'external edit')
    assert.equal(f.snapshot().finalEvidenceReady, false)
    const second = f.input()
    assert.notEqual(second.idempotencyKey, first.idempotencyKey)
    assert.equal(second.expectedRevision, first.expectedRevision)
    const refreshed = await prepareEnnoVerification(f.database, second, { descendantSettleMs: 0 })
    assert.equal(refreshed.ennoOduno.nextAction, 'submit_final_review')
    assert.equal(f.snapshot().finalEvidenceReady, true)
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM enno_verifier_runs WHERE work_unit_id IS NULL').get()?.n, 2)
  } finally { await f.cleanup() }
})

test('a nonzero verifier with stable evidence still reaches final review, never automatic acceptance', async () => {
  const f = await fixture('process.exit(1)')
  try {
    const verified = await prepareEnnoVerification(f.database, f.input(), { descendantSettleMs: 0 })
    assert.equal(verified.ennoOduno.nextAction, 'submit_final_review')
    assert.equal(verified.verifierResults?.[0]?.status, 'failed')
    const reviewed = await finishEnno(f.database, { ...f.identity, expectedRevision: 2, idempotencyKey: 'failed-review',
      review: { decision: 'accept', summary: 'An exit failure cannot be accepted' },
    })
    assert.equal(reviewed.ennoOduno.nextAction, 'submit_plan')
  } finally { await f.cleanup() }
})

test('mutation at the attempt limit blocks instead of creating an unbounded replan', async () => {
  const f = await fixture('require("node:fs").writeFileSync("source.elc", "compiled")', 2)
  try {
    const response = await prepareEnnoVerification(f.database, f.input(), { descendantSettleMs: 0 })
    assert.equal(response.ennoOduno.status, 'blocked')
    assert.equal(f.snapshot().attempts, 2)
    assert.equal(f.database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get(f.identity.runId)?.status, 'failed')
  } finally { await f.cleanup() }
})

test('a corrected verifier proceeds through plan approval, work, review and meditation to completion', async () => {
  const f = await fixture('require("node:fs").writeFileSync("source.elc", "compiled")')
  try {
    await prepareEnnoVerification(f.database, f.input(), { descendantSettleMs: 0 })
    const rejected = f.snapshot()
    assert.equal(rejected.status, 'zenki_planning')
    const { scope, exclusions, acceptanceCriteria, workPlan, provenance, maxAttempts } = rejected.contract
    const revised = await submitEnnoPlan(f.database, { ...f.identity, expectedRevision: rejected.revision,
      idempotencyKey: 'corrected-plan', scope, exclusions, acceptanceCriteria, workPlan, skillRequirements: [], provenance,
      maxAttempts, capabilities, finalVerifiers: [{ ...rejected.contract.finalVerifiers[0], args: ['--eval', 'process.exit(0)'] }],
    })
    assert.equal(revised.ennoOduno.nextAction, 'ask_user_confirmation', 'repair never silently bypasses approval')
    const revision = revised.ennoOduno.contractRevision!
    const approved = answerEnno(f.database, { ...f.identity, expectedRevision: revision, idempotencyKey: 'approve-repair', action: 'approve' })
    await reportEnnoWork(f.database, { ...f.identity, expectedRevision: revision, idempotencyKey: 'work-repair',
      workUnitId: 'work', leaseToken: approved.executionLease!.leaseToken, routeEpoch: approved.executionLease!.routeEpoch,
      result: { outcome: 'completed', summary: 'Verified existing work against corrected plan', mutated: false, changedPaths: [] },
    }, { descendantSettleMs: 0 })
    const verified = await prepareEnnoVerification(f.database, f.input(), { descendantSettleMs: 0 })
    assert.equal(verified.ennoOduno.nextAction, 'submit_final_review')
    const reviewed = await finishEnno(f.database, { ...f.identity, expectedRevision: revision, idempotencyKey: 'review-repair',
      review: { decision: 'accept', summary: 'Fresh verification passed' },
    })
    assert.equal(reviewed.ennoOduno.nextAction, 'submit_meditation')
    const completed = submitOdunoMeditation(f.database, { ...f.identity, expectedRevision: revision, idempotencyKey: 'meditate-repair',
      meditation: { summary: 'No deletion necessary', inspectedPaths: ['source.txt'], deletionCandidates: [] },
    })
    assert.equal(completed.ennoOduno.status, 'completed')
    assert.equal(await readFile(join(f.repository, 'source.elc'), 'utf8'), 'compiled')
  } finally { await f.cleanup() }
})
