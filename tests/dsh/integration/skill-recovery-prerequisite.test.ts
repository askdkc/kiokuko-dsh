import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const marker = "    await f.reload('compiled')\n", begin = source.indexOf(marker), end = source.indexOf('    const firstAfterRecovery =', begin)
  if (begin < 0 || end <= begin || source.indexOf(marker, begin + 1) !== -1) throw new Error('Skill replay recovery boundary changed')
  const preflight = source.slice(begin + marker.length, end)
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
    const f = { agent, ctx: { commands: { async execute(current: any, input: string, _args: unknown, signal: AbortSignal) {
      assert.equal(current, agent); calls.push(input)
      if (input.startsWith('/kioku-task ')) return { result: await command.handler!({ agent, rawInput: input.slice('/kioku-task '.length), signal } as any) }
      assert.equal(input, '/kioku-lisp recover')
      try { await authority.run(owner, () => authority.authorizeEffect(owner)); authorized++; return { result: { kind: 'success' } } }
      catch (error) {
        if (!['TASK_STATE_CONFLICT', 'TASK_REQUIRED'].includes(String((error as { code?: string }).code))) throw error
        return { result: { kind: 'error', text: String(error) } }
      }
    } } } }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    t.diagnostic(JSON.stringify({ before: pending, scope: 'Task-authority gate only; no protected recovery or replay execution' }))
    await new AsyncFunction('assert', 'f', 'AbortController', preflight)(assert, f, AbortController)
    const resumed = (await service.snapshot(agent)).task!
    assert.equal(resumed.state, 'Working')
    assert.equal(resumed.taskId, initial.taskId)
    assert.ok(resumed.generation > pending.generation)
    assert.equal(authorized, 1)
    assert.deepEqual(calls, ['/kioku-task resume', '/kioku-lisp recover'])
  } finally { service?.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})
