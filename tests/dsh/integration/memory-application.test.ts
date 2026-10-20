import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { ensureGlobalWorkspace, resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { recordEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { createRequestIntentContext, bindMainModelRequestIntent, requestIntentMessageRefs, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
import { mountMemoryApplication } from '../../../src/dsh/memory-application.js'
import { runMemoryAwareVerifiers } from '../../../src/enno-oduno/memory-verification.js'
import { memoryApplicationStatus, recordMemoryApplicationReview, recordMemoryApplicationReviewBatch, recordCompletedMemoryApplicationsInTransaction, beginMemoryExecution, completeMemoryExecution, bindMemoryApplication, applicationSourceDigest } from '../../../src/memory/application.js'
import { AutoGlobalizationWorker, autoGlobalizationStatus, processNextAutoGlobalizationInTransaction } from '../../../src/memory/auto-globalization.js'
import { readEntry } from '../../../src/memory/entries.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { forgetMemory } from '../../../src/memory/forget.js'
import { explainMemory } from '../../../src/memory/explain.js'

test('forget retracts an explicitly seeded historical Global and invalidates proof while retaining accounting', async () => {
  const f = await fixture()
  const worker = new AutoGlobalizationWorker(f.runtime as any, true)
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'historical-review', f.review())
    beginMemoryExecution(f.db, f.identity, 'historical-test', 'node check.mjs')
    const result = spawnSync(process.execPath, ['check.mjs'], { cwd: f.root, encoding: 'utf8' })
    assert.equal(result.status, 0)
    completeMemoryExecution(f.db, f.identity, 'historical-test', { value: { exitCode: 0 } })
    await f.tasks.finish(f.task, 'completed')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM auto_global_application_receipts').get()?.n, 0,
      'native completion must not create automatic memory accounting')
    // Reconstruct retained pre-migration accounting explicitly. This is not a native save path.
    const completedAt = f.db.prepare('SELECT ended_at FROM ledger_runs WHERE run_id=?').get<{ended_at: string}>(f.task.runId)!.ended_at
    recordCompletedMemoryApplicationsInTransaction(f.db, f.task.runId, completedAt)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM auto_global_application_receipts').get()?.n, 1)
    ensureGlobalWorkspace(f.db)
    const global = recordEntry(f.db, { workspace: 'global', kind: f.memory.kind, title: f.memory.title,
      body: f.memory.body, scope: { visibility: 'global' }, createdBy: 'historical-fixture',
      provenance: { type: 'curator_globalize', reference: `${f.memory.id}@1#historical-fixture`, sourceWorkspace: f.memory.workspace } })
    assert.equal(explainMemory(f.db, { workspace: 'global', entryId: global.id }).derivation?.kind, 'global')
    const accounting = f.db.prepare('SELECT * FROM auto_global_application_receipts').all()
    assert.equal(forgetMemory(f.db, { workspace: f.memory.workspace, entryId: f.memory.id,
      expectedRevision: 1, operationId: 'historical-global-forget' }).count, 2)
    assert.throws(() => readEntry(f.db, { workspace: 'global', entryId: global.id }))
    worker.kick(); await worker.whenIdle(); f.reopen(); worker.kick(); await worker.whenIdle()
    assert.deepEqual(f.db.prepare('SELECT * FROM auto_global_application_receipts').all(), accounting)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM task_memory_executions WHERE outcome='passed'").get()?.n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_reviews WHERE entry_id=?').get(f.memory.id)?.n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_delivery_entries WHERE entry_id IN (?,?)').get(f.memory.id, global.id)?.n, 0)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await worker.dispose(); await f.close() }
})

const capabilities = ['kiokuko-soul', 'memory-reasoning'].map(name => ({ kind: 'skill' as const, name }))
test('empty application has no write transaction or result observer after five effectful calls', async () => {
  const f = await fixture()
  try {
    const identity = { ...f.identity }
    f.db.prepare('DELETE FROM task_memory_bindings WHERE run_id=?').run(f.task.runId)
    bindMemoryApplication(f.db, identity, f.task.profile, null, 'no_match')
    const counts = { writes: 0, reads: 0 }
    const database = { filePath: f.db.filePath, close: () => {}, exec(sql: string) {
      if (sql === 'BEGIN IMMEDIATE') counts.writes++
      f.db.exec(sql)
    }, prepare(sql: string) { const statement = f.db.prepare(sql); return {
      get: (...args: any[]) => { counts.reads++; return statement.get(...args) },
      all: (...args: any[]) => { counts.reads++; return statement.all(...args) },
      run: (...args: any[]) => statement.run(...args),
    } } } as typeof f.db
    const listeners = new Map<string, any>()
    const dispose = mountMemoryApplication({ tools: { register: () => () => {} }, on(name, handler) {
      listeners.set(name, handler); return () => listeners.delete(name)
    } }, { runtime: { withDatabase: async (operation: any) => operation(database) } as any,
      resolve: execution => execution.agent === identity ? identity : undefined, refresh: async () => undefined })
    try {
      for (let n = 0; n < 5; n++) {
        const execution = { callId: `empty-${n}`, name: 'Bash', arguments: { command: 'true' }, agent: identity, signal: new AbortController().signal }
        await listeners.get('tools/pre-execute')(execution, async () => undefined)
        const reads = counts.reads
        await listeners.get('tools/result')(execution, { value: { exitCode: 0 } })
        assert.equal(counts.reads, reads, 'untracked result must not access SQLite')
      }
      assert.equal(counts.writes, 0)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_executions WHERE run_id=?').get<{n:number}>(f.task.runId)?.n, 0)
    } finally { dispose() }
  } finally { await f.close() }
})
test('native admission, public review actions, and checkpoint stay memory-write-free through completion and restart', async () => {
  const f = await fixture('build', false), listeners = new Map<string, any>(), tools: any[] = [], agent = {}
  let refreshes = 0, effects = 0
  const dispose = mountMemoryApplication({ tools: { register(tool) { tools.push(tool); return () => {} } },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) } }, {
    runtime: f.runtime as any, resolve: execution => execution.agent === agent ? f.identity : undefined,
    refresh: async () => { refreshes++ },
  })
  const snapshot = () => Object.fromEntries(['entries', 'entry_revisions', 'context_deliveries',
    'task_memory_bindings', 'task_memory_reviews', 'task_memory_executions', 'auto_global_application_receipts',
    'auto_global_projections'].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  try {
    assert.equal(f.task.admitted, true)
    assert.equal(f.task.memory, null)
    assert.equal(f.task.context, null)
    assert.equal(f.status().supported, false)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_bindings').get()?.n, 0)
    const before = snapshot(), reviewTool = tools.find(tool => tool.name === 'task_memory_review')
    const execute = (callId: string, name: string, args: unknown = {}) => ({ callId, name, arguments: args,
      agent, signal: new AbortController().signal })
    for (const [index, input] of [
      { action: 'review', review: f.review() },
      { action: 'review_batch', reviews: [f.review(), { ...f.review(), entryRevision: 99 }] },
      { action: 'refresh', query: 'migration expectations code' },
    ].entries()) {
      assert.deepEqual(await reviewTool.execute(input, execute(`review-${index}`, 'task_memory_review')), {
        recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required',
      })
      assert.deepEqual(snapshot(), before)
    }
    assert.equal(refreshes, 0, 'the public refresh action cannot call the former retrieval writer')
    const refreshed=await f.tasks.refresh(f.task,'migration expectations',new AbortController().signal)
    assert.equal(refreshed.memory,null);assert.equal(refreshed.context,null)
    assert.equal(refreshed.corrections?.retrieval,'no_correction','ordinary memory is not treated as a user correction')
    assert.deepEqual(await f.tasks.checkpoint(f.task, { outcome: 'completed', memories: [{ kind: 'lesson',
      title: 'Model-only memory', body: 'Do not persist this unapproved claim.' }] }, new AbortController().signal), {
      project: null, entries: [], recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required',
    })
    const call = execute('ordinary-bash', 'Bash', { command: 'node check.mjs' })
    await listeners.get('tools/pre-execute')(call, async () => { effects++ })
    const result = spawnSync(process.execPath, ['check.mjs'], { cwd: f.root, encoding: 'utf8' })
    assert.equal(result.status, 0)
    await listeners.get('tools/result')(call, { value: { exitCode: 0 } })
    assert.equal(effects, 1)
    assert.deepEqual(snapshot(), before)
    await f.tasks.finish(f.task, 'completed')
    f.reopen()
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
    assert.deepEqual(snapshot(), before)
  } finally { dispose(); await f.close() }
})

test('memory observer outage cannot reject native effects or completion', async () => {
  const f = await fixture(), listeners = new Map<string, any>()
  const dispose = mountMemoryApplication({ tools: { register: () => () => {} },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) } }, {
    runtime: { withDatabase: async () => { throw new Error('memory observer unavailable') } } as any,
    resolve: () => f.identity, refresh: async () => undefined,
  })
  try {
    let effects = 0
    const call = { callId: 'outage-bash', name: 'Bash', arguments: { command: 'node check.mjs' }, signal: new AbortController().signal }
    await listeners.get('tools/pre-execute')(call, async () => { effects++ })
    await listeners.get('tools/result')(call, { value: { exitCode: 0 } })
    assert.equal(effects, 1)
    assert.equal(f.status().ready, false)
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_executions').get()?.n, 0)
  } finally { dispose(); await f.close() }
})

async function fixture(taskType: 'build' | 'review' = 'build', historicalBinding = true) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-application-')), root = realpathSync(join(directory))
  await mkdir(join(root, '.git')); await mkdir(join(root, 'migrations'))
  await writeFile(join(root, 'migrations', '001.sql'), 'SELECT 1;')
  await writeFile(join(root, 'package.json'), '{"name":"memory-fixture","private":true}')
  await writeFile(join(root, 'check.mjs'), 'import assert from "node:assert/strict"; import { readdirSync } from "node:fs"; assert.deepEqual(readdirSync("migrations"), ["001.sql"]);')
  let db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const project = (await resolveProjectWorkspace(db, root))!
  const memory = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'migration expectations', body: 'Derive current migration expectations from the bundled migrations, including the next migration. Fixed historical schema fixtures may use fixed versions.', createdBy: 'fixture', scope: { visibility: 'project', applicability: { languages: ['JavaScript'] } } })
  const runtime = { withDatabase: async (fn: any) => fn(db) }
  const tasks = new CoreTasks(runtime as any)
  const task = await tasks.prepare({ requestId: 'request', sessionId: 'session', turn: 1, task: 'migration expectations code', cwd: root, capabilities,
    profileHints: { taskType, target: 'migration code tests', expected: 'Handle the next migration', constraints: 'Preserve past schemas' }, signal: new AbortController().signal })
  const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: root }
  // Native preparation no longer binds memory. Legacy proof tests own their historical
  // delivery/binding fixture, so they cannot accidentally reintroduce admission coupling.
  const bindHistorical = async (query = 'migration expectations code', selected = task) => {
    const result = await queryScopedContextGated(db, { project, projectOnly: true, task: query,
      taskProfile: selected.profile, runId: selected.runId, limit: 5, characterBudget: 4000 },
    () => ({ persist: true, value: null }))
    assert.ok(result.context)
    bindMemoryApplication(db, { runId: selected.runId, workspace: selected.workspace,
      sessionId: selected.sessionId, repositoryRoot: root }, selected.profile, result.context)
    return result.context
  }
  if (historicalBinding) await bindHistorical()
  const status = () => memoryApplicationStatus(db, task.runId)
  const review = (decision: 'adopted' | 'not_applicable' | 'contradicted' = 'adopted') => ({ generation: status().supported ? (status() as any).generation : 1,
    entryId: memory.id, entryRevision: memory.revision, expectedRevision: 0, decision, basis: 'check.mjs currently enumerates migration names.', paths: ['check.mjs', 'migrations'],
    invariant: 'Current expectations follow every bundled migration.', counterexample: 'Adding a second migration breaks a fixed list.', method: 'Add the next migration to this isolated fixture and execute check.mjs.', command: 'node check.mjs' })
  return { root, tasks, task, runtime, identity, memory, status, review, bindHistorical, get db() { return db },
    reopen() { db.close(); db = openConnection(join(root, 'state.sqlite3')) },
    async close() { db.close(); await rm(directory, { recursive: true, force: true }) } }
}

test('native execution observes historical regression proof without turning public review into a memory writer', async () => {
  const f = await fixture(), listeners = new Map<string, any>(), tools: any[] = []
  const agent = { session: {} }, host = { ...f.runtime }
  const dispose = mountMemoryApplication({ tools: { register(tool) { tools.push(tool); return () => {} } }, on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) } }, {
    runtime: host as any, resolve: execution => execution.agent === agent ? f.identity : undefined,
    refresh: async (_execution, query) => f.tasks.refresh(f.task, query, new AbortController().signal),
  })
  const execution = (callId: string, name = 'Bash', args: unknown = { command: 'node check.mjs' }) => ({ callId, name, arguments: args, agent, signal: new AbortController().signal })
  try {
    assert.deepEqual(Reflect.ownKeys(tools.find(tool => tool.name === 'task_memory_review').parameters), Object.keys(tools.find(tool => tool.name === 'task_memory_review').parameters),
      'native DSH schema projection rejects non-enumerable or symbol properties')
    assert.equal(tools.find(tool => tool.name === 'task_memory_review').parameters.type, 'object', 'model provider requires an object-root tool schema')
    assert.deepEqual(tools.find(tool => tool.name === 'task_memory_review').parameters.required, ['action'])
    assert.deepEqual(tools.find(tool => tool.name === 'task_memory_review').parameters.properties.action.enum, ['status', 'review', 'review_batch', 'refresh'])
    assert.equal(f.status().ready, false)
    const pendingStatus = f.status()
    for (const name of ['read', 'Read', 'read_file', 'glob', 'grep', 'skill', 'observation_read', 'memory_explain', 'lisp_status']) {
      let readAllowed = false
      const call = execution(`original-${name}`, name, { file_path: 'check.mjs' })
      await listeners.get('tools/pre-execute')(call, async () => { readAllowed = true })
      await listeners.get('tools/result')(call, { value: { exitCode: 0 } })
      assert.equal(readAllowed, true, `${name} must remain available to assess pending memory`)
    }
    const read = execution('pending-explanation','memory_explain',{entryId:f.memory.id})
    const explanation = await listeners.get('tools/pre-execute')(read,async () => tools.find(tool => tool.name === 'memory_explain').execute(read.arguments,read))
    assert.equal(explanation.body,f.memory.body)
    assert.equal(explanation.evidenceStatus,'details_unavailable')
    await assert.rejects(tools.find(tool => tool.name === 'memory_explain').execute({entryId:f.memory.id,workspace:'global'},read))
    assert.deepEqual(f.status(), pendingStatus, 'retrieval is not a new execution or verification')
    let effects = 0
    for (const name of ['Edit', 'edit', 'write', 'bash', 'lisp_eval', 'unknown_tool']) {
      const unresolved = execution(`unresolved-${name}`, name)
      await listeners.get('tools/pre-execute')(unresolved, async () => { effects++ })
      await listeners.get('tools/result')(unresolved, { value: {} })
    }
    assert.equal(effects, 6, 'an unresolved decision never rejects the call')
    assert.equal(f.status().ready, false, 'historical memory remains unresolved advisory data')
    const declined = await tools.find(tool => tool.name === 'task_memory_review').execute({ action: 'review', review: f.review() }, execution('review', 'task_memory_review'))
    assert.deepEqual(declined, { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' })
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_reviews').get()?.n, 0)
    recordMemoryApplicationReview(f.db, f.identity, 'historical-review', f.review())
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
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'active')
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

test('PTC transport and nested effects continue while public review leaves historical memory unresolved', async () => {
  const f = await fixture(), listeners = new Map<string, any>(), tools: any[] = []
  const agent = { session: {} }
  const dispose = mountMemoryApplication({ tools: { register(tool) { tools.push(tool); return () => {} } },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) } }, {
    runtime: f.runtime as any, resolve: execution => execution.agent === agent ? f.identity : undefined,
    refresh: async () => undefined,
  })
  const execution = (callId: string, name: string, parent?: unknown) => ({ callId, rootCallId: 'ptc-root', name,
    arguments: {}, agent, signal: new AbortController().signal, ...(parent === undefined ? {} : { parent }) })
  try {
    let transportRuns = 0, effects = 0
    const parent = Symbol('ptc-parent')
    // Unresolved historical memory is advisory and never rejects native work.
    const root = execution('ptc-root', 'run_code')
    await listeners.get('tools/pre-execute')(root, async () => { transportRuns++ })
    await listeners.get('tools/result')(root, { value: { logs: [], result: null } })
    assert.equal(transportRuns, 1, 'the transport call runs while decisions are unresolved')
    assert.equal(f.status().ready, false, 'historical memory remains unresolved advisory data')
    const statusCall = execution('direct-status', 'task_memory_review')
    const status = await tools.find(tool => tool.name === 'task_memory_review').execute({ action: 'status' }, statusCall)
    assert.equal(status.pending[0]?.problem, 'decision_missing')
    await assert.rejects(tools.find(tool => tool.name === 'task_memory_review').execute({ action: 'status' }, execution('foreign:ptc:1', 'task_memory_review', parent)), /No active native task/)
    const nested = execution('ptc-root:ptc:2', 'bash', parent)
    await listeners.get('tools/pre-execute')(nested, async () => { effects++ })
    await listeners.get('tools/result')(nested, { value: {} })
    assert.equal(effects, 1, 'nested effects are tracked while decisions are unresolved')
    const review = await tools.find(tool => tool.name === 'task_memory_review').execute({ action: 'review', review: f.review('not_applicable') }, execution('direct-review', 'task_memory_review'))
    assert.deepEqual(review, { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' })
    assert.equal(f.status().ready, false)
    assert.equal((await tools.find(tool => tool.name === 'task_memory_review').execute({ action: 'status' }, execution('ptc-root:ptc:3', 'task_memory_review', parent))).ready, false)
    await listeners.get('tools/pre-execute')(execution('ptc-root:ptc:4', 'bash', parent), async () => { effects++ })
    assert.equal(effects, 2)
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_reviews').get()?.n, 0)
  } finally { dispose(); await f.close() }
})

test('advisory memory status keeps the native PTC transport and uses SDK subdispatch', async () => {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const { pathToFileURL } = await import('node:url')
  const [cordis, prompt, toolModule, scope] = await Promise.all(
    ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
      .map(name => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)))
  const f = await fixture()
  const ctx = new cordis.Context(), fibers: any[] = []
  let scoped: any, unmount: (() => void) | undefined
  const releaseRuntime = ctx.provide('ptcRuntime', { language: 'typescript' })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}), await ctx.plugin(toolModule.default, { mode: 'ptc' }))
    const session = { id: 'session' }, agent: any = { id: 'ordinary-agent', session }
    scoped = scope.createScope(ctx, agent); agent.ctx = scoped.ctx
    const tools = scoped.ctx.get('tools')
    // Match the production host projection; scoped Cordis contexts require
    // injection before reading an optional service such as commands.
    unmount = mountMemoryApplication({ tools, on: scoped.ctx.on.bind(scoped.ctx) }, { runtime: f.runtime as any,
      resolve: execution => execution.agent === agent ? f.identity : undefined, refresh: async () => undefined })
    assert.equal(tools.modeFor(agent), 'ptc')
    assert.deepEqual(tools.wireSchemas(agent).schemas.map((schema: any) => schema.name), ['run_code'])
    assert.equal(tools.modeFor(agent), 'ptc')
    const review = tools.get('task_memory_review', agent)
    assert.ok(review, 'pending review remains available to the run_code SDK')
    const result = await review.execute({ action: 'status' }, { agent, name: 'task_memory_review', callId: 'run:ptc:1', parent: { callId: 'run' }, rootCallId: 'run', signal: new AbortController().signal })
    assert.equal(result.ready, false)
    assert.equal(result.pending[0]?.problem, 'decision_missing')
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
  } finally {
    unmount?.()
    await scoped?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    releaseRuntime()
    await f.close()
  }
})

test('completed native and Enno applications never automatically globalize, even with retained historical receipts', async () => {
  const f = await fixture()
  const workers = [true, true, false].map(enabled => new AutoGlobalizationWorker(f.runtime as any, enabled))
  try {
    for (let number = 1; number <= 4; number++) {
      const task = number === 1 ? f.task : await f.tasks.prepare({ requestId: `request-${number}`,
        sessionId: 'session', turn: number, task: 'migration expectations code', cwd: f.root, capabilities,
        profileHints: { taskType: 'build', target: 'migration code tests', expected: 'Handle the next migration', constraints: 'Preserve past schemas' },
        signal: new AbortController().signal })
      if (number !== 1) await f.bindHistorical('migration expectations code', task)
      const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: f.root }
      const status = memoryApplicationStatus(f.db, task.runId)
      assert.ok(status.supported)
      assert.equal(status.items.length, 1)
      recordMemoryApplicationReview(f.db, identity, `review-${number}`, { ...f.review(), generation: status.generation,
        command: number === 2 ? `${process.execPath} check.mjs` : 'node check.mjs' })
      if (number === 2) {
        const spec = { id: 'regression', kind: 'test' as const, executable: process.execPath,
          args: ['check.mjs'], cwd: '.', timeoutMs: 5000 }
        assert.equal((await runMemoryAwareVerifiers(f.db, task.runId, [spec], f.root, { descendantSettleMs: 0 }))[0]?.status, 'passed')
      } else {
        beginMemoryExecution(f.db, identity, `verify-${number}`, 'node check.mjs')
        const result = spawnSync(process.execPath, ['check.mjs'], { cwd: f.root, encoding: 'utf8' })
        assert.equal(result.status, 0)
        completeMemoryExecution(f.db, identity, `verify-${number}`, { value: { exitCode: 0 } })
      }
      assert.equal(memoryApplicationStatus(f.db, task.runId).ready, true)
      await f.tasks.finish(task, 'completed')
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM auto_global_application_receipts WHERE run_id=?').get(task.runId)?.n, 0,
        'ordinary completion cannot create an automatic application receipt')
      // Explicit reconstruction exercises a database containing older valid receipts.
      const completedAt = f.db.prepare('SELECT ended_at FROM ledger_runs WHERE run_id=?').get<{ended_at: string}>(task.runId)!.ended_at
      recordCompletedMemoryApplicationsInTransaction(f.db, task.runId, completedAt)
      assert.equal(autoGlobalizationStatus(f.db, f.memory.id, 1).successfulRuns, number)
    }
    const before = { entries: f.db.prepare('SELECT * FROM entries ORDER BY id').all(),
      queue: f.db.prepare('SELECT * FROM auto_global_queue ORDER BY entry_id,entry_revision').all(),
      receipts: f.db.prepare('SELECT * FROM auto_global_application_receipts ORDER BY run_id').all() }
    assert.equal(processNextAutoGlobalizationInTransaction(f.db, true), false)
    for (const worker of workers) worker.kick()
    await Promise.all(workers.map(worker => worker.whenIdle()))
    f.reopen()
    for (const worker of workers) worker.kick()
    await Promise.all(workers.map(worker => worker.whenIdle()))
    assert.deepEqual(f.db.prepare('SELECT * FROM entries ORDER BY id').all(), before.entries)
    assert.deepEqual(f.db.prepare('SELECT * FROM auto_global_queue ORDER BY entry_id,entry_revision').all(), before.queue)
    assert.deepEqual(f.db.prepare('SELECT * FROM auto_global_application_receipts ORDER BY run_id').all(), before.receipts)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM auto_global_projections').get()?.n, 0)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM entries WHERE workspace='global'").get()?.n, 0)
    // The supported positive save path is the actual native two-question approval
    // flow in writer-boundary-native-audit.test.ts and replay-memory-review.test.ts.
  } finally { for (const worker of workers) await worker.dispose(); await f.close() }
})

test('model reports and stale or failed historical proof cannot become verification or veto native completion', async () => {
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
    const checkpoint = await f.tasks.checkpoint(f.task, { outcome: 'completed', evidence: { commands: [{ executable: 'node', outcome: 'passed', exitCode: 0 }] } }, new AbortController().signal)
    assert.deepEqual(checkpoint, { project: null, entries: [], recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' })
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_evidence WHERE run_id=?').get(f.task.runId)?.n, 0, 'a public checkpoint cannot persist model evidence')
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed', 'stale historical memory cannot rewrite native success')
  } finally { await f.close() }
})

test('historical reviews bind revisions and identities while explicit rebinding retains unchanged decisions', async () => {
  const f = await fixture()
  try {
    const review = f.review('not_applicable')
    assert.deepEqual(recordMemoryApplicationReview(f.db, f.identity, 'r', review), { revision: 1, provenance: 'model_reported' })
    assert.deepEqual(recordMemoryApplicationReview(f.db, f.identity, 'r', review), { revision: 1, provenance: 'model_reported' })
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'r', { ...review, basis: 'different' }), /different input/)
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'other', review), /revision changed/)
    assert.throws(() => recordMemoryApplicationReview(f.db, { ...f.identity, sessionId: 'forged' }, 'x', review), /identity changed/)
    assert.equal(f.status().ready, true, 'a justified historical fixed-version fixture is allowed')
    const initial = f.status()
    assert.ok(initial.supported)
    const generation = initial.generation
    await f.bindHistorical('unrelated-query-that-matches-nothing')
    const refreshed = f.status()
    assert.ok(refreshed.supported)
    assert.equal(refreshed.generation, generation)
    assert.equal(refreshed.ready, true)
    assert.equal(refreshed.items[0]?.decision, 'not_applicable')
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'stale', review), /revision changed/)
    updateCandidateEntry(f.db, { workspace: f.task.workspace, entryId: f.memory.id, expectedRevision: 1, kind: f.memory.kind, title: f.memory.title, body: 'migration expectations updated', actor: 'fixture' })
    assert.equal(f.status().ready, false)
    await f.bindHistorical('migration expectations updated')
    const revised = f.status()
    assert.ok(revised.supported)
    assert.equal(revised.generation, generation + 1)
    assert.equal(revised.items[0]?.problem, 'decision_missing')
    await f.tasks.finish(f.task, 'cancelled')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'cancelled')
  } finally { await f.close() }
})

test('explicit historical rebinding adds only new decisions and invalidates prior execution proof', async () => {
  const f = await fixture()
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'original-review', f.review())
    beginMemoryExecution(f.db, f.identity, 'original-proof', 'node check.mjs')
    completeMemoryExecution(f.db, f.identity, 'original-proof', { value: { exitCode: 0 } })
    assert.equal(f.status().ready, true)
    const initial = f.status()
    assert.ok(initial.supported)
    const generation = initial.generation
    const added = recordEntry(f.db, { workspace: f.task.workspace, kind: 'lesson', title: 'batching signal',
      body: 'The batching signal requires an independent current-source decision.', createdBy: 'fixture', scope: { visibility: 'project' } })
    await f.bindHistorical('batching signal')
    const refreshed = f.status()
    assert.ok(refreshed.supported)
    assert.equal(refreshed.generation, generation)
    assert.equal(refreshed.items.find(item => item.entryId === f.memory.id)?.decision, 'adopted')
    assert.equal(refreshed.items.find(item => item.entryId === f.memory.id)?.problem, 'verification_missing_failed_or_stale')
    assert.equal(refreshed.items.find(item => item.entryId === added.id)?.problem, 'decision_missing')
    // Low-level accounting still marks historical proof incomplete without blocking work.
    beginMemoryExecution(f.db, f.identity, 'unresolved-effect', null)
    completeMemoryExecution(f.db, f.identity, 'unresolved-effect', { value: {} })
    assert.equal(f.status().ready, false, 'historical memory remains unresolved advisory data')
    recordMemoryApplicationReview(f.db, f.identity, 'added-review', { generation, entryId: added.id,
      entryRevision: added.revision, expectedRevision: 0, decision: 'not_applicable',
      basis: 'The batching signal is unrelated to migration checks.', paths: [] })
    beginMemoryExecution(f.db, f.identity, 'new-proof', 'node check.mjs')
    completeMemoryExecution(f.db, f.identity, 'new-proof', { value: { exitCode: 0 } })
    assert.equal(f.status().ready, true)
  } finally { await f.close() }
})

test('topic-based non-applicability survives unrelated edits while source-backed decisions expire', async () => {
  const f = await fixture()
  try {
    const topicReview = { ...f.review('not_applicable'), paths: [],
      basis: 'The delivered migration lesson does not apply to this separate task.' }
    recordMemoryApplicationReview(f.db, f.identity, 'topic-review', topicReview)
    assert.equal(f.status().ready, true)
    await writeFile(join(f.root, 'check.mjs'), 'process.exit(0)')
    assert.equal(f.status().ready, true, 'an unrelated edit cannot stale a decision with no source dependency')
    recordMemoryApplicationReview(f.db, f.identity, 'source-review', {
      ...f.review('not_applicable'), expectedRevision: 1,
      basis: 'The current check.mjs has no migration assertion.' })
    await writeFile(join(f.root, 'check.mjs'), 'process.exit(1)')
    const changed = f.status()
    assert.ok(changed.supported)
    assert.equal(changed.items[0]?.problem, 'basis_changed', 'a source-backed decision still expires')
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'empty-adoption', {
      ...f.review(), expectedRevision: 2, paths: [] }), /path|Path|Array/u)
  } finally { await f.close() }
})

test('historical batch review storage stays atomic and exact-replay bound', async () => {
  const f = await fixture()
  try {
    const added = recordEntry(f.db, { workspace: f.task.workspace, kind: 'lesson', title: 'batch review',
      body: 'A distinct lesson for an independent review.', createdBy: 'fixture', scope: { visibility: 'project' } })
    await f.bindHistorical('batch review')
    const status = f.status()
    assert.ok(status.supported)
    assert.equal(status.items.length, 2)
    const original = { ...f.review('not_applicable'), generation: status.generation, paths: [] }
    const second = { generation: status.generation, entryId: added.id, entryRevision: added.revision,
      expectedRevision: 0, decision: 'not_applicable', basis: 'The second lesson is unrelated.', paths: [] }
    assert.throws(() => recordMemoryApplicationReviewBatch(f.db, f.identity, 'bad', [original, { ...second, entryRevision: 99 }]))
    const afterRejection = f.status()
    assert.ok(afterRejection.supported)
    assert.equal(afterRejection.items.every(item => item.decision === null), true, 'invalid batch must write no decisions')
    const result = recordMemoryApplicationReviewBatch(f.db, f.identity, 'batch', [original, second])
    const saved = f.status()
    assert.ok(saved.supported)
    assert.deepEqual(result, saved)
    assert.equal(saved.ready, true)
    assert.equal(saved.items.length, 2)
    assert.deepEqual(recordMemoryApplicationReviewBatch(f.db, f.identity, 'batch', [original, second]), saved)
    assert.throws(() => recordMemoryApplicationReviewBatch(f.db, f.identity, 'batch', [{ ...original, basis: 'changed' }, second]), /different input/)
  } finally { await f.close() }
})

test('superseded historical memory invalidates proof and re-review without vetoing native completion', async () => {
  const f = await fixture()
  try {
    recordMemoryApplicationReview(f.db, f.identity, 'review', f.review('not_applicable'))
    assert.equal(f.status().ready, true)
    const replacement = recordEntry(f.db, { workspace: f.task.workspace, kind: 'reference', title: 'Replacement evidence',
      body: 'The previous migration guidance is no longer applicable.', createdBy: 'fixture', scope: { visibility: 'project' } })
    f.db.prepare("UPDATE entries SET status='superseded',superseded_by=? WHERE id=?").run(replacement.id, f.memory.id)
    assert.equal(f.status().ready, false)
    assert.equal(f.status().pending[0]?.problem, 'entry_changed')
    beginMemoryExecution(f.db, f.identity, 'edit', null)
    completeMemoryExecution(f.db, f.identity, 'edit', { value: {} })
    assert.equal(f.status().ready, false, 'the effect runs while historical proof remains invalid')
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'retry', { ...f.review('not_applicable'), expectedRevision: 1 }), /Memory entry changed/)
    new LedgerStore(f.db).updateRunStatus(f.task.runId, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
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


// Real native tool dispatch plus a genuinely unresolved isolated memory binding.
for (const kind of ['direct', 'carrier', 'resumed'] as const) test(`host-only ${kind} preparation is not a memory execution`, async () => {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const { pathToFileURL } = await import('node:url')
  const [cordis, tools, prompt] = await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt'].map(name => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)))
  const { OnDemandIntake, TASK_PREPARE_TOOL } = await import('../../../src/dsh/on-demand-intake.js')
  const f = await fixture(), ctx = new cordis.Context()
  const sessionModule = kind === 'carrier' ? await import(pathToFileURL(join(packages, '@deepseek-ai', 'dsh-session', 'lib/index.js')).href) : undefined
  const session = sessionModule
    ? sessionModule.Session.create(sessionModule.SessionId('preparation-carrier'), [], { version: 4, id: 'preparation-carrier', createdAt: 1, isSeeded: false, cwd: f.root })
    : { id: 'session', header: { cwd: f.root }, snapshotEvents: () => [{ type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } }] }
  const agent: any = { id: 'preparation-agent', session }
  if (kind === 'carrier') agent.ctx = ctx
  let preparations = 0, effects = 0, ready = kind === 'resumed'
  const fibers: any[] = []
  fibers.push(await ctx.plugin(prompt.default, {}))
  if (kind === 'carrier') {
    for (const name of ['dsh-session-projection', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node'] as const) {
      const plugin = (await import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)).default
      const config = name === 'dsh-fs-local' ? { cwd: f.root } : name === 'dsh-working-directory' ? { defaultDirectory: f.root }
        : name === 'dsh-sandbox-policy' ? { mode: 'read-only', workspaceRoot: f.root } : name === 'dsh-ptc-runtime-node' ? { timeoutMs: 10000 } : {}
      fibers.push(await ctx.plugin(plugin, config))
    }
  }
  const fiber = ctx.plugin(tools.default, { mode: kind === 'carrier' ? 'ptc' : 'native' }); fibers.push(fiber); await fiber
  const intake = new OnDemandIntake({
    validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
    existing: async () => kind === 'resumed', classify: async () => ({ deferInference: true, ...(kind === 'resumed' ? { taskType: 'debug' as const } : {}) }),
    ...(kind === 'resumed' ? { interpret: async (input: any, task: string) => {
      const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(input.messages, task), activeGoal: { runId: f.task.runId, outOfScope: [], constraints: [] } })!
      return { context, decision: bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: 'change', changeScope: 'implementation', evidenceRefs: requestIntentReferenceIds(context) }, context)! }
    } } : {}),
    prepare: async () => { preparations++; ready = true; return true },
    ready: candidate => candidate === agent && ready,
  })
  const disposeMemory = mountMemoryApplication(ctx, { runtime: f.runtime as any,
    resolve: (execution: any) => execution.agent === agent ? f.identity : undefined,
    preparationOnly: execution => intake.preparationOnly(execution),
    refresh: async () => undefined,
  })
  intake.mount(ctx, ctx.tools)
  const releaseEffect = ctx.tools.register({ name: 'effect_probe', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => { effects++; return 'unexpected effect' } })
  let call = 0
  const invoke = (name: string, args: any = {}, overrides: any = {}) => ctx.tools.execute({ callId: `memory-preparation-${++call}`, name, arguments: args, agent, signal: new AbortController().signal, ...overrides })
  try {
    await intake.capture({ agent, turn: 1, step: 0, messages: [{ role: 'user', id: 'original', content: [{ type: 'text', text: 'Fix the migration expectations without unrelated edits.' }] }], signal: new AbortController().signal })
    assert.equal(f.status().ready, false)
    const name = kind === 'carrier' ? 'run_code' : TASK_PREPARE_TOOL
    const args = kind === 'carrier' ? { description: 'Prepare only', code: 'return await tools.prepare_requested_work({"taskType":"debug"})' } : { taskType: 'debug' }
    const call = (tool: string, input: any, overrides: any = {}) => kind === 'carrier' && tool !== 'run_code'
      ? invoke('run_code', { description: `Dispatch ${tool}`, code: `return await tools.${tool}(${JSON.stringify(input)})` }, overrides)
      : invoke(tool, input, overrides)
    const releaseDenial = ctx.tools.guard((execution: any) => execution.name === name ? 'native preparation denial' : undefined)
    try { assert.equal((await invoke(name, args)).isError, true); assert.equal(preparations, 0) } finally { releaseDenial() }
    const result = await invoke(name, args)
    assert.equal(result.isError, false, JSON.stringify(result))
    const preparation = kind === 'carrier' ? result.value.result : result.value
    assert.equal(preparation.prepared, true, 'host-only preparation must admit this exact request')
    assert.equal(preparation.permissions, 'unchanged_native_policy')
    assert.equal(preparations, kind === 'resumed' ? 0 : 1)
    assert.equal(f.status().ready, false, 'preparation must not resolve or bypass memory decisions')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_executions WHERE run_id=?').get(f.task.runId)?.n, 0, 'control preparation must not create an execution receipt')
    // The historical binding cannot reject native effects or completion.
    const effectResult = await call('effect_probe', {})
    assert.equal(effectResult.isError, false, JSON.stringify(effectResult))
    assert.equal(effects, 1)
    assert.equal(f.status().ready, false, 'historical memory remains unresolved advisory data')
    assert.equal((await invoke(name, args, { agent: { ...agent } })).isError, true, 'copied identity cannot borrow preparation proof')
    const statusResult = await call('task_memory_review', { action: 'status' })
    const status = kind === 'carrier' ? statusResult.value.result : statusResult.value
    assert.equal(status.ready, false)
    assert.equal((await call('task_memory_review', { action: 'review', review: f.review('not_applicable') })).isError, false)
    assert.equal((await call('effect_probe', {})).isError, false)
    assert.equal(effects, 2)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_memory_reviews').get()?.n, 0, 'native review is not a memory writer')
    await f.tasks.finish(f.task, 'completed')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'completed')
  } finally { await intake.dispose(); disposeMemory(); releaseEffect(); for (const mounted of fibers.reverse()) await mounted.dispose(); await f.close() }
})

test('a same-name preparation tool without host proof is tracked, not control-exempt', async () => {
  const f = await fixture(), listeners = new Map<string, any>()
  let effects = 0
  const dispose = mountMemoryApplication({ tools: { register: () => () => {} }, on(name, listener) { listeners.set(name, listener); return () => {} } }, {
    runtime: f.runtime as any, resolve: () => f.identity, refresh: async () => undefined,
  })
  try {
    const forged = { callId: 'forged-prepare', name: 'prepare_requested_work', arguments: { taskType: 'debug' }, signal: new AbortController().signal }
    await listeners.get('tools/pre-execute')(forged, async () => { effects++ })
    await listeners.get('tools/result')(forged, { value: {} })
    assert.equal(effects, 1, 'a forged preparation call is tracked, not control-exempt')
    assert.equal(f.status().ready, false, 'a forged preparation call cannot resolve memory decisions')
  } finally { dispose(); await f.close() }
})


test('memory proof binds the actual working directory and keeps legacy root reviews compatible', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'sub'))
    recordMemoryApplicationReview(f.db, f.identity, 'cwd-review', {...f.review(), cwd:'sub'})
    beginMemoryExecution(f.db, f.identity, 'wrong-directory', 'node check.mjs', f.root)
    completeMemoryExecution(f.db, f.identity, 'wrong-directory', {value:{exitCode:0}})
    assert.equal(f.status().ready, false)
    beginMemoryExecution(f.db, f.identity, 'correct-directory', 'node check.mjs', join(f.root,'sub'))
    completeMemoryExecution(f.db, f.identity, 'correct-directory', {value:{exitCode:0}})
    assert.equal(f.status().ready, true)
    f.reopen(); assert.equal(f.status().ready, true)
  } finally { await f.close() }
})
