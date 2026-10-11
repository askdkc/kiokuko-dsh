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

test('public code API returns unavailable without installing a parser or LSP provider', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires SBCL' : false, timeout: 120000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-code-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  for (const migration of ['019_dsh_lisp.sql', '031_dsh_lisp_hot_tools.sql'])
    db.exec(await readFile(new URL(`../../../../migrations/${migration}`, import.meta.url), 'utf8'))
  const owner = { sessionId: 'session', agentId: 'agent', root }
  const manager = new LispManager({ store: new LispStore(async fn => fn(db)),
    config: LispConfig.parse({ executionMode: process.env.KIOKUKO_CODE_EXECUTION_MODES === 'development' ? 'development' : 'protected', enabled: true, startupTimeoutMs: 60000 }), dataRoot: join(base, 'data') })
  t.after(async () => { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) })
  await manager.start(); await manager.enable(owner)
  const code = `(if (find-package :kioku.code) (funcall (intern "CAPABILITIES" :kioku.code)) "CODE_API_MISSING")`
  const result = await manager.execute(owner, 'lisp_eval', { operationId: 'capabilities', code }) as any
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.json?.status, 'unavailable', 'the public API must preserve absence as a typed status')
  assert.equal(result.value.json?.reason, 'provider_missing')
  const described = await manager.execute(owner, 'lisp_describe', { operationId: 'describe', symbol: 'kioku.code' }) as any
  assert.ok(described.value.symbols.includes('kioku.code:with-snapshot'))
})
