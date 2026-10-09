import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { createLispPackageAdapter } from '../../../../src/dsh/lisp/packages.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

for (const mode of ['apply', 'decline', 'stale'] as const) test(`protected public lockfile API: ${mode} preserves frozen evidence, approvals and journal`, {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 120000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'packages-update-'))), root = join(base, 'workspace')
  await mkdir(root)
  const original = '{"name":"fixture","version":"1.0.0","dependencies":{"roarr":"2.15.4"}}'
  await writeFile(join(root, 'package.json'), original)
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 'session', agentId: 'agent', root }
  let commands = 0, approvals = 0
  const questions: DshUserQuestions = { ask: async request => {
    approvals++
    const applying = request.questions[0]!.header !== 'Lisp · Package operation'
    if (applying && mode === 'stale') await writeFile(join(root, 'package.json'), '{"name":"concurrent-change"}')
    return { answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![applying && mode === 'decline' ? 0 : 1]!.label] }] }
  } }
  const adapter = createLispPackageAdapter(questions, undefined, async (_manager, args, directory) => {
    commands++
    if (args[0] !== '--version') await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/sprintf-js":{"version":"1.1.3"}}}')
    return { code: 0, stdout: args[0] === '--version' ? '11.0.0' : '', stderr: '' }
  })
  const manager = new LispManager({ store, config: LispConfig.parse({ enabled: true, startupTimeoutMs: 60000 }), dataRoot: join(base, 'data'), questions, packagesCall: adapter })
  t.after(async () => { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) })
  await manager.start(); await manager.enable(owner)
  const code = `(let ((v (make-hash-table :test 'equal))) (setf (gethash "sprintf-js" v) "1.1.3") (kioku.packages:update-lockfiles v))`
  const result = await manager.execute(owner, 'lisp_eval', { operationId: 'update', code }) as any
  assert.equal(commands, 2); assert.equal(approvals, 2)
  const content = await readFile(join(root, 'package.json'), 'utf8')
  if (mode === 'apply') {
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.changes.length, 2); assert.ok(result.changes.every((change: any) => change.state === 'APPLIED'))
    assert.equal(JSON.parse(content).overrides['sprintf-js'], '1.1.3')
    assert.ok(result.changes.every((change: any) => change.backup))
  } else {
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.changes.every((change: any) => change.state === 'NOT_APPLIED'))
    assert.equal(content, mode === 'decline' ? original : '{"name":"concurrent-change"}')
  }
  assert.equal((await manager.execute(owner, 'lisp_eval', { operationId: 'update', code }) as any).replay, true)
  assert.equal(commands, 2); assert.equal(approvals, 2)
})
