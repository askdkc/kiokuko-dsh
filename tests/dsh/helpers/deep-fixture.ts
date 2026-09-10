import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DeepStore } from '../../../src/deep-thinker/store.js'
import { DeepConfigurationSchema, DEEP_ROLES, type DeepBudget } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'

export async function deepFixture(budget: Partial<DeepBudget> = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'deep-fixture-')))
  const dbPath = join(root, 'state.sqlite3'), db = openConnection(dbPath)
  migrateDatabase(db, join(process.cwd(), 'migrations'))
  registerRepositoryAndLocation(db, { repositoryId: 'deep-fixture', workspace: 'deep-fixture', displayName: 'Deep fixture', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 })
  let now = 1_000
  const runtime = { withDatabase: async <T>(fn: DshDatabaseOperation<T>): Promise<T> => fn(db, undefined as never) }
  const store = new DeepStore(runtime, () => now)
  const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, { provider: 'mock', model: role }])), budget })
  const intent = await store.createIntent({ workspace: 'deep-fixture', sessionId: 'parent', rootPath: root, commandId: 'start-command', task: 'Design a bounded analysis process', status: 'pending', configuration })
  const prepared = await prepareAgentTask(db, { requestId: intent.startId, task: intent.task, cwd: root, dshSessionId: intent.sessionId, deepSelection: { startId: intent.startId, configuration },
    profileHints: { taskType: 'analysis', target: root, expected: 'A verified plan' }, skillDiscoveryMode: 'off' })
  const state = initialDeepState(intent, prepared.run.runId, '')
  await store.createRun(state)
  return { root, dbPath, db, runtime, store, state, intent, configuration, advance: (ms: number) => { now += ms },
    close: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
