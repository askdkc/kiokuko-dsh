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
import { AutoGlobalizationWorker, autoGlobalizationStatus, autoGlobalApplicable } from '../../../src/memory/auto-globalization.js'
import { readEntry } from '../../../src/memory/entries.js'
import { recordContextFeedback } from '../../../src/context/feedback.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'

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
async function fixture(taskType: 'build' | 'review' = 'build', automatic = false) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-application-')), root = realpathSync(join(directory))
  await mkdir(join(root, '.git')); await mkdir(join(root, 'migrations'))
  await writeFile(join(root, 'migrations', '001.sql'), 'SELECT 1;')
  if (automatic) await writeFile(join(root, 'package.json'), '{"name":"memory-fixture","private":true}')
  await writeFile(join(root, 'check.mjs'), 'import assert from "node:assert/strict"; import { readdirSync } from "node:fs"; assert.deepEqual(readdirSync("migrations"), ["001.sql"]);')
  let db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const project = (await resolveProjectWorkspace(db, root))!
  const memory = recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'migration expectations', body: 'Derive current migration expectations from the bundled migrations, including the next migration. Fixed historical schema fixtures may use fixed versions.', createdBy: 'fixture', scope: { visibility: 'project', ...(automatic ? { applicability: { languages: ['JavaScript'] } } : {}) } })
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
    assert.equal(tools[0].parameters.type, 'object', 'model provider requires an object-root tool schema')
    assert.deepEqual(tools[0].parameters.required, ['action'])
    assert.deepEqual(tools[0].parameters.properties.action.enum, ['status', 'review', 'review_batch', 'refresh'])
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

test('three completed native and Enno applications create one source-verified Global and a fourth remains idempotent', async () => {
  const f = await fixture('build', true)
  const worker = new AutoGlobalizationWorker(f.runtime as any, true)
  const concurrentWorker = new AutoGlobalizationWorker(f.runtime as any, true)
  const disabledWorker = new AutoGlobalizationWorker(f.runtime as any, false)
  try {
    for (let number = 1; number <= 4; number++) {
      const task = number === 1 ? f.task : await f.tasks.prepare({
        requestId: `request-${number}`, sessionId: 'session', turn: number,
        task: 'migration expectations code', cwd: f.root, capabilities,
        profileHints: { taskType: 'build', target: 'migration code tests', expected: 'Handle the next migration', constraints: 'Preserve past schemas' },
        signal: new AbortController().signal,
      })
      const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: f.root }
      const status = memoryApplicationStatus(f.db, task.runId)
      assert.equal(status.supported, true)
      assert.equal(status.items.length, 1)
      const review = { generation: status.generation, entryId: f.memory.id, entryRevision: f.memory.revision,
        expectedRevision: 0, decision: 'adopted' as const, basis: 'Current migration fixture is checked.',
        paths: ['check.mjs', 'migrations'], invariant: 'Migration expectations follow bundled files.',
        counterexample: 'A fixed list misses new migration files.', method: 'Run the repository check.',
        command: number === 2 ? `${process.execPath} check.mjs` : 'node check.mjs' }
      recordMemoryApplicationReview(f.db, identity, `review-${number}`, review)
      if (number === 2) {
        const spec = { id:'regression', kind:'test' as const, executable:process.execPath,
          args:['check.mjs'], cwd:'.', timeoutMs:5000 }
        assert.equal((await runMemoryAwareVerifiers(f.db, task.runId, [spec], f.root, {descendantSettleMs:0}))[0]?.status, 'passed')
      } else {
        beginMemoryExecution(f.db, identity, `verify-${number}`, 'node check.mjs')
        const result = spawnSync(process.execPath, ['check.mjs'], { cwd: f.root, encoding: 'utf8' })
        assert.equal(result.status, 0)
        completeMemoryExecution(f.db, identity, `verify-${number}`, { value: { exitCode: result.status } })
      }
      await f.tasks.finish(task, 'completed')
      if (number === 1) {
        const before = f.db.prepare('SELECT completed_at,receipt_digest FROM auto_global_application_receipts WHERE entry_id=? AND run_id=?')
          .get<{completed_at:string;receipt_digest:string}>(f.memory.id,task.runId)
        new LedgerStore(f.db).updateRunStatus(task.runId,'completed','2099-01-01T00:00:00.000Z')
        assert.deepEqual(f.db.prepare('SELECT completed_at,receipt_digest FROM auto_global_application_receipts WHERE entry_id=? AND run_id=?')
          .get(f.memory.id,task.runId),before,'repeated completion cannot rewrite immutable proof')
      }
      if (number === 3) {
        f.db.exec("CREATE TRIGGER abort_auto_mapping BEFORE INSERT ON auto_global_projections BEGIN SELECT RAISE(ABORT,'injected projection failure'); END")
        worker.kick()
        await assert.rejects(worker.whenIdle(), /injected projection failure/)
        assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE workspace='global'")
          .get<{count:number}>()!.count,0,'projection failure rolls back the generated entry')
        assert.equal(f.db.prepare('SELECT state FROM auto_global_queue WHERE entry_id=? AND entry_revision=?')
          .get<{state:string}>(f.memory.id,f.memory.revision)?.state,'pending')
        f.db.exec('DROP TRIGGER abort_auto_mapping')
      }
      worker.kick()
      if (number === 3) concurrentWorker.kick()
      await Promise.all([worker.whenIdle(),concurrentWorker.whenIdle()])
      const auto = autoGlobalizationStatus(f.db, f.memory.id, f.memory.revision)
      assert.equal('successfulRuns' in auto && auto.successfulRuns, number)
      const projections = f.db.prepare('SELECT global_entry_id FROM auto_global_projections WHERE entry_id=?').all<{global_entry_id:string}>(f.memory.id)
      assert.equal(projections.length, number < 3 ? 0 : 1)
      if (number >= 3) {
        const global = readEntry(f.db, { workspace: 'global', entryId: projections[0]!.global_entry_id })
        assert.equal(global.trustLevel, 'source_verified')
        assert.equal(global.provenance.type, 'auto_curator_globalize')
        assert.equal(autoGlobalApplicable(f.db, global, JSON.parse(f.db.prepare('SELECT fingerprint_json FROM task_memory_bindings WHERE run_id=?').get<{fingerprint_json:string}>(task.runId)!.fingerprint_json)), true)
      }
    }
    const projectionId = f.db.prepare('SELECT global_entry_id FROM auto_global_projections WHERE entry_id=?')
      .get<{global_entry_id:string}>(f.memory.id)!.global_entry_id
    const global = readEntry(f.db, { workspace: 'global', entryId: projectionId })
    const accepted = JSON.parse(f.db.prepare('SELECT fingerprint_json FROM task_memory_bindings WHERE run_id=?')
      .get<{fingerprint_json:string}>(f.task.runId)!.fingerprint_json)
    assert.equal(autoGlobalApplicable(f.db, global, {...accepted, languages:['Python']}), false, JSON.stringify({source:f.memory.scope, global:global.scope}))
    assert.equal(autoGlobalApplicable(f.db, global), false)
    const nextRoot = realpathSync(await mkdtemp(join(tmpdir(),'auto-global-next-')))
    try {
      await mkdir(join(nextRoot,'.git'))
      await writeFile(join(nextRoot,'package.json'),'{"name":"other-javascript-project","private":true}')
      await resolveProjectWorkspace(f.db,nextRoot)
      const next = await f.tasks.prepare({requestId:'other-project-request',sessionId:'other-session',turn:1,
        task:'migration expectations code',cwd:nextRoot,capabilities,
        profileHints:{taskType:'build',target:'migration code tests',expected:'Handle migration expectations',constraints:'Preserve tests'},
        signal:new AbortController().signal})
      const preview = await queryScopedContextGated(f.db,{project:next.context!.project!,
        task:'migration expectations code',taskProfile:next.profile,runId:next.runId,
        limit:5,characterBudget:4000},candidate => ({persist:false,value:candidate}))
      assert.equal((preview.value as NonNullable<typeof next.context>).items.some(item => item.entryId === global.id),true,
        'the normal DSH scoped selection can deliver the generated Global to a matching next request')
      await f.tasks.finish(next,'interrupted')
    } finally { await rm(nextRoot,{recursive:true,force:true}) }
    updateCandidateEntry(f.db, { workspace:f.memory.workspace, entryId:f.memory.id, expectedRevision:1,
      kind:f.memory.kind, title:f.memory.title, body:`${f.memory.body} Revised.`,
      scope:f.memory.scope, actor:'fixture' })
    assert.equal(autoGlobalApplicable(f.db, global, accepted), false, 'stale selections are blocked before worker runs')
    worker.kick(); await worker.whenIdle()
    assert.equal(f.db.prepare('SELECT state FROM auto_global_projections WHERE global_entry_id=?')
      .get<{state:string}>(projectionId)?.state, 'quarantined')
    let latestDelivery = ''
    let latestRun = ''
    for (let number = 5; number <= 7; number++) {
      const task = await f.tasks.prepare({requestId:`request-${number}`,sessionId:'session',turn:number,
        task:'migration expectations code',cwd:f.root,capabilities,
        profileHints:{taskType:'build',target:'migration code tests',expected:'Handle the next migration',constraints:'Preserve past schemas'},
        signal:new AbortController().signal})
      const status = memoryApplicationStatus(f.db,task.runId)
      assert.equal(status.supported,true); assert.equal(status.items.length,1)
      assert.equal(status.items[0]?.revision,2)
      assert.ok(status.deliveryId)
      latestDelivery = status.deliveryId; latestRun = task.runId
      const identity = {runId:task.runId,workspace:task.workspace,sessionId:task.sessionId,repositoryRoot:f.root}
      recordMemoryApplicationReview(f.db,identity,`review-${number}`,{generation:status.generation,
        entryId:f.memory.id,entryRevision:2,expectedRevision:0,decision:'adopted',
        basis:'Current migration fixture is checked.',paths:['check.mjs','migrations'],
        invariant:'Migration expectations follow bundled files.',counterexample:'A fixed list misses new files.',
        method:'Run the repository check.',command:'node check.mjs'})
      beginMemoryExecution(f.db,identity,`verify-${number}`,'node check.mjs')
      const result = spawnSync(process.execPath,['check.mjs'],{cwd:f.root,encoding:'utf8'})
      assert.equal(result.status,0)
      completeMemoryExecution(f.db,identity,`verify-${number}`,{value:{exitCode:0}})
      await f.tasks.finish(task,'completed'); disabledWorker.kick(); await disabledWorker.whenIdle()
      const newProjection = f.db.prepare('SELECT global_entry_id FROM auto_global_projections WHERE entry_id=? AND entry_revision=2')
        .get<{global_entry_id:string}>(f.memory.id)
      assert.equal(!!newProjection,false,'disabled configuration cannot create a projection')
    }
    assert.equal(autoGlobalizationStatus(f.db,f.memory.id,2).successfulRuns,3)
    worker.kick(); await worker.whenIdle()
    const replacementId = f.db.prepare('SELECT global_entry_id FROM auto_global_projections WHERE entry_id=? AND entry_revision=2')
      .get<{global_entry_id:string}>(f.memory.id)!.global_entry_id
    assert.equal(f.db.prepare('SELECT state FROM auto_global_projections WHERE global_entry_id=?')
      .get<{state:string}>(projectionId)?.state,'replaced')
    const replacement = readEntry(f.db,{workspace:'global',entryId:replacementId})
    assert.equal(autoGlobalApplicable(f.db,replacement,accepted),true)
    let command: any
    const unmount = mountMemoryApplication({tools:{register:() => () => {}},on:() => () => {},
      commands:{register:(definition:any) => {command=definition; return () => {}}}} as any,
    {runtime:f.runtime as any,resolve:() => undefined,
      session:() => ({sessionId:'session',repositoryRoot:f.root}),refresh:async () => undefined})
    try {
      const reported = await command.handler({rawInput:'status --json',agent:{},signal:new AbortController().signal})
      const status = JSON.parse(reported.text)
      assert.equal(status.globalization[0].successfulRuns,3)
      assert.equal(status.globalization[0].globalEntryId,replacementId)
    } finally { unmount() }
    recordContextFeedback(f.db,{workspace:f.memory.workspace,feedbackId:'negative-auto-global',
      deliveryId:latestDelivery,entryId:f.memory.id,entryRevision:2,runId:latestRun,
      verdict:'conflicting',actor:'fixture',idempotencyKey:'negative-auto-global',createdAt:new Date().toISOString()})
    assert.equal(autoGlobalApplicable(f.db,replacement,accepted),false,'negative feedback blocks stale selections immediately')
    worker.kick(); await worker.whenIdle()
    assert.equal(f.db.prepare('SELECT state FROM auto_global_projections WHERE global_entry_id=?')
      .get<{state:string}>(replacementId)?.state,'quarantined')
  } finally { await disabledWorker.dispose(); await concurrentWorker.dispose(); await worker.dispose(); await f.close() }
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

test('reviews bind revisions, reject conflicting retry and foreign identities, and refresh retains unchanged decisions', async () => {
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
    await f.tasks.refresh(f.task, 'unrelated-query-that-matches-nothing', new AbortController().signal)
    const refreshed = f.status()
    assert.ok(refreshed.supported)
    assert.equal(refreshed.generation, generation)
    assert.equal(refreshed.ready, true)
    assert.equal(refreshed.items[0]?.decision, 'not_applicable')
    assert.throws(() => recordMemoryApplicationReview(f.db, f.identity, 'stale', review), /revision changed/)
    updateCandidateEntry(f.db, { workspace: f.task.workspace, entryId: f.memory.id, expectedRevision: 1, kind: f.memory.kind, title: f.memory.title, body: 'migration expectations updated', actor: 'fixture' })
    assert.equal(f.status().ready, false)
    await f.tasks.refresh(f.task, 'migration expectations updated', new AbortController().signal)
    const revised = f.status()
    assert.ok(revised.supported)
    assert.equal(revised.generation, generation + 1)
    assert.equal(revised.items[0]?.problem, 'decision_missing')
    await f.tasks.finish(f.task, 'cancelled')
    assert.equal(new LedgerStore(f.db).readRun(f.task.runId)?.status, 'cancelled')
  } finally { await f.close() }
})

test('refresh reviews only new entries while invalidating prior execution proof', async () => {
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
    await f.tasks.refresh(f.task, 'batching signal', new AbortController().signal)
    const refreshed = f.status()
    assert.ok(refreshed.supported)
    assert.equal(refreshed.generation, generation)
    assert.equal(refreshed.items.find(item => item.entryId === f.memory.id)?.decision, 'adopted')
    assert.equal(refreshed.items.find(item => item.entryId === f.memory.id)?.problem, 'verification_missing_failed_or_stale')
    assert.equal(refreshed.items.find(item => item.entryId === added.id)?.problem, 'decision_missing')
    assert.throws(() => beginMemoryExecution(f.db, f.identity, 'blocked', null), /resolve memory decisions/)
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

test('native batch reviews multiple memories atomically with exact replay', async () => {
  const f = await fixture(), tools: any[] = [], agent = {}
  const dispose = mountMemoryApplication({ tools: { register(tool) { tools.push(tool); return () => {} } }, on() { return () => {} } }, {
    runtime: f.runtime as any, resolve: execution => execution.agent === agent ? f.identity : undefined,
    refresh: async () => undefined,
  })
  try {
    const added = recordEntry(f.db, { workspace: f.task.workspace, kind: 'lesson', title: 'batch review',
      body: 'A distinct lesson for an independent review.', createdBy: 'fixture', scope: { visibility: 'project' } })
    await f.tasks.refresh(f.task, 'batch review', new AbortController().signal)
    const status = f.status()
    assert.ok(status.supported)
    assert.equal(status.items.length, 2)
    const original = { ...f.review('not_applicable'), generation: status.generation, paths: [] }
    const second = { generation: status.generation, entryId: added.id, entryRevision: added.revision,
      expectedRevision: 0, decision: 'not_applicable', basis: 'The second lesson is unrelated.', paths: [] }
    const execution = (callId: string) => ({ callId, name: 'task_memory_review', agent, signal: new AbortController().signal })
    await assert.rejects(tools[0].execute({ action: 'review_batch', reviews: [original, { ...second, entryRevision: 99 }] }, execution('bad')))
    const afterRejection = f.status()
    assert.ok(afterRejection.supported)
    assert.equal(afterRejection.items.every(item => item.decision === null), true, 'invalid batch must write no decisions')
    const result = await tools[0].execute({ action: 'review_batch', reviews: [original, second] }, execution('batch'))
    assert.equal(result.ready, true)
    assert.equal(result.items.length, 2)
    assert.equal((await tools[0].execute({ action: 'review_batch', reviews: [original, second] }, execution('batch'))).ready, true)
    await assert.rejects(tools[0].execute({ action: 'review_batch', reviews: [{ ...original, basis: 'changed' }, second] }, execution('batch')), /different input/)
  } finally { dispose(); await f.close() }
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
