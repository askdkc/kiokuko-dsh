import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { createBoundaries } from '../../../src/dsh/host-adapter/boundaries.js'
import { DshCompletionReporter, decideCompletionRecovery, dshTurnEndBoundary } from '../../../src/dsh/completion-report.js'
import { dshNoticeResponse } from '../../../src/dsh/session-notice-surface.js'
import type { DeepPlanningController } from '../../../src/deep-thinker/controller.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import {
  assessTaskCompletion,
  beginTaskCompletionExecution,
  bindTaskCriterion,
  finishTaskCompletionExecution,
} from '../../../src/dsh/task-completion.js'
import type { DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'

const TAP = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
const METHOD = {
  kind: 'native_command' as const,
  command: 'node --test --test-reporter=tap src/check.test.ts',
  cwd: '.',
  sourcePaths: ['src/check.test.ts'],
  assertion: 'selected_tests_pass' as const,
}

interface FixtureOptions {
  readonly acceptance?: 'verified' | 'none'
  readonly status?: 'active' | 'completed'
}

async function fixture(options: FixtureOptions = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'kiokuko-completion-report-')))
  const root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/check.test.ts'), 'test source')
  await writeFile(join(root, 'evidence.txt'), 'Actual current evidence')
  const db = openConnection(join(base, 'state.sqlite3'))
  migrateDatabase(db, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(db, {
    requestId: `completion-report-${options.acceptance ?? 'none'}-${options.status ?? 'active'}`,
    cwd: root,
    task: options.acceptance === 'verified'
      ? 'Report the observed output.\n完了条件:\n- The selected test passes'
      : 'Read evidence.txt and report its actual contents.',
    dshSessionId: 'report-session',
    profileHints: { taskType: 'research', target: 'evidence.txt', expected: 'report', constraints: null },
    ...(options.acceptance === 'verified' ? { completionMode: 'enforce' as const } : {}),
    capabilities: [],
    skillDiscoveryMode: 'off',
  })
  const runId = prepared.run.runId
  const ledger = new LedgerStore(db)
  if (ledger.readRun(runId)?.status !== 'active') ledger.updateRunStatus(runId, 'active')
  if (options.acceptance === 'verified') {
    for (const [index, criterion] of assessTaskCompletion(db, runId).criteria.entries())
      bindTaskCriterion(db, { runId, callId: `bind-${index}`, criterionId: criterion.criterionId, method: METHOD, approved: true })
    for (const [index] of assessTaskCompletion(db, runId).criteria.entries()) {
      const callId = `observed-${index}`
      beginTaskCompletionExecution(db, { runId, callId, command: METHOD.command, repositoryRoot: root })
      finishTaskCompletionExecution(db, { runId, callId, result: {
        value: { exitCode: 0 }, content: [{ type: 'text', text: TAP }],
      } })
    }
    assert.equal(assessTaskCompletion(db, runId).verified, true, 'fixture must hold real acceptance evidence')
  }
  if (options.status === 'completed') ledger.updateRunStatus(runId, 'completed')
  const events: DshLogEvent[] = []
  const session = {
    id: 'report-session',
    header: { cwd: root },
    append: () => {},
    snapshotEvents: () => events,
  }
  /** The turn receipt is the report's identity source; its trigger creates the pending row. */
  const report = (turn: number, nextAction: string | null) => {
    const receiptId = createHash('sha256').update(`${runId}:${turn}:${nextAction ?? 'none'}`).digest('hex')
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO dsh_turn_intents(receipt_id, run_id, dsh_session_id, native_turn, phase,
      contract_revision, work_unit_key, input_digest, operation, idempotency_key, continuation_id,
      boundary_job_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receiptId, runId, session.id, turn, 'complete', turn, '', 'a'.repeat(64), 'finish',
        `idempotency-${turn}`, createHash('sha256').update(`continuation:${turn}`).digest('hex'),
        createHash('sha256').update(`job:${turn}`).digest('hex'), now)
    db.prepare(`INSERT INTO dsh_turn_receipts(receipt_id, run_id, dsh_session_id, native_turn, phase,
      contract_revision, work_unit_key, input_digest, outcome_kind, next_action, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receiptId, runId, session.id, turn, 'complete', turn, '', 'a'.repeat(64), 'applied', nextAction, now)
    if (nextAction === null || !['complete', 'report_blocker'].includes(nextAction))
      db.prepare('INSERT INTO dsh_completion_reports(run_id, receipt_id, dsh_session_id, native_turn) VALUES(?,?,?,?)')
        .run(runId, receiptId, session.id, turn)
    return receiptId
  }
  const end = (turn: number, kind: string, seq: number): DshLogEvent =>
    ({ type: 'turn/end', seq, time: Date.now(), data: { turn, reason: { kind } } })
  const reportNotice = (): string | undefined =>
    db.prepare("SELECT text FROM dsh_session_notices WHERE run_id=? AND kind='report'")
      .get<{ text: string }>(runId)?.text
  const reportStatus = (): string | undefined =>
    db.prepare('SELECT status FROM dsh_completion_reports WHERE run_id=?').get<{ status: string }>(runId)?.status
  const flush = async () => {}
  const reporter = new DshCompletionReporter(
    { withDatabase: async (fn: (database: typeof db) => unknown) => await fn(db) } as never,
    flush,
  )
  return {
    db, root, runId, prepared, events, session, report, end, reportNotice, reportStatus, reporter,
    async dispose() { db.close(); await rm(base, { recursive: true, force: true }) },
  }
}

const until = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

/** Drive the real session-start recovery path with only the close effect observed. */
async function mountRecovery(f: Awaited<ReturnType<typeof fixture>>, flushOverride?: () => Promise<void>) {
  const listeners = new Map<string, (...args: any[]) => unknown>()
  const ctx = { on(name: string, listener: (...args: any[]) => unknown) { listeners.set(name, listener); return () => listeners.delete(name) } }
  const closed: Array<{ runId: string; status: string; sourceEndSeq?: number }> = []
  const agent = { id: 'report-agent', status: 'idle', session: f.session }
  const boundaries = createBoundaries({
    isGenericNativeChild: () => false,
    ctx: ctx as never,
    runtime: { withDatabase: async (fn: (database: typeof f.db) => unknown) => await fn(f.db) } as never,
    now: undefined,
    agents: { get: (id: string) => (id === agent.id ? agent : undefined), list: () => [] },
    sessions: {
      get: (id: string) => (id === f.session.id ? f.session : undefined),
      flush: flushOverride ?? (async () => {}),
    },
    skills: undefined,
    tools: undefined,
    gate: {} as never,
    executionSupport: { paused: () => false } as never,
    answerReview: { recover: async () => {} } as never,
    sessionMirror: { checkpointAfterNativeFlush: async () => {} } as never,
    currentSession: () => undefined,
    capabilityCatalog: async () => ({}),
    closeTurn: async input => { closed.push(input) },
    sessionEventSource: () => f.session,
  })
  return {
    closed,
    start: () => { void (listeners.get('agent/session-start') as (payload: unknown) => unknown)({ agent }) },
    dispose: () => { boundaries.boundarySessionStartDisposer(); boundaries.clear() },
  }
}

test('a missing final turn end never records the active run as complete', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    await f.reporter.deliver(f.session)
    const text = f.reportNotice()
    assert.ok(text)
    assert.match(text, /still records this run as active/)
    assert.match(text, /no end of its final native turn is recorded; completion is unverified/u)
    assert.match(text, /Purpose verification: no acceptance evidence tied to this request was observed/u)
    assert.doesNotMatch(text, /recorded as complete/u)
    assert.equal(f.reportStatus(), 'delivered')
  } finally { await f.dispose() }
})

test('polling a saved report reflects a later ledger close while preserving its verification snapshot', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'completed', 4))
    await f.reporter.deliver(f.session)
    const saved = f.reportNotice()
    assert.match(saved!, /《active》/u)
    assert.match(saved!, /no acceptance evidence tied to this request was observed/u)
    const host = {
      store: { database: async (fn: (db: typeof f.db) => unknown) => fn(f.db) },
      options: { sessions: new Map([[f.session.id, f.session]]) },
    } as unknown as DeepPlanningController
    const request = new Request(`http://localhost/api/kiokuko.notices?sessionId=${f.session.id}`)
    const before = await dshNoticeResponse(host, request)
    request.headers.set('if-none-match', before.headers.get('etag')!)
    new LedgerStore(f.db).updateRunStatus(f.runId, 'completed')
    const after = await dshNoticeResponse(host, request)
    assert.equal(after.status, 200, 'ledger-only transitions invalidate the cached report')
    const { items: [report] } = await after.json()
    assert.equal(report.currentRunStatus, 'completed')
    assert.equal(report.text, saved)
    assert.equal(f.reportNotice(), saved)
    request.headers.set('if-none-match', after.headers.get('etag')!)
    assert.equal((await dshNoticeResponse(host, request)).status, 304)
  } finally { await f.dispose() }
})

test('an explicit stop is reported as stopped and retires the ledger as cancelled', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'aborted', 5))
    const recovery = await mountRecovery(f)
    try {
      recovery.start()
      await until(() => recovery.closed.length > 0, 'the aborted run close')
      assert.match(f.reportNotice()!, /stopped before completion: its final native turn was interrupted/u)
      assert.doesNotMatch(f.reportNotice()!, /records this run as completed/u)
      assert.deepEqual(recovery.closed, [{ runId: f.runId, status: 'cancelled', sourceEndSeq: 5 }])
    } finally { recovery.dispose() }
  } finally { await f.dispose() }
})

test('an abnormal stop is reported as stopped and retires the ledger as failed', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'error', 7))
    const recovery = await mountRecovery(f)
    try {
      recovery.start()
      await until(() => recovery.closed.length > 0, 'the failed run close')
      assert.match(f.reportNotice()!, /ended with an error/u)
      assert.deepEqual(recovery.closed, [{ runId: f.runId, status: 'failed', sourceEndSeq: 7 }])
    } finally { recovery.dispose() }
  } finally { await f.dispose() }
})

test('a reported blocker stays active and is never closed as complete', async () => {
  const f = await fixture()
  try {
    f.report(1, 'report_blocker')
    f.events.push(f.end(1, 'completed', 9))
    const recovery = await mountRecovery(f)
    try {
      recovery.start()
      await until(() => f.reportStatus() === 'delivered', 'the blocker report')
      await settle()
      assert.match(f.reportNotice()!, /reported a blocker; this run remains active/u)
      assert.match(f.reportNotice()!, /completion is unverified/u)
      assert.deepEqual(recovery.closed, [])
      assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{ status: string }>(f.runId)?.status, 'active')
    } finally { recovery.dispose() }
  } finally { await f.dispose() }
})

test('a completed ledger run is only described as terminal without acceptance evidence', async () => {
  const f = await fixture({ status: 'completed' })
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'completed', 3))
    await f.reporter.deliver(f.session)
    const text = f.reportNotice()!
    assert.match(text, /The ledger records this run as completed/u)
    assert.match(text, /That is the ledger terminal state, not a fresh verification/u)
    assert.match(text, /Purpose verification: no acceptance evidence tied to this request was observed/u)
    assert.doesNotMatch(text, /the requested outcome was verified/u)
  } finally { await f.dispose() }
})

test('a completed ledger that contradicts its own turn end is reported as unverified', async () => {
  const f = await fixture({ status: 'completed' })
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'aborted', 6))
    await f.reporter.deliver(f.session)
    const text = f.reportNotice()!
    assert.match(text, /The ledger records this run as completed, but its final native turn was interrupted/u)
    assert.match(text, /the evidence is contradictory and completion is unverified/u)
  } finally { await f.dispose() }
})

test('a completed ledger run reports the acceptance evidence tied to its request', async () => {
  const f = await fixture({ acceptance: 'verified', status: 'completed' })
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'completed', 3))
    await f.reporter.deliver(f.session)
    const text = f.reportNotice()!
    assert.match(text, /The ledger records this run as completed/u)
    assert.match(text, /Purpose verification: the requested outcome was verified by acceptance evidence tied to this request/u)
  } finally { await f.dispose() }
})

test('the recovery judgement keeps terminal state, verification and close separate', () => {
  const base = {
    runStatus: 'active', nextAction: 'complete', endReason: 'completed',
    verification: 'unverified' as const,
  }
  assert.deepEqual(decideCompletionRecovery(base),
    { result: 'completed', detail: 'native_turn_completed', close: 'completed' })
  assert.deepEqual(decideCompletionRecovery({ ...base, verification: 'unresolved' }),
    { result: 'unverified', detail: 'required_evidence_unresolved' })
  assert.deepEqual(decideCompletionRecovery({ ...base, verification: 'unavailable' }),
    { result: 'unverified', detail: 'completion_unavailable' })
  assert.equal(decideCompletionRecovery({ ...base, nextAction: 'report_blocker' }).result, 'blocked')
  assert.equal(decideCompletionRecovery({ ...base, nextAction: null }).result, 'unverified')
  assert.equal(decideCompletionRecovery({ ...base, endReason: undefined }).result, 'unverified')
  assert.equal(decideCompletionRecovery({ ...base, endReason: 'max-tokens' }).close, undefined)
  assert.deepEqual(decideCompletionRecovery({ ...base, endReason: 'error' }),
    { result: 'stopped', detail: 'native_turn_error', close: 'failed' })
  assert.deepEqual(decideCompletionRecovery({ ...base, endReason: 'aborted' }),
    { result: 'stopped', detail: 'native_turn_aborted', close: 'cancelled' })
  assert.equal(decideCompletionRecovery({ ...base, runStatus: 'cancelled' }).result, 'stopped')
  assert.equal(decideCompletionRecovery({ ...base, runStatus: undefined }).result, 'unverified')
  assert.deepEqual(decideCompletionRecovery({ ...base, runStatus: 'completed' }),
    { result: 'completed', detail: 'ledger_terminal' })
  assert.equal(decideCompletionRecovery({ ...base, runStatus: 'completed', endReason: 'aborted' }).result, 'unverified')
})

test('the recovery end lookup never borrows or throws on a missing or ambiguous turn end', () => {
  const end = (turn: number, kind: string, seq: number): DshLogEvent =>
    ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind } } })
  assert.equal(dshTurnEndBoundary([], 1), undefined)
  assert.equal(dshTurnEndBoundary([end(2, 'completed', 2)], 1), undefined)
  assert.equal(dshTurnEndBoundary([end(1, 'completed', 3), end(1, 'error', 4)], 1), undefined)
  assert.deepEqual(dshTurnEndBoundary([end(1, 'completed', 3)], 1), { seq: 3, reason: 'completed' })
})

test('an unrelated native turn end leaves the report unclosed', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    f.events.push(f.end(2, 'completed', 11))
    const recovery = await mountRecovery(f)
    try {
      recovery.start()
      await until(() => f.reportStatus() === 'delivered', 'the unrelated-end report')
      await settle()
      assert.deepEqual(recovery.closed, [])
      assert.match(f.reportNotice()!, /no end of its final native turn is recorded/u)
    } finally { recovery.dispose() }
  } finally { await f.dispose() }
})

test('a failed history flush keeps the report pending and re-delivers it once', async () => {
  const f = await fixture()
  try {
    f.report(1, 'complete')
    f.events.push(f.end(1, 'completed', 4))
    let fail = true
    const recovery = await mountRecovery(f, async () => {
      if (!fail) return
      fail = false
      throw new Error('native flush unavailable')
    })
    try {
      recovery.start()
      await until(() => f.reportNotice() !== undefined, 'the first notice attempt')
      await settle()
      assert.equal(f.reportStatus(), 'pending')
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM dsh_session_notices WHERE run_id=? AND kind='report'")
        .get<{ n: number }>(f.runId)?.n, 1)
      recovery.start()
      await until(() => recovery.closed.length > 0, 'the retried close')
      assert.equal(f.reportStatus(), 'delivered')
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM dsh_session_notices WHERE run_id=? AND kind='report'")
        .get<{ n: number }>(f.runId)?.n, 1, 're-delivery must not add another notice')
      assert.deepEqual(recovery.closed, [{ runId: f.runId, status: 'completed', sourceEndSeq: 4 }])
    } finally { recovery.dispose() }
  } finally { await f.dispose() }
})
