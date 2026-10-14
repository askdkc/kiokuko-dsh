import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LispError } from '../../../../src/dsh/lisp/contracts.js'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import { applyChange, freezeChange } from '../../../../src/dsh/lisp/files.js'
import { runPackageCommand } from '../../../../src/dsh/lisp/package-manager.js'
import { LispProposalBatch } from '../../../../src/dsh/lisp/proposal-batch.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const signal = new AbortController().signal
const denied = () => { throw new LispError('TASK_STALE', 'Task changed before effect.') }
const allow: DshUserQuestions = { ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.intent!.approve!] }] }) }

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-effect-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace'), backups = join(base, 'backups')
  await mkdir(root); await mkdir(backups)
  const owner = { sessionId: 'session', agentId: 'agent', root }
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  t.after(() => db.close())
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)); await store.enable(owner)
  return { base, root, backups, owner, store }
}

for (const boundary of ['missing', 'approval', 'runner'] as const) test(`CI effect authority: ${boundary} denies before process execution`, async t => {
  const f = await fixture(t); let valid = true, commands = 0
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const questions: DshUserQuestions = { ask: async request => { if (boundary === 'approval') valid = false; return allow.ask(request) } }
  const adapter = createLispCiAdapter(questions, async (_file, _args, options) => {
    if (boundary === 'runner') valid = false
    await options.beforeEffect!()
    commands++; return { code: 0, stdout: '', stderr: '' }
  }, boundary === 'missing' ? undefined : async () => { if (!valid) denied() })
  await assert.rejects(adapter(f.owner, { kind: 'verify', target: 'test' }, signal), { code: boundary === 'missing' ? 'TASK_REQUIRED' : 'TASK_STALE' })
  assert.equal(commands, 0)
})

test('CI read operations do not require or invoke effect authority', async t => {
  const f = await fixture(t); let calls = 0
  const adapter = createLispCiAdapter(undefined, async (_file, args, options) => {
    calls++; assert.equal(options.beforeEffect, undefined)
    return { code: 0, stdout: args[1] === 'list' ? '[]' : 'failed log', stderr: '' }
  }, async () => denied())
  await adapter(f.owner, { kind: 'list-runs', limit: 1 }, signal)
  await adapter(f.owner, { kind: 'failed-log', runId: '1' }, signal)
  assert.equal(calls, 2)
})

test('the default CI runner rechecks after resolving its executable', async t => {
  const f = await fixture(t); let checks = 0
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'unused' } }))
  const bin = join(f.base, 'bin'); await mkdir(bin); await symlink('/usr/bin/true', join(bin, 'npm'))
  const previousPath = process.env.PATH
  process.env.PATH = bin
  try {
    const adapter = createLispCiAdapter(allow, undefined, async () => { if (++checks === 2) denied() })
    await assert.rejects(adapter(f.owner, { kind: 'verify', target: 'test' }, signal), { code: 'TASK_STALE' })
    assert.equal(checks, 2)
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
})

for (const operation of ['write', 'delete'] as const) for (const boundary of ['missing', 'publish'] as const)
  test(`file ${operation}: ${boundary} authority leaves the target unchanged`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.root, 'target'), 'original')
    const change = await freezeChange(f.owner, operation === 'write' ? { operation, path: 'target', content: 'replacement' } : { operation, path: 'target' }, f.backups, [])
    let calls = 0
    // Existing-file write checks before backup, temporary bytes, and rename;
    // deletion checks before backup and unlink. Revoke at publication.
    const authorize = boundary === 'missing' ? undefined : async () => {
      if (++calls === (operation === 'write' ? 3 : 2)) denied()
    }
    await assert.rejects(applyChange(f.owner, change, [], new Map(), authorize), { code: boundary === 'missing' ? 'TASK_REQUIRED' : 'TASK_STALE' })
    assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'original')
    if (boundary === 'missing') assert.deepEqual(await readdir(f.backups), [])
    else assert.equal(await readFile(change.backup!, 'utf8'), 'original')
  })

for (const branch of ['native', 'owned'] as const) test(`proposal ${branch}: missing authority cannot write or execute`, async t => {
  const f = await fixture(t); let calls = 0
  const batch = new LispProposalBatch({ store: f.store, backupRoot: f.backups, protectedRoots: () => [], stopped: () => false,
    ...(branch === 'owned' ? { execute: async () => { calls++; return { applied: true } } } : {}) })
  const result = await batch.apply(f.owner, 'eval', 'generation', [{ operation: 'write', path: 'target', content: 'new' }], signal)
  assert.equal(result[0]!.code, 'TASK_REQUIRED'); assert.equal(result[0]!.state, 'NOT_APPLIED')
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.root), [])
})

test('proposal task revocation during approval preserves every target', async t => {
  const f = await fixture(t); let valid = true
  await writeFile(join(f.root, 'target'), 'original')
  const batch = new LispProposalBatch({ store: f.store, backupRoot: f.backups, protectedRoots: () => [], stopped: () => false,
    authorizeEffect: async () => { if (!valid) denied() }, questions: { ask: async request => { valid = false; return allow.ask(request) } } })
  const result = await batch.apply(f.owner, 'eval', 'generation', [{ operation: 'write', path: 'target', content: 'new' }], signal)
  assert.equal(result[0]!.code, 'TASK_STALE'); assert.equal(result[0]!.state, 'NOT_APPLIED')
  assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'original')
})

test('package command without authority refuses before executable lookup or scratch writes', async t => {
  const f = await fixture(t)
  await assert.rejects(runPackageCommand('npm', ['--version'], f.root, signal), { code: 'TASK_REQUIRED' })
  assert.deepEqual(await readdir(f.root), [])
})

for (const boundary of ['policy', 'spawn'] as const) test(`package command rechecks authority before ${boundary}`, {
  skip: process.platform !== 'darwin' ? 'macOS policy boundary' : false,
}, async t => {
  const f = await fixture(t); let checks = 0
  // Resolve a trusted OS executable without depending on the machine's npm
  // packaging. The authority callback rejects before this fixture can execute.
  const bin = join(f.base, 'bin'); await mkdir(bin); await symlink('/usr/bin/true', join(bin, 'npm'))
  const previousPath = process.env.PATH
  process.env.PATH = bin
  try {
    await assert.rejects(runPackageCommand('npm', ['--version'], f.root, signal, async () => {
      if (++checks === (boundary === 'policy' ? 2 : 3)) denied()
    }), { code: 'TASK_STALE' })
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
  assert.equal((await readdir(f.root)).length, boundary === 'policy' ? 0 : 1)
})

// A protocol fixture exercises the public Worker request path without SBCL or
// executing the requested program. Native integration tests cover the OS sandbox.
for (const boundary of ['missing', 'launch'] as const) test(`protected worker ${boundary} authority blocks run/start-job and preserves pure eval`, async t => {
  const f = await fixture(t), library = join(f.base, 'library'), scratch = join(f.base, 'scratch'), inputs = join(f.base, 'inputs'), cache = join(f.base, 'cache')
  for (const path of [library, scratch, inputs, cache]) await mkdir(path)
  await writeFile(join(library, 'supervisor.mjs'), `import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => writeSync(3, JSON.stringify(value) + '\\n');
let pending;
send({ version: 1, type: 'ready' });
createInterface({ input: createReadStream('', { fd: 3, autoClose: false }) }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method) {
    pending = frame.id;
    if (frame.code === 'pure') send({ version: 1, type: 'result', id: pending, ok: true, value: 42, proposals: [] });
    else send({ version: 1, type: 'rpc', id: 'rpc', request: pending, method: frame.code,
      arguments: frame.code === 'run' || frame.code === 'start-job' ? { program: process.execPath, argv: [], timeoutMs: 100 } : { id: 'missing' } });
  } else send({ version: 1, type: 'result', id: pending, ok: true, value: frame, proposals: [] });
});
`)
  let checks = 0
  const worker: LispWorker = new LispWorker({ base: f.base, library, scratch, inputs, cache, protected: false },
    LispConfig.parse({ executionMode: 'protected', sbclPath: process.execPath, startupTimeoutMs: 1000 }), undefined, undefined,
    boundary === 'missing' ? undefined : async (): Promise<void> => {
      assert.equal(worker.jobsIdle, false, 'process admission in progress is not idle')
      if (++checks % 2 === 0) denied()
    })
  t.after(() => worker.stop())
  await worker.start()
  for (const method of ['run', 'start-job']) {
    const result = await worker.request('eval', { code: method }, 1000)
    assert.equal((result.value as { code: string }).code, boundary === 'missing' ? 'TASK_REQUIRED' : 'TASK_STALE')
    assert.equal(worker.jobs.size, 0)
    assert.equal(worker.jobsIdle, true, 'denied admission leaves no pending job')
  }
  for (const method of ['job-status', 'cancel-job']) {
    const result = await worker.request('eval', { code: method }, 1000)
    assert.equal((result.value as { error: string }).error, 'UNKNOWN_JOB')
  }
  assert.equal((await worker.request('eval', { code: 'pure' }, 1000)).value, 42)
})
