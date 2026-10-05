import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { digest } from '../../../../src/dsh/lisp/contracts.js'
import { HotToolRuntime } from '../../../../src/dsh/lisp/hot-tools.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

const owner = { sessionId: 'session', agentId: 'agent', root: '/project' }
const contract = { name: 'increment', description: 'Increment', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }

async function fixture() {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  for (const migration of ['019_dsh_lisp.sql', '031_dsh_lisp_hot_tools.sql'])
    db.exec(readFileSync(new URL(`../../../../migrations/${migration}`, import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)); await store.enable(owner)
  const controls = { before: async (_source: string, _mode?: string) => {}, calls: 0 }
  const runtime = new HotToolRuntime({ store, projectRoot: async () => owner.root, authorize: async () => {},
    questions: { ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['承認する'] }] }) },
    input: async () => { throw new Error('unexpected inputRef') },
    // Unit seam only: protected execution is covered by the native integration suite.
    run: async (_owner, source, input, _signal, mode) => {
      controls.calls++; await controls.before(source, mode)
      return { value: mode === 'compile' ? null : Number(input) + 1, output: {}, generation: 'unit-worker' }
    } })
  const execute = (tool: 'lisp_hot_contract' | 'lisp_hot_install' | 'lisp_hot_call', id: string, input: unknown) =>
    runtime.execute(owner, tool, id, digest({ tool, input }), input) as Promise<any>
  const approved = await execute('lisp_hot_contract', 'approve', contract)
  assert.equal(approved.ok, true)
  const install = (id: string, source = '(lambda (input) (+ input 1))') => execute('lisp_hot_install', id,
    { name: contract.name, contractRef: approved.contractRef, expectedRevision: 0, source })
  return { db, store, runtime, controls, execute, install }
}

test('hot runtime rejects disable/re-enable during validation even when the owner root is unchanged', async () => {
  const f = await fixture()
  try {
    const oldEpoch = (await f.store.session(owner.sessionId))!.epoch
    f.controls.before = async (_source, mode) => { if (mode === 'compile') { await f.store.disable(owner.sessionId); await f.store.enable(owner) } }
    const result = await f.install('revoked')
    assert.equal(result.code, 'HOT_SCOPE')
    assert.notEqual((await f.store.session(owner.sessionId))!.epoch, oldEpoch)
    assert.equal((await f.runtime.catalog.status(owner.root))[0]!.bundleRef, null)
    assert.equal((await f.store.get(owner, 'revoked'))!.state, 'FAILED')
    assert.equal(f.controls.calls, 1)
  } finally { f.db.close() }
})

test('hot runtime concurrent candidates use CAS and cancelled late results cannot publish', async () => {
  const f = await fixture()
  try {
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    f.controls.before = async (source, mode) => { if (source.includes('slow') && mode === 'compile') { entered(); await hold } }
    const slow = f.install('slow-install', '(lambda (input) ; slow\n (+ input 1))')
    await waiting
    const fast = await f.install('fast-install')
    assert.equal(fast.ok, true)
    release()
    assert.equal((await slow).code, 'HOT_REVISION_CONFLICT')
    assert.equal((await f.runtime.catalog.active(owner.root, contract.name)).bundleRef, fast.bundleRef)

    f.controls.before = async () => { f.runtime.cancel(owner.sessionId) }
    const cancelled = await f.execute('lisp_hot_call', 'cancelled-call', { name: contract.name, input: 9 })
    assert.equal(cancelled.code, 'CANCELLED')
    assert.equal((await f.store.get(owner, 'cancelled-call'))!.state, 'CANCELLED')
  } finally { f.db.close() }
})

test('hot publication rolls back the code pointer and version if its success receipt cannot commit', async () => {
  const f = await fixture()
  try {
    f.db.exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE ON dsh_lisp_operations
      WHEN NEW.operation_id='cannot-commit' AND NEW.state='SUCCEEDED'
      BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
    const result = await f.install('cannot-commit')
    assert.equal(result.ok, false)
    assert.equal((await f.runtime.catalog.status(owner.root))[0]!.bundleRef, null)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_hot_versions').get<{ n: number }>()!.n, 0)
    assert.equal((await f.store.get(owner, 'cannot-commit'))!.state, 'FAILED')
  } finally { f.db.close() }
})

test('hot status pages full approved data without executing workers', async () => {
  const f = await fixture()
  try {
    const name = 'large-contract', text = 'あ'.repeat(3000)
    const large = await f.execute('lisp_hot_contract', 'large', { ...contract, name,
      inputSchema: { type: 'string' }, outputSchema: { type: 'string' }, properties: [{ input: text, expected: text }] })
    assert.equal(large.ok, true)
    let offset: number | null = 0, json = ''
    while (offset !== null) {
      const page = await f.runtime.status(owner, { name, contractOffset: offset }) as any
      json += page.text; offset = page.nextOffset
    }
    assert.equal(JSON.parse(json).properties[0].expected, text)
    assert.equal(f.controls.calls, 0)
    await assert.rejects(f.runtime.status(owner, { name, offset: 1, contractOffset: 0 }), /Named inspection/u)
  } finally { f.db.close() }
})

test('hot call result is rolled back when its replay receipt fails', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.install('installed')).ok, true)
    f.db.exec(`CREATE TRIGGER reject_call_receipt BEFORE UPDATE ON dsh_lisp_operations
      WHEN NEW.operation_id='lost-receipt' AND NEW.state='SUCCEEDED'
      BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
    const result = await f.execute('lisp_hot_call', 'lost-receipt', { name: contract.name, input: 2 })
    assert.equal(result.ok, false)
    assert.equal((await f.store.get(owner, 'lost-receipt'))!.state, 'FAILED')
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM dsh_lisp_operations WHERE kind='task_result'").get<{ n: number }>()!.n, 0)
  } finally { f.db.close() }
})
