import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { CODING_MINIMUM_DEFINITION_EXAMPLE } from '../../../../src/dsh/coding-workflow/contracts.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice, proposeCodingWorkflow } from '../../../../src/dsh/coding-workflow/service.js'
import { bindTaskCriterion } from '../../../../src/dsh/task-completion.js'
import { mountOwnedExecution } from '../../../../src/dsh/owned-execution.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../../../../src/dsh/lisp/coding-choice.js'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { currentTaskAuthority, withTaskAuthority } from '../../../../src/dsh/task-authority-context.js'
import { TASK_AUTHORITY, captureTaskLease, readTaskSnapshot, recordTaskEvidence, transitionTask } from '../../../../src/dsh/task-state.js'

const initial = 'export const value = 0;\n'
const regression = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.mjs';test('bounded value',()=>assert.equal(value,42));\n"
const command = 'node --test --test-reporter=tap tests/unit.test.mjs'

// Actual intake, Goal/choice and criterion enrollment. No protocol JSON injection.
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'protocol-lisp-boundary-')))
  let closeDatabase = () => {}
  try {
    const root = join(base, 'workspace')
    await mkdir(root); execFileSync('git', ['init', '-q', root]); await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'))
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

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT

test('enrolled protected surface dispatches the real owned adapter with its pinned lease; ordinary native effects stay fenced', {
  skip: packages ? false : 'requires the pinned native DSH registry; no SBCL is used by this policy test', timeout: 60000,
}, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const f = await fixture(), ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const session = { id: f.owner.sessionId, header: { cwd: f.root } }
  const agent: any = { id: f.owner.agentId, session }
  const runtime: any = { executionJournalDirectory: join(f.base, 'journal'), withDatabase: async (fn: any) => fn(f.db) }
  const signal = new AbortController().signal
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, local: any, unmountOwned: (() => Promise<void>) | undefined
  let ordinaryEffects = 0, replacementEffects = 0, observedLease: unknown
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'protocol-owned-policy-services', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      c.provide('sessions', { get: (id: string) => id === session.id ? session : undefined })
      c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    } }))
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    unmountOwned = mountOwnedExecution(ctx, { runtime, resolve: execution => execution.agent === agent
      ? { ...f.identity, workspace: f.workspace, generation: 'native-generation', agent } : undefined })
    ctx.tools.register(tools.defineTool({ name: 'fixture_write', description: 'ordinary native effect', parameters: {},
      output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++ordinaryEffects }))
    ctx.on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
      if (execution.name === 'kioku_write') observedLease = currentTaskAuthority()
      return next()
    })
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, executionMode: 'protected',
      sbclPath: join(f.base, 'must-not-start-sbcl') }))
    // Host task-mode admission is real and starts no worker. Activation binds the
    // native registry without the command handler's independent scope revision.
    await surface.manager.enableTask(f.owner)
    const coding = ctx.get(LISP_CODING_SERVICE) as LispCodingService
    assert.ok(coding.activate); await coding.activate(agent)
    assert.equal(readCodingWorkflow(f.db, f.task.taskId)!.scopeVersion,
      readCodingWorkflow(f.db, f.task.taskId)!.protocol!.scopeVersion)

    const ordinary = await executeNativeTool(ctx, packages!, { callId: randomUUID(), name: 'fixture_write', arguments: {}, agent, signal })
    assert.equal(ordinary.isError, true); assert.equal(ordinaryEffects, 0)
    assert.equal((await surface.manager.status(f.owner) as any).state, 'TASK_READY')
    const nativeWrite = await executeNativeTool(ctx, packages!, { callId: 'not-a-lisp-bridge', name: 'kioku_write',
      arguments: { path: 'tests/unit.test.mjs', content: 'bypass' }, agent, signal })
    assert.equal(nativeWrite.isError, true, 'Registry visibility alone cannot grant an unrestricted native effect')
    const leasedNative = await withTaskAuthority(f.lease, () => executeNativeTool(ctx, packages!, { callId: 'not-a-bridge-even-with-lease',
      name: 'kioku_write', arguments: { path: 'tests/unit.test.mjs', content: 'bypass' }, agent, signal, [TASK_AUTHORITY]: f.lease }))
    assert.equal(leasedNative.isError, true, 'Caller-supplied authority cannot mint the private bridge scope')
    const savedTests = await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8')
    await assert.rejects(surface.manager.options.toolCall!(f.owner, 'kioku_write',
      { path: 'tests/unit.test.mjs', content: 'missing-lease' }, signal, 'missing-lease'), { code: 'TASK_REQUIRED' })
    assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), savedTests)
    const removeReplacement = agent.ctx.get('tools').register(tools.defineTool({ name: 'kioku_write',
      description: 'same-name replacement must not inherit authority', parameters: {},
      output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++replacementEffects }))
    try {
      await assert.rejects(surface.manager.options.toolCall!(f.owner, 'kioku_write',
        { path: 'tests/unit.test.mjs', content: 'replacement' }, signal, 'replacement', f.lease), { code: 'PROTOCOL_ROUTE_REQUIRED' })
      assert.equal(replacementEffects, 0)
    } finally { removeReplacement() }
    const pinnedDefinition = ctx.tools.get('kioku_write', agent), originalExecute = pinnedDefinition.execute
    pinnedDefinition.execute = async () => ++replacementEffects
    try {
      await assert.rejects(surface.manager.options.toolCall!(f.owner, 'kioku_write',
        { path: 'tests/unit.test.mjs', content: 'in-place-replacement' }, signal, 'in-place-replacement', f.lease), { code: 'PROTOCOL_ROUTE_REQUIRED' })
      assert.equal(replacementEffects, 0)
    } finally { pinnedDefinition.execute = originalExecute }
    // This invokes the production surface callback, native registry and owned
    // service. It intentionally does not claim to exercise the SBCL wire.
    const reply: any = await surface.manager.options.toolCall!(f.owner, 'kioku_write',
      { path: 'tests/unit.test.mjs', content: regression }, signal, 'policy-owned-write', f.lease)
    assert.notEqual(reply.isError, true, JSON.stringify(reply))
    const value = reply.value ?? reply
    assert.equal(value.applied, true, JSON.stringify(reply))
    assert.equal(value.receipt.persistence, 'saved'); assert.deepEqual(value.receipt.taskAuthority, f.lease)
    assert.deepEqual(observedLease, f.lease)
    assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), regression)
    assert.equal(f.phase(), 'verify-red')
    const expectDenied = async (name: string, args: Record<string, unknown>, id: string, pattern: RegExp) => {
      await assert.rejects(async () => {
        // Native policy rejection throws; an observed owned failure can instead
        // be a saved receipt. Normalize that failure without masking a success.
        const raw: any = await surface!.manager.options.toolCall!(f.owner, name, args, signal, id, f.lease)
        const result = raw.value ?? raw
        if (result.receipt?.error) {
          assert.notEqual(result.receipt.processStarted, true)
          throw new Error(result.receipt.error)
        }
      }, pattern)
    }
    await expectDenied('kioku_write', { path: 'src/value.mjs', content: 'bypass' }, 'policy-early-implementation', /RED|phase|protocol/i)
    assert.equal(await readFile(join(f.root, 'src/value.mjs'), 'utf8'), initial)
    await expectDenied('kioku_exec', { command: 'node --version' }, 'policy-unbound-command', /exact approved selected test command/)
    recordTaskEvidence(f.db, f.task, { ref: 'policy-settled', kind: 'stopped', generation: f.task.generation, verified: true })
    const pending = transitionTask(f.db, f.task, { operation: 'wait', operationId: 'policy-wait', expectedRevision: f.task.revision,
      reason: 'All fixture file calls have settled', evidence: ['policy-settled'] })
    transitionTask(f.db, pending, { operation: 'resume', operationId: 'policy-resume', expectedRevision: pending.revision,
      explicit: true, reason: 'New task generation' })
    await assert.rejects(surface.manager.options.toolCall!(f.owner, 'kioku_write',
      { path: 'tests/unit.test.mjs', content: 'stale' }, signal, 'policy-stale', f.lease), /stale or stopped/)
    assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), regression)
    assert.equal(ordinaryEffects, 0); assert.equal(replacementEffects, 0)
  } finally {
    surface?.stop(); await surface?.dispose(); await unmountOwned?.(); await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await f.close()
  }
})
