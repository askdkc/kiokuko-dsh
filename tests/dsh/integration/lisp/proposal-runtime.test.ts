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

test('pathname write proposals preserve the worker and its scratch after rejection', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-proposal-'))), root = join(base, 'work')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const manager = new LispManager({ store: new LispStore(async fn => fn(db)), dataRoot: join(base, 'data'),
    config: LispConfig.parse({ enabled: true, startupTimeoutMs: 60000, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl' }) })
  const owner = { sessionId: 'session', agentId: 'agent', root }
  const evaluate = (operationId: string, code: string) => manager.execute(owner, 'lisp_eval', { operationId, code }) as Promise<any>
  try {
    await manager.start(); await manager.enable(owner)
    const setup = await evaluate('setup', '(defparameter *answer* 42) (kioku.files:write-text (merge-pathnames "solution.txt" (kioku.files:scratch)) "keep this work")')
    assert.equal(setup.ok, true, JSON.stringify(setup))
    const result = await evaluate('absolute-proposal', '(kioku.files:propose-write (merge-pathnames "solution.txt" (kioku.files:scratch)) "replacement")')
    assert.equal(result.ok, false)
    assert.equal(result.changes[0].code, 'PROTECTED_PATH')
    assert.equal((await manager.status(owner) as any).state, 'READY', JSON.stringify({ result, diagnostics: await manager.diagnostics(owner) }))
    const preserved = await evaluate('preserved', '(list *answer* (kioku.files:read-text (merge-pathnames "solution.txt" (kioku.files:scratch))))')
    assert.equal(preserved.ok, true, JSON.stringify(preserved))
    assert.equal(preserved.generation, setup.generation)
    assert.match(preserved.value.printed, /42.*keep this work/)
    const written = await evaluate('relative-proposal', '(kioku.files:propose-write #P"solution.txt" "saved solution")')
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.equal(await readFile(join(root, 'solution.txt'), 'utf8'), 'saved solution')
    const deletion = await evaluate('delete-proposal', '(kioku.files:propose-delete #P"solution.txt")')
    assert.equal(deletion.ok, false, 'deleting an existing file still requires consent')
    assert.equal(deletion.changes[0].state, 'NOT_APPLIED')
    assert.equal(await readFile(join(root, 'solution.txt'), 'utf8'), 'saved solution')
    for (const [index, code] of [
      '(kioku.files:propose-write 42 "bad")',
      '(kioku.files:propose-write "bad.txt" #P"bad")',
      '(kioku.files:propose-delete "")',
      '(kioku.files:propose-delete (make-string 4097 :initial-element #\\a))',
      '(kioku.files:propose-write "bad.txt" (make-string 131073 :initial-element (code-char #x1f642)))',
    ].entries()) {
      const rejected = await evaluate(`invalid-${index}`, `(kioku.files:propose-write "must-not-exist.txt" "bad") ${code}`)
      assert.equal(rejected.ok, false, JSON.stringify(rejected))
      assert.equal(rejected.generation, setup.generation)
      assert.deepEqual(rejected.proposals, [], 'failed evaluation must discard even earlier valid proposals')
      assert.equal((await manager.status(owner) as any).state, 'READY')
      await assert.rejects(readFile(join(root, 'must-not-exist.txt')), { code: 'ENOENT' })
    }
    const exited = await evaluate('exit-evidence', '(write-line "fixture exit diagnostic" *error-output*) (finish-output *error-output*) (sb-ext:exit :code 70)')
    assert.equal(exited.code, 'WORKER_EXITED')
    assert.match(exited.output.stderr, /fixture exit diagnostic/)
    const saved = await manager.diagnostics(owner, 'exit-evidence') as any
    assert.equal(saved.result.output.stderr, exited.output.stderr)
    assert.equal(saved.result.generation, setup.generation)
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
