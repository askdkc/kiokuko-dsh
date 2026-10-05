import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { digest } from '../../../../src/dsh/lisp/contracts.js'
import { HotToolStore } from '../../../../src/dsh/lisp/hot-store.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

const root = '/workspace/project'
const owner = { sessionId: 'session', agentId: 'agent', root }
const integer = { type: 'integer' as const }
const schemaContract = (name: string, expectedContractRef: string | null = null) => ({
  name, description: `${name} contract`, inputSchema: integer, outputSchema: integer,
  properties: [{ input: 1, expected: 2 }], expectedContractRef,
})
const bundle = (name: string, contractRef: string, source = '(lambda (input) (+ input 1))') => ({
  name, contractRef, source, inputSchema: integer, outputSchema: integer,
})

async function fixture() {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)); await store.enable(owner)
  const epoch = (await store.session(owner.sessionId))!.epoch
  return { db, store, hot: new HotToolStore(store), epoch }
}

async function pending(store: LispStore, id: string, kind: string, epoch: string, state: 'RUNNING' | 'AWAITING_APPROVAL', request: Record<string, unknown> = {}, result: Record<string, unknown> = {}, projectRoot = root) {
  const payload = { projectRoot, ...request }
  await store.reserve(owner, id, kind, digest({ id, kind, payload }), epoch, payload)
  if (state === 'AWAITING_APPROVAL') await store.transition(owner, id, ['RUNNING'], 'AWAITING_APPROVAL', result)
  else if (Object.keys(result).length) await store.transition(owner, id, ['RUNNING'], 'RUNNING', result)
}

test('hot store approves contracts, enforces CAS, and keeps active code until replacement activates', async () => {
  const f = await fixture()
  try {
    const first = schemaContract('add-one')
    await pending(f.store, 'contract-1', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...first, expectedContractRef: null } })
    const approved = await f.hot.approve(owner, f.epoch, root, 'contract-1', first)
    assert.equal(approved.revision, 0)
    const firstRef = approved.contractRef

    await pending(f.store, 'install-1', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'add-one', contractRef: firstRef, expectedRevision: 0, sourceDigest: digest('(lambda (input) (+ input 1))') }, { phase: 'checking', checked: 1, total: 1 })
    const installed = await f.hot.activate(owner, f.epoch, root, 'install-1', { name: 'add-one', contractRef: firstRef, expectedRevision: 0, bundle: bundle('add-one', firstRef) })
    assert.equal(installed.revision, 1)
    const activeBefore = await f.hot.active(root, 'add-one')
    assert.equal(activeBefore.bundleRef, installed.bundleRef)

    await pending(f.store, 'restart-unknown', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'add-one', contractRef: firstRef, expectedRevision: 1, sourceDigest: digest('(lambda (input) (+ input 1))') })
    await f.store.start()
    assert.equal((await f.hot.active(root, 'add-one')).bundleRef, installed.bundleRef, 'restart quarantine must not move the active pointer')

    await pending(f.store, 'contract-2', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...first, expectedContractRef: null } })
    await assert.rejects(f.hot.approve(owner, f.epoch, root, 'contract-2', first), (error: any) => error.code === 'HOT_CONTRACT_CONFLICT')
    const second = schemaContract('add-one', firstRef)
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_operations SET payload=? WHERE operation_id=?').run(JSON.stringify({ projectRoot: root, request: second }), 'contract-2'))
    const approvedSecond = await f.hot.approve(owner, f.epoch, root, 'contract-2', second)
    assert.notEqual(approvedSecond.contractRef, firstRef)
    assert.equal((await f.hot.active(root, 'add-one')).bundleRef, installed.bundleRef)

    await pending(f.store, 'install-2', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'add-one', contractRef: approvedSecond.contractRef, expectedRevision: 1, sourceDigest: digest('(lambda (input) (+ input 2))') }, { phase: 'checking', checked: 1, total: 1 })
    const installedSecond = await f.hot.activate(owner, f.epoch, root, 'install-2', { name: 'add-one', contractRef: approvedSecond.contractRef, expectedRevision: 1, bundle: bundle('add-one', approvedSecond.contractRef, '(lambda (input) (+ input 2))') })
    assert.equal(installedSecond.revision, 2)
    assert.notEqual((await f.hot.active(root, 'add-one')).bundleRef, installed.bundleRef)
    await assert.rejects(f.hot.activate(owner, f.epoch, root, 'install-2', { name: 'add-one', contractRef: approvedSecond.contractRef, expectedRevision: 1, bundle: bundle('add-one', approvedSecond.contractRef) }), (error: any) => error.code === 'STATE_CONFLICT' || error.code === 'ID_CONFLICT')
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_hot_versions SET created_at=? WHERE bundle_ref=?').run(new Date(Date.now() - 31 * 86400000).toISOString(), installed.bundleRef))
    await f.hot.expire(new Date())
    assert.equal((await f.hot.active(root, 'add-one')).bundleRef, installedSecond.bundleRef)
    assert.equal(await f.store.database(db => db.prepare('SELECT 1 AS present FROM dsh_lisp_hot_versions WHERE bundle_ref=?').get(installed.bundleRef)), undefined)
  } finally { f.db.close() }
})

test('hot store binds the approved request, source digest, progress and deactivation target', async () => {
  const f = await fixture()
  try {
    const contract = schemaContract('bound')
    await pending(f.store, 'bound-contract', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...contract, name: 'other', expectedContractRef: null } })
    await assert.rejects(f.hot.approve(owner, f.epoch, root, 'bound-contract', contract), (error: any) => error.code === 'STATE_CONFLICT')
    assert.equal((await f.hot.status(root)).length, 0)

    await pending(f.store, 'real-contract', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...contract, expectedContractRef: null } })
    const approved = await f.hot.approve(owner, f.epoch, root, 'real-contract', contract)
    const source = '(lambda (input) (+ input 1))'
    await pending(f.store, 'bad-source', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, sourceDigest: digest(source + ' changed') }, { phase: 'checking', checked: 1, total: 1 })
    await assert.rejects(f.hot.activate(owner, f.epoch, root, 'bad-source', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, bundle: bundle('bound', approved.contractRef, source) }), (error: any) => error.code === 'STATE_CONFLICT')
    assert.equal((await f.hot.status(root)).length, 1)

    await pending(f.store, 'incomplete', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, sourceDigest: digest(source) }, { phase: 'checking', checked: 0, total: 1 })
    await assert.rejects(f.hot.activate(owner, f.epoch, root, 'incomplete', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, bundle: bundle('bound', approved.contractRef, source) }), (error: any) => error.code === 'STATE_CONFLICT')
    assert.equal((await f.hot.status(root))[0]!.bundleRef, null)

    await pending(f.store, 'good-install', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, sourceDigest: digest(source) }, { phase: 'checking', checked: 1, total: 1 })
    const installed = await f.hot.activate(owner, f.epoch, root, 'good-install', { name: 'bound', contractRef: approved.contractRef, expectedRevision: 0, bundle: bundle('bound', approved.contractRef, source) })
    await pending(f.store, 'bad-deactivate', 'lisp_hot_deactivate', f.epoch, 'AWAITING_APPROVAL', { name: 'bound', expectedRevision: 0 })
    await assert.rejects(f.hot.deactivate(owner, f.epoch, root, 'bad-deactivate', { name: 'bound', expectedRevision: installed.revision }), (error: any) => error.code === 'STATE_CONFLICT')
    assert.equal((await f.hot.active(root, 'bound')).bundleRef, installed.bundleRef)
  } finally { f.db.close() }
})

test('hot store rejects epoch revocation and cross-project authority', async () => {
  const f = await fixture()
  try {
    await pending(f.store, 'contract-scope', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...schemaContract('scoped'), expectedContractRef: null } })
    await f.store.disable(owner.sessionId)
    await assert.rejects(f.hot.approve(owner, f.epoch, root, 'contract-scope', schemaContract('scoped')), (error: any) => error.code === 'HOT_SCOPE')
  } finally { f.db.close() }
})

test('hot store retains an obsolete contract while an UNKNOWN install can recover it, then collects it after abandonment', async () => {
  const f = await fixture()
  try {
    const first = schemaContract('recoverable')
    await pending(f.store, 'recover-contract-1', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...first, expectedContractRef: null } })
    const firstApproved = await f.hot.approve(owner, f.epoch, root, 'recover-contract-1', first)
    const replacement = schemaContract('recoverable', firstApproved.contractRef)
    await pending(f.store, 'recover-contract-2', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: replacement })
    await f.hot.approve(owner, f.epoch, root, 'recover-contract-2', replacement)
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_hot_contracts SET created_at=? WHERE contract_ref=?').run(new Date(Date.now() - 31 * 86400000).toISOString(), firstApproved.contractRef))
    await pending(f.store, 'recover-install', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'recoverable', contractRef: firstApproved.contractRef, expectedRevision: 0, sourceDigest: digest('(lambda (input) (+ input 1))') })
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_operations SET state=? WHERE operation_id=?').run('UNKNOWN', 'recover-install'))
    await f.hot.expire(new Date())
    assert.notEqual(await f.hot.contract(root, firstApproved.contractRef), undefined)
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_operations SET state=? WHERE operation_id=?').run('ABANDONED', 'recover-install'))
    await f.hot.expire(new Date())
    await assert.rejects(f.hot.contract(root, firstApproved.contractRef), (error: any) => error.code === 'HOT_CONTRACT_MISSING')
  } finally { f.db.close() }
})

test('hot store allows deactivation at the unchanged active revision after contract reapproval', async () => {
  const f = await fixture()
  try {
    const contract = schemaContract('remove-after-review')
    await pending(f.store, 'remove-contract-1', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...contract, expectedContractRef: null } })
    const approved = await f.hot.approve(owner, f.epoch, root, 'remove-contract-1', contract)
    const source = '(lambda (input) (+ input 1))'
    await pending(f.store, 'remove-install', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'remove-after-review', contractRef: approved.contractRef, expectedRevision: 0, sourceDigest: digest(source) }, { phase: 'checking', checked: 1, total: 1 })
    const installed = await f.hot.activate(owner, f.epoch, root, 'remove-install', { name: 'remove-after-review', contractRef: approved.contractRef, expectedRevision: 0, bundle: bundle('remove-after-review', approved.contractRef, source) })
    const reapproved = schemaContract('remove-after-review', approved.contractRef)
    await pending(f.store, 'remove-contract-2', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: reapproved })
    await f.hot.approve(owner, f.epoch, root, 'remove-contract-2', reapproved)
    await pending(f.store, 'remove-deactivate', 'lisp_hot_deactivate', f.epoch, 'AWAITING_APPROVAL', { name: 'remove-after-review', expectedRevision: installed.revision })
    const result = await f.hot.deactivate(owner, f.epoch, root, 'remove-deactivate', { name: 'remove-after-review', expectedRevision: installed.revision })
    assert.equal(result.revision, installed.revision + 1)
    assert.equal((await f.hot.status(root, 'remove-after-review'))[0]!.bundleRef, null)
  } finally { f.db.close() }
})

test('hot store rejects corrupted active payload and preserves active versions during expiry', async () => {
  const f = await fixture()
  try {
    const contract = schemaContract('retained')
    await pending(f.store, 'retained-contract', 'lisp_hot_contract', f.epoch, 'AWAITING_APPROVAL', { request: { ...contract, expectedContractRef: null } })
    const approved = await f.hot.approve(owner, f.epoch, root, 'retained-contract', contract)
    await pending(f.store, 'retained-install', 'lisp_hot_install', f.epoch, 'RUNNING', { name: 'retained', contractRef: approved.contractRef, expectedRevision: 0, sourceDigest: digest('(lambda (input) (+ input 1))') }, { phase: 'checking', checked: 1, total: 1 })
    const installed = await f.hot.activate(owner, f.epoch, root, 'retained-install', { name: 'retained', contractRef: approved.contractRef, expectedRevision: 0, bundle: bundle('retained', approved.contractRef) })
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_hot_versions SET created_at=? WHERE bundle_ref=?').run(new Date(Date.now() - 31 * 86400000).toISOString(), installed.bundleRef))
    await f.hot.expire(new Date())
    assert.equal((await f.hot.active(root, 'retained')).bundleRef, installed.bundleRef)
    await f.store.database(db => db.prepare('UPDATE dsh_lisp_hot_versions SET payload=? WHERE bundle_ref=?').run('{"name":"retained"}', installed.bundleRef))
    await assert.rejects(f.hot.active(root, 'retained'), (error: any) => error.code === 'HOT_INTEGRITY' || error.name === 'ZodError')
  } finally { f.db.close() }
})
