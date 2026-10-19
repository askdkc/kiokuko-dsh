import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { bindTaskRepository, transitionTask, captureTaskLease } from '../../../src/dsh/task-state.js'
import { createAdmission } from '../../../src/dsh/host-adapter/admission.js'

// Exercise the production preflight with actual persisted task identities. The
// next database boundary deliberately ends this isolated test; native tests own
// full model-loop behavior after preflight.
for (const variant of ['exact', 'human', 'context-clone', 'intent-clone', 'restart', 'foreign-agent', 'foreign-session', 'later-turn'] as const) {
  test(`continuation preflight admits only captured same-turn authority: ${variant}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'continuation-guard-')))
    const db = openConnection(join(root, 'state.sqlite3'))
    try {
      migrateDatabase(db)
      const service = new DshRunIntakeService(db, { akinatorMemory: AkinatorMemoryConfig.parse({ mode: 'off' }) })
      const open = (id: string) => {
        const run = service.openRun({ idempotencyKey: id, dshSessionId: 'session', request: {
          apiVersion: '1', workspace: 'project:guard-test', task: { title: id, query: 'Inspect existing parser',
            profileHints: { taskType: 'research', target: '.', expected: 'Report observations', constraints: null } },
          captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' }, metadata: { taskStateExplicit: true },
        } })
        const identity = { taskId: run.runId, sessionId: 'session', repositoryRoot: root }
        const task = bindTaskRepository(db, identity)
        transitionTask(db, identity, { operation: 'start', operationId: 'start', expectedRevision: task.revision, reason: 'Admitted test work' })
        return captureTaskLease(db, identity)
      }
      const historical = open('old'), authority = open('replacement')
      db.prepare('UPDATE ledger_runs SET task_revision=task_revision+1 WHERE run_id=?').run(historical.taskId)
      const nativeAgent = {}, nativeSession = {}
      const requestIntent = { relation: 'scope_change', action: 'change', changeScope: 'implementation' }
      const requestIntentContext = { activeTask: historical }
      const prior = { agentId: 'agent', sessionId: 'session', turn: 2, task: 'Change parser', closed: false, failed: false,
        nativeAgent, nativeSession, authority, requestIntent, requestIntentContext }
      let calls = 0
      const nextBoundary = new Error('passed authority preflight')
      const owner = createAdmission({
        runtime: { withDatabase: async (fn: (db: any) => unknown) => { if (++calls > 1) throw nextBoundary; return fn(db) } },
        turnState: { currentSession: () => prior,
          currentForAgentEvent: (_a: string, _s: string, _t: number, session: object, agent: object) =>
            variant !== 'restart' && session === nativeSession && agent === nativeAgent ? prior : undefined },
      } as any)
      const event = { agent: { id: 'agent' }, sessionId: 'session', turn: variant === 'later-turn' ? 3 : 2, task: prior.task, cwd: root,
        nativeAgent: variant === 'foreign-agent' ? {} : nativeAgent,
        nativeSession: variant === 'foreign-session' ? {} : nativeSession,
        nativeMessages: variant === 'human' ? [{ role: 'user', content: 'Change parser', source: { kind: 'user' } }] : [],
        requestIntent: variant === 'intent-clone' ? { ...requestIntent } : requestIntent,
        requestIntentContext: variant === 'context-clone' ? { ...requestIntentContext } : requestIntentContext,
        signal: new AbortController().signal }
      await assert.rejects(owner.gate.prepare(event as any), variant === 'exact' ? error => error === nextBoundary : /Task continuation revision changed/)
      assert.equal(calls, variant === 'exact' ? 2 : 1)
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
}
