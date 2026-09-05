import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { prepareTurnIntent } from '../../../src/dsh/turn-process.js'
import { submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { DshCompletionReporter } from '../../../src/dsh/completion-report.js'
import type { DshRuntime, DshDatabaseOperation } from '../../../src/dsh/runtime.js'
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
  database.prepare('INSERT INTO dsh_completion_reports(run_id, receipt_id, dsh_session_id, native_turn) VALUES (?, ?, ?, 1)')
    .run(prepared.run.runId, intent.receiptId, 'report-session')
  const events: DshLogEvent[] = [{ type: 'tool/result', seq: 0, time: 0, data: { turn: 1, ennoOduno: { nextAction: 'complete' } } }]
  const session = { id: 'report-session', snapshotEvents: () => events,
    append(type: string, data: unknown) { const event = { type, data, seq: events.length, time: 0 }; events.push(event); return event } }
  const runtime: Pick<DshRuntime, 'withDatabase'> = { withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(database, undefined as never) }
  return { database, events, session, runtime, cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) } }
}

test('completion fallback flushes before ack and deduplicates a crash replay', async () => {
  const f = await fixture()
  try {
    await assert.rejects(new DshCompletionReporter(f.runtime, async () => { throw new Error('flush failed') }).deliver(f.session), /flush failed/u)
    assert.equal(f.events.length, 2)
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'pending')
    const recovered = new DshCompletionReporter(f.runtime, async () => undefined)
    await Promise.all([recovered.deliver(f.session), recovered.deliver(f.session)])
    assert.equal(f.events.length, 2)
    assert.equal(f.events[1]?.type, 'kiokuko/completion-report')
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'delivered')
    assert.match((f.events[1]?.data as { text: string }).text, /No recorded results/u)
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

test('corrupt or unavailable auxiliary evidence cannot prevent the durable final report', async () => {
  const f = await fixture()
  try {
    f.database.prepare('DROP TABLE dsh_execution_evidence').run()
    await new DshCompletionReporter(f.runtime, async () => undefined).deliver(f.session)
    assert.equal(f.database.prepare('SELECT status FROM dsh_completion_reports').get()?.status, 'delivered')
    assert.equal(f.database.prepare('SELECT status FROM enno_contracts').get()?.status, 'completed')
    assert.match((f.events[1]?.data as { text: string }).text, /Auxiliary evidence: unknown/)
    assert.match((f.events[1]?.data as { text: string }).text, /No recorded results/)
  } finally { await f.cleanup() }
})
