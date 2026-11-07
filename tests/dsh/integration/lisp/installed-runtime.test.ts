import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { workingLispTask } from '../../helpers/lisp-task.js'

test('installed executable: relocation, no external SBCL, dynamic compilation and persistent isolated sessions', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires native Lisp build' : false, timeout: 120000,
}, async () => {
  const source = fileURLToPath(new URL('../../../../', import.meta.url))
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.postinstall ?? '', /install-lisp/, 'registry installs must build the standalone runtime')
  const { buildInstalledLisp, installedLispRuntime } = await import('../../../../src/dsh/lisp/installed-runtime.js')
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-installed-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  migrateDatabase(db)
  let manager: LispManager | undefined
  try {
    const library = join(base, 'lisp'), root = join(base, 'project')
    await mkdir(root)
    await cp(join(source, 'lisp'), library, { recursive: true, filter: path => !path.includes('/.native') })
    const built = await buildInstalledLisp(library, process.env.KIOKUKO_LISP_SBCL ?? 'sbcl')
    assert.equal(built.reused, false)
    assert.equal((await buildInstalledLisp(library, '/no-external-sbcl')).reused, true)
    const moved = join(base, 'relocated-lisp')
    await rename(library, moved)
    const config = LispConfig.parse({ enabled: true, executionMode: 'protected', sbclPath: '/no-external-sbcl', startupTimeoutMs: 60000 })
    manager = new LispManager({ dataRoot: join(base, 'data'), library: moved, config, store: new LispStore(async fn => fn(db)) })
    await manager.start()
    const owner = { sessionId: 'installed-session', agentId: 'main', root }
    workingLispTask(db, owner)
    const enabled = await manager.enable(owner) as any
    assert.equal(enabled.state, 'READY')
    const evalCode = (operationId: string, code: string) => manager!.execute(owner, 'lisp_eval', { operationId, code }) as Promise<any>
    const result = await evalCode('compiled', '(defparameter *saved* 41) (defun next-value () (1+ *saved*)) (list (compiled-function-p (compile nil (lambda (x) (+ x 1)))) (next-value) kioku.internal:*generation*)')
    assert.equal(result.ok, true)
    assert.match(result.value.printed, /T 42/)
    assert.ok(result.value.printed.includes(enabled.generation), 'saved image must read the session generation at launch')
    await manager.stopSessionWork(owner.sessionId)
    assert.equal((await manager.status(owner) as any).runtimePid, enabled.runtimePid)
    assert.equal((await evalCode('retained', '(next-value)')).value.printed, '(42)')
    const other = { ...owner, sessionId: 'other' }
    workingLispTask(db, other)
    await manager.enable(other)
    const isolated = await manager.execute(other, 'lisp_eval', { operationId: 'isolated', code: '(boundp (quote kioku.user::*saved*))' }) as any
    assert.equal(isolated.ok, true); assert.equal(isolated.value.printed, '(NIL)')
    await manager.dispose(); manager = undefined
    const runtime = await installedLispRuntime(moved)
    assert.ok(runtime)
    await appendFile(runtime.executable, 'corrupt')
    await assert.rejects(installedLispRuntime(moved), { code: 'INSTALLED_RUNTIME_INVALID' })
    await appendFile(join(moved, 'tools.lisp'), '\n;; changed source\n')
    await assert.rejects(installedLispRuntime(moved), { code: 'INSTALLED_RUNTIME_STALE' })
  } finally { await manager?.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
