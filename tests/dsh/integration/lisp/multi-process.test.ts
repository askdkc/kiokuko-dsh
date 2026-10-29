import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import type { LispOwner } from '../../../../src/dsh/lisp/contracts.js'

function host(base: string) {
  const child = fork(new URL('../../helpers/lisp-host-process.ts', import.meta.url), [base], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let sequence = 0, diagnostics = ''
  child.stderr!.on('data', data => { diagnostics += data })
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  child.on('message', ({ id, value, error }: any) => {
    const call = pending.get(id); pending.delete(id)
    if (error) call?.reject(Object.assign(new Error(error.message), { code: error.code }))
    else call?.resolve(value)
  })
  const exited = once(child, 'exit')
  child.on('exit', () => { for (const call of pending.values()) call.reject(new Error(`host exited: ${diagnostics}`)); pending.clear() })
  return { child, exited, call(method: string, owner?: LispOwner, input?: unknown): Promise<any> {
    const id = ++sequence
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, method, owner, input }) })
  }, async stop() { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } } }
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'host did not reach the expected operation state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-multi-')))
  const db = openConnection(join(base, 'state.sqlite3'))
  const owners: LispOwner[] = []
  for (let i = 0; i < 6; i++) {
    const root = join(base, `project-${i}`); await mkdir(root)
    const owner = { sessionId: `session-${i}`, agentId: 'same-agent', root }
    workingLispTask(db, owner); owners.push(owner)
  }
  return { base, db, owners, store: new LispStore(async fn => fn(db)) }
}

test('independent Lisp hosts share a data root without quarantining live work', { timeout: 30000 }, async () => {
  const f = await fixture(), first = host(f.base), second = host(f.base)
  try {
    await first.call('start')
    await f.store.enable(f.owners[0]!)
    await f.store.reserve(f.owners[0]!, 'live', 'lisp_eval', 'hash', 'generation', {})
    const journal = new ManagedOperationJournal(f.db)
    const scope = journal.createScope({ sessionId: f.owners[0]!.sessionId, parentId: 'live', runtimeIdentity: 'sbcl:live' })
    const operation = journal.prepare(scope.scopeId, { route: 'native', kind: 'process', request: {} })
    journal.claim(operation.operationId); journal.transition(operation.operationId, { state: 'running' })
    await second.call('start')
    assert.equal((await f.store.get(f.owners[0]!, 'live'))?.state, 'RUNNING', 'another host startup must not recover a live evaluation')
    assert.equal(journal.snapshot(scope.scopeId).operations[0]!.state, 'running', 'another host startup must not recover a live native process')
    await second.call('dispose'); await second.exited
    await first.call('dispose'); await first.exited
  } finally { await Promise.all([first.stop(), second.stop()]); f.db.close(); await rm(f.base, { recursive: true, force: true }) }
})

test('separate hosts atomically reserve file targets across sessions', { timeout: 30000 }, async () => {
  const f = await fixture(), hosts = [host(f.base), host(f.base)]
  const owners = [f.owners[0]!, { ...f.owners[0]!, sessionId: 'same-project-other-session' }]
  try {
    for (const owner of owners) await f.store.enable(owner)
    await Promise.all(hosts.map(h => h.call('start')))
    const path = join(owners[0]!.root, 'same-file.txt')
    const results = await Promise.allSettled(hosts.map((h, i) => h.call('reserve-proposal', owners[i], { operationId: 'shared-target', path })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const denied = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(denied.reason.code, 'TARGET_LOCKED')
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM dsh_lisp_operations WHERE kind='proposal'").get<{n:number}>()!.n, 1)
    const winner = results.findIndex(result => result.status === 'fulfilled'), loser = 1 - winner
    await f.store.transition(owners[winner]!, 'shared-target', ['RUNNING'], 'NOT_APPLIED', {})
    await hosts[loser]!.call('reserve-proposal', owners[loser], { operationId: 'shared-target', path })
    await Promise.all(hosts.map((h, i) => h.call('reserve-proposal', owners[i], { operationId: 'independent-target', path: join(owners[i]!.root, `file-${i}.txt`) })))
  } finally {
    await Promise.all(hosts.map(async h => { await h.call('dispose').catch(() => {}); await h.stop() }))
    f.db.close(); await rm(f.base, { recursive: true, force: true })
  }
})

test('six projects in separate hosts: cold cache, isolated state, cancellation, shutdown and crash recovery', {
  timeout: 180000, skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires native SBCL' : false,
}, async () => {
  const f = await fixture(), hosts = f.owners.map(() => host(f.base)), competitor = host(f.base)
  try {
    await Promise.all(hosts.map(h => h.call('start')))
    const statuses = await Promise.all(hosts.map((h, i) => h.call('enable', f.owners[i])))
    assert.ok(statuses.every(status => status.state === 'READY'))
    assert.equal(new Set(statuses.map(status => status.compilation.key)).size, 1)
    assert.deepEqual(await readdir(join(f.base, 'data', 'compiled')), [statuses[0].compilation.key])
    const values = await Promise.all(hosts.map((h, i) => h.call('lisp_eval', f.owners[i], { operationId: 'same-id', code: `(defparameter *project* ${i})` })))
    assert.ok(values.every(value => value.ok), JSON.stringify(values))

    const running = hosts[0]!.call('lisp_eval', f.owners[0], { operationId: 'live', code: '(progn (sleep 1) (incf *project*))' })
    await until(async () => (await f.store.get(f.owners[0]!, 'live'))?.state === 'RUNNING')
    await competitor.call('start')
    assert.equal((await f.store.get(f.owners[0]!, 'live'))?.state, 'RUNNING')
    await assert.rejects(competitor.call('enable', f.owners[0]), { code: 'SESSION_IN_USE' })
    assert.equal((await running).ok, true)
    await hosts[1]!.call('dispose'); await hosts[1]!.exited
    assert.equal((await hosts[0]!.call('lisp_eval', f.owners[0], { operationId: 'after-other-exit', code: '*project*' })).value.printed, '(1)')
    const cancelled = hosts[2]!.call('lisp_eval', f.owners[2], { operationId: 'cancel-me', code: '(sleep 30)' })
    await until(async () => (await f.store.get(f.owners[2]!, 'cancel-me'))?.state === 'RUNNING')
    await hosts[2]!.call('lisp_cancel', f.owners[2]); assert.equal((await cancelled).ok, false)
    assert.equal((await hosts[3]!.call('lisp_eval', f.owners[3], { operationId: 'unaffected', code: '*project*' })).value.printed, '(3)')

    const crashed = hosts[4]!.call('lisp_eval', f.owners[4], { operationId: 'crash', code: '(sleep 30)' }).catch(() => undefined)
    await until(async () => (await f.store.get(f.owners[4]!, 'crash'))?.state === 'RUNNING')
    await hosts[4]!.stop(); await crashed
    await competitor.call('enable', f.owners[4])
    assert.equal((await f.store.get(f.owners[4]!, 'crash'))?.state, 'UNKNOWN')
    const replay = await competitor.call('lisp_eval', f.owners[4], { operationId: 'crash', code: '(sleep 30)' })
    assert.equal(replay.state, 'UNKNOWN'); assert.equal(replay.code, 'UNKNOWN'); assert.equal(replay.result, null, 'uncertain evaluation has no fabricated result')
    assert.equal((await competitor.call('recover', f.owners[4])).state, 'READY')
    assert.equal((await competitor.call('lisp_eval', f.owners[4], { operationId: 'new', code: '(+ 40 2)' })).value.printed, '(42)')
  } finally {
    await Promise.all([...hosts, competitor].map(async h => {
      if (h.child.exitCode === null && h.child.signalCode === null) await h.call('dispose').catch(() => {})
      await h.stop()
    }))
    f.db.close(); await rm(f.base, { recursive: true, force: true })
  }
})
