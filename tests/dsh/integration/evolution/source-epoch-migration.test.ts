import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { defaultMigrationsDirectory, loadMigrationSnapshot, migrateDatabase } from '../../../../src/db/migrate.js'
import { recordEntry } from '../../../../src/memory/entries.js'

const tables = ['memory_episodes', 'memory_episode_entries', 'memory_evolution_jobs', 'memory_evolution_calls', 'memory_evolution_skips'] as const
const now = '2026-10-14T00:00:00.000Z', workspace = 'project:epoch-migration'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-epoch-migration-')), old = join(root, '41'), target = join(root, '42')
  await mkdir(old); await mkdir(target)
  const source = defaultMigrationsDirectory()
  for (const migration of loadMigrationSnapshot(source).migrations.filter(item => item.version <= 42)) {
    await copyFile(join(source, migration.name), join(target, migration.name))
    if (migration.version <= 41) await copyFile(join(source, migration.name), join(old, migration.name))
  }
  const db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db, old)
  db.prepare('INSERT INTO repositories VALUES(?,?,?,NULL,1,0,?,?)').run(workspace, workspace, 'fixture', now, now)
  db.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
    VALUES('old-run',?,'old-session','1','test','{}','completed','{}',?,?,?)`).run(workspace, now, now, now)
  const entry = recordEntry(db, { workspace, kind: 'lesson', title: 'Retain legacy provenance', body: 'Original source body', createdBy: 'fixture' }, { now })
  const episodeJson = ' { "runId" : "old-run", "legacy" : "日本語" } \n'
  const inputJson = '[ { "runId" : "old-run", "legacy" : true } ]', modelJson = '{ "provider" : "fixture", "model" : "fixed" }'
  db.prepare('INSERT INTO memory_episodes VALUES(?,?,?,?,?,?,?)').run('old-run', workspace, 'signature', 'evidence-digest', episodeJson, entry.id, now)
  db.prepare('INSERT INTO memory_episode_entries VALUES(?,?)').run('old-run', entry.id)
  db.prepare('INSERT INTO memory_derivations VALUES(?,?,?,?,?,?,?,?,?)')
    .run(entry.id, entry.revision, workspace, 'signature', 'episode', 'legacy-algorithm', episodeJson, 'derivation-digest', 'held')
  db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,
    algorithm,state,attempts,claim_token,lease_until,settings_generation,reason,created_at,updated_at)
    VALUES('job-1',?,'old-run','signature','positive',?,'[ "seen" ]','input-1',?,'legacy-algorithm','processing',2,
      'claim-token','2099-01-01T00:00:00.000Z',7,'original reason',?,?)`).run(workspace, inputJson, modelJson, now, now)
  db.prepare(`INSERT INTO memory_evolution_calls VALUES('call-1','job-1','old-run',?,'2026-10-14',123,45,6,789,'unknown',?)`).run(workspace, now)
  // Calls retain budget history even after the original run/job was deleted.
  db.prepare(`INSERT INTO memory_evolution_calls VALUES('orphan-call',NULL,'deleted-run',?,'2026-10-14',12,NULL,NULL,NULL,'failed',?)`).run(workspace, now)
  db.prepare('INSERT INTO memory_evolution_skips VALUES(?,?,?)').run('old-run', workspace, 'original skip')
  const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all().map(row => ({ ...row }))]))
  return { db, target, entry, rows, async close() { db.close(); await rm(root, { recursive: true, force: true }) } }
}

test('041 to 042 retains all legacy episode, membership, claim and budget bytes as epoch 1', async () => {
  const f = await fixture(), { db } = f
  try {
    const before = f.rows(), derivation = db.prepare('SELECT * FROM memory_derivations').get()
    const processing = db.prepare('SELECT * FROM dsh_memory_processing_state ORDER BY workspace').all()
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
    assert.deepEqual(migrateDatabase(db, f.target).applied, [42])
    for (const table of tables) assert.deepEqual(f.rows()[table], before[table]!.map(row => ({ ...row, source_epoch: 1 })), table)
    assert.deepEqual(db.prepare('SELECT * FROM memory_derivations').get(), derivation)
    assert.deepEqual(db.prepare('SELECT * FROM dsh_memory_processing_state ORDER BY workspace').all(), processing,
      'copying the same sources must not manufacture new source changes')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'migration_042_%'").all(), [])
    assert.deepEqual(migrateDatabase(db, f.target).applied, [])
  } finally { await f.close() }
})

test('epoch 2 has separate source identity while lifecycle, erasure, foreign keys and daily budgets remain intact', async () => {
  const f = await fixture(), { db } = f
  try {
    migrateDatabase(db, f.target)
    const revision = () => Number(db.prepare("SELECT context_revision AS n FROM dsh_memory_processing_state WHERE workspace='global'").get()!.n)
    const initial = revision()
    const insertEpisode = () => db.prepare('INSERT INTO memory_episodes(run_id,workspace,signature,evidence_digest,episode_json,created_at,source_epoch) VALUES(?,?,?,?,?,?,?)')
      .run('old-run', workspace, 'signature', 'evidence-2', '{"epoch":2}', now, 2)
    insertEpisode(); assert.equal(revision(), initial + 1)
    assert.throws(insertEpisode, /UNIQUE/)
    db.prepare('INSERT INTO memory_episode_entries(run_id,entry_id,source_epoch) VALUES(?,?,2)').run('old-run', f.entry.id)
    assert.equal(revision(), initial + 2)
    db.prepare('UPDATE memory_episode_entries SET entry_id=entry_id WHERE run_id=? AND source_epoch=2').run('old-run')
    db.prepare('UPDATE memory_episodes SET created_at=? WHERE run_id=? AND source_epoch=2').run('2026-10-15', 'old-run')
    assert.equal(revision(), initial + 4)
    assert.throws(() => db.prepare('UPDATE memory_episodes SET source_epoch=3 WHERE run_id=? AND source_epoch=2').run('old-run'), /immutable/)
    assert.throws(() => db.prepare('UPDATE memory_episodes SET overview_entry_id=? WHERE run_id=? AND source_epoch=1').run('other-entry', 'old-run'), /immutable/)
    assert.throws(() => db.prepare('INSERT INTO memory_episode_entries(run_id,entry_id,source_epoch) VALUES(?,?,3)').run('old-run', f.entry.id), /FOREIGN KEY/)
    assert.throws(() => db.prepare('INSERT INTO memory_episode_entries(run_id,entry_id,source_epoch) VALUES(?,?,1)').run('old-run', 'missing-entry'), /FOREIGN KEY/)
    assert.throws(() => db.prepare('INSERT INTO memory_episodes(run_id,workspace,signature,evidence_digest,episode_json,created_at) VALUES(?,?,?,?,?,?)')
      .run('missing-run', workspace, 'signature', 'digest', '{}', now), /FOREIGN KEY/)
    const insertJob = (id: string, digest: string) => db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,state,created_at,updated_at,source_epoch)
      VALUES(?,?,'old-run','signature','positive','[]','[]',?,'{}','pending',?,?,2)`).run(id, workspace, digest, now, now)
    insertJob('job-2', 'input-2')
    assert.throws(() => insertJob('duplicate-job', 'other-input'), /UNIQUE/)
    assert.throws(() => db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,state,created_at,updated_at,source_epoch)
      VALUES('digest-duplicate',?,'old-run','signature','positive','[]','[]','input-1','{}','pending',?,?,3)`).run(workspace, now, now), /UNIQUE/)
    const insertCall = (id: string) => db.prepare(`INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,outcome,created_at,source_epoch)
      VALUES(?,'job-2','old-run',?,'2026-10-14',14,'unknown',?,2)`).run(id, workspace, now)
    insertCall('call-2'); assert.throws(() => insertCall('duplicate-call'), /UNIQUE/)
    db.prepare('INSERT INTO memory_evolution_skips(run_id,workspace,reason,source_epoch) VALUES(?,?,?,2)').run('old-run', workspace, 'epoch 2 skip')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls WHERE workspace=? AND utc_day=?').get(workspace, '2026-10-14')!.n, 3)
    assert.throws(() => db.prepare("UPDATE memory_evolution_jobs SET input_json='[]',seen_json='[]' WHERE id='job-1'").run(), /immutable/)
    db.prepare("INSERT INTO memory_forget_jobs VALUES('evolution','job-1')").run()
    db.prepare("UPDATE memory_evolution_jobs SET input_json='[]',seen_json='[]' WHERE id='job-1'").run()
    assert.throws(() => db.prepare("UPDATE memory_evolution_jobs SET source_epoch=9 WHERE id='job-1'").run(), /immutable/)
    assert.throws(() => db.prepare('INSERT INTO memory_evolution_skips(run_id,workspace,reason,source_epoch) VALUES(?,?,?,0)').run('old-run', workspace, 'invalid'), /CHECK/)
    db.prepare('DELETE FROM memory_episodes WHERE run_id=? AND source_epoch=2').run('old-run')
    assert.equal(revision(), initial + 6, 'the episode and membership delete triggers must both run')
    assert.deepEqual(db.prepare('SELECT source_epoch FROM memory_episode_entries').all().map(row => row.source_epoch), [1])
    db.prepare("DELETE FROM ledger_runs WHERE run_id='old-run'").run()
    for (const table of ['memory_episodes', 'memory_episode_entries', 'memory_evolution_jobs', 'memory_evolution_skips'])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls WHERE job_id IS NULL').get()!.n, 3)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_derivations').get()!.n, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.close() }
})

test('an interrupted 042 rolls back schema, source data, foreign keys and its migration marker atomically', async () => {
  const f = await fixture(), { db } = f
  try {
    const before = f.rows(), schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
    assert.throws(() => migrateDatabase(db, f.target, { beforeMarkApplied(_connection, migration) {
      if (migration.version === 42) throw new Error('fixture: marker write interrupted')
    } }), /marker write interrupted/)
    assert.deepEqual(f.rows(), before)
    assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(), schema)
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, 41)
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'migration_042_%'").all(), [])
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(migrateDatabase(db, f.target).applied, [42])
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.close() }
})
