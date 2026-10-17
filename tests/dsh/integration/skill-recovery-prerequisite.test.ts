import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { stripTypeScriptTypes } from 'node:module'
import { requireCommandSuccess } from '../../../scripts/verification-diagnostics.mjs'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { workingLispTask } from '../helpers/lisp-task.js'
import { recordTaskEvidence, transitionTask } from '../../../src/dsh/task-state.js'
import { DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { taskWorkflowCommand } from '../../../src/dsh/task-state-surface.js'
import { LispTaskAuthority } from '../../../src/dsh/lisp/task-authority.js'

// This is a task-authority prerequisite check. The recovery adapter stops at
// authorizeEffect; it never runs protected recovery, a Lisp worker or replay.
test('skill replay fixture resumes its persisted Pending task before recovery authorization', async t => {
  const source = await readFile(new URL('../skill-delivery/skill-delivery.test.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('skill-delivery.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const workflowName = 'Lisp workflow reaches the next model request through native approval, evidence paging, plugin restart and exact replay'
  const workflows: ts.ArrowFunction[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === workflowName) {
      const callback = node.arguments.at(-1)
      if (callback && ts.isArrowFunction(callback)) workflows.push(callback)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(workflows.length, 1, 'the exact native replay workflow must be present once')
  const reloads: ts.ExpressionStatement[] = [], boundaries: ts.VariableStatement[] = []
  const locate = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression) && ts.isCallExpression(node.expression.expression)) {
      const call = node.expression.expression
      if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
        && call.expression.expression.text === 'f' && call.expression.name.text === 'reload') reloads.push(node)
    }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'firstAfterRecovery')) boundaries.push(node)
    ts.forEachChild(node, locate)
  }
  locate(workflows[0]!)
  assert.equal(reloads.length, 1); assert.equal(boundaries.length, 1)
  assert.equal(reloads[0]!.parent, boundaries[0]!.parent, 'recovery must remain in the same workflow block')
  assert.ok(reloads[0]!.end < boundaries[0]!.getStart(parsed))
  const helper = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'enableLisp')
  assert.equal(helper.length, 1, 'execute the real shared command assertion, not a copied replacement')
  const preflight = stripTypeScriptTypes(helper[0]!.getText(parsed) + '\n' + source.slice(reloads[0]!.end, boundaries[0]!.getStart(parsed)))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'skill-recovery-authority-')))
  const db = openConnection(join(root, 'state.sqlite3'))
  let service: DshTaskWorkflow | undefined
  try {
    execFileSync('git', ['init', '--quiet', '--template=', root])
    const owner = { root, sessionId: 'skill-main', agentId: 'skill-main' }
    const initial = workingLispTask(db, owner)
    registerRepositoryAndLocation(db, { repositoryId: 'skill-recovery', workspace: 'project:lisp-tests', displayName: 'Skill recovery fixture', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 })
    recordTaskEvidence(db, initial, { ref: 'fixture-stopped', kind: 'stopped', generation: initial.generation, verified: true })
    const pending = transitionTask(db, initial, { operation: 'wait', operationId: 'fixture-wait', expectedRevision: initial.revision, evidence: ['fixture-stopped'], reason: 'Fixture has no live processes' })
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: root } }, status: 'idle', async whenIdle() {} }
    const runtime = { withDatabase: async (operation: any) => operation(db) }
    service = new DshTaskWorkflow({ runtime: runtime as any, agents: new Map([[agent.id, agent]]), sessions: new Map([[agent.session.id, agent.session]]),
      tools: { schemas: () => [] }, skills: { snapshot: async () => ({ complete: true, skills: [] }) }, emit() {} })
    const authority = new LispTaskAuthority(async operation => operation(db))
    const command = taskWorkflowCommand(service), calls: string[] = []
    let authorized = 0
    const denied: string[] = []
    const f = { agent, ctx: { commands: { async execute(current: any, input: string, _args: unknown, signal: AbortSignal) {
      assert.equal(current, agent); calls.push(input)
      if (input.startsWith('/kioku-task ')) return { result: await command.handler!({ agent, rawInput: input.slice('/kioku-task '.length), signal } as any) }
      assert.equal(input, '/kioku-lisp recover')
      try { await authority.run(owner, () => authority.authorizeEffect(owner)); authorized++; return { result: { kind: 'success' } } }
      catch (error) {
        if (!['TASK_STATE_CONFLICT', 'TASK_REQUIRED'].includes(String((error as { code?: string }).code))) throw error
        denied.push(String((error as { code?: string }).code))
        return { result: { kind: 'error', text: String(error) } }
      }
    } } } }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await assert.rejects(authority.run(owner, () => authority.authorizeEffect(owner)), (error: any) => ['TASK_STATE_CONFLICT', 'TASK_REQUIRED'].includes(error.code), 'Pending task must remain unauthorized before the real resume command')
    t.diagnostic(JSON.stringify({ before: pending, scope: 'Task-authority gate only; no protected recovery or replay execution' }))
    const execute = (code: string) => new AsyncFunction('assert', 'f', 'AbortController', 'requireCommandSuccess', code)(assert, f, AbortController, requireCommandSuccess)
    const withoutResume = preflight.replace("'/kioku-task resume'", "'/kioku-task status'")
    assert.notEqual(withoutResume, preflight, 'the counterexample must remove the real resume command')
    await assert.rejects(execute(withoutResume))
    assert.deepEqual(calls, ['/kioku-task status', '/kioku-lisp recover'])
    assert.equal(denied.length, 1, 'real task authority must reject recovery while still Pending')
    assert.equal((await service.snapshot(agent)).task!.state, 'Pending')
    assert.equal(authorized, 0)
    calls.length = 0
    await execute(preflight)
    const resumed = (await service.snapshot(agent)).task!
    assert.equal(resumed.state, 'Working')
    assert.equal(resumed.taskId, initial.taskId)
    assert.ok(resumed.generation > pending.generation)
    assert.equal(authorized, 1)
    assert.deepEqual(calls, ['/kioku-task resume', '/kioku-lisp recover'])
  } finally { service?.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})
