import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispTaskAuthority } from '../../../../src/dsh/lisp/task-authority.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { layaConfig } from '../../helpers/laya.js'
import { workingLispTask } from '../../helpers/lisp-task.js'

// Exercise exactly the fixture's setup and pre-recover admission, without
// starting a worker or substituting a development runtime for protected Lisp.
const sourceUrl = new URL('./decisions-runtime.test.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
function block(start: string, end: string) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  if (first < 0 || last <= first || source.indexOf(start, first + 1) !== -1) throw new Error('Recovery fixture setup boundary changed; review this extraction')
  return source.slice(first, last)
}
const setup = block('  const base = await realpath(await mkdtemp(', '  let mode = ')
const admission = block('    late(Response.json({}));', 'await manager.recover(owner)')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const create = new AsyncFunction('mkdtemp', 'realpath', 'mkdir', 'tmpdir', 'join', 'NodeSqliteAdapter', 'DatabaseSync',
  'readFile', 'provider', 'TypedDecisionsConfig', 'layaConfig', 'migrateDatabase',
  setup.replaceAll('import.meta.url', JSON.stringify(sourceUrl.href)) + '\nreturn { base, root, db, owner }')
const admit = new AsyncFunction('late', 'Response', 'workingLispTask', 'db', 'owner', admission)
for (const provider of ['typesafe', 'nimble', 'laya-coreml', 'laya-v1']) {
  test(`decision recovery fixture supplies current task authority: ${provider}`, async () => {
    const f = await create(mkdtemp, realpath, mkdir, tmpdir, join, NodeSqliteAdapter, DatabaseSync,
      readFile, provider, TypedDecisionsConfig, layaConfig, migrateDatabase)
    try {
      const authority = new LispTaskAuthority(async operation => operation(f.db))
      assert.equal(await authority.run(f.owner, async () => 42), 42, 'Taskless pure work remains available')
      let released = 0
      await admit(() => { released++ }, Response, workingLispTask, f.db, f.owner)
      assert.equal(released, 1)
      let denied: unknown
      try { await authority.run(f.owner, () => authority.authorizeEffect(f.owner)) }
      catch (error) {
        if (!['TASK_STATE_UNAVAILABLE', 'TASK_REQUIRED'].includes(String((error as { code?: string }).code))) throw error
        denied = error
      }
      assert.equal(denied, undefined, 'The fixture must bind a real Working task before effectful recovery')
      const lease = await authority.run(f.owner, () => authority.authorizeEffect(f.owner))
      assert.equal(lease.sessionId, f.owner.sessionId)
      assert.equal(lease.repositoryRoot, f.root)
      assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { f.db.close(); await rm(f.base, { recursive: true, force: true }) }
  })
}
