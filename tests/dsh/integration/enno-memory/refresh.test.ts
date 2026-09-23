import { submitReviewedPlan } from '../../helpers/reviewed-plan.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, failure } from './fixture.js'
import { renderScopedRetrievalQuery } from '../../../../src/context/retrieval-query.js'
import { federatedEntries } from '../../../../src/memory/federated-retrieval.js'
import { currentRequestMemory } from '../../../../src/dsh/request-memory.js'
import { injectDshContext } from '../../../../src/dsh/context-injection.js'
import { readRefreshMetadata, reserveMemoryRefresh } from '../../../../src/dsh/enno-memory-refresh-store.js'
import { DshEnnoMemoryRefresh } from '../../../../src/dsh/enno-memory-refresh.js'
import { openConnection } from '../../../../src/db/connection.js'
import { readContextDelivery } from '../../../../src/context/delivery.js'

for (const mode of ['off','observe','active'] as const) test(`${mode}: discover an error outside 200 initial candidates, then reuse without another Full`, async () => {
  const f = await fixture(mode, 200)
  try {
    const initial = f.prepared, identity = f.db.prepare('SELECT * FROM enno_contracts WHERE run_id=?').get(initial.run.runId)
    const candidates = await federatedEntries(f.db, { project: initial.project,
      query: renderScopedRetrievalQuery({ task: 'QUEUE_TEST_BASELINE を修正', taskProfile: initial.intake.profile, recommendedTags: initial.intake.recommendedTags }), limit: 200 })
    assert.equal(candidates.length, 200); assert.ok(!candidates.some(hit => hit.entry.id === f.correct.id))
    await f.service.refresh(f.binding())
    assert.equal(readRefreshMetadata(f.db, initial.run.runId)?.fullCount ?? 0, 0)
    f.service.observeResult(initial.run.runId, f.agent, f.session, f.root, failure)
    await f.service.refresh(f.binding())
    if (mode === 'active') {
      assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id), JSON.stringify(f.observations))
      assert.equal(readRefreshMetadata(f.db, initial.run.runId)?.fullCount, 1)
      assert.equal(f.prepared.context?.policyVersion, 'context-ranking-v8')
      const messages = await injectDshContext({ prepared: f.prepared, task: 'QUEUE_TEST_BASELINE', runtime: f.runtime })
      assert.match(JSON.stringify(messages), /Only fifo-mode: release latch after quiescence/)
      assert.match(JSON.stringify(messages), /Never apply to damaged storage/)
      assert.equal(readContextDelivery(f.db, { workspace: initial.project.workspace, deliveryId: f.prepared.context!.deliveryId! }).policyVersion, 'context-ranking-v8')
      f.service.observeResult(initial.run.runId, f.agent, f.session, f.root, failure)
      await f.service.refresh(f.binding())
      assert.equal(readRefreshMetadata(f.db, initial.run.runId)?.fullCount, 1)
      f.db.prepare("UPDATE entries SET status='superseded',superseded_by=? WHERE id=?").run(initial.context!.items[0]!.entryId, f.correct.id)
      assert.ok(!currentRequestMemory(f.db, f.prepared).has(`memory:memory:${f.correct.id}`))
    } else {
      assert.equal(f.prepared, initial); assert.equal(readRefreshMetadata(f.db, initial.run.runId), undefined)
      assert.equal(f.observations.length, mode === 'off' ? 0 : 2)
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM enno_contracts WHERE run_id=?').get(initial.run.runId), identity)
    assert.ok(f.observations.every(o => o.remoteCalls === 0 && o.llmCalls === 0 && o.embeddingCalls === 0))
  } finally { await f.close() }
})

test('durable reservations survive a new connection and cold restart; two hosts cannot exceed the run budget', async () => {
  const f = await fixture('active', 1, 2)
  try {
    await f.service.refresh(f.binding())
    const db2 = openConnection(f.path)
    try {
      const reserve = (db: typeof db2) => reserveMemoryRefresh(db, { runId: f.prepared.run.runId, config: 'a'.repeat(64), full: true, maxFull: 2, assertCurrent: () => {} })
      assert.equal(reserve(f.db)?.fullCount, 1); assert.equal(reserve(db2)?.fullCount, 2); assert.equal(reserve(f.db), undefined)
    } finally { db2.close() }
    f.prepared = { ...f.prepared, context: null }
    const restarted = new DshEnnoMemoryRefresh(f.runtime, f.config, o => f.observations.push(o))
    await restarted.refresh(f.binding()); restarted.close()
    assert.equal(f.prepared.context, null); assert.equal(f.observations.at(-1)?.reason, 'budget_exhausted')
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 2)
  } finally { await f.close() }
})

test('late results and config disable cannot replace current input or retain the active selection', async () => {
  const f = await fixture()
  try {
    const baseline = f.prepared.context
    await f.service.refresh(f.binding())
    f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
    const pending = f.service.refresh(f.binding()); f.supersede(); await pending
    assert.ok(!f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    assert.equal(f.observations.at(-1)?.resultDiscarded, true)
    await f.service.refresh(f.binding())
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    f.service.configure({ ...f.config, mode: 'off' })
    assert.deepEqual(f.prepared.context, baseline)
    assert.ok(!currentRequestMemory(f.db, f.prepared).has(`memory:memory:${f.correct.id}`))
  } finally { await f.close() }
})

test('current capability gate applies when initial memory was empty; cold resume is a new budgeted search', async () => {
  const f = await fixture()
  try {
    f.prepared = { ...f.prepared, context: null }
    const binding = f.binding()
    await f.service.refresh({ ...binding, capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }], constraints: 'E_LOCK_TIMEOUT' })
    assert.equal(f.prepared.context, null); assert.equal(f.prepared.memoryPolicy.contextWithheld, true)
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 1)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM context_deliveries WHERE policy_version='context-ranking-v8'").get()?.n, 0)
    const withheld = f.prepared
    const required = new DshEnnoMemoryRefresh({ withDatabase: async operation =>
      f.runtime.withDatabase(db => operation(db, { mode: 'required' } as never)) }, f.config,
    () => { throw new Error('optional observer failure') })
    await required.refresh(f.binding()); required.close()
    assert.equal(f.prepared, withheld, 'required semantic contract cannot silently become lexical retrieval')
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 2, 'failed reserved work is not refunded')
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM context_deliveries WHERE policy_version='context-ranking-v8'").get()?.n, 0)
  } finally { await f.close() }
})

test('phase-only changes rebind delivery without retrieval or intake mutation', async () => {
  const f = await fixture()
  try {
    const { submitOdunoIdeal } = await import('../../../../src/enno-oduno/service.js')
    const initialProfile = structuredClone(f.prepared.intake.profile)
    await f.service.refresh(f.binding())
    const oldDelivery = f.prepared.context!.deliveryId
    const oldMetadata = readRefreshMetadata(f.db, f.prepared.run.runId)
    await f.service.refresh(f.binding())
    assert.equal(f.prepared.context!.deliveryId, oldDelivery, 'identical refresh must keep the current delivery')
    assert.deepEqual(readRefreshMetadata(f.db, f.prepared.run.runId), oldMetadata, 'identical refresh must not reserve again')
    const response = submitOdunoIdeal(f.db, { runId: f.prepared.run.runId, workspace: f.prepared.project.workspace,
      orchestrationId: f.prepared.intake.sessionId, expectedRevision: 1, idempotencyKey: 'phase-only',
      ideal: { objective: 'Implement source', principles: ['Verify'], skillContributions: [], successSignals: ['verified'] } })
    f.prepared = { ...f.prepared, ennoOduno: response.ennoOduno }
    await f.service.refresh(f.binding())
    assert.equal(f.observations.at(-1)?.decision, 'reuse')
    assert.equal(f.observations.at(-1)?.retrievalMs, 0)
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 0)
    assert.notEqual(f.prepared.context!.deliveryId, oldDelivery)
    assert.deepEqual(f.prepared.intake.profile, initialProfile)
    // Completed host verifier evidence can reach Zenki even without a native tools/result event.
    f.db.prepare(`INSERT INTO enno_verifier_runs(verifier_run_id,run_id,contract_revision,mutation_revision,
      verifier_id,verifier_json,status,exit_code,duration_ms,stderr_preview,started_at,finished_at)
      VALUES('refresh-verifier',?,1,0,'verify','{}','timeout',NULL,1000,'E_LOCK_TIMEOUT',?,?)`)
      .run(f.prepared.run.runId, new Date().toISOString(), new Date().toISOString())
    await f.service.refresh(f.binding())
    assert.equal(f.prepared.ennoOduno.status, 'zenki_planning')
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 1)
    await f.service.refresh(f.binding())
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 1)
  } finally { await f.close() }
})

test('simultaneous boundaries share one search, failed delivery rolls back metadata without refund, and DB failure preserves input', async () => {
  const f = await fixture()
  try {
    await f.service.refresh(f.binding())
    f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
    const initial = f.prepared.context
    f.db.exec("CREATE TEMP TRIGGER refresh_fail BEFORE INSERT ON context_deliveries WHEN NEW.policy_version='context-ranking-v8' BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END")
    await Promise.all([f.service.refresh(f.binding()), f.service.refresh(f.binding())])
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 1)
    assert.equal(f.prepared.context, initial)
    f.db.exec('DROP TRIGGER refresh_fail')
    await Promise.all([f.service.refresh(f.binding()), f.service.refresh(f.binding())])
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 2)
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    const before = f.prepared
    const unavailable = new DshEnnoMemoryRefresh({ withDatabase: async () => { throw new Error('unavailable') } }, f.config)
    await unavailable.refresh(f.binding()); unavailable.close()
    assert.equal(f.prepared, before)
  } finally { await f.close() }
})

test('new corpus entries trigger discovery, cancellation and terminal states never revive a run', async () => {
  const f = await fixture()
  try {
    await f.service.refresh(f.binding())
    const { recordEntry } = await import('../../../../src/memory/entries.js')
    const fresh = recordEntry(f.db, { workspace: f.prepared.project.workspace, title: 'QUEUE_TEST_BASELINE new guidance',
      body: 'New corpus evidence', kind: 'reference', scope: { visibility: 'project' }, createdBy: 'fixture' })
    await f.service.refresh(f.binding())
    assert.equal(f.observations.at(-1)?.reason, 'corpus_changed')
    assert.ok(f.prepared.context?.items.some(item => item.entryId === fresh.id))
    f.abort.abort()
    const count = readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount
    await f.service.refresh(f.binding())
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, count)
    f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.prepared.run.runId)
    assert.throws(() => reserveMemoryRefresh(f.db, { runId: f.prepared.run.runId, config: 'a'.repeat(64), full: true, maxFull: 8, assertCurrent: () => {} }), /not active/)
  } finally { await f.close() }
})

test('execution requires the current lease and does not accept a replaced native owner', async () => {
  const f = await fixture()
  try {
    const { submitOdunoIdeal, answerEnno } = await import('../../../../src/enno-oduno/service.js')
    const identity = { runId: f.prepared.run.runId, workspace: f.prepared.project.workspace, orchestrationId: f.prepared.intake.sessionId }
    submitOdunoIdeal(f.db, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal', ideal: { objective: 'QUEUE_TEST_BASELINE', principles: ['Verify'], skillContributions: [], successSignals: ['verified'] } })
    const verifier = { id: 'verify', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }
    await submitReviewedPlan(f.db, { ...identity, expectedRevision: 1, idempotencyKey: 'plan', scope: ['src'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Verified' }],
      workPlan: { objective: 'QUEUE_TEST_BASELINE', units: [{ id: 'unit', objective: 'QUEUE_TEST_BASELINE', scope: ['src'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify' }], acceptanceCriteria: ['Verified'], focusedVerifiers: [verifier] }] },
      skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3, capabilities: f.binding().capabilities,
      provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' } })
    const approved = answerEnno(f.db, { ...identity, expectedRevision: 2, idempotencyKey: 'approve', action: 'approve' })
    f.prepared = { ...f.prepared, ennoOduno: approved.ennoOduno }
    const before = f.prepared
    await f.service.refresh({ ...f.binding(), leaseToken: 'wrong' })
    assert.equal(f.prepared, before); assert.equal(readRefreshMetadata(f.db, identity.runId), undefined)
    await f.service.refresh({ ...f.binding(), leaseToken: approved.executionLease!.leaseToken })
    assert.equal(f.observations.at(-1)?.resultDiscarded, false)
    f.service.observeResult(identity.runId, {}, f.session, f.root, failure)
    await f.service.refresh({ ...f.binding(), leaseToken: approved.executionLease!.leaseToken })
    assert.equal(readRefreshMetadata(f.db, identity.runId)?.fullCount, 0, 'unbound native result was ignored')
    f.db.prepare("UPDATE enno_execution_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").run(identity.runId)
    const accepted = f.prepared
    await f.service.refresh({ ...f.binding(), leaseToken: approved.executionLease!.leaseToken })
    assert.equal(f.prepared, accepted); assert.equal(f.observations.at(-1)?.resultDiscarded, true)
  } finally { await f.close() }
})

test('failure on the first active boundary does not swallow a later new error into the baseline', async () => {
  const f = await fixture()
  try {
    let fail = true
    const service = new DshEnnoMemoryRefresh({ withDatabase: async operation => {
      if (fail) throw new Error('initial optional storage failure')
      return f.runtime.withDatabase(operation)
    } }, f.config)
    await service.refresh(f.binding()); fail = false
    service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
    await service.refresh(f.binding())
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    assert.equal(readRefreshMetadata(f.db, f.prepared.run.runId)?.fullCount, 1)
    service.close()
  } finally { await f.close() }
})

test('a late capability check, deadline or mode change cannot commit additional context', async () => {
  const f = await fixture()
  try {
    await f.service.refresh(f.binding())
    const initial = f.prepared.context
    f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
    await f.service.refresh({ ...f.binding(), validateCapabilities: async () => { throw new Error('catalog changed') } })
    assert.equal(f.prepared.context, initial)
    f.service.configure({ ...f.config, localBudgetMs: 100 })
    await f.service.refresh({ ...f.binding(), validateCapabilities: async () => { await new Promise(resolve => setTimeout(resolve, 150)) } })
    assert.equal(f.observations.at(-1)?.reason, 'time_budget')
    assert.ok(!f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    f.service.configure({ ...f.config, mode: 'observe' }); await f.service.refresh(f.binding())
    f.service.configure(f.config); await f.service.refresh(f.binding())
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    assert.equal(f.observations.at(-1)?.reason, 'config_changed')
  } finally { await f.close() }
})

test('owner eviction restores the initial selection so disabling cannot retain an evicted active selection', async () => {
  const f = await fixture()
  try {
    const baseline = f.prepared.context
    await f.service.refresh(f.binding())
    f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
    await f.service.refresh(f.binding())
    assert.ok(f.prepared.context?.items.some(item => item.entryId === f.correct.id))
    // Other admitted bindings whose optional DB reads are unavailable still occupy bounded owners.
    for (let n = 0; n < 32; n++) await f.service.refresh({ ...f.binding(), runId: `unavailable-run-${n}`, apply: () => {} })
    assert.deepEqual(f.prepared.context, baseline)
    f.service.configure({ ...f.config, mode: 'off' })
    assert.deepEqual(f.prepared.context, baseline)
  } finally { await f.close() }
})
