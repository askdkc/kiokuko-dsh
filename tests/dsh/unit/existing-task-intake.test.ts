import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { continueTaskIntake } from '../../../src/dsh/existing-task-intake.js'
import { bindTaskRepository, readTaskSnapshot, transitionTask } from '../../../src/dsh/task-state.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
import type { TaskType } from '../../../src/akinator/types.js'

function fixture(taskType: TaskType | null = 'research') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'existing-intake-')))
  const db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const opened = new DshRunIntakeService(db, { deferTaskTypeInference: true }).openRun({
    idempotencyKey: 'create', dshSessionId: 'session', request: { apiVersion: '1', workspace: 'project:intake-test',
      task: { title: 'Investigate', query: 'Investigate', profileHints: { taskType, target: null, expected: null, constraints: null } },
      captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      capabilities: [], metadata: { taskStateExplicit: true } } })
  const identity = { taskId: opened.runId, sessionId: 'session', repositoryRoot: root }
  const task = bindTaskRepository(db, identity)
  const input = { ...identity, workspace: 'project:intake-test', expectedRevision: task.revision,
    expectedGeneration: task.generation, capabilities: [], signal: new AbortController().signal }
  return { db, identity, task, input, close() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

for (const taskType of ['research', null] as const) test(`resuming an incomplete task keeps known context (stored task type: ${taskType})`, async () => {
  const f = fixture(taskType)
  const task = 'READMEの導入手順を報告してください。'
  const context = createRequestIntentContext({ task, workspaceDirectory: f.identity.repositoryRoot,
    activeTask: f.task, messageRefs: [{ id: 'clarification', digest: 'b'.repeat(64) }] })!
  const requestIntent = bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: 'research', evidenceRefs: requestIntentReferenceIds(context) }, context)!
  const agent = { id: 'agent', model: { current: () => ({ provider: 'fixture', model: 'main' }) } }
  try {
    const result = await continueTaskIntake(f.db, { ...f.input, agent, requestIntent, evidence: [task],
      answerer: { async ask(question) { assert.fail(`Already known: ${question.id}`) } },
      llm: { async *stream(request) {
        assert.deepEqual(JSON.parse((request.messages[0] as any).content[0].text).evidence, [task])
        yield { type: 'text-delta', text: JSON.stringify({ expected: 'READMEの導入手順が報告されている。', quote: task }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } } })
    assert.notEqual(result.state.status, 'needs_answer')
    assert.equal(result.state.session.profile.target, f.identity.repositoryRoot)
    assert.equal(result.state.session.profile.expected, 'READMEの導入手順が報告されている。')
    assert.equal(readTaskSnapshot(f.db, f.identity).state, 'ToDo')
    assert.equal(f.db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, 1)
  } finally { f.close() }
})

test('incomplete explicit task answers its existing intake without granting Working or creating another task', async () => {
  const f = fixture(); let answers = 0, checks = 0
  try {
    const result = await continueTaskIntake(f.db, { ...f.input,
      answerer: { async ask(question) { answers++; return question.id === 'target' ? 'README.md' : 'Report observed contents' } },
      validateCapabilities: async () => { checks++ } })
    assert.ok(answers > 0); assert.equal(checks, answers)
    assert.notEqual(result.state.status, 'needs_answer')
    const current = readTaskSnapshot(f.db, f.identity)
    assert.equal(current.state, 'ToDo'); assert.equal(current.runStatus, 'active')
    assert.equal(f.db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, 1)
    assert.equal(f.db.prepare('SELECT count(*) n FROM dsh_coding_workflows').get()!.n, 0)
    assert.equal(transitionTask(f.db, f.identity, { operation: 'start', operationId: 'start', expectedRevision: current.revision,
      expectedGeneration: current.generation, reason: 'Start the completed intake' }).state, 'Working')
  } finally { f.close() }
})

test('an answer cannot persist after its task is paused while the question is open', async () => {
  const f = fixture()
  try {
    await assert.rejects(continueTaskIntake(f.db, { ...f.input, answerer: { async ask() {
      transitionTask(f.db, f.identity, { operation: 'wait', operationId: 'wait', expectedRevision: f.task.revision, reason: 'Pause before answering' })
      return 'README.md'
    } } }), /authority changed/)
    assert.equal(readTaskSnapshot(f.db, f.identity).state, 'Pending')
    assert.equal(f.db.prepare('SELECT status FROM akinator_sessions').get()!.status, 'active')
  } finally { f.close() }
})

test('changed native capabilities reject an intake answer before persistence', async () => {
  const f = fixture()
  try {
    await assert.rejects(continueTaskIntake(f.db, { ...f.input, answerer: { async ask() { return 'README.md' } },
      validateCapabilities: async () => { throw new Error('Native capability catalog changed') } }), /capability catalog changed/)
    assert.equal(readTaskSnapshot(f.db, f.identity).revision, f.task.revision)
    assert.equal(f.db.prepare('SELECT status FROM akinator_sessions').get()!.status, 'active')
  } finally { f.close() }
})
