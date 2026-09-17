import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispManager, type ManagerOptions } from '../../../../src/dsh/lisp/manager.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'

test('crash-state journal between file receipts and parent commit remains inspectable through restart, recovery and exact replay', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-lifecycle-'))), root = join(base, 'work')
  await mkdir(root); await writeFile(join(root, 'a.txt'), 'old-a'); await writeFile(join(root, 'b.txt'), 'old-b')
  const db = new NodeSqliteAdapter(join(base, 'live.sqlite3'), new DatabaseSync(join(base, 'live.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const owner = { sessionId: 'restart-session', agentId: 'restart-agent', root }, store = new LispStore(async fn => fn(db))
  const crashPath = join(base, 'interrupted.sqlite3'), transition = store.transition.bind(store)
  let asks = 0, snapshotted = false, reopened: NodeSqliteAdapter | undefined
  const options: ManagerOptions = { store, dataRoot: join(base, 'data'), config: LispConfig.parse({ enabled: true, startupTimeoutMs: 60000 }),
    questions: { ask: async request => { asks++; return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].intent!.approve] }] } } } }
  let manager = new LispManager(options)
  const request = { operationId: 'batch', code: '(kioku.files:propose-write "a.txt" "new-a") (kioku.files:propose-write "b.txt" "new-b")' }
  try {
    await manager.start(); await manager.enable(owner)
    store.transition = async (...args) => {
      if (args[1] === 'batch' && args[3] === 'SUCCEEDED') {
        assert.equal((await store.get(owner, 'batch'))!.state, 'RUNNING')
        // Capture a real SQLite image at the exact crash window, not a hand-made
        // result. Files and independent backup/receipt commits already exist.
        db.prepare('VACUUM INTO ?').run(crashPath); snapshotted = true
      }
      return transition(...args)
    }
    assert.equal((await manager.execute(owner, 'lisp_eval', request) as any).ok, true)
    assert.ok(snapshotted); assert.equal(asks, 1)
    const before = (await stat(join(root, 'a.txt'))).mtimeMs
    await manager.dispose()
    reopened = new NodeSqliteAdapter(crashPath, new DatabaseSync(crashPath))
    const resumedStore = new LispStore(async fn => fn(reopened!))
    manager = new LispManager({ ...options, store: resumedStore }); await manager.start()
    assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    const saved = await manager.execute(owner, 'lisp_inspect', { operationId: 'read-before-recover', resultOperationId: 'batch', section: 'changes' }) as any
    assert.equal(saved.state, 'UNKNOWN')
    const receipts = JSON.parse(saved.data)
    assert.equal(receipts.length, 2); assert.ok(receipts.every((r: any) => r.state === 'APPLIED'))
    for (const receipt of receipts) assert.match(await readFile(receipt.backup, 'utf8'), /^old-/u)
    const replayBefore = await manager.execute(owner, 'lisp_eval', request) as any
    assert.equal(replayBefore.replay, true); assert.equal(replayBefore.result.ok, false)
    assert.equal((await manager.recover(owner) as any).state, 'READY')
    const replayAfter = await manager.execute(owner, 'lisp_eval', request) as any
    assert.equal(replayAfter.state, 'ABANDONED'); assert.equal(replayAfter.result.ok, false)
    assert.equal(replayAfter.result.changes.length, 2)
    assert.equal(asks, 1); assert.equal((await stat(join(root, 'a.txt'))).mtimeMs, before)
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'new-a'); assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'new-b')
  } finally { await manager.dispose(); reopened?.close(); db.close(); await rm(base, { recursive: true, force: true }) }
})
