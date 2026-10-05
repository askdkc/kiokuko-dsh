import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const native = {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false,
  timeout: 180000,
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-hot-')))
  const root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db))
  let approvals = 0, forgeApproval = false, holdApproval = false
  const questions: DshUserQuestions = { ask: async request => {
    approvals++
    const question = request.questions[0]!
    assert.ok(question.options && question.options.length >= 2)
    if (holdApproval) await new Promise<void>(resolve => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
    return { answers: [{ id: question.id, selected: [forgeApproval ? 'forged custom approval' : question.options[1]!.label] }] }
  } }
  const options = {
    store,
    questions,
    config: LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }),
    dataRoot: join(base, 'data'),
  }
  let manager = new LispManager(options)
  await manager.start()
  return { base, root, get manager() { return manager }, store, get approvalsCount() { return approvals }, set forgeApproval(value: boolean) { forgeApproval = value }, set holdApproval(value: boolean) { holdApproval = value }, restart: async () => { await manager.dispose(); manager = new LispManager(options); await manager.start() }, close: async () => { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) } }
}

test('hot task tools: approval, immutable contract, shared code, owner-local results, replay and deactivation', native, async () => {
  const f = await fixture()
  const ownerA = { sessionId: 'session-a', agentId: 'agent-a', root: f.root }
  const ownerB = { sessionId: 'session-b', agentId: 'agent-b', root: f.root }
  try {
    assert.deepEqual(await f.manager.enableTask(ownerA), { ok: true, state: 'TASK_READY' })
    assert.deepEqual(await f.manager.enableTask(ownerB), { ok: true, state: 'TASK_READY' })

    const contract = await f.manager.execute(ownerA, 'lisp_hot_contract', {
      operationId: 'hot-contract', name: 'add-one', description: 'Add one',
      inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' },
      properties: [{ input: 1, expected: 2 }, { input: 4, expected: 5 }],
    }) as any
    assert.equal(contract.ok, true, JSON.stringify(contract))
    assert.equal(contract.expectedContractRef, undefined)
    assert.match(contract.contractRef, /^[0-9a-f-]{36}$/u)
    const installed = await f.manager.execute(ownerA, 'lisp_hot_install', {
      operationId: 'hot-install', name: 'add-one', contractRef: contract.contractRef,
      expectedRevision: 0, source: '(lambda (input) (+ input 1))',
    }) as any
    assert.equal(installed.ok, true, JSON.stringify(installed))
    assert.equal(installed.revision, 1)
    assert.match(installed.bundleRef, /^[0-9a-f-]{36}$/u)

    const first = await f.manager.execute(ownerB, 'lisp_hot_call', { operationId: 'hot-call', name: 'add-one', input: 41 }) as any
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.value, 42)
    assert.match(first.resultRef, /^[0-9a-f-]{36}$/u)
    assert.equal(first.revision, 1)
    const replay = await f.manager.execute(ownerB, 'lisp_hot_call', { operationId: 'hot-call', name: 'add-one', input: 41 }) as any
    assert.equal(replay.replay, true)
    assert.equal(replay.result?.resultRef ?? replay.resultRef, first.resultRef)
    await f.restart()
    assert.deepEqual(await f.manager.enableTask(ownerA), { ok: true, state: 'TASK_READY' })
    assert.deepEqual(await f.manager.enableTask(ownerB), { ok: true, state: 'TASK_READY' })
    const afterRestart = await f.manager.execute(ownerB, 'lisp_hot_call', { operationId: 'hot-call', name: 'add-one', input: 41 }) as any
    assert.equal(afterRestart.replay, true, 'durable operation replay must survive manager restart')
    assert.equal(afterRestart.result?.resultRef ?? afterRestart.resultRef, first.resultRef)
    const conflict = await f.manager.execute(ownerB, 'lisp_hot_call', { operationId: 'hot-call', name: 'add-one', input: 99 }) as any
    assert.equal(conflict.code, 'ID_CONFLICT')

    const foreign = await f.manager.execute(ownerA, 'lisp_hot_call', { operationId: 'foreign-result', name: 'add-one', inputRef: first.resultRef }) as any
    assert.equal(foreign.ok, false)
    assert.match(foreign.code, /RESULT|OWNER|INPUT/u)

    const status = await f.manager.execute(ownerB, 'lisp_hot_status', {}) as any
    assert.equal(status.ok, true, JSON.stringify(status))
    assert.equal(status.projectRoot, f.root)
    assert.equal(status.tools.find((tool: any) => tool.name === 'add-one').revision, 1)
    const deactivated = await f.manager.execute(ownerA, 'lisp_hot_deactivate', { operationId: 'hot-deactivate', name: 'add-one', expectedRevision: 1 }) as any
    assert.equal(deactivated.ok, true, JSON.stringify(deactivated))
    assert.equal(deactivated.revision, 2)
    const inactiveCall = await f.manager.execute(ownerB, 'lisp_hot_call', { operationId: 'inactive-call', name: 'add-one', input: 1 }) as any
    assert.equal(inactiveCall.ok, false)
    assert.equal(inactiveCall.code, 'HOT_NOT_ACTIVE')
    assert.ok(f.approvalsCount >= 1, 'deactivation must require user confirmation')
  } finally { await f.close() }
})

test('hot task tools: stale contract, forged approval, dependency snapshot and root fence fail closed', native, async () => {
  const f = await fixture()
  const owner = { sessionId: 'session', agentId: 'agent', root: f.root }
  const otherRoot = join(f.base, 'other-workspace'); await mkdir(otherRoot)
  const other = { sessionId: 'other-session', agentId: 'other-agent', root: otherRoot }
  try {
    await f.manager.enableTask(owner)
    await f.manager.enableTask(other)
    const baseTask = await f.manager.execute(owner, 'lisp_define', {
      operationId: 'dependency-task', name: 'base-task', description: 'Base dependency',
      source: '(lambda (input) (+ input 1))', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' },
    }) as any
    assert.equal(baseTask.ok, true, JSON.stringify(baseTask))
    const base = await f.manager.execute(owner, 'lisp_hot_contract', { operationId: 'dependency-contract', name: 'base', description: 'Base', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }) as any
    const baseInstall = await f.manager.execute(owner, 'lisp_hot_install', { operationId: 'dependency-install', name: 'base', contractRef: base.contractRef, expectedRevision: 0, source: '(lambda (input) (+ input 1))' }) as any
    assert.equal(baseInstall.ok, true, JSON.stringify(baseInstall))
    const composed = await f.manager.execute(owner, 'lisp_hot_contract', { operationId: 'composed-contract', name: 'composed', description: 'Composed', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }) as any
    const composedInstall = await f.manager.execute(owner, 'lisp_hot_install', { operationId: 'composed-install', name: 'composed', contractRef: composed.contractRef, expectedRevision: 0, source: '(lambda (input) (base-task input))', dependencies: [{ binding: 'base-task', toolRef: baseTask.toolRef }] }) as any
    assert.equal(composedInstall.ok, true, JSON.stringify(composedInstall))
    const called = await f.manager.execute(owner, 'lisp_hot_call', { operationId: 'composed-call', name: 'composed', input: 1 }) as any
    assert.equal(called.value, 2, 'dependency binding is copied exactly and remains callable')

    const newer = await f.manager.execute(owner, 'lisp_hot_contract', { operationId: 'new-contract', name: 'composed', description: 'Changed', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 4 }], expectedContractRef: composed.contractRef }) as any
    const stale = await f.manager.execute(owner, 'lisp_hot_install', { operationId: 'stale-install', name: 'composed', contractRef: composed.contractRef, expectedRevision: 1, source: '(lambda (input) (+ input 100))' }) as any
    assert.equal(stale.ok, false)
    assert.match(stale.code, /CONTRACT|REVISION|STALE/u)
    assert.ok(newer.contractRef)

    f.forgeApproval = true
    const forged = await f.manager.execute(owner, 'lisp_hot_deactivate', { operationId: 'forged-deactivate', name: 'composed', expectedRevision: composedInstall.revision }) as any
    assert.equal(forged.ok, false)
    assert.match(forged.code, /CONFIRM|APPROVAL|USER/u)
    const wrongRoot = await f.manager.execute(other, 'lisp_hot_call', { operationId: 'wrong-root', name: 'composed', input: 1 }) as any
    assert.equal(wrongRoot.ok, false)
    assert.equal(wrongRoot.code, 'HOT_NOT_ACTIVE')
  } finally { await f.close() }
})

for (const mode of ['task', 'persistent'] as const) test(`hot tools: ${mode} cancellation during approval leaves no active contract`, native, async () => {
  const f = await fixture()
  const owner = { sessionId: 'cancel-session', agentId: 'cancel-agent', root: f.root }
  try {
    if (mode === 'task') await f.manager.enableTask(owner)
    else await f.manager.enable(owner)
    f.holdApproval = true
    const controller = new AbortController()
    const pending = f.manager.execute(owner, 'lisp_hot_contract', { operationId: 'cancel-contract', name: 'cancelled', description: 'Cancelled', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }, controller.signal) as Promise<any>
    const deadline = Date.now() + 5000
    while (f.approvalsCount === 0) {
      assert.ok(Date.now() < deadline, 'approval was not requested')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (mode === 'task') controller.abort()
    else assert.equal((await f.manager.execute(owner, 'lisp_cancel', {}) as any).ok, true)
    const result = await pending
    assert.equal(result.ok, false)
    assert.match(result.code, /CANCELLED|HOT_APPROVAL_REQUIRED/u)
    f.holdApproval = false
    const status = await f.manager.execute(owner, 'lisp_hot_status', {}) as any
    assert.equal(status.ok, true)
    assert.equal(status.tools.some((tool: any) => tool.name === 'cancelled'), false)
  } finally { await f.close() }
})
