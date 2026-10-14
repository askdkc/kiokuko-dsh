import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeExecutionSelection, readExecutionSelection, writeExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { bindTaskRepository, readTaskSnapshot, transitionTask } from '../../../src/dsh/task-state.js'
import { readCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { readEnnoSnapshot, updateContractInTransaction } from '../../../src/enno-oduno/store.js'

for (const type of ['build', 'debug', 'review', 'devops'] as const) test(`generic task resume renews ${type} Enno source without inventing a coding Goal`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'task-resume-enno-')))
  await mkdir(join(root, '.git'))
  const db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  try {
    const prepared = await prepareAgentTask(db, { requestId: `resume-${type}`, dshSessionId: 'session', cwd: root,
      task: `Inspect the ${type} outcome`, profileHints: { taskType: type, target: '.', expected: 'Report observed results', constraints: 'Keep existing scope' },
      capabilities: [], skillDiscoveryMode: 'off' })
    const source = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId }
    const owner = { taskId: source.runId, sessionId: 'session', repositoryRoot: root }
    bindTaskRepository(db, owner)
    initializeExecutionSelection(db, source.runId)
    const selection = readExecutionSelection(db, source.runId)!
    const model = { provider: 'fixture', model: 'fixture' }
    writeExecutionSelection(db, source.runId, selection.revision, { mode: 'enno', status: 'ready', configuration: { custom: false,
      template: { id: 'ollama', version: 1 }, maxConcurrentChildren: 1,
      roles: { ideal: model, zenki: model, goki: model, worker: model, check: model } } })
    const previous = readEnnoSnapshot(db, source)
    // A cancelled source is a durable fixture, not a model-produced receipt.
    withImmediateTransaction(db, () => {
      updateContractInTransaction(db, previous, { contract: previous.contract, status: 'cancelled', confirmationState: 'cancelled' })
      new LedgerStore(db).updateRunStatusInTransaction(source.runId, 'cancelled')
    })
    const before = readTaskSnapshot(db, owner)
    const operation = { operation: 'resume' as const, operationId: 'explicit-resume', expectedRevision: before.revision,
      reason: 'Resume the same task', explicit: true }
    const resumed = transitionTask(db, owner, operation)
    assert.equal(resumed.taskId, owner.taskId)
    assert.equal(resumed.state, 'Working')
    assert.equal(resumed.runStatus, 'active')
    assert.equal(resumed.previousOutcome!.status, 'cancelled')
    const current = readEnnoSnapshot(db, source)
    assert.equal(current.revision, previous.revision + 1)
    assert.equal(current.status, 'oduno_ideal')
    assert.equal(current.ideal, null)
    assert.deepEqual(current.contract.workPlan, previous.contract.workPlan)
    assert.equal(readCodingWorkflow(db, owner.taskId), undefined, 'generic task resume creates no coding workflow')
    assert.deepEqual(transitionTask(db, owner, operation), resumed, 'outer operation replay cannot increment source twice')
    assert.equal(readEnnoSnapshot(db, source).revision, current.revision)
    assert.equal(new LedgerStore(db).verifyChain(source.runId), true)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
