import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { codingStatus, answerCodingChoice, synchronizeCodingWorkflow, proposeCodingWorkflow, overrideCodingChoice, assertCodingDispatch } from '../../../src/dsh/coding-workflow/service.js'
import { assessTaskCompletion } from '../../../src/dsh/task-completion.js'
import { initializeExecutionSelection, readExecutionSelection, writeExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { submitOdunoIdeal, answerEnno, reportEnnoWork, prepareEnnoVerification, finishEnno } from '../../../src/enno-oduno/service.js'
import { readEnnoSnapshot } from '../../../src/enno-oduno/store.js'
import { submitReviewedPlan } from '../helpers/reviewed-plan.js'

for (const routeChanged of [false, true]) test(`Enno actual focused/final user-entry checks: ${routeChanged ? 'route change invalidates evidence and permits replan' : 'authoritative Goal becomes satisfied'}`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'coding-enno-')), root = await realpath(base)
  await mkdir(join(root, 'repo')); const repository = join(root, 'repo')
  execFileSync('git', ['init', '-q', repository])
  await writeFile(join(repository, 'parser.mjs'), 'console.log(Number(process.argv[2])+1)\n')
  await writeFile(join(repository, 'parser.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';test('public parser command',()=>assert.equal(execFileSync(process.execPath,['parser.mjs','41'],{encoding:'utf8'}).trim(),'42'));\n")
  const db = openConnection(join(root, 'state.sqlite3'))
  try {
    migrateDatabase(db)
    const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }]
    const task = await prepareAgentTask(db, { requestId: 'enno-coding', cwd: repository, task: 'Implement the public parser command',
      profileHints: { taskType: 'build', target: 'parser.mjs', expected: 'The public command returns 42' }, capabilities, dshSessionId: 'parent', skillDiscoveryMode: 'off' })
    const identity = { runId: task.run.runId, workspace: task.project.workspace, orchestrationId: task.intake.sessionId }
    const codingIdentity = { runId: identity.runId, sessionId: 'parent', repositoryRoot: repository }
    initializeCodingWorkflow(db, { ...codingIdentity, requestId: 'enno-coding', task: 'Implement the public parser command' })
    initializeExecutionSelection(db, identity.runId)
    const selection = readExecutionSelection(db, identity.runId)!
    const model = { provider: 'fixture', model: 'fixture' }
    writeExecutionSelection(db, identity.runId, selection.revision, { mode: 'enno', status: 'ready', configuration: { custom: false,
      template: { id: 'ollama', version: 1 }, maxConcurrentChildren: 1, roles: { ideal: model, zenki: model, goki: model, worker: model, check: model } } })
    submitOdunoIdeal(db, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal',
      ideal: { objective: 'The user runs the public parser command and sees 42', principles: ['Verify the ordinary entry'], skillContributions: [], successSignals: ['Public command outputs 42'] } })
    const verifier = { id: 'public-check', kind: 'test', executable: process.execPath, args: ['--test', '--test-reporter=tap', 'parser.test.mjs'], cwd: '.', timeoutMs: 5000 }
    const plan = await submitReviewedPlan(db, { ...identity, expectedRevision: 1, idempotencyKey: 'plan', scope: ['parser.mjs', 'parser.test.mjs'], exclusions: [],
      acceptanceCriteria: [{ id: 'entry', description: 'Public command outputs 42' }], workPlan: { objective: 'Implement the parser command', units: [{ id: 'parser',
        objective: 'Implement the public parser', scope: ['parser.mjs', 'parser.test.mjs'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the actual command' }], acceptanceCriteria: ['Regression assertions pass'], focusedVerifiers: [verifier] }] },
      skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3, capabilities,
      provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' } })
    const approved = plan.ennoOduno.nextAction === 'ask_user_confirmation' ? answerEnno(db, { ...identity, expectedRevision: 2, idempotencyKey: 'approve', action: 'approve' }) : plan
    codingStatus(db, codingIdentity)
    const workflow = readCodingWorkflow(db, identity.runId)!
    assert.match(workflow.definition!.goal.ideal, /public parser/)
    assert.equal(workflow.definition!.items.length, 1)
    assert.throws(() => proposeCodingWorkflow(db, codingIdentity, 'competing', workflow.revision, workflow.definition!, true), /Enno/)
    answerCodingChoice(db, codingIdentity, { callId: 'human-choice', expectedRevision: workflow.revision, workflowId: workflow.workflowId, scopeVersion: workflow.scopeVersion,
      questionId: workflow.choice.questionId, questionRevision: workflow.choice.revision, answerRef: 'native-question:no', choice: 'no' })
    const lease = approved.executionLease!
    const report = await reportEnnoWork(db, { ...identity, expectedRevision: 2, idempotencyKey: 'work', workUnitId: 'parser', leaseToken: lease.leaseToken, routeEpoch: lease.routeEpoch,
      result: { outcome: 'completed', summary: 'The actual parser assertions pass', mutated: false, changedPaths: [] } }, { descendantSettleMs: 0 })
    assert.equal(report.ennoOduno.nextAction, 'run_final_verification')
    const focused = assessTaskCompletion(db, identity.runId)
    assert.equal(focused.verified, false, 'Focused results cannot complete the final Goal')
    assert.equal(focused.criteria.find(criterion => criterion.criterionId.includes('item-check'))!.state, 'satisfied')
    if (routeChanged) {
      overrideCodingChoice(db, codingIdentity, 'no', 'human:explicit-new-route')
      codingStatus(db, codingIdentity)
      assert.equal(assessTaskCompletion(db, identity.runId).criteria.find(criterion => criterion.criterionId.includes('item-check'))!.state, 'stale')
    }
    await prepareEnnoVerification(db, { ...identity, expectedRevision: 2, idempotencyKey: 'final' }, { descendantSettleMs: 0 })
    if (routeChanged) {
      assert.equal(assessTaskCompletion(db, identity.runId).verified, false, 'Old focused evidence cannot substantiate the new route')
      const replanned = await finishEnno(db, { ...identity, expectedRevision: 2, idempotencyKey: 'replan', review: { decision: 'replan', summary: 'Reverify focused items for the explicitly changed route' } })
      assert.equal(replanned.ennoOduno.status, 'zenki_planning')
      return
    }
    assert.equal(assessTaskCompletion(db, identity.runId).verified, true)
    assert.equal(synchronizeCodingWorkflow(db, identity.runId)!.state, 'verifying_goal', 'Passing Goal evidence must preserve the authoritative Enno final review')
    assert.equal(readEnnoSnapshot(db, identity).status, 'enno_verifying', 'Common completion never fabricates Enno final review')
    assert.doesNotThrow(() => assertCodingDispatch(db, codingIdentity, 'kioku_exec'), 'Final review can still request a repair or replan')
    assert.equal(execFileSync(process.execPath, ['parser.mjs', '41'], { cwd: repository, encoding: 'utf8' }).trim(), '42')
    await writeFile(join(repository, 'parser.mjs'), 'console.log(0)\n')
    assert.equal(assessTaskCompletion(db, identity.runId).verified, false, 'A changed artifact invalidates Enno evidence')
    await writeFile(join(repository, 'parser.mjs'), 'console.log(Number(process.argv[2])+1)\n')
    const replanned = await finishEnno(db, { ...identity, expectedRevision: 2, idempotencyKey: 'final-replan', review: { decision: 'replan', summary: 'Final review requires the next contract revision' } })
    assert.equal(replanned.ennoOduno.status, 'zenki_planning')
    const resumed = codingStatus(db, codingIdentity)
    assert.equal(resumed.applicable && resumed.definition!.goal.revision, 3, 'The existing Enno authority remains able to revise the common Goal after passing checks')
    assert.equal(resumed.applicable && resumed.choice.state, 'no', 'An unchanged scope retains its human route choice')
    assert.equal(assessTaskCompletion(db, identity.runId).verified, false, 'Previous contract results cannot complete the new revision')
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
