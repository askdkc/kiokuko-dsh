import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deepFixture } from '../helpers/deep-fixture.js'
import { migrateDatabase } from '../../../src/db/migrate.js'

test('V4 upgrade normalizes only unsent Deep inputs and preserves uncertain delivery', async () => {
  const migrations = resolve('migrations'), version26 = await mkdtemp(join(tmpdir(), 'dsh-v26-'))
  for (const name of await readdir(migrations)) {
    if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 26) await copyFile(join(migrations, name), join(version26, name))
  }
  const f = await deepFixture({}, {}, version26)
  try {
    const row = f.db.prepare("SELECT event_id AS eventId, payload_json AS payloadJson FROM dsh_deep_outbox WHERE kind='input'")
      .get<{ eventId: string; payloadJson: string }>()!
    const legacy = JSON.stringify({ message: {
      ...JSON.parse(row.payloadJson).message,
      source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' },
    } })
    f.db.prepare('UPDATE dsh_deep_outbox SET payload_json=? WHERE event_id=?').run(legacy, row.eventId)
    f.db.prepare(`INSERT INTO dsh_deep_outbox
      SELECT 'uncertain-input', start_id, run_id, dsh_session_id, kind, ?, 'sending', event_seq, created_at
      FROM dsh_deep_outbox WHERE event_id=?`).run(legacy, row.eventId)

    assert.deepEqual(migrateDatabase(f.db, migrations).applied, [27, 28])
    const pending = f.db.prepare('SELECT payload_json AS payloadJson FROM dsh_deep_outbox WHERE event_id=?')
      .get<{ payloadJson: string }>(row.eventId)!
    assert.deepEqual(JSON.parse(pending.payloadJson).message.source, { kind: 'plugin:kiokuko-dsh', form: 'instructions' })
    const uncertain = f.db.prepare("SELECT payload_json AS payloadJson FROM dsh_deep_outbox WHERE event_id='uncertain-input'")
      .get<{ payloadJson: string }>()!
    assert.equal(uncertain.payloadJson, legacy)
  } finally { await f.close(); await rm(version26, { recursive: true, force: true }) }
})
