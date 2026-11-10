import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { clarificationClaims } from '../../../src/dsh/clarification-claims.js'
import type { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'

test('answer delivery phases advance once under exact ownership and cannot revive consumed answers', async t => {
  const db = openConnection(':memory:')
  migrateDatabase(db)
  t.after(() => db.close())
  const runtime = { withDatabase: async (fn: any) => fn(db) } as DshCoreRuntime
  const claims = clarificationClaims(runtime)
  const identity = { sessionId: 'session', agentId: 'agent', turn: 1, questionId: 'question' }
  const phase = () => db.prepare('SELECT delivery_phase FROM dsh_clarification_claims WHERE question_id=?').get('question')!.delivery_phase
  assert.equal(await claims.claim(identity), true)
  assert.equal(await claims.settle(identity, 'answer'), true)
  assert.equal(phase(), 'queued')
  assert.equal(await claims.advance(identity, 'answer', 'consumed'), false)
  assert.equal(await claims.advance({ ...identity, sessionId: 'foreign' }, 'answer', 'captured'), false)
  assert.equal(await claims.advance(identity, 'other-answer', 'captured'), false)
  assert.equal(await claims.advance(identity, 'answer', 'captured'), true)
  assert.equal(await claims.advance(identity, 'answer', 'captured'), true)
  assert.equal(await claims.advance(identity, 'answer', 'consumed'), true)
  assert.equal(phase(), 'consumed')
  assert.equal(await claims.advance(identity, 'answer', 'captured'), false)
  assert.equal(await clarificationClaims(runtime).claim(identity), false)
  assert.equal(phase(), 'consumed')
})

test('a replacement host restores only the exact persisted native answer and owner', async t => {
  const { clarificationReply } = await import('../../../src/dsh/clarification-context.js')
  const root = await mkdtemp(join(tmpdir(), 'answer-restart-'))
  const path = join(root, 'state.sqlite3')
  let db = openConnection(path); migrateDatabase(db)
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  const runtime = { withDatabase: async (fn: any) => fn(db) } as DshCoreRuntime
  const identity = { sessionId: 'session', agentId: 'agent', turn: 1, questionId: 'question' }
  const reply = clarificationReply({ sources: [{ id: 'original', text: 'Fix the chosen file; do not publish.' }], answers: [] },
    { id: 'answer', questionId: 'question', question: 'Which file?', value: 'src/parser.ts', scope: 'current-scope' })
  const claims = clarificationClaims(runtime)
  await claims.claim(identity)
  await claims.settle(identity, 'answer', reply)
  db.close(); db = openConnection(path)
  const replacement = clarificationClaims(runtime)
  assert.deepEqual(await replacement.restore('session', 'agent', 'answer', reply.content, 2), { context: reply.context, identity })
  assert.equal(await replacement.restore('other', 'agent', 'answer', reply.content, 2), undefined)
  assert.equal(await replacement.restore('session', 'other', 'answer', reply.content, 2), undefined)
  assert.equal(await replacement.restore('session', 'agent', 'answer', reply.content + ' now publish', 2), undefined)
  assert.equal(await replacement.restore('session', 'agent', 'forged-answer', reply.content, 2), undefined)
  assert.equal(await replacement.restore('session', 'agent', 'answer', reply.content, 3), undefined, 'an answer from an older request cannot enter a later turn')
  await replacement.invalidate('session', 'agent', 'answer')
  assert.equal(await replacement.restore('session', 'agent', 'answer', reply.content, 2), undefined)
})
