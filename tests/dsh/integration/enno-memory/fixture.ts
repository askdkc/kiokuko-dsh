import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { DshEnnoMemoryRefresh, type EnnoMemoryObservation, type RefreshBinding } from '../../../../src/dsh/enno-memory-refresh.js'
import { EnnoMemoryConfig } from '../../../../src/dsh/config.js'
import type { DshDatabaseOperation } from '../../../../src/dsh/runtime.js'
export const capabilities = ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'memory-reasoning'].map(name => ({ kind: 'skill', name }))
export const failure = { value: { exitCode: 1, stderr: 'E_LOCK_TIMEOUT' }, content: [{ type: 'text', text: 'E_LOCK_TIMEOUT' }], isError: true }
export async function fixture(mode: 'off' | 'observe' | 'active' = 'active', count = 1, maxFull = 8) {
  const root = await mkdtemp(join(tmpdir(), 'enno-memory-')); await mkdir(join(root, '.git'))
  const path = join(root, '.git/state.sqlite3'), db = openConnection(path); migrateDatabase(db)
  const project = (await resolveProjectWorkspace(db, root))!
  for (let i = 0; i < count; i++) recordEntry(db, { workspace: i >= 100 ? 'global' : project.workspace, kind: 'reference', title: `QUEUE_TEST_BASELINE ${i}`, body: 'General test reference', createdBy: 'fixture', scope: i >= 100 ? { schemaVersion: 3, visibility: 'global', retrievalScope: 'global', portableReason: 'Generic disposable test guidance' } : { visibility: 'project' } })
  const correct = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'E_LOCK_TIMEOUT', body: 'Only fifo-mode: release latch after quiescence. Never apply to damaged storage.', createdBy: 'fixture', scope: { visibility: 'project' } })
  let prepared = await prepareAgentTask(db, { requestId: 'refresh-fixture', cwd: root, task: 'QUEUE_TEST_BASELINE を修正',
    profileHints: { taskType: 'build', target: 'QUEUE_TEST_BASELINE', expected: 'verified' }, capabilities, dshSessionId: 'parent', skillDiscoveryMode: 'off' })
  const runtime = { withDatabase: async <T>(fn: DshDatabaseOperation<T>): Promise<T> => fn(db, { mode: 'off' } as never) }
  const observations: EnnoMemoryObservation[] = [], agent = {}, session = {}, abort = new AbortController()
  let generation = 0
  const config = EnnoMemoryConfig.parse({ mode, maxFullSearchesPerRun: maxFull, localBudgetMs: 5000 })
  const service = new DshEnnoMemoryRefresh(runtime, config, value => observations.push(value))
  const binding = (): RefreshBinding => {
    const captured = generation
    return { runId: prepared.run.runId, sessionId: 'parent', nativeAgent: agent, nativeSession: session,
      prepared, capabilities, constraints: '', signal: abort.signal, isCurrent: () => captured === generation,
      apply: value => { prepared = { ...prepared, ...value } } }
  }
  return { root, path, db, runtime, correct, service, config, observations, binding, agent, session, abort,
    get prepared() { return prepared }, set prepared(value) { prepared = value },
    supersede() { generation++; service.invalidate(prepared.run.runId) },
    async close() { service.close(); db.close(); await rm(root, { recursive: true, force: true }) } }
}
