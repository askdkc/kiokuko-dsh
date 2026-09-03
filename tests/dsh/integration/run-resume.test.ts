import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { submitEnnoPlan, submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { DshContinuationRegistry } from '../../../src/dsh/agent-state.js'
import { DshRuntime } from '../../../src/dsh/runtime.js'

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work to Kiokuko Skills.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Shapes focused code contracts.' },
]

test('continuation bindings require exact session, run, workspace, and route epoch', () => {
  const registry = new DshContinuationRegistry()
  const binding = {
    resumeToken: 'opaque-dsh-token', dshSessionId: 'session-a', runId: 'run-a', workspace: 'workspace-a', routeEpoch: 3,
  } as const
  registry.bind(binding)
  assert.deepEqual(registry.resolve(binding), binding)
  assert.throws(() => registry.resolve({ ...binding, dshSessionId: 'session-b' }), /exact dsh route/u)
  assert.throws(() => registry.resolve({ ...binding, runId: 'run-b' }), /exact dsh route/u)
  assert.throws(() => registry.resolve({ ...binding, workspace: 'workspace-b' }), /exact dsh route/u)
  assert.throws(() => registry.resolve({ ...binding, routeEpoch: 4 }), /exact dsh route/u)
  assert.doesNotThrow(() => registry.bind(binding))
  assert.equal(registry.size, 1)
  registry.clear()
  assert.equal(registry.size, 0)
})

test('runtime resumes the exact dsh route and rejects stale credentials before adapter mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-resume-'))
  await mkdir(join(root, 'src'))
  execFileSync('git', ['init', '-q', root])
  const databasePath = join(root, 'data.sqlite3')
  await initializeDatabase({ databasePath })
  const database = openConnection(databasePath)
  const sessionId = 'dsh-resume-session'
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'dsh-resume-request', cwd: root, task: 'Repair the dsh route',
      profileHints: { taskType: 'debug', target: 'src/route.ts', expected: 'route resumes', constraints: null },
      capabilities, dshSessionId: sessionId, skillDiscoveryMode: 'off',
    })
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId }
    submitOdunoIdeal(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'dsh-resume-ideal',
      ideal: {
        objective: 'Resume the exact dsh route', principles: ['Preserve run identity'],
        skillContributions: [], successSignals: ['route resumes'],
      },
    })
    await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'dsh-resume-plan',
      scope: ['src/route.ts'], exclusions: [], acceptanceCriteria: [{ id: 'resume', description: 'route resumes' }],
      workPlan: { objective: 'Resume route', units: [{
        id: 'route', objective: 'Keep route exact', scope: ['src/route.ts'], dependencies: [], routes: ['code'],
        skillNames: [], expertRefs: [{ id: 'code.protocol.v1', reason: 'Preserve exact continuation identity' }],
        acceptanceCriteria: ['route resumes'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [{
        id: 'resume-final', kind: 'test', executable: process.execPath,
        args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 5000,
      }], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      }, capabilities,
    })
    const runtime = new DshRuntime({
      repositoryRoot: realpathSync(root), databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
      embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 },
    })
    try {
      await assert.rejects(runtime.resume({ dshSessionId: sessionId, cwd: join(root, 'src') }), /runId is required/u)
      const first = await runtime.resume({ dshSessionId: sessionId, runId: prepared.run.runId, cwd: join(root, 'src') })
      assert.equal(first.continue, true)
      assert.equal(first.runId, prepared.run.runId)
      assert.ok(first.resumeToken)
      assert.ok(first.executionLease)
      assert.equal(first.reason?.includes(first.resumeToken!), false)
      assert.equal(first.reason?.includes(first.executionLease!.leaseToken), false)
      assert.equal(runtime.continuationCount, 1)

      await assert.rejects(
        runtime.resume({ dshSessionId: 'dsh-resume-session-b', runId: prepared.run.runId, cwd: root }),
        /active Enno WorkUnit lease prevents DSH session rebinding/u,
      )
      database.prepare("UPDATE enno_execution_leases SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(prepared.run.runId)
      const rebound = await runtime.resume({ dshSessionId: 'dsh-resume-session-b', runId: prepared.run.runId, cwd: root })
      assert.equal(rebound.continue, true)
      assert.equal(rebound.routeEpoch, (first.routeEpoch ?? 0) + 1)
      assert.ok(rebound.resumeToken)
      assert.equal(database.prepare('SELECT dsh_session_id AS value FROM enno_contracts WHERE run_id = ?').get<{ value: string }>(prepared.run.runId)?.value, 'dsh-resume-session-b')
      await assert.rejects(
        runtime.resume({ dshSessionId: sessionId, runId: prepared.run.runId, resumeToken: first.resumeToken!, cwd: root }),
        /route (?:epoch is|is) stale|does not match the current DSH route/u,
      )

      const continuationRows = () => database.prepare('SELECT continuation_count AS count FROM enno_dsh_continuations WHERE run_id = ? AND dsh_session_id = ?').get<{ count: number }>(prepared.run.runId, 'dsh-resume-session-b')?.count
      const beforeStale = continuationRows()
      database.prepare('UPDATE enno_contracts SET route_epoch = route_epoch + 1 WHERE run_id = ?').run(prepared.run.runId)
      await assert.rejects(runtime.resume({ dshSessionId: 'dsh-resume-session-b', runId: prepared.run.runId, resumeToken: rebound.resumeToken!, cwd: root }), /route epoch is stale/u)
      assert.equal(continuationRows(), beforeStale)
    } finally {
      await runtime.close()
    }
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
