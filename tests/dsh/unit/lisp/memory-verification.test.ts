import { bindHistoricalMemory } from '../../helpers/historical-memory.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import type { SqliteDatabase } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { memoryApplicationStatus, recordMemoryApplicationReview } from '../../../../src/memory/application.js'
import { CoreTasks } from '../../../../src/dsh/core/tasks.js'
import { createLispMemoryVerification } from '../../../../src/dsh/lisp/memory-verification.js'
import { LispTaskAuthority } from '../../../../src/dsh/lisp/task-authority.js'
import { bindTaskRepository, transitionTask } from '../../../../src/dsh/task-state.js'

for (const mode of ['missing', 'revoked', 'working'] as const) test(`Lisp CI proof publication: ${mode} authority at the database commit`, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-proof-authority-'))), root = join(base, 'work')
  await mkdir(root); await mkdir(join(root, '.git'))
  await writeFile(join(root, 'check.mjs'), 'process.exit(0)')
  const db = openConnection(join(base, 'state.sqlite3')); migrateDatabase(db)
  const runtime = { withDatabase: async <T>(operation: (connection: SqliteDatabase) => T) => operation(db) }
  try {
    const tasks = new CoreTasks(runtime as any), project = (await resolveProjectWorkspace(db, root))!
    const memory = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'Check the source',
      body: 'Run the source check after changing the source.', createdBy: 'fixture',
      scope: { visibility: 'project', applicability: { languages: ['JavaScript'] } } })
    const task = await tasks.prepare({ requestId: 'proof-authority', sessionId: 'session', turn: 1,
      task: 'check the source code', cwd: root,
      capabilities: ['kiokuko-soul', 'memory-reasoning'].map(name => ({ kind: 'skill' as const, name })),
      profileHints: { taskType: 'build', target: 'check.mjs', expected: 'Verify source', constraints: 'Keep the check passing' },
      signal: new AbortController().signal })
    await bindHistoricalMemory(db, task, project, root)
    const owner = { sessionId: 'session', agentId: 'agent', root }
    const taskIdentity = { taskId: task.runId, sessionId: owner.sessionId, repositoryRoot: root }
    const admitted = bindTaskRepository(db, taskIdentity)
    if (admitted.state === 'ToDo') transitionTask(db, taskIdentity, { operation: 'start', operationId: 'start',
      expectedRevision: admitted.revision, reason: 'CI proof fixture', evidence: [] })
    const status = memoryApplicationStatus(db, task.runId)
    assert.equal(status.items?.length, 1)
    recordMemoryApplicationReview(db, { runId: task.runId, workspace: task.workspace, sessionId: owner.sessionId, repositoryRoot: root }, 'review', {
      generation: status.generation, entryId: memory.id, entryRevision: memory.revision, expectedRevision: 0, decision: 'adopted',
      basis: 'The check verifies this source.', paths: ['check.mjs'], invariant: 'The check passes.',
      counterexample: 'The check fails.', method: 'Run the check.', command: 'npm test' })
    const authority = new LispTaskAuthority(runtime.withDatabase)
    let validations = 0
    const verifier = createLispMemoryVerification(runtime as any, mode === 'missing' ? {} : {
      authorizePublication: (connection, subject) => { validations++; authority.authorizeEffectPublication(connection, subject) },
    })
    const request = { kind: 'verify' as const, target: 'test' as const }
    await authority.run(owner, async () => {
      await verifier.beforeCall(owner, request)
      await authority.authorizeEffect(owner)
      // An execution may finish successfully before a stop/resume changes its lease.
      if (mode === 'revoked') db.prepare('UPDATE ledger_runs SET task_revision=task_revision+1,task_generation=task_generation+1 WHERE run_id=?').run(task.runId)
      const commit = verifier.afterEval(owner, 'operation', 'worker-generation', request,
        { script: 'test', state: 'SUCCEEDED', code: 0, stdout: 'check passed', stderr: '' })
      if (mode === 'working') await commit
      else await assert.rejects(commit, { code: mode === 'missing' ? 'TASK_REQUIRED' : 'TASK_STATE_CONFLICT' })
    })
    assert.equal(validations, mode === 'missing' ? 0 : 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_memory_executions WHERE run_id=?').get<{ count: number }>(task.runId)!.count,
      mode === 'working' ? 1 : 0)
  } finally { db.close(); await rm(base, { recursive: true, force: true }) }
})
