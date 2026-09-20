import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { submitOdunoIdeal, reviewEnnoPlan, submitEnnoPlan } from '../../../../src/enno-oduno/service.js'
import { readEnnoSnapshot, updateContractInTransaction } from '../../../../src/enno-oduno/store.js'
import { readPlanDraft } from '../../../../src/enno-oduno/plan-draft.js'
import { advisorySlotDefinitions } from '../../../../src/enno-oduno/advisory.js'
import { DecisionService, databaseDecisionStore } from '../../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { NimbleDecisionProvider, TypeSafeDecisionProvider } from '../../../../src/dsh/decisions/providers.js'
import { reviewPlanDecisions } from '../../../../src/dsh/decisions/plan-review.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'typed-plan-')), root = join(dir, 'repo'); await mkdir(root)
  const db = openConnection(join(dir, 'state.db')); migrateDatabase(db, join(process.cwd(), 'migrations'))
  const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }]
  const task = await prepareAgentTask(db, { requestId: 'draft', cwd: root, task: 'Implement the parser', profileHints: { taskType: 'build', target: 'src', expected: 'Parser verified' }, capabilities, dshSessionId: 'parent', skillDiscoveryMode: 'off' })
  const identity = { runId: task.run.runId, workspace: task.project.workspace, orchestrationId: task.intake.sessionId }
  submitOdunoIdeal(db, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal', ideal: { objective: 'Implement parser', principles: ['Verify'], skillContributions: [], successSignals: ['Verified'] } })
  const verifier = { id: 'test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }
  const plan = { ...identity, expectedRevision: 1, idempotencyKey: 'candidate', capabilities, scope: ['src'], exclusions: [], acceptanceCriteria: [{ id: 'parser', description: 'Parser verified' }],
    workPlan: { objective: 'Implement parser', units: [{ id: 'unit', objective: 'Implement parser', scope: ['src'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify parser' }], acceptanceCriteria: ['Parser verified'], focusedVerifiers: [verifier] }] },
    skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3,
    provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' } }
  return { db, plan, identity, cleanup: async () => { db.close(); await rm(dir, { recursive: true, force: true }) } }
}
const success = async () => ({ backend: { provider: 'fixture', requestedModel: 'check' }, contributions: advisorySlotDefinitions('planning').map(s => ({ slotId: s.slotId, outcome: 'completed' as const, summary: 'Reviewed complete candidate', recommendations: [] })) })
for (const kind of ['typesafe', 'nimble'] as const) test(`${kind}: reviewed candidate, catalog and dispositions are required; exact replay avoids calls`, async () => {
  const f = await fixture()
  try {
    let calls = 0, fallback = 0
    const config = TypedDecisionsConfig.parse({ provider: kind, nimble: { endpoint: 'http://localhost:8000/v1/systemone', model: 'fixture' } })
    const http: typeof fetch = async (_url, options) => {
      calls++; const input = JSON.parse(String(options!.body))
      assert.ok(input.state.candidate.workPlan.units.length); assert.deepEqual(input.state.candidate.scope, ['src'])
      return Response.json({ model: input.model, answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]: [string, any]) => [id, { type: 'choice', choice: 'satisfied', probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, c === 'satisfied' ? 1 : 0])), confidence: 1 }])) })
    }
    const store = databaseDecisionStore({ withDatabase: async fn => fn(f.db) })
    const provider = kind === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'fixture', http) : new NimbleDecisionProvider(config.nimble, async () => undefined, http)
    const service = new DecisionService(config, () => provider, store)
    let reviewedContext: any
    const reviewer = (context: any, signal: AbortSignal) => { reviewedContext = context; return reviewPlanDecisions({ service, requestId: 'request', context, signal, check: { identity: {}, verifyReadOnly: () => true, execute: async () => { fallback++; throw new Error('Should not run') } } }) }
    await assert.rejects(submitEnnoPlan(f.db, f.plan), /Review the exact/)
    assert.equal(readEnnoSnapshot(f.db, f.identity).workUnits.length, 0)
    const reviewed = await reviewEnnoPlan(f.db, f.plan, reviewer, new AbortController().signal)
    assert.equal(reviewed.ennoOduno.nextAction, 'submit_plan'); assert.equal(calls, 1); assert.equal(fallback, 0)
    await reviewEnnoPlan(f.db, f.plan, reviewer, new AbortController().signal); assert.equal(calls, 1)
    const submit = { ...f.plan, advisoryRoundDigest: reviewed.advisoryRound!.inputDigest, advisoryDisposition: reviewed.advisoryRound!.contributions.map(c => ({ slotId: c.slotId, disposition: 'adopted', rationale: 'Checked' })) }
    await assert.rejects(submitEnnoPlan(f.db, { ...submit, scope: ['other'] }), /Review the exact/)
    await assert.rejects(submitEnnoPlan(f.db, { ...submit, capabilities: [...f.plan.capabilities, { kind: 'tool', name: 'other' }] }), /Review the exact/)
    await assert.rejects(submitEnnoPlan(f.db, { ...submit, advisoryDisposition: [] }))
    const accepted = await submitEnnoPlan(f.db, submit)
    assert.equal(accepted.ennoOduno.nextAction, 'ask_user_confirmation'); assert.equal(accepted.executionLease, undefined)
    assert.equal(f.db.prepare('SELECT status FROM enno_plan_drafts').get()?.status, 'submitted')
    // Reloaded service still uses the original configuration snapshot.
    const changed = new DecisionService(TypedDecisionsConfig.parse({ provider: kind === 'typesafe' ? 'nimble' : 'typesafe' }), () => { throw new Error('Must not evaluate') }, store)
    assert.deepEqual(await changed.bind('request'), config)
    const replay = await reviewPlanDecisions({ service: changed, requestId: 'request', context: reviewedContext, signal: new AbortController().signal,
      check: { identity: {}, verifyReadOnly: () => { throw new Error('Completed persisted result must replay') }, execute: async () => ({}) } })
    assert.equal(replay.backend.provider, kind); assert.equal(calls, 1); assert.equal(fallback, 0)
  } finally { await f.cleanup() }
})
test('late or cancelled reviews cannot replace newer draft state; failed review cannot submit', async () => {
  const f = await fixture()
  try {
    let finish!: (value: Awaited<ReturnType<typeof success>>) => void
    const old = reviewEnnoPlan(f.db, f.plan, () => new Promise(resolve => { finish = resolve }), new AbortController().signal)
    const newPlan = { ...f.plan, scope: ['src', 'tests'] }
    await reviewEnnoPlan(f.db, newPlan, success, new AbortController().signal)
    finish(await success()); await assert.rejects(old, /superseded/)
    assert.deepEqual(readPlanDraft(f.db, readEnnoSnapshot(f.db, f.identity))?.candidate.scope, ['src', 'tests'])
    const controller = new AbortController()
    await assert.rejects(reviewEnnoPlan(f.db, f.plan, async () => { controller.abort(); return success() }, controller.signal))
    assert.equal(readPlanDraft(f.db, readEnnoSnapshot(f.db, f.identity))?.status, 'failed')
    await assert.rejects(submitEnnoPlan(f.db, f.plan), /Review the exact/)
    await assert.rejects(reviewEnnoPlan(f.db, f.plan, async () => { throw new Error('review unavailable') }, new AbortController().signal), /review unavailable/)
    assert.equal(readEnnoSnapshot(f.db, f.identity).workUnits.length, 0)
  } finally { await f.cleanup() }
})

test('a failed older contract review cannot mark an identical newer draft failed', async () => {
  const f = await fixture()
  try {
    let finishOld!: (value: Awaited<ReturnType<typeof success>>) => void
    let finishNew!: (value: Awaited<ReturnType<typeof success>>) => void
    const old = reviewEnnoPlan(f.db, f.plan, () => new Promise(resolve => { finishOld = resolve }), new AbortController().signal)
    const snapshot = readEnnoSnapshot(f.db, f.identity)
    updateContractInTransaction(f.db, snapshot, { contract: { ...snapshot.contract, revision: 2 }, status: snapshot.status, confirmationState: snapshot.confirmationState })
    const newer = reviewEnnoPlan(f.db, { ...f.plan, expectedRevision: 2 }, () => new Promise(resolve => { finishNew = resolve }), new AbortController().signal)
    finishOld(await success())
    await assert.rejects(old)
    assert.equal(readPlanDraft(f.db, readEnnoSnapshot(f.db, f.identity))?.status, 'reviewing')
    finishNew(await success()); await newer
    assert.equal(readPlanDraft(f.db, readEnnoSnapshot(f.db, f.identity))?.status, 'reviewed')
  } finally { await f.cleanup() }
})
