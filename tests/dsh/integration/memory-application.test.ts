import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { recordEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { mountMemoryApplication } from '../../../src/dsh/memory-application.js'
import { runMemoryAwareVerifiers } from '../../../src/enno-oduno/memory-verification.js'
import { memoryApplicationStatus, recordMemoryApplicationReview, beginMemoryExecution, completeMemoryExecution, bindMemoryApplication, applicationSourceDigest } from '../../../src/memory/application.js'

const capabilities = ['kiokuko-soul', 'memory-reasoning'].map(name => ({ kind: 'skill' as const, name }))
async function fixture(taskType: 'build' | 'review' = 'build') {
  const directory = await mkdtemp(join(tmpdir(), 'memory-application-')), root = realpathSync(join(directory))
  await mkdir(join(root, '.git')); await mkdir(join(root, 'migrations'))
  await writeFile(join(root, 'migrations', '001.sql'), 'SELECT 1;')
  await writeFile(join(root, 'check.mjs'), 'import assert from "node:assert/strict"; import { readdirSync } from "node:fs"; assert.deepEqual(readdirSync("migrations"), ["001.sql"]);')
  let db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const project = (await resolveProjectWorkspace(db, root))!
  const memory = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'migration expectations', body: 'Derive current migration expectations from the bundled migrations, including the next migration. Fixed historical schema fixtures may use fixed versions.', createdBy: 'fixture', scope: { visibility: 'project' } })
  const runtime = { withDatabase: async (fn: any) => fn(db) }
  const tasks = new CoreTasks(runtime as any)
  const task = await tasks.prepare({ requestId: 'request', sessionId: 'session', turn: 1, task: 'migration expectations code', cwd: root, capabilities,
    profileHints: { taskType, target: 'migration code tests', expected: 'Handle the next migration', constraints: 'Preserve past schemas' }, signal: new AbortController().signal })
  const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: root }
  const status = () => memoryApplicationStatus(db, task.runId)
  const review = (decision: 'adopted' | 'not_applicable' | 'contradicted' = 'adopted') => ({ generation: status().supported ? (status() as any).generation : 1,
    entryId: memory.id, entryRevision: memory.revision, expectedRevision: 0, decision, basis: 'check.mjs currently enumerates migration names.', paths: ['check.mjs', 'migrations'],
    invariant: 'Current expectations follow every bundled migration.', counterexample: 'Adding a second migration breaks a fixed list.', method: 'Add the next migration to this isolated fixture and execute check.mjs.', command: 'node check.mjs' })
  return { root, tasks, task, runtime, identity, memory, status, review, get db() { return db },
    reopen() { db.close(); db = openConnection(join(root, 'state.sqlite3')) },
    async close() { db.close(); await rm(directory, { recursive: true, force: true }) } }
}

test('native path blocks missing decisions, observes failing next-migration regression, then accepts dynamic expectations and survives restart', async () => {
  const f = await fixture(), listeners = new Map<string, any>(), tools: any[] = []
  const agent = { session: {} }, host = { ...f.runtime }
  const dispose = mountMemoryApplication({ tools: { register(tool) { tools.push(tool); return () => {} } }, on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) } }, {
    runtime: host as any, resolve: execution => execution.agent === agent ? f.identity : undefined,
    refresh: async (_execution, query) => f.tasks.refresh(f.task, query, new AbortController().signal),
  })
  const execution = (callId: string, name = 'Bash', args: unknown = { command: 'node check.mjs' }) => ({ callId, name, arguments: args, agent, signal: new AbortController().signal })
  try {
    assert.deepEqual(Reflect.ownKeys(tools[0].parameters), Object.keys(tools[0].parameters),
      'native DSH schema projection rejects non-enumerable or symbol properties')
    assert.equal(f.status().ready, false)
    const pendingStatus = f.status()
    for (const name of ['read', 'Read', 'read_file', 'glob', 'grep', 'skill', 'observation_read', 'lisp_status']) {
      let readAllowed = false
      const call = execution(`original-${name}`, name, { file_path: 'check.mjs' })
      await listeners.get('tools/pre-execute')(call, async () => { readAllowed = true })
      await listeners.get('tools/result')(call, { value: { exitCode: 0 } })
      assert.equal(readAllowed, true, `${name} must remain available to assess pending memory`)
    }
    assert.deepEqual(f.status(), pendingStatus, 'retrieval is not a new execution or verification')
    let effects = 0
    for (const name of ['Edit', 'edit', 'write', 'bash', 'lisp_eval', 'unknown_tool']) {
      await assert.rejects(listeners.get('tools/pre-execute')(execution(`missing-${name}`, name), async () => { effects++ }), /resolve memory decisions/)
    }
    assert.equal(effects, 0)
    await tools[0].execute({ action: 'review', review: f.review() }, execution('review', 'task_memory_review'))
    await writeFile(join(f.root, 'migrations', '002.sql'), 'SELECT 2;')
    const run = async (callId: string) => {
      const call = execution(callId)
      await listeners.get('tools/pre-execute')(call, async () => { effects++ })
      const result = spawnSync(process.execPath, ['check.mjs'], { cwd: f.root, encoding: 'utf8' })
      await listeners.get('tools/result')(call, { isError: result.status !== 0, value: { exitCode: result.status }, content: [{ type: 'text', text: result.stderr }] })
      return result.status
    }
    assert.equal(await run('broken'), 1)
    assert.equal(f.status().ready, false)
    assert.throws(() => new LedgerStore(f.db).updateRunStatus(f.task.runId, 'completed'), /incomplete/)
    await writeFile(join(f.root, 'check.mjs'), 'import assert from "node:assert/strict"; import { readdirSync } from "node:fs"; const versions = readdirSync("migrations").map(f => Number(f.slice(0,3))); assert.deepEqual(versions, Array.from({length: versions.length}, (_,i) => i+1));')
    assert.equal(await run('fixed'), 0)
    assert.equal(f.status().ready, true)
    assert.equal(f.status().verification, 'client_observed')
    f.reopen()
    assert.equal(f.status().ready, true)
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
  } finally { dispose(); await f.close() }
})

test('model reports, skip, unknown, failure, background and stale files never satisfy observed verification', async () => {
  const f = await fixture()
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'review', f.review())
    const results = [ { value: { exitCode: 1 } }, { value: { exitCode: 0, skipped: true } }, { value: { exitCode: 0, kind: 'background' } },
      { value: { exitCode: 0, timedOut: true } }, { content: 'passed' }, { value: { exitCode: 0 }, content: '# skipped 1' } ]
    for (const [index, result] of results.entries()) {
      beginMemoryExecution(f.db, f.identity, `call-${index}`, 'node check.mjs')
      completeMemoryExecution(f.db, f.identity, `call-${index}`, result)
      assert.equal(f.status().ready, false)
      if ((result.value as any)?.kind === 'background') completeMemoryExecution(f.db, f.identity, `call-${index}`, { value: { exitCode: 1 } })
    }
    beginMemoryExecution(f.db, f.identity, 'good', 'node check.mjs')
    completeMemoryExecution(f.db, f.identity, 'good', { value: { exitCode: 0 } })
    assert.equal(f.status().ready, true)
    await writeFile(join(f.root, 'check.mjs'), 'throw Error("changed")')
    assert.equal(f.status().ready, false)
    await assert.rejects(f.tasks.checkpoint(f.task, { outcome: 'completed', evidence: { commands: [{ executable: 'node', outcome: 'passed', exitCode: 0 }] } }, new AbortController().signal), /incomplete/)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_evidence WHERE run_id=?').get(f.task.runId)?.n, 0, 'rejected checkpoint rolls back model evidence')
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'interrupted', 'native completion stops without an automatic continuation')
  } finally { await f.close() }
})

test('reviews bind revisions, reject conflicting retry and foreign identities, and refresh cannot erase prior obligations', async () => {
  const f = await fixture()
  try {
    const review = f.review('not_applicable')
    assert.deepEqual(recordMemoryApplicationReview(f.db, f.identity, 'r', review), { revision: 1, provenance: 'model_reported' })
    assert.deepEqual(recordMemoryApplicationReview(f.db, f.identity, 'r', review), { revision: 1, provenance: 'model_reported' })
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'r', { ...review, basis: 'different' }), /different input/)
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'other', review), /revision changed/)
    assert.throws(() => recordMemoryApplicationReview(f.db, { ...f.identity, sessionId: 'forged' }, 'x', review), /identity changed/)
    assert.equal(f.status().ready, true, 'a justified historical fixed-version fixture is allowed')
    await f.tasks.refresh(f.task, 'unrelated-query-that-matches-nothing', new AbortController().signal)
    assert.equal(f.status().ready, false)
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'stale', review), /delivery changed/)
    recordMemoryApplicationReview(f.db, f.identity, 'current', f.review('contradicted'))
    assert.equal(f.status().ready, true)
    updateCandidateEntry(f.db, { workspace: f.task.workspace, entryId: f.memory.id, expectedRevision: 1, kind: f.memory.kind, title: f.memory.title, body: 'migration expectations updated', actor: 'fixture' })
    assert.equal(f.status().ready, false)
    await f.tasks.finish(f.task, 'cancelled')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'cancelled')
  } finally { await f.close() }
})

test('superseding an ordinary reviewed memory blocks further effects and completion without a revision change', async () => {
  const f = await fixture()
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'review', f.review('not_applicable'))
    assert.equal(f.status().ready, true)
    const replacement = recordEntry(f.db, { workspace: f.task.workspace, kind: 'reference', title: 'Replacement evidence',
      body: 'The previous migration guidance is no longer applicable.', createdBy: 'fixture', scope: { visibility: 'project' } })
    f.db.prepare("UPDATE entries SET status='superseded',superseded_by=? WHERE id=?").run(replacement.id, f.memory.id)
    assert.equal(f.status().ready, false)
    assert.equal(f.status().pending[0]?.problem, 'entry_changed')
    assert.throws(() => beginMemoryExecution(f.db, f.identity, 'edit', null), /resolve memory decisions/)
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'retry', { ...f.review('not_applicable'), expectedRevision: 1 }), /Memory entry changed/)
    assert.throws(() => new LedgerStore(f.db).updateRunStatus(f.task.runId, 'completed'), /incomplete/)
  } finally { await f.close() }
})

test('plan reviews need current rationale but no implementation command; edits invalidate prior proof and concurrent results', async () => {
  const plan = await fixture('review')
  try {
    const { command: _command, ...review } = plan.review()
    recordMemoryApplicationReview(plan.db, plan.identity, 'plan', review)
    assert.equal(plan.status().ready, true)
    assert.equal(plan.status().verification, 'unobserved')
    await plan.tasks.finish(plan.task, 'completed')
  } finally { await plan.close() }
  const f = await fixture()
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'r', f.review())
    beginMemoryExecution(f.db, f.identity, 'test', 'node check.mjs')
    beginMemoryExecution(f.db, f.identity, 'parallel-edit', null)
    completeMemoryExecution(f.db, f.identity, 'test', { value: { exitCode: 0 } })
    assert.equal(f.status().ready, false)
    completeMemoryExecution(f.db, f.identity, 'parallel-edit', { value: {} })
    beginMemoryExecution(f.db, f.identity, 'next-test', 'node check.mjs')
    completeMemoryExecution(f.db, f.identity, 'next-test', { value: { exitCode: 0 } })
    assert.equal(f.status().ready, true)
    assert.throws(() => completeMemoryExecution(f.db, f.identity, 'next-test', { value: { exitCode: 1 } }), /changed on replay/)
    assert.throws(() => completeMemoryExecution(f.db, f.identity, 'next-test', { value: { exitCode: 0 }, content: '# skipped 1' }), /changed on replay/)
    assert.throws(() => applicationSourceDigest(f.root, ['../outside']), /relative/)
    assert.throws(() => bindMemoryApplication(f.db, { ...f.identity, runId: 'different' }, f.task.profile, f.task.context), /identity/)
  } finally { await f.close() }
})

test('existing approved Enno verifier supplies proof; skipped checks beyond the preview and later failures revoke it', async () => {
  const f = await fixture()
  try {
    const spec = { id: 'regression', kind: 'test' as const, executable: process.execPath, args: ['check.mjs'], cwd: '.', timeoutMs: 5000 }
    recordMemoryApplicationReview(f.db, f.identity, 'r', { ...f.review(), command: `${process.execPath} check.mjs` })
    assert.equal((await runMemoryAwareVerifiers(f.db, f.task.runId, [spec], f.root, { descendantSettleMs: 0 }))[0]?.status, 'passed')
    assert.equal(f.status().ready, true)
    await writeFile(join(f.root, 'check.mjs'), 'console.log("x".repeat(12000)); console.log("# skipped 1");')
    const skipped = await runMemoryAwareVerifiers(f.db, f.task.runId, [spec], f.root, { descendantSettleMs: 0 })
    assert.equal(skipped[0]?.exitCode, 0)
    assert.equal(skipped[0]?.skipped, true)
    assert.equal(f.status().ready, false)
    await writeFile(join(f.root, 'check.mjs'), 'process.exit(0)')
    await runMemoryAwareVerifiers(f.db, f.task.runId, [spec], f.root, { descendantSettleMs: 0 })
    assert.equal(f.status().ready, true)
    beginMemoryExecution(f.db, f.identity, 'failed-repeat', `${process.execPath} check.mjs`)
    completeMemoryExecution(f.db, f.identity, 'failed-repeat', { value: { exitCode: 1 } })
    assert.equal(f.status().ready, false, 'a former success cannot hide the latest failing result')
  } finally { await f.close() }
})
