import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { createDecisionService } from '../../../src/dsh/decisions/host.js'
import { databaseDecisionStore } from '../../../src/dsh/decisions/service.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import type { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { layaConfig, layaReply, serveLaya } from '../helpers/laya.js'

const signal = () => new AbortController().signal

test('Laya host reaches framed socket, persists exact bindings/replay, preserves memory order and legacy DB digests', { skip: process.platform === 'win32' }, async t => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  t.after(() => db.close())
  db.exec(await readFile(new URL('../../../migrations/021_typed_decisions.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../migrations/024_decision_selection.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (operation: any) => operation(db) } as Pick<DshCoreRuntime, 'withDatabase'>
  let evidenceCalls = 0
  const socket = await serveLaya(t, request => {
    if (request.op === 'predict_strict' && !request.questions.fruit) {
      evidenceCalls++
      const state = JSON.parse(request.state), id = Object.keys(request.questions)[0]!
      assert.deepEqual(Object.keys(state.memories), [id]); assert.equal(state.task, 'Keep complete task')
      if (id === 'too-large') return { version: 1, ok: false, error: { code: 'too_large' } }
    }
    return layaReply(request)
  })
  const config = layaConfig(socket.path)
  const ctx = { get() { throw new Error('Laya must not resolve TypeSafe or Nimble credentials') } }
  const service = createDecisionService(ctx, runtime, config)
  await service.inspectStatus(signal()); assert.equal(socket.calls(), 0)
  assert.equal((await service.probe(signal())).state, 'ready')
  const input = { purpose: 'memory-reuse', state: { task: 'Keep complete task', constraints: 'Keep constraints', memories: { first: 'First complete record', 'too-large': 'Oversized fixture', last: 'Last complete record' } },
    questions: ['first', 'too-large', 'last'].map(id => ({ id, instructions: 'Is this applicable?', choices: [{ id: 'yes', description: 'Yes' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' })) }
  const result = await service.evaluate('memory', input, signal())
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') throw new Error('expected completed')
  assert.deepEqual(result.result.answers.map(a => [a.id, a.status]), [['first', 'selected'], ['too-large', 'abstained'], ['last', 'selected']])
  assert.equal(evidenceCalls, 3); assert.equal((service.status() as any).readiness.state, 'ready')
  const count = socket.calls()
  const restarted = createDecisionService(ctx, runtime, config)
  assert.deepEqual(await restarted.evaluate('memory', input, signal()), result); assert.equal(socket.calls(), count)
  const changed = layaConfig(socket.path); changed['laya-coreml']!.runtimeFingerprint = `sha256:${'b'.repeat(64)}`
  const updated = createDecisionService(ctx, runtime, changed)
  assert.deepEqual(await updated.evaluate('memory', input, signal()), result); assert.equal(socket.calls(), count, 'old logical request retains its exact binding')
  for (const provider of ['typesafe', 'nimble'] as const) {
    const old = TypedDecisionsConfig.parse({ provider })
    delete old['laya-coreml']
    const json = JSON.stringify(old), hash = canonicalContentHash(old)
    db.prepare('INSERT INTO dsh_decision_bindings VALUES (?,?,?)').run(`legacy-${provider}`, json, hash)
    assert.deepEqual(await databaseDecisionStore(runtime).bind(`legacy-${provider}`, config), old)
    assert.equal(db.prepare('SELECT config_digest FROM dsh_decision_bindings WHERE request_id=?').get(`legacy-${provider}`)!.config_digest, hash)
  }
})
