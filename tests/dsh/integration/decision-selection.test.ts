import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { createDecisionService, mountDecisionCommand } from '../../../src/dsh/decisions/host.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import type { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import type { DshNativeCommandDefinition } from '../../../src/dsh/commands.js'
import { layaReply, layaRuntime, serveLaya } from '../helpers/laya.js'

const signal = () => new AbortController().signal
const batch = { purpose: 'lisp', state: 'The fruit is apple.', questions: [{ id: 'fruit', instructions: 'Which fruit?', choices: [{ id: 'apple', description: 'Apple' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }
async function database(t: import('node:test').TestContext) {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:')); t.after(() => db.close())
  for (const name of ['021_typed_decisions', '024_decision_selection']) db.exec(await readFile(new URL(`../../../migrations/${name}.sql`, import.meta.url), 'utf8'))
  return { db, runtime: { withDatabase: async (operation: any) => operation(db) } as Pick<DshCoreRuntime, 'withDatabase'> }
}
const ctx = { get: () => ({ resolve: async () => ({ value: 'fixture-key', source: 'file' }) }) }
function command(service: ReturnType<typeof createDecisionService>) {
  let command!: DshNativeCommandDefinition
  mountDecisionCommand({ register: value => { command = value; return () => {} } }, service)
  return (rawInput: string, abort = signal()) => command.handler({ rawInput, signal: abort })
}
function jev(t: import('node:test').TestContext) {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const request = JSON.parse(String(init.body))
    return Response.json({ model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]: [string, any]) => [id, { type: 'choice', choice: 'apple', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'apple' ? 1 : 0])) }])) })
  })
  return () => calls
}

test('native command switches Jev/Laya without identity fields or restart, persists selection, preserves old request bindings', { skip: process.platform === 'win32' }, async t => {
  const { db, runtime } = await database(t), socket = await serveLaya(t), calls = jev(t)
  const base = TypedDecisionsConfig.parse({ 'laya-coreml': { socketPath: socket.path }, nimble: { endpoint: 'http://127.0.0.1:9000/v1/systemone', model: 'fixture-nimble' } })
  const make = (root = '/repo', config = base) => createDecisionService(ctx, runtime, config, undefined, undefined, root)
  const service = make(), run = command(service)
  await service.bind('old-jev')
  assert.equal((await run('use laya')).kind, 'success')
  assert.equal((service.status() as any).provider, 'laya-coreml'); assert.equal(calls(), 0)
  const bound = await service.bind('old-laya')
  assert.equal(bound['laya-coreml']?.runtimeFingerprint, layaRuntime.runtimeFingerprint)
  assert.equal(bound['laya-coreml']?.model, layaRuntime.model)
  assert.equal((await service.bind('old-jev')).provider, 'typesafe')
  assert.equal((await service.evaluate('old-laya', batch, signal())).status, 'completed')
  const before = socket.calls(), restarted = make()
  const restored = JSON.parse((await command(restarted)('status')).text!)
  assert.equal(restored.provider, 'laya-coreml'); assert.equal(socket.calls(), before, 'status never contacts the socket')
  assert.equal((await restarted.bind('old-laya'))['laya-coreml']?.runtimeFingerprint, layaRuntime.runtimeFingerprint)
  assert.equal((await command(restarted)('use jev')).kind, 'success'); assert.equal(calls(), 1)
  assert.equal((await restarted.bind('new-jev')).provider, 'typesafe')
  assert.equal((await restarted.bind('old-laya')).provider, 'laya-coreml')
  assert.equal((await restarted.evaluate('old-jev', batch, signal())).status, 'completed'); assert.equal(calls(), 2)
  const otherRoot = make('/other'); await otherRoot.initialize(); assert.equal((otherRoot.status() as any).provider, 'typesafe')
  const changed = make('/repo', TypedDecisionsConfig.parse({ ...base, typesafe: { model: 'changed-model' } })); await changed.initialize()
  assert.equal((changed.status() as any).provider, 'typesafe', 'changed plugin configuration does not inherit old selection')
  assert.equal((await run('use laya')).kind, 'error', 'stale host may not overwrite a more recent selection')
  assert.equal(db.prepare('SELECT revision FROM dsh_decision_selections').get()!.revision, 2)
  assert.equal((await command(restarted)('use nimble')).kind, 'success')
  assert.equal((await restarted.bind('new-nimble')).provider, 'nimble')
  assert.equal((await command(restarted)('use default')).kind, 'success')
  assert.equal((await restarted.bind('restored-default')).provider, 'typesafe')
  assert.match((await run('')).text!, /use jev.*use laya/)
  assert.equal((await run('use laya extra')).kind, 'error')
})

test('old worker, failed probe and cancellation preserve the previous choice and create no persisted selection', { skip: process.platform === 'win32' }, async t => {
  const { db, runtime } = await database(t)
  let mode: 'legacy' | 'rejected' | 'good' = 'legacy'
  const socket = await serveLaya(t, req => mode === 'legacy' ? { version: 1, ok: true, status: 'ready' } : layaReply(req, (_id, choices) => mode === 'rejected' ? 'unknown' : choices[0]!))
  const config = TypedDecisionsConfig.parse({ 'laya-coreml': { socketPath: socket.path } })
  const service = createDecisionService(ctx, runtime, config), run = command(service)
  const legacy = await run('use laya'); assert.equal(legacy.kind, 'error'); assert.match(legacy.text!, /DECISION_UNSUPPORTED.*worker/)
  mode = 'rejected'; assert.equal((await run('use laya')).kind, 'error')
  mode = 'good'; const cancelled = new AbortController(); cancelled.abort()
  assert.match((await run('use laya', cancelled.signal)).text!, /DECISION_CANCELLED/)
  assert.equal((service.status() as any).provider, 'typesafe')
  assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_decision_selections').get()!.n, 0)
  assert.equal((await run('use laya')).kind, 'success', 'explicit retry works after recovery')
})

test('configuration-only Laya discovers once before binding, keeps runtime pinned and replays without contacting a changed worker', { skip: process.platform === 'win32' }, async t => {
  const { runtime } = await database(t)
  let fingerprint = layaRuntime.runtimeFingerprint
  const socket = await serveLaya(t, req => { const reply = structuredClone(layaReply(req)); reply.runtime.runtimeFingerprint = fingerprint; return reply })
  const config = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { socketPath: socket.path } })
  const service = createDecisionService(ctx, runtime, config)
  assert.equal((await service.evaluate('pinned', batch, signal())).status, 'completed')
  const before = socket.calls(); fingerprint = `sha256:${'b'.repeat(64)}`
  const restarted = createDecisionService(ctx, runtime, config)
  assert.equal((await restarted.evaluate('pinned', batch, signal())).status, 'completed'); assert.equal(socket.calls(), before)
  const changed = { ...batch, state: 'Changed evidence' }
  assert.deepEqual(await restarted.evaluate('pinned', changed, signal()), { status: 'fallback', reason: 'DECISION_UNSUPPORTED' })
  assert.equal((await command(service)('use laya')).kind, 'success')
  assert.equal((await service.bind('after-refresh'))['laya-coreml']?.runtimeFingerprint, fingerprint)
  assert.equal((await service.bind('pinned'))['laya-coreml']?.runtimeFingerprint, layaRuntime.runtimeFingerprint)
})
