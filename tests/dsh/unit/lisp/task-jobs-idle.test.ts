import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from '../../../../src/dsh/lisp/request-surface.js'

test('job observation never creates a worker or queries the database; mismatched roots and a closed host fail closed', async () => {
  const store = new LispStore(async () => { throw new Error('observation must not touch storage') })
  const manager = new LispManager({ store, config: LispConfig.parse({}), dataRoot: '/unused-observation' })
  const owner = { sessionId: 'session', agentId: 'agent', root: '/workspace' }
  assert.equal(manager.taskJobsIdle(owner), true)
  manager.enabled.set(owner.sessionId, owner.root)
  assert.equal(manager.taskJobsIdle(owner), true)
  assert.equal(manager.taskJobsIdle({ ...owner, root: '/other' }), false)
  await manager.dispose()
  assert.equal(manager.taskJobsIdle(owner), false)
})

for (const synchronous of [false, true]) for (const change of ['none', 'jobs', 'unknown', 'agent', 'session', 'session-id', 'root', 'stopped'] as const)
  test(`job observation surface revalidates exact owner (${synchronous ? 'transaction' : 'async'}): ${change}`, async t => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-job-observation-')))
    const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
    migrateDatabase(db)
    const definitions = new Map<string, unknown>()
    const tools = { guard: () => () => {}, schemas: () => [], get: () => undefined }
    const agent = { id: 'agent', session: { id: 'session', header: { cwd: base } }, ctx: { get: () => tools } }
    let currentAgent = agent, currentSession = agent.session
    const services: Record<string, unknown> = { tools,
      agents: { get: (id: string) => id === currentAgent.id ? currentAgent : undefined },
      sessions: { get: (id: string) => id === currentSession.id ? currentSession : undefined },
      commands: { register: () => () => {} },
    }
    const ctx: any = { get: (name: string) => services[name], on: () => () => {},
      provide(name: string, service: unknown) { definitions.set(name, service); return () => definitions.delete(name) } }
    ctx.root = ctx
    const surface = await mountLispSurface(ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true }))
    const service = definitions.get(LISP_ASSEMBLY_SERVICE) as LispAssemblyService
    const observe = synchronous ? service.taskJobsIdleSync!.bind(service) : service.taskJobsIdle!.bind(service)
    try {
      assert.equal(await observe({ ...agent }), false, 'a same-ID impostor is rejected')
      const before = db.prepare('SELECT total_changes() AS count').get<{ count: number }>()!.count
      t.mock.method(surface.manager, 'taskJobsIdle', (owner: LispOwner) => {
        assert.deepEqual(owner, { sessionId: 'session', agentId: 'agent', root: base })
        if (change === 'agent') currentAgent = { ...agent }
        if (change === 'session') agent.session = currentSession = { ...agent.session }
        if (change === 'session-id') agent.session.id = 'replacement'
        if (change === 'root') agent.session.header.cwd = dirname(base)
        if (change === 'stopped') surface.stop()
        if (change === 'unknown') throw new Error('job observation unavailable')
        return change !== 'jobs'
      })
      assert.equal(await observe(agent), change === 'none')
      assert.equal(db.prepare('SELECT total_changes() AS count').get<{ count: number }>()!.count, before)
    } finally { await surface.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
  })
