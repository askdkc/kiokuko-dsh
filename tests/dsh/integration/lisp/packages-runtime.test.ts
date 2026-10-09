import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'

test('public Lisp package API routes approved host metadata once and journals replay', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 120000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-packages-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 'session', agentId: 'agent', root }
  let calls = 0
  const manager = new LispManager(Object.assign({ store, config: LispConfig.parse({ enabled: true, startupTimeoutMs: 60000 }), dataRoot: join(base, 'data') }, {
    packagesCall: async (_owner: unknown, request: unknown) => {
      calls++
      assert.deepEqual(request, { kind: 'metadata', name: 'sprintf-js', version: 'latest' })
      return { value: { state: 'SUCCEEDED', package: { name: 'sprintf-js', version: '1.1.3' } } }
    },
  }))
  t.after(async () => { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) })
  await manager.start(); await manager.enable(owner)
  const code = `(if (find-package :kioku.packages)
    (funcall (intern "METADATA" :kioku.packages) "sprintf-js")
    "PACKAGE_API_MISSING")`
  const result = await manager.execute(owner, 'lisp_eval', { operationId: 'metadata', code }) as any
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.json?.state, 'SUCCEEDED', 'registry metadata must be reachable through the public Lisp API')
  assert.equal(calls, 1)
  assert.equal((await manager.execute(owner, 'lisp_eval', { operationId: 'metadata', code }) as any).replay, true)
  assert.equal(calls, 1, 'replay cannot resend a registry request')
  const discovery = await manager.execute(owner, 'lisp_describe', { operationId: 'describe', symbol: 'kioku.packages' }) as any
  assert.ok(discovery.value.symbols.includes('kioku.packages:metadata'))
})
