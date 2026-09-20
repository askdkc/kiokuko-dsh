import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { submitReviewedPlan } from './reviewed-plan.js'
import { submitOdunoIdeal, answerEnno } from '../../../src/enno-oduno/service.js'
import { initializeExecutionSelection, writeExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { DshEnnoDelegation } from '../../../src/dsh/enno-delegation.js'

/** Actual persisted WorkUnit lease behind the native child compaction tests. */
export async function compactionEnno(child: any) {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-enno-')), db = openConnection(join(directory, 'state.sqlite3'))
  migrateDatabase(db, join(process.cwd(), 'migrations'))
  const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }]
  const task = await prepareAgentTask(db, { requestId: 'semantic-worker', cwd: process.cwd(), task: 'Implement semantic compaction', profileHints: { taskType: 'build', target: 'src', expected: 'verified' }, capabilities, dshSessionId: 'parent', skillDiscoveryMode: 'off' })
  const identity = { runId: task.run.runId, workspace: task.project.workspace, orchestrationId: task.intake.sessionId }
  submitOdunoIdeal(db, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal', ideal: { objective: 'Semantic compaction', principles: ['Verify'], skillContributions: [], successSignals: ['verified'] } })
  const verifier = { id: 'verify', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }
  await submitReviewedPlan(db, { ...identity, expectedRevision: 1, idempotencyKey: 'plan', scope: ['src'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Verified' }],
    workPlan: { objective: 'Semantic compaction', units: [{ id: 'unit', objective: 'Implement', scope: ['src'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify' }], acceptanceCriteria: ['Verified'], focusedVerifiers: [verifier] }] },
    skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3, capabilities,
    provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred' } })
  const approved = answerEnno(db, { ...identity, expectedRevision: 2, idempotencyKey: 'approve', action: 'approve' })
  const model = { provider: 'mock', model: 'mock' }
  initializeExecutionSelection(db, identity.runId)
  writeExecutionSelection(db, identity.runId, 0, { mode: 'enno', status: 'ready', configuration: { custom: true, maxConcurrentChildren: 1, roles: { ideal: model, zenki: model, goki: model, worker: model, check: model } } })
  const runtime = { withDatabase: async <T>(fn: DshDatabaseOperation<T>): Promise<T> => fn(db, undefined as never) }
  let finish!: (value: any) => void, started!: () => void
  const finished = new Promise<any>(resolve => { finish = resolve }), ready = new Promise<void>(resolve => { started = resolve })
  const delegation = new DshEnnoDelegation(runtime, { start: async () => {
    delegation.created(child); await delegation.restoreOrPersist(child); started()
    return { id: child.id, localAgent: child, result: finished, dispose: async () => {} }
  } })
  const binding = { ...identity, dshSessionId: 'parent', revision: 2, routeEpoch: approved.executionLease!.routeEpoch, leaseToken: approved.executionLease!.leaseToken, workUnitId: 'unit', idempotencyKey: 'worker-1' }
  const pending = delegation.execute({ id: 'parent', session: { id: 'parent', header: { cwd: process.cwd() } } } as any, { instruction: 'Inspect old files' }, binding, ['read'], new AbortController().signal)
  await Promise.race([ready, pending.then(() => { throw new Error('Child ended before binding') })])
  const snapshot = () => JSON.stringify(['dsh_enno_delegations', 'enno_contracts', 'enno_work_units'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))
  return { delegation, runtime, db, snapshot, close: async () => { finish({ output: 'Complete', stopReason: 'completed' }); await pending; db.close(); await rm(directory, { recursive: true, force: true }) } }
}
