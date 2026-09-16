import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LispError } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

const native = { skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected native SBCL' : false, timeout: 120000 }
async function fixture(startupTimeoutMs = 60000) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-compiled-')))
  const root = join(base, 'project'), library = join(base, 'lisp'), dataRoot = join(base, 'data')
  await mkdir(root)
  await cp(fileURLToPath(new URL('../../../../lisp/', import.meta.url)), library, { recursive: true })
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db))
  const manager = new LispManager({ dataRoot, library, store,
    config: LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs }) })
  const owner = { sessionId: 'cache-session', agentId: 'cache-agent', root }
  await manager.start()
  return { manager, owner, library, dataRoot, async close() { await manager.dispose(); db.close() } }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'setup did not reach the expected phase')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('compiled cache: concurrent admission, source invalidation, corrupt bundle stops before recovery', native, async () => {
  const f = await fixture()
  try {
    const other = { ...f.owner, sessionId: 'other-session', agentId: 'other-agent' }
    const [first, second] = await Promise.all([f.manager.enable(f.owner), f.manager.enable(other)]) as any[]
    assert.equal(first.compilation.reused, false); assert.equal(second.compilation.reused, true)
    assert.equal(first.compilation.key, second.compilation.key)
    await f.manager.disable(other)
    const originalPath = join(f.dataRoot, 'compiled', first.compilation.key, 'runtime.fasl')
    const originalStat = await stat(originalPath)
    await appendFile(join(f.library, 'tools.lisp'), '\n(defun kioku.user::cache-fixture () :updated)\n')
    const changed = await f.manager.recover(f.owner) as any
    assert.equal(changed.state, 'READY'); assert.equal(changed.compilation.reused, false)
    assert.notEqual(changed.compilation.key, first.compilation.key)
    assert.equal((await stat(originalPath)).mtimeMs, originalStat.mtimeMs)
    const evaluated = await f.manager.execute(f.owner, 'lisp_eval', { operationId: 'changed-source', code: '(cache-fixture)' }) as any
    assert.equal(evaluated.ok, true); assert.match(evaluated.value.printed, /UPDATED/)

    const path = join(f.dataRoot, 'compiled', changed.compilation.key, 'runtime.fasl')
    await writeFile(path, 'damaged fixture')
    await assert.rejects(f.manager.recover(f.owner), { code: 'CACHE_INVALID' })
    assert.equal((await f.manager.status(f.owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await f.manager.execute(f.owner, 'lisp_eval', { operationId: 'blocked', code: '(+ 1 2)' }) as any).code, 'RECOVERY_REQUIRED')
    const entries = await readdir(join(f.dataRoot, 'compiled'))
    assert.ok(entries.some(n => n.startsWith(`invalid-${changed.compilation.key}-`)))
    assert.ok(!entries.some(n => n.startsWith('.build-')), 'private setup directories must be cleaned')
    const recovered = await f.manager.recover(f.owner) as any
    assert.equal(recovered.state, 'READY'); assert.equal(recovered.compilation.reused, false)
    assert.equal(recovered.compilation.key, changed.compilation.key)
    const reset = await f.manager.execute(f.owner, 'lisp_reset', { operationId: 'reset' }) as any
    assert.equal(reset.ok, true); assert.equal((await f.manager.status(f.owner) as any).compilation.reused, true)
  } finally { await f.close() }
})

test('compiled cache: failed or cancelled build never publishes; explicit recovery builds successfully', native, async () => {
  const f = await fixture()
  try {
    const compiler = join(f.library, 'compile.lisp'), original = await readFile(compiler, 'utf8')
    await writeFile(compiler, '(error "fixture: compile failed")\n')
    await assert.rejects(f.manager.enable(f.owner), { code: 'COMPILE_FAILED' })
    assert.equal((await f.manager.status(f.owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await f.manager.status(f.owner) as any).compilation.state, 'failed')
    assert.deepEqual(await readdir(join(f.dataRoot, 'compiled')), [])
    const failedKey = (await f.manager.status(f.owner) as any).compilation.key
    await writeFile(compiler, '(loop)\n')
    const starting = f.manager.recover(f.owner).catch(error => error)
    await until(async () => {
      const status = await f.manager.status(f.owner) as any
      return status.state === 'PREFLIGHT' && status.compilation?.state === 'compiling' && status.compilation.key !== failedKey
    })
    await f.manager.execute(f.owner, 'lisp_cancel', {})
    const cancelled = await starting
    assert.ok(cancelled instanceof LispError); assert.equal(cancelled.code, 'CANCELLED')
    assert.equal((await f.manager.status(f.owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await f.manager.status(f.owner) as any).compilation.state, 'failed')
    assert.deepEqual(await readdir(join(f.dataRoot, 'compiled')), [])
    await writeFile(compiler, original)
    assert.equal((await f.manager.recover(f.owner) as any).state, 'READY')
  } finally { await f.close() }
})

test('compiled cache: setup deadline stops a busy compiler without publishing', native, async () => {
  const f = await fixture(500)
  try {
    await writeFile(join(f.library, 'compile.lisp'), '(loop)\n')
    await assert.rejects(f.manager.enable(f.owner), { code: 'COMPILE_TIMEOUT' })
    assert.equal((await f.manager.status(f.owner) as any).state, 'RECOVERY_REQUIRED')
    assert.deepEqual(await readdir(join(f.dataRoot, 'compiled')), [])
  } finally { await f.close() }
})
