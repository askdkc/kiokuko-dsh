import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { NodeSqliteAdapter, type SqliteDatabase } from '../../../src/db/adapter.js'
import { NativeWorkerRouting, type NativeWorkerOwner } from '../../../src/dsh/native-worker-routing.js'

const pair = { preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const, head: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, worker: { provider: 'deepseek', model: 'deepseek-flash' } }
function fixture() {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../migrations/037_native_worker_routing.sql', import.meta.url), 'utf8'))
  const root = { id: 'root', session: { id: 'root-session', header: { cwd: '/repo', createdAt: 1 } } }
  const agents = new Map<string, any>([[root.id, root]])
  const sessions = new Map<string, any>([[root.session.id, root.session]])
  let owner: NativeWorkerOwner | undefined = { id: 'run:one', sessionId: root.session.id, selectionId: '1', pair }
  const calls: any[] = []
  const backend = { async startActivation(spec: any): Promise<{ childId: string }> {
    calls.push(spec)
    const child = { id: spec.childId, session: { id: spec.childId, header: { parentSession: spec.request.parent.session.id, origin: 'subagent', cwd: '/repo' } } }
    agents.set(child.id, child); sessions.set(child.session.id, child.session)
    assert.deepEqual(await router.worker(child, spec.signal), pair.worker, 'child is bound before first request')
    return { childId: child.id }
  } }
  const original = backend.startActivation
  let validate = async () => {}
  const options = {
    runtime: { withDatabase: async <T>(fn: (database: SqliteDatabase) => T | Promise<T>) => fn(db) }, backend,
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] }, sessions: { get: (id: string) => sessions.get(id) },
    resolveOwner: async (agent: any) => agent === root ? owner : undefined,
    validate: async () => validate(),
  }
  let router: NativeWorkerRouting = new NativeWorkerRouting(options)
  const launch = (provider = 'spawn', parent: any = root, delivery = 'parent') => backend.startActivation({ provider, delivery, signal: new AbortController().signal, label: 'test',
    request: { parent, prompt: [], maxDepth: 2, toolFilter: { allow: ['read'] }, agentOptions: { provider: 'original', model: 'head', reasoningEffort: 'high', maxTokens: 123 } } })
  return { db, root, agents, sessions, backend, original, calls, launch, get router() { return router },
    setValidation: (callback: () => Promise<void>) => { validate = callback },
    owner: () => owner, setOwner: (next: NativeWorkerOwner | undefined) => { owner = next },
    restore: () => { router.dispose(); router = new NativeWorkerRouting(options) },
    close: () => { router.dispose(); db.close() } }
}
for (const provider of ['spawn', 'fork']) test(`native ${provider} gets explicit worker options without changing safety or parent`, async t => {
  const f = fixture(); t.after(f.close)
  const run = await f.launch(provider)
  assert.deepEqual(f.calls[0].request.agentOptions, { ...pair.worker, maxTokens: 123 })
  assert.deepEqual(f.calls[0].request.toolFilter, { allow: ['read'] })
  assert.equal(f.calls[0].request.maxDepth, 2)
  assert.equal(f.calls[0].request.parent, f.root)
  assert.deepEqual(await f.router.head(f.root, new AbortController().signal), pair.head)
  f.restore()
  assert.deepEqual(await f.router.worker(f.agents.get(run.childId), new AbortController().signal), pair.worker)
})
test('unchanged defaults preserve native start and explicit managed delegation', async () => {
  const calls: any[] = []
  const backend = { startActivation: async (spec: any) => { calls.push(spec); return { childId: 'native' } } }
  const router = new NativeWorkerRouting({ runtime: { withDatabase: async () => { throw new Error('no receipt expected') } }, backend,
    agents: undefined, sessions: undefined, resolveOwner: async () => undefined, validate: async () => { throw new Error('no validation expected') } })
  try {
    for (const [provider, delivery] of [['spawn', 'parent'], ['spawn', 'caller'], ['other', 'parent']]) {
      const request = { provider, request: { parent: { id: 'root' } }, delivery, signal: new AbortController().signal }
      await backend.startActivation(request)
      assert.equal(calls.at(-1), request)
    }
  } finally { router.dispose() }
})
test('selection changes, owner replacement and forged identities revoke a durable child', async t => {
  const f = fixture(); t.after(f.close)
  const { childId } = await f.launch()
  const child = f.agents.get(childId), saved = f.owner()!
  for (const changed of [undefined, { ...saved, selectionId: '2' }, { ...saved, id: 'run:two' }, { ...saved, pair: { ...pair, worker: { ...pair.worker, provider: 'other' } } }]) {
    f.setOwner(changed)
    await assert.rejects(f.router.worker(child, new AbortController().signal), /selection|owner/i)
  }
  f.setOwner(saved)
  await assert.rejects(f.router.worker({ ...child }, new AbortController().signal), /identity/i)
  child.session.header.parentSession = 'other'
  await assert.rejects(f.router.worker(child, new AbortController().signal), /lineage/i)
})
test('nested generic children inherit worker and exact original owner', async t => {
  const f = fixture(); t.after(f.close)
  const one = await f.launch(), child = f.agents.get(one.childId)
  const two = await f.launch('fork', child)
  assert.deepEqual(await f.router.worker(f.agents.get(two.childId), new AbortController().signal), pair.worker)
  f.setOwner(undefined)
  await assert.rejects(f.router.worker(f.agents.get(two.childId), new AbortController().signal), /selection|owner/i)
})
test('disposal restores only its own wrapper', t => {
  const f = fixture(); t.after(f.close)
  f.router.dispose(); assert.equal(f.backend.startActivation, f.original)
  f.restore()
  const other = async () => ({ childId: 'other' })
  f.backend.startActivation = other
  f.router.dispose(); assert.equal(f.backend.startActivation, other)
})

test('an assembled request cannot dispatch after the selected generation changes', async t => {
  const f = fixture(); t.after(f.close)
  const signal = new AbortController().signal
  assert.deepEqual(await f.router.head(f.root, signal), pair.head)
  f.setOwner({ ...f.owner()!, selectionId: 'next' })
  await assert.rejects(f.router.assertRequest(f.root, pair.head, signal), /selection changed/)
})
test('an incomplete admission cannot be restored after restart', async t => {
  const f = fixture(); t.after(f.close)
  const { childId } = await f.launch()
  f.db.prepare("UPDATE dsh_native_worker_routes SET state='admitting' WHERE child_session_id=?").run(childId)
  f.restore()
  await assert.rejects(f.router.worker(f.agents.get(childId), new AbortController().signal), /not active/)
})

test('unavailable worker validation blocks head and dispatch without a native fallback', async t => {
  const f = fixture(); t.after(f.close)
  f.setValidation(async () => { throw new Error('worker route unavailable') })
  await assert.rejects(f.router.head(f.root, new AbortController().signal), /unavailable/)
  await assert.rejects(f.launch(), /unavailable/)
  assert.equal(f.calls.length, 0)
})
test('selection changes during async preflight are rejected before native launch', async t => {
  const f = fixture(); t.after(f.close)
  f.setValidation(async () => { f.setOwner({ ...f.owner()!, selectionId: 'changed' }) })
  await assert.rejects(f.launch(), /selection|owner/i)
  assert.equal(f.calls.length, 0)
})

test('a stale child response cannot execute a tool after disabling its owner selection', async t => {
  const f = fixture(); t.after(f.close)
  const { childId } = await f.launch()
  const child = f.agents.get(childId)
  let effects = 0
  const execute = async () => { await f.router.assertCurrent(child); effects++ }
  await execute()
  f.setOwner(undefined)
  await assert.rejects(execute(), /selection|owner/i)
  assert.equal(effects, 1)
})
