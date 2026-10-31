import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { prepareTurnIntent } from '../../../src/dsh/turn-process.js'
import { submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { DshCompletionReporter, completionReportText, completionVerificationReport } from '../../../src/dsh/completion-report.js'
import type { DshRuntime, DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { readEnnoSnapshot } from '../../../src/enno-oduno/store.js'
import { runVerifier } from '../../../src/enno-oduno/verifier.js'
import type { EnnoRunSnapshot, VerifierRunResult } from '../../../src/enno-oduno/types.js'
import type { DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-completion-report-'))
  await mkdir(join(root, 'src'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(database, {
    requestId: 'report-request', cwd: root, task: 'Build a report', dshSessionId: 'report-session',
    profileHints: { taskType: 'build', target: 'src', expected: 'visible results', constraints: null },
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }],
    skillDiscoveryMode: 'off',
  })
  const intent = prepareTurnIntent(database, {
    runId: prepared.run.runId, dshSessionId: 'report-session', nativeTurn: 1, phase: 'ideal',
    contractRevision: 1, inputDigest: canonicalContentHash({ ideal: 1 }), operation: 'ideal_submit', idempotencyKey: 'report-ideal',
  })
  submitOdunoIdeal(database, {
    runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
    expectedRevision: 1, idempotencyKey: 'report-ideal',
    ideal: { objective: 'Report', principles: ['Truth'], skillContributions: [], successSignals: ['Visible'] },
  })
  database.prepare("UPDATE enno_contracts SET status = 'completed' WHERE run_id = ?").run(prepared.run.runId)
  database.prepare("UPDATE dsh_turn_receipts SET next_action = 'complete' WHERE receipt_id = ?").run(intent.receiptId)
  database.prepare('INSERT INTO dsh_completion_reports(run_id, receipt_id, dsh_session_id, native_turn) VALUES (?, ?, ?, 1)')
    .run(prepared.run.runId, intent.receiptId, 'report-session')
  const events: DshLogEvent[] = [{ type: 'tool/result', seq: 0, time: 0, data: { turn: 1, ennoOduno: { nextAction: 'complete' } } }]
  const session = { id: 'report-session', header: { cwd: root }, snapshotEvents: () => events,
    append(type: string, data: unknown) { const event = { type, data, seq: events.length, time: 0 }; events.push(event); return event } }
  const runtime: Pick<DshRuntime, 'withDatabase'> = { withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(database, undefined as never) }
  const notices = () => database.prepare('SELECT * FROM dsh_session_notices').all<{text:string;kind:string;delivered:number}>()
  return { database, events, session, runtime, notices,
    snapshot: () => readEnnoSnapshot(database, { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId }), cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) } }
}

test('completion fallback flushes before ack and deduplicates a crash replay', async () => {
  const f = await fixture()
  try {
    await assert.rejects(new DshCompletionReporter(f.runtime, async () => { throw new Error('flush failed') }).deliver(f.session), /flush failed/u)
    assert.equal(f.events.length, 1)
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'pending')
    const recovered = new DshCompletionReporter(f.runtime, async () => undefined)
    await Promise.all([recovered.deliver(f.session), recovered.deliver(f.session)])
    assert.equal(f.events.length, 1)
    assert.equal(f.notices().length, 1)
    assert.equal(f.notices()[0]?.kind, 'report')
    assert.equal(f.notices()[0]?.delivered, 0)
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'delivered')
    assert.match(f.notices()[0]!.text, /No recorded results/u)
  } finally { await f.cleanup() }
})

test('a nonempty model final response suppresses the host fallback', async () => {
  const f = await fixture()
  try {
    f.events.push({ type: 'assistant/message', seq: 1, time: 0, data: { turn: 1,
      message: { content: [{ type: 'text', text: 'Completed and checked.' }] } } })
    await new DshCompletionReporter(f.runtime, async () => undefined).deliver(f.session)
    assert.equal(f.events.length, 2)
    assert.equal(f.database.prepare('SELECT delivered_seq AS seq FROM dsh_completion_reports').get()?.seq, 1)
  } finally { await f.cleanup() }
})

test('text following a work report cannot hide a later host verification blocker', async () => {
  const f = await fixture()
  try {
    f.database.prepare("UPDATE dsh_turn_receipts SET next_action = 'run_final_verification'").run()
    f.database.prepare("UPDATE enno_contracts SET status = 'blocked', blocker = 'Final verification failed'").run()
    f.events.push({ type: 'assistant/message', seq: 1, time: 0, data: { turn: 1,
      message: { content: [{ type: 'text', text: 'Implementation is ready for verification.' }] } } })
    await new DshCompletionReporter(f.runtime, async () => undefined).deliver(f.session)
    assert.equal(f.notices().length, 1)
    assert.match(f.notices()[0]!.text, /Final verification failed/)
  } finally { await f.cleanup() }
})

test('corrupt or unavailable auxiliary evidence cannot prevent the durable final report', async () => {
  const f = await fixture()
  try {
    f.database.prepare('DROP TABLE dsh_execution_evidence').run()
    await new DshCompletionReporter(f.runtime, async () => undefined).deliver(f.session)
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'delivered')
    assert.equal(f.database.prepare('SELECT status FROM enno_contracts').get()?.status, 'completed')
    assert.match(f.notices()[0]!.text, /Auxiliary evidence: unknown/)
    assert.match(f.notices()[0]!.text, /No recorded results/)
  } finally { await f.cleanup() }
})

function observation(id: string, status: 'passed' | 'failed'): VerifierRunResult {
  return { verifier: { id, kind: 'test', executable: process.execPath, args: [], cwd: '.', timeoutMs: 1000 },
    status, exitCode: status === 'passed' ? 0 : 1, signal: null, durationMs: 1,
    stdoutPreview: '', stderrPreview: '', stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64) }
}
function measured(snapshot: EnnoRunSnapshot, checks: VerifierRunResult[]): EnnoRunSnapshot {
  return { ...snapshot, finalEvidenceReady: true, finalEvidence: checks,
    contract: { ...snapshot.contract, finalVerifiers: checks.map(check => check.verifier) } }
}

test('mixed measurements cannot become an overall pass through a sandbox explanation or forecast', async () => {
  const f = await fixture()
  try {
    const failed = { ...observation('tests', 'failed'), tapSummary: { tests: 313, pass: 279, fail: 33, cancelled: 1, skipped: 0, todo: 0 } }
    const snapshot = measured(f.snapshot(), [observation('typecheck', 'passed'), observation('build', 'passed'), failed])
    snapshot.blocker = 'Likely caused by the sandbox; expected to pass in another environment.'
    snapshot.meditation = { summary: 'Build succeeded; the running application probably has this change.', inspectedPaths: [], deletionCandidates: [] }
    const before = JSON.stringify(snapshot), text = completionReportText(snapshot)
    assert.doesNotMatch(text, /^The requested work is complete/u)
    assert.match(text, /Observed verification: failed/u)
    assert.match(text, /tests: failed/u); assert.match(text, /fail=33, cancelled=1/u)
    assert.match(text, /Unverified explanations/u)
    assert.match(text, /Other environments and deployed runtime: unverified/u)
    assert.equal(JSON.stringify(snapshot), before, 'reporting does not change stored completion or observations')
  } finally { await f.cleanup() }
})

test('completed state without recorded checks is reported as unverified by the actual outbox', async () => {
  const f = await fixture()
  try {
    await new DshCompletionReporter(f.runtime, async () => undefined).deliver(f.session)
    const text = f.notices()[0]!.text
    assert.doesNotMatch(text, /^The requested work is complete/u)
    assert.match(text, /Observed verification: unverified/u)
    assert.equal(f.database.prepare('SELECT status FROM enno_contracts').get()?.status, 'completed', 'the report never rewrites task state')
  } finally { await f.cleanup() }
})

test('only a later measured passing check changes the recorded outcome; outside scope stays unverified', async () => {
  const f = await fixture()
  try {
    const file = join(f.session.header.cwd, 'check.cjs')
    const spec = { id: 'selected-tests', kind: 'test' as const, executable: process.execPath,
      args: ['--test', '--test-reporter=tap', 'check.cjs'], cwd: '.', timeoutMs: 5000 }
    await writeFile(file, "require('node:test')('contract',()=>require('node:assert/strict').equal(1,2))\n")
    const failed = await runVerifier(spec, f.session.header.cwd)
    assert.equal(failed.status, 'failed'); assert.equal(failed.tapSummary?.fail, 1)
    const previous = completionReportText(measured(f.snapshot(), [failed]))
    assert.match(previous, /Observed verification: failed/u)
    await writeFile(file, "require('node:test')('contract',()=>require('node:assert/strict').equal(1,1))\n")
    const passed = await runVerifier(spec, f.session.header.cwd)
    assert.equal(passed.status, 'passed'); assert.equal(passed.tapSummary?.pass, 1)
    assert.equal(passed.skipped, false, 'the zero-skipped TAP trailer is not a SKIP directive')
    const next = completionReportText(measured(f.snapshot(), [passed]))
    assert.match(next, /Observed verification: passed/u)
    assert.match(next, /Other environments and deployed runtime: unverified/u)
    assert.match(previous, /selected-tests: failed/u, 'later measurements cannot rewrite the old report')
    await writeFile(file, "require('node:test')('contract',{skip:true},()=>{})\n")
    const skipped = await runVerifier(spec, f.session.header.cwd)
    assert.equal(skipped.skipped, true); assert.equal(skipped.tapSummary?.skipped, 1)
    assert.match(completionReportText(measured(f.snapshot(), [skipped])), /Observed verification: unverified/u)
  } finally { await f.cleanup() }
})

test('verification projection retains incomplete scope, contradictory counts and process failures', async () => {
  const f = await fixture()
  try {
    const pass = observation('local', 'passed'), required = observation('external', 'passed').verifier
    const complete = measured(f.snapshot(), [pass])
    assert.equal(completionVerificationReport(complete).status, 'passed')
    const missing = { ...complete, contract: { ...complete.contract, finalVerifiers: [pass.verifier, required] } }
    const pending = completionVerificationReport(missing)
    assert.equal(pending.status, 'unverified'); assert.deepEqual(pending.missingVerifierIds, ['external'])
    assert.equal(completionVerificationReport({ ...complete, finalEvidenceReady: false }).status, 'unverified')
    assert.equal(completionVerificationReport({ ...complete, finalEvidence: [pass, pass] }).status, 'unverified')
    assert.equal(completionVerificationReport({ ...complete, finalEvidence: [{ ...pass, skipped: true }] }).status, 'unverified')
    assert.equal(completionVerificationReport({ ...complete, finalEvidence: [{ ...pass, changedDuringVerification: true }] }).status, 'unverified')
    for (const row of [{ ...pass, exitCode: 1 }, { ...pass, signal: 'SIGTERM' }, { ...pass, status: 'timeout' as const },
      { ...pass, status: 'spawn_failed' as const }, { ...pass, tapSummary: { tests: 34, pass: 0, fail: 33, cancelled: 1, skipped: 0, todo: 0 } }]) {
      const report = completionVerificationReport({ ...complete, finalEvidence: [row] })
      assert.equal(report.status, 'failed'); assert.equal(report.checks[0]!.recordedStatus, row.status)
      assert.equal(report.otherEnvironments, 'unverified'); assert.equal(report.deployedRuntime, 'unverified')
    }
    const ja = completionReportText({ ...missing, userFacingLanguage: 'ja' })
    assert.match(ja, /実測された検証: unverified/u); assert.match(ja, /別環境と稼働中runtime: 未検証/u)
    assert.match(ja, /未確認の必須チェック: external/u)
  } finally { await f.cleanup() }
})

test('streamed zero-skip summary and an EOF SKIP directive remain distinct', async () => {
  const f = await fixture()
  try {
    const spec = { id: 'stream-check', kind: 'custom' as const, executable: process.execPath,
      args: ['--eval', "process.stdout.write('# SKIP');setTimeout(()=>process.stdout.write('ped 0\\n'),20)"], cwd: '.', timeoutMs: 5000 }
    const zero = await runVerifier(spec, f.session.header.cwd)
    assert.equal(zero.status, 'passed'); assert.equal(zero.skipped, false)
    const skipped = await runVerifier({ ...spec, args: ['--eval', "process.stdout.write('ok 1 - pending # SKIP')"] }, f.session.header.cwd)
    assert.equal(skipped.skipped, true, 'a complete EOF directive still records a real skip')
  } finally { await f.cleanup() }
})
