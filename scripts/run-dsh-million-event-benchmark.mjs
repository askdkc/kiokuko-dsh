import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../dist/db/connection.js'
import { withImmediateTransaction } from '../dist/db/transaction.js'
import { DshSessionLogMirror } from '../dist/dsh/session-log-mirror.js'
import { DshSessionLogExportService } from '../dist/dsh/session-log-export.js'
import { reduceDshFinalizationLog } from '../dist/dsh/session-memory-finalizer.js'

const EVENT_COUNT = 1_000_000
const MAX_BUFFER_HIGH_WATER = 8 * 1024 * 1024
const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-million-'))
const cachePath = join(root, 'session-cache.sqlite3')
const sessionId = 'million-event-release-benchmark'
const runtime = { async withDatabase() { /* health projection is not used by this benchmark */ } }
const mirror = new DshSessionLogMirror({ runtime, databasePath: cachePath })

try {
  await mirror.start()
  const database = openConnection(cachePath)
  const expectedDigest = createHash('sha256')
  const now = new Date().toISOString()
  const insert = database.prepare(`
    INSERT INTO session_events (session_id, seq, event_json, byte_count, digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (let base = 0; base < EVENT_COUNT; base += 10_000) {
    withImmediateTransaction(database, () => {
      for (let seq = base; seq < Math.min(EVENT_COUNT, base + 10_000); seq += 1) {
        const event = seq === 0
          ? { type: 'turn/start', seq, time: seq, data: { turn: 1 } }
          : seq === 1
            ? { type: 'request/header', seq, time: seq, data: { header: { config: { provider: 'benchmark', model: 'benchmark' }, tools: [] } } }
            : seq === EVENT_COUNT - 1
              ? { type: 'turn/end', seq, time: seq, data: { turn: 1, reason: { kind: 'stop' } } }
              : { type: 'benchmark/event', seq, time: seq, data: { value: 'x' } }
        const json = JSON.stringify(event)
        const line = `${json}\n`
        expectedDigest.update(line)
        insert.run(sessionId, seq, json, Buffer.byteLength(json), createHash('sha256').update(json).digest('hex'), now)
      }
    })
  }
  database.prepare(`
    INSERT INTO session_watermarks (
      session_id, observed_through, mirrored_through, native_durable_through,
      health, updated_at
    ) VALUES (?, ?, ?, ?, 'healthy', ?)
  `).run(sessionId, EVENT_COUNT - 1, EVENT_COUNT - 1, EVENT_COUNT - 1, now)
  database.prepare(`
    INSERT INTO session_retention (session_id, state, last_accessed_at, byte_count)
    SELECT ?, 'unfinalized', ?, coalesce(sum(byte_count), 0)
      FROM session_events WHERE session_id = ?
  `).run(sessionId, now, sessionId)
  database.close()

  let sequence = 0
  let rawHighWater = 0
  const actualDigest = createHash('sha256')
  for await (const chunk of mirror.exportJsonl(sessionId)) {
    rawHighWater = Math.max(rawHighWater, chunk.byteLength)
    actualDigest.update(chunk)
    for (const line of Buffer.from(chunk).toString('utf8').trimEnd().split('\n')) {
      if (line.length === 0) continue
      assert.equal(JSON.parse(line).seq, sequence)
      sequence += 1
    }
  }
  assert.equal(sequence, EVENT_COUNT)
  assert.equal(actualDigest.digest('hex'), expectedDigest.digest('hex'))

  const reduced = await reduceDshFinalizationLog(mirror.streamEvents(sessionId), 0, EVENT_COUNT - 1)
  assert.equal(reduced.eventCount, EVENT_COUNT)
  assert.match(reduced.digest, /^[0-9a-f]{64}$/u)
  assert.ok(Buffer.byteLength(reduced.evidence, 'utf8') <= 4 * 1024 * 1024)

  const exported = await new DshSessionLogExportService(mirror).open(sessionId)
  let zipHighWater = 0
  let zipBytes = 0
  for await (const chunk of exported.body) {
    zipHighWater = Math.max(zipHighWater, chunk.byteLength)
    zipBytes += chunk.byteLength
  }
  assert.ok(rawHighWater <= MAX_BUFFER_HIGH_WATER)
  assert.ok(zipHighWater <= MAX_BUFFER_HIGH_WATER)
  process.stdout.write(`${JSON.stringify({ events: EVENT_COUNT, ordered: true, digest: true, finalizerReduced: true, evidenceBytes: Buffer.byteLength(reduced.evidence), rawHighWater, zipHighWater, zipBytes })}\n`)
} finally {
  await mirror.close()
  await rm(root, { recursive: true, force: true })
}
