import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'
import { DeepStore, IntentSchema } from '../../../src/deep-thinker/store.js'
import { DeepConfigurationSchema, DEEP_ROLES, type DeepBudget, type DeepConfiguration } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'

/** Seed the released v16/v26 row shape. Current task admission deliberately does
 * not run before upgrade: its authority queries require the current schema. */
export async function historicalDeepFixture(budget: Partial<DeepBudget> = {}, overrides: Partial<DeepConfiguration> = {}, migrationsDirectory: string) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'historical-deep-fixture-')))
  const dbPath = join(root, 'state.sqlite3'), db = openConnection(dbPath)
  try {
    const migration = migrateDatabase(db, migrationsDirectory)
    if (![16, 26].includes(migration.currentVersion)) throw new Error('Historical Deep fixtures support released schema v16 or v26 only')
    registerRepositoryAndLocation(db, { repositoryId: 'deep-fixture', workspace: 'deep-fixture', displayName: 'Deep fixture', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 })
    let now = 1_000
    const runtime = { withDatabase: async <T>(fn: DshDatabaseOperation<T>): Promise<T> => fn(db, undefined as never) }
    const store = new DeepStore(runtime, () => now)
    const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, { provider: 'mock', model: role }])), budget, ...overrides })
    const runId = randomUUID()
    const intent = IntentSchema.parse({ revision: 1, startId: randomUUID(), workspace: 'deep-fixture', sessionId: 'parent', rootPath: root,
      commandId: 'start-command', messageId: randomUUID(), task: 'Design a bounded analysis process', status: 'accepted', runId,
      configuration, messages: [], problem: '' })
    const state = initialDeepState(intent, runId, '')
    state.revision = 1
    const { nodes, ...header } = state
    const timestamp = new Date(now).toISOString()
    withImmediateTransaction(db, () => {
      db.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,title,metadata_json,started_at,created_at,updated_at)
        VALUES(?,?,?,'1','minimal','{}','active',?,'{}',?,?,?)`)
        .run(runId, intent.workspace, intent.sessionId, intent.task, timestamp, timestamp, timestamp)
      db.prepare(`INSERT INTO dsh_deep_intents(start_id,workspace,dsh_session_id,command_id,command_digest,message_id,input_digest,state_json,revision,status,run_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(intent.startId, intent.workspace, intent.sessionId, intent.commandId, canonicalContentHash({ task: intent.task, armed: false }),
          intent.messageId, canonicalContentHash({ task: intent.task }), JSON.stringify(intent), intent.revision, intent.status, runId, now)
      db.prepare("INSERT INTO dsh_execution_owners(dsh_session_id,workspace,mode,start_id,run_id) VALUES(?,?,'deep-thinker',?,?)")
        .run(intent.sessionId, intent.workspace, intent.startId, runId)
      db.prepare('INSERT INTO dsh_deep_runs(run_id,start_id,workspace,dsh_session_id,phase,revision,state_json) VALUES(?,?,?,?,?,?,?)')
        .run(runId, intent.startId, intent.workspace, intent.sessionId, state.phase, state.revision, JSON.stringify(header))
      for (const node of nodes) db.prepare('INSERT INTO dsh_deep_nodes(run_id,node_id,revision,state_json) VALUES(?,?,?,?)')
        .run(runId, node.id, node.revision, JSON.stringify(node))
      const enqueue = (id: string, kind: 'input' | 'status', payload: unknown) => {
        db.prepare(`INSERT INTO dsh_deep_outbox(event_id,start_id,run_id,dsh_session_id,kind,payload_json,status,event_seq,created_at)
          VALUES(?,?,NULL,?,?,?,'pending',NULL,?)`).run(id, intent.startId, intent.sessionId, kind, JSON.stringify(payload), now)
      }
      enqueue(`deep-intent:${intent.startId}`, 'status', { phase: 'pending', text: 'Deepへの入力を保存しました。' })
      enqueue(`deep-input:${intent.startId}`, 'input', { message: { id: intent.messageId, role: 'user', content: [{ type: 'text', text: intent.task }],
        source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' } } })
    })
    return { root, dbPath, db, runtime, store, state, intent, configuration, advance: (ms: number) => { now += ms },
      close: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    try { db.close() } finally { await rm(root, { recursive: true, force: true }) }
    throw error
  }
}
