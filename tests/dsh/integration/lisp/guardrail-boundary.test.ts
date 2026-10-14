import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { CODING_MINIMUM_DEFINITION_EXAMPLE } from '../../../../src/dsh/coding-workflow/contracts.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice, proposeCodingWorkflow } from '../../../../src/dsh/coding-workflow/service.js'
import { bindTaskCriterion } from '../../../../src/dsh/task-completion.js'
import { OwnedExecutionService } from '../../../../src/dsh/owned-execution.js'
import { withTaskAuthority } from '../../../../src/dsh/task-authority-context.js'
import { TASK_AUTHORITY, authorizeTaskLease, captureTaskLease, readTaskSnapshot, recordTaskEvidence, transitionTask, type TaskLease } from '../../../../src/dsh/task-state.js'

const initial = 'export const value = 0;\n'
const regression = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.mjs';test('bounded value',()=>assert.equal(value,42));\n"
const command = 'node --test --test-reporter=tap tests/unit.test.mjs'

// Actual intake, Goal/choice and criterion enrollment. No protocol JSON injection.
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'protocol-lisp-boundary-')))
  let closeDatabase = () => {}
  try {
    const root = join(base, 'workspace')
    await mkdir(root); await mkdir(join(root, '.git')); await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'))
    await writeFile(join(root, 'src/value.mjs'), initial)
    await writeFile(join(root, 'tests/unit.test.mjs'), '// Write the regression through owned tools.\n')
    const databasePath = join(base, 'state.sqlite3')
    const db = new NodeSqliteAdapter(databasePath, new DatabaseSync(databasePath)); closeDatabase = () => db.close(); migrateDatabase(db)
    const owner = { sessionId: 'protocol-session', agentId: 'agent', root }
    const prepared = await prepareAgentTask(db, { requestId: 'protocol', dshSessionId: owner.sessionId, cwd: root,
      task: 'Implement the bounded value unit', profileHints: { taskType: 'build', target: 'src/value.mjs',
        expected: 'The selected test passes', constraints: 'Do not change tests after RED' }, capabilities: [], skillDiscoveryMode: 'off', sessionOwnership: true })
    const identity = { runId: prepared.run.runId, sessionId: owner.sessionId, repositoryRoot: root }
    const taskIdentity = { taskId: identity.runId, sessionId: owner.sessionId, repositoryRoot: root }
    initializeCodingWorkflow(db, { ...identity, requestId: 'protocol', task: 'Implement the bounded value unit' })
    const workflow = proposeCodingWorkflow(db, identity, 'propose', 1, CODING_MINIMUM_DEFINITION_EXAMPLE)
    answerCodingChoice(db, identity, { callId: 'choice', expectedRevision: workflow.revision,
      workflowId: workflow.workflowId, scopeVersion: workflow.scopeVersion,
      questionId: workflow.choice.questionId, questionRevision: workflow.choice.revision, answerRef: 'fixture-human:yes', choice: 'yes' })
    bindTaskCriterion(db, { runId: identity.runId, callId: 'bind', criterionId: `coding:${workflow.workflowId}:item-check`,
      method: { kind: 'native_command', command, cwd: '.', sourcePaths: ['src/value.mjs', 'tests/unit.test.mjs'],
        assertion: 'selected_tests_pass', protocol: { kind: 'bounded-tdd-v1', unitId: 'implementation',
          implementationPaths: ['src/value.mjs'], testPaths: ['tests/unit.test.mjs'] } }, approved: true })
    const task = readTaskSnapshot(db, taskIdentity)
    const lease = captureTaskLease(db, {taskId:task.taskId,sessionId:owner.sessionId,repositoryRoot:root})
    const store = new LispStore(async fn => fn(db))
    const phase = () => readCodingWorkflow(db, task.taskId)!.protocol!.phase
    assert.equal(phase(), 'write-tests')
    assert.deepEqual(readCodingWorkflow(db, task.taskId)!.protocol!.lease, lease)
    return { base, root, db, owner, task, identity, lease, store, phase, workspace: prepared.project.workspace,
      async close() { db.close(); await rm(base, { recursive: true, force: true }) } }
  } catch (error) { closeDatabase(); await rm(base, { recursive: true, force: true }); throw error }
}

function toolCode(name: string, args: Record<string, unknown>): string {
  return `(kioku.tools:call-tool ${JSON.stringify(name)} (kioku.data:parse-json ${JSON.stringify(JSON.stringify(args))}))`
}

// This is a no-runtime admission check, not proof of protected computation.
test('enrolled protocol rejects development Lisp admission before starting SBCL', async () => {
  const f = await fixture()
  const manager = new LispManager({ store: f.store, dataRoot: join(f.base, 'runtime'),
    config: LispConfig.parse({ enabled: true, executionMode: 'development', sbclPath: join(f.base, 'must-not-start') }) })
  try {
    await manager.start()
    await assert.rejects(manager.enable(f.owner), { code: 'PROTOCOL_PROTECTED_REQUIRED' })
    await assert.rejects(manager.enableTask(f.owner), { code: 'PROTOCOL_PROTECTED_REQUIRED' })
    assert.equal(manager.enabled.has(f.owner.sessionId), false)
    assert.equal((await manager.execute(f.owner, 'lisp_eval', { operationId: 'denied-development', code: '(+ 20 22)' }) as any).ok, false)
    assert.equal(await readFile(join(f.root, 'src/value.mjs'), 'utf8'), initial)
  } finally { await manager.dispose(); await f.close() }
})

for (const scenario of ['bounded-cycle', 'stale-reply'] as const) test(`real protected Lisp, enrolled owned RPC: ${scenario}`, {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires real protected SBCL; skipped is not runtime evidence' : false,
  timeout: 180000,
}, async () => {
  const f = await fixture(), agent = { id: f.owner.agentId }
  const runtime: any = { executionJournalDirectory: join(f.base, 'journal'), withDatabase: async (fn: any) => fn(f.db) }
  const owned = new OwnedExecutionService({ runtime, resolve: execution => execution.agent === agent
    ? { ...f.identity, workspace: f.workspace, generation: 'owned-generation', agent } : undefined })
  let directCalls = 0, approvals = 0, rotateAfterEffect = false, bridgeCalls = 0
  const leases: TaskLease[] = []
  const manager = new LispManager({ store: f.store, dataRoot: join(f.base, 'runtime'),
    config: LispConfig.parse({ enabled: true, executionMode: 'protected',
      sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }),
    ciCall: async () => { directCalls++; throw new Error('Direct CI effect must be rejected before the adapter') },
    questions: { ask: async () => { approvals++; throw new Error('Denied direct proposal must not request approval') } },
    toolCall: async (owner, name, args, signal, callId, lease) => {
      assert.deepEqual(owner, f.owner); assert.ok(signal); assert.ok(callId); assert.ok(lease)
      assert.match(callId, /^lisp-rpc:/); assert.equal(Object.isFrozen(lease), true)
      assert.deepEqual(lease, f.lease, 'The RPC retains the original task, revision, generation, owner and root')
      leases.push(lease); bridgeCalls++
      const result = await withTaskAuthority(lease, () => owned.execute(name, args,
        { name, arguments: args, signal, callId, agent, [TASK_AUTHORITY]: lease })) as any
      if (rotateAfterEffect) {
        rotateAfterEffect = false
        // The synchronous file operation has settled; no child process exists.
        recordTaskEvidence(f.db, f.task, { ref: 'file-settled', kind: 'stopped', generation: f.task.generation, verified: true })
        const pending = transitionTask(f.db, f.task, { operation: 'wait', operationId: 'wait',
          expectedRevision: f.task.revision, reason: 'Owned file operation has settled', evidence: ['file-settled'] })
        transitionTask(f.db, pending, { operation: 'resume', operationId: 'resume', expectedRevision: pending.revision,
          explicit: true, reason: 'New explicit execution generation' })
        assert.throws(() => authorizeTaskLease(f.db, lease), /stale or stopped/)
      }
      return result
    } })
  const evaluate = (id: string, code: string) => manager.execute(f.owner, 'lisp_eval', { operationId: id, code }) as Promise<any>
  const success = (value: any) => { assert.equal(value.ok, true, JSON.stringify(value)); return value }
  try {
    await manager.start(); assert.equal((await manager.enable(f.owner) as any).state, 'READY')
    const pure = success(await evaluate('pure', '(+ 20 22)'))
    assert.equal(pure.value.json, 42); assert.equal(pure.value.printed, '(42)')
    assert.equal((await f.store.get(f.owner, 'pure'))!.state, 'SUCCEEDED')
    assert.equal(bridgeCalls, 0); assert.equal(directCalls, 0)

    const raw = await evaluate('raw-workspace-write', `(kioku.files:write-text ${JSON.stringify(join(f.root, 'src/value.mjs'))} "bypass")`)
    assert.equal(raw.ok, false, JSON.stringify(raw))
    const direct = await evaluate('direct-ci', '(kioku.ci:verify :test)')
    assert.equal(direct.ok, false, JSON.stringify(direct)); assert.match(JSON.stringify(direct), /Bounded protocol effects require the owned tool bridge/)
    const proposed = await evaluate('direct-proposal', '(kioku.files:propose-write "src/value.mjs" "bypass")')
    assert.equal(proposed.ok, false); assert.equal(proposed.changes[0].code, 'PROTOCOL_ROUTE_REQUIRED')
    assert.equal(proposed.changes[0].state, 'NOT_APPLIED')
    assert.equal(directCalls, 0); assert.equal(approvals, 0)
    assert.equal(await readFile(join(f.root, 'src/value.mjs'), 'utf8'), initial)
    assert.equal(success(await evaluate('pure-after-denial', '(* 6 7)')).value.json, 42)

    if (scenario === 'stale-reply') {
      rotateAfterEffect = true
      const late = await evaluate('late-owned-reply', toolCode('kioku_write', { path: 'tests/unit.test.mjs', content: regression }))
      assert.equal(bridgeCalls, 1); assert.equal(leases.length, 1)
      assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), regression, 'The settled owned effect remains recorded')
      assert.equal(late.ok, false, JSON.stringify(late)); assert.match(JSON.stringify(late), /TASK_STATE_CONFLICT|stale or stopped/)
      assert.notEqual((await f.store.get(f.owner, 'late-owned-reply'))!.state, 'SUCCEEDED', 'A late RPC success cannot publish under a new lease')
      return
    }

    const write = success(await evaluate('write-regression', toolCode('kioku_write', { path: 'tests/unit.test.mjs', content: regression }))).value.json
    assert.equal(write.applied, true); assert.deepEqual(write.receipt.taskAuthority, f.lease)
    assert.equal(f.phase(), 'verify-red')
    const red = success(await evaluate('actual-red', toolCode('kioku_exec', { command }))).value.json
    assert.equal(red.exitCode, 1); assert.equal(f.phase(), 'implement')
    const implementation = success(await evaluate('write-implementation', toolCode('kioku_write', { path: 'src/value.mjs', content: 'export const value = 42;\n' }))).value.json
    assert.equal(implementation.applied, true); assert.deepEqual(implementation.receipt.taskAuthority, f.lease)
    const green = success(await evaluate('actual-green', toolCode('kioku_exec', { command }))).value.json
    assert.equal(green.exitCode, 0); assert.equal(f.phase(), 'report')
    assert.equal(bridgeCalls, 4); assert.equal(leases.length, 4)
    assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), regression)
    assert.equal(directCalls, 0); assert.equal(approvals, 0)
  } finally { await manager.dispose(); await owned.close(); await f.close() }
})
