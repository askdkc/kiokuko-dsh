import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { CODING_MINIMUM_DEFINITION_EXAMPLE } from '../../../../src/dsh/coding-workflow/contracts.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice, assertCodingDispatch, codingCriterionId, proposeCodingWorkflow,
  reopenTerminalCodingWorkflow, stopCodingWorkflow, synchronizeCodingWorkflow } from '../../../../src/dsh/coding-workflow/service.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, finishTaskCompletionExecution } from '../../../../src/dsh/task-completion.js'
import { runOwnedProcess } from '../../../../src/dsh/owned-execution.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coding-reopen-')))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'check.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('public entry',()=>assert.equal(20+22,42));\n")
  const db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const prepared = await prepareAgentTask(db, { requestId: 'reopen-request', dshSessionId: 'session', cwd: root,
    task: 'Implement the public entry', profileHints: { taskType: 'build', target: 'entry', expected: 'The entry works', constraints: 'Preserve behavior' },
    capabilities: [], skillDiscoveryMode: 'off', completionMode: 'shadow' })
  const identity = { runId: prepared.run.runId, sessionId: 'session', repositoryRoot: root }
  const command = 'node --test --test-reporter=tap check.test.mjs'
  const read = () => readCodingWorkflow(db, identity.runId)!
  const choose = () => {
    const current = read()
    return answerCodingChoice(db, identity, { callId: `choice:${current.scopeVersion}`, expectedRevision: current.revision,
      workflowId: current.workflowId, scopeVersion: current.scopeVersion, questionId: current.choice.questionId,
      questionRevision: current.choice.revision, answerRef: 'human:explicit-choice', choice: 'no' })
  }
  const bind = () => {
    const current = read()
    for (const criterion of current.definition!.criteria) bindTaskCriterion(db, { runId: identity.runId,
      callId: `bind:${current.scopeVersion}:${criterion.criterionId}`, criterionId: codingCriterionId(current, criterion.criterionId),
      method: { kind: 'native_command', command, cwd: '.', sourcePaths: ['check.test.mjs'], assertion: 'selected_tests_pass' }, approved: true })
  }
  const execute = async (callId: string) => {
    assert.equal(beginTaskCompletionExecution(db, { runId: identity.runId, callId, command, repositoryRoot: root }), true)
    const result = await runOwnedProcess(command, root, 'bash', new AbortController().signal, 10_000)
    finishTaskCompletionExecution(db, { runId: identity.runId, callId, result })
  }
  return { db, root, identity, read, choose, bind, execute,
    initialize() { return initializeCodingWorkflow(db, { ...identity, requestId: 'reopen-request', task: 'Implement the public entry' }) },
    async close() { db.close(); await rm(root, { recursive: true, force: true }) } }
}

for (const terminalState of ['cancelled', 'completed'] as const) test(`explicit resume reopens ${terminalState} coding with preserved receipts and fresh real checks`, async () => {
  const f = await fixture()
  try {
    f.initialize()
    const definition = structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE)
    proposeCodingWorkflow(f.db, f.identity, 'definition', 1, definition)
    f.choose(); f.bind()
    await f.execute('old-item')
    await f.execute('old-goal')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, true)
    if (terminalState === 'completed') synchronizeCodingWorkflow(f.db, f.identity.runId)
    else stopCodingWorkflow(f.db, f.identity.runId, 'cancelled')
    const previous = f.read()
    const receiptCount = () => f.db.prepare('SELECT count(*) AS count FROM dsh_completion_executions WHERE run_id=?')
      .get<{ count: number }>(f.identity.runId)!.count
    const reopened = reopenTerminalCodingWorkflow(f.db, f.identity, 'explicit-resume')!
    assert.equal(reopened.workflowId, previous.workflowId)
    assert.equal(reopened.scopeVersion, previous.scopeVersion + 1)
    assert.equal(reopened.definition!.goal.ideal, previous.definition!.goal.ideal)
    assert.deepEqual(reopened.definition!.items, previous.definition!.items)
    assert.equal(reopened.definition!.goal.revision, previous.definition!.goal.revision + 1)
    assert.ok(reopened.definition!.criteria.every((criterion, i) => criterion.revision === previous.definition!.criteria[i]!.revision + 1))
    assert.equal(reopened.state, 'awaiting_lisp_choice')
    assert.equal(reopened.choice.state, 'pending')
    assert.equal(receiptCount(), 2, 'old host execution evidence is retained')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, false)
    assert.ok(assessTaskCompletion(f.db, f.identity.runId).criteria.every(item => item.state === 'stale'))
    assert.throws(() => assertCodingDispatch(f.db, f.identity, 'kioku_write'), /Lisp choice/u)
    assert.deepEqual(reopenTerminalCodingWorkflow(f.db, f.identity, 'explicit-resume'), reopened)
    f.choose()
    assert.doesNotThrow(() => assertCodingDispatch(f.db, f.identity, 'kioku_write'))
    f.bind()
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, false, 'rebinding does not turn old proof into new proof')
    await f.execute('new-item')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, false, 'Goal check still follows item checks')
    await f.execute('new-goal')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, true)
    assert.equal(receiptCount(), 4)
  } finally { await f.close() }
})

test('reopen never invents a workflow or Goal and rolls back with the task transaction', async () => {
  const f = await fixture()
  try {
    assert.equal(reopenTerminalCodingWorkflow(f.db, f.identity, 'no-workflow'), undefined)
    f.initialize(); stopCodingWorkflow(f.db, f.identity.runId, 'cancelled')
    const previous = f.read()
    assert.throws(() => withImmediateTransaction(f.db, () => {
      reopenTerminalCodingWorkflow(f.db, f.identity, 'rolled-back-resume')
      throw new Error('Later task CAS failed')
    }), /Later task CAS/u)
    assert.deepEqual(f.read(), previous)
    const reopened = reopenTerminalCodingWorkflow(f.db, f.identity, 'explicit-resume')!
    assert.equal(reopened.definition, undefined)
    assert.equal(reopened.state, 'preparing')
    assert.equal(reopened.choice.state, 'pending')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).verified, false)
  } finally { await f.close() }
})
