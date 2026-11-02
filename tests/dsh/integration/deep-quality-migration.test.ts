import {DeepStore} from '../../../src/deep-thinker/store.js'
import {openConnection} from '../../../src/db/connection.js'
import { CURRENT_MIGRATION_VERSIONS, CURRENT_SCHEMA_VERSION } from '../../fixtures/current-migrations.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { historicalDeepFixture as deepFixture } from '../helpers/historical-deep-fixture.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { jobFor } from '../../../src/deep-thinker/prompts.js'
import { DeepScheduler } from '../../../src/deep-thinker/scheduler.js'

test('quality migration preserves a version 1 interrupted attempt byte-for-byte and resumes its original protocol', async () => {
  const migrations = resolve('migrations'), version16 = await mkdtemp(join(tmpdir(), 'deep-version16-'))
  for (const name of await readdir(migrations)) {
    if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 16) await copyFile(join(migrations, name), join(version16, name))
  }
  const f = await deepFixture({}, {}, version16)
  const scheduler = new DeepScheduler(f.store, { execute: async (_authority, job) => {
    assert.equal(job.quality, undefined)
    return job.role === 'solver'
      ? { kind: 'candidate', answer: 'Legacy result', evidence: [], assumptions: [], unresolved: [] }
      : { kind: 'supported', requirementIds: f.state.nodes[0]!.requirementIds, reason: 'Legacy verification', evidence: [] }
  } }, async () => {})
  try {
    const node = f.state.nodes[0]!, job = jobFor(f.state, node, 'planner', [])
    await f.store.mutate(f.state.runId, (state, db) => {
      state.phase = 'paused'; state.nodes[0]!.activeAttemptId = 'legacy-attempt'
      db.prepare(`INSERT INTO dsh_deep_attempts(attempt_id,run_id,node_id,node_revision,requirement_revision,
        owner_epoch,role,input_digest,prompt,model_json,status,created_at) VALUES(?,?,?,?,?,?,'planner',?,?,?,'uncertain',1000)`)
        .run('legacy-attempt', state.runId, node.id, node.revision, state.requirementRevision, state.ownerEpoch,
          job.inputDigest, job.prompt, JSON.stringify(state.configuration.roles.planner))
    })
    const before = f.db.prepare('SELECT * FROM dsh_deep_attempts').get()!
    const beforeRun = f.db.prepare('SELECT * FROM dsh_deep_runs').get()!
    assert.deepEqual(migrateDatabase(f.db, migrations).applied, CURRENT_MIGRATION_VERSIONS.filter(version => version > 16))
    const { job_json, ...after } = f.db.prepare('SELECT * FROM dsh_deep_attempts').get()!
    assert.equal(job_json, null); assert.deepEqual(after, { ...before })
    assert.deepEqual(f.db.prepare('SELECT * FROM dsh_deep_runs').get(), beforeRun)
    await scheduler.reconcile('legacy-attempt', { kind: 'leaf', reason: 'One bounded legacy goal' })
    await scheduler.start(f.state.runId); await scheduler.idle(f.state.runId)
    const state = await f.store.read(f.state.runId)
    assert.equal(state.phase, 'answered', state.reason)
    assert.equal(state.protocolVersion, 1); assert.equal(state.nodes[0]!.receipt!.verifierVersion, 1)
    assert.equal(state.nodes[0]!.candidate!.answer, 'Legacy result')
  } finally {
    await scheduler.dispose(); await f.close(); await rm(version16, { recursive: true, force: true })
  }
})

const historicalMigrations=resolve('migrations')
for (const version of [16, 26]) test(`historical v${version} fixture owns its old schema and survives reopen plus forward migration`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'historical-deep-contract-')), old = join(root, 'historicalMigrations')
  let fixture:Awaited<ReturnType<typeof deepFixture>>|undefined
  try {
    await mkdir(old)
    for (const name of await readdir(historicalMigrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= version)
      await copyFile(join(historicalMigrations, name), join(old, name))
    t.mock.method(DeepStore.prototype, 'createIntent', async () => { throw new Error('Historical seed must not use current admission') })
    t.mock.method(DeepStore.prototype, 'createRun', async () => { throw new Error('Historical seed must not use current admission') })
    fixture = await deepFixture({}, {}, old)
    const f = fixture
    assert.equal(f.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version, version)
    assert.equal(f.db.prepare('PRAGMA table_info(ledger_runs)').all().some(row => row.name === 'task_owner_session_id'), false)
    const state = await f.store.read(f.state.runId)
    assert.equal(state.protocolVersion, 1)
    assert.equal(state.nodes.length, 1)
    assert.equal(f.db.prepare('SELECT run_id FROM dsh_execution_owners WHERE dsh_session_id=?').get(f.intent.sessionId)?.run_id, f.state.runId)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
    const stored = f.db.prepare('SELECT * FROM dsh_deep_runs').get()
    const reopened = openConnection(f.dbPath)
    try {
      assert.deepEqual(reopened.prepare('SELECT * FROM dsh_deep_runs').get(), stored)
      assert.deepEqual(migrateDatabase(reopened, historicalMigrations).applied, CURRENT_MIGRATION_VERSIONS.filter(value => value > version))
      assert.equal(reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version, CURRENT_SCHEMA_VERSION)
      assert.deepEqual(reopened.prepare('SELECT * FROM dsh_deep_runs').get(), stored)
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { reopened.close() }
    assert.deepEqual(await f.store.read(f.state.runId), state)
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }) }
})
