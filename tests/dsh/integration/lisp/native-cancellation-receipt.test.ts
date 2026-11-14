/** Actual SBCL -> current native Bash -> process-range observer -> journal.
 * Host delivery is delayed/stripped; the existing journal recovery boundary
 * marks the pending operation unknown before its original receipt arrives. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openConnection } from '../../../../src/db/connection.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { OnDemandIntake } from '../../../../src/dsh/on-demand-intake.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../../../../src/dsh/lisp/coding-choice.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { executeNativeTool, mountNativeTools } from '../../helpers/native-tools.js'
import { mountTaskCompletion } from '../../../../src/dsh/task-completion-host.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
// New hosts must retain proof. Older supported hosts exercise the conservative fallback.
const supportsHostReceipts = typeof (await load('dsh-tools')).ToolExecutionError === 'function'
const cases = [false, true].flatMap(jobs => (supportsHostReceipts ? [true, false] : [false]).map(retained => ({
  jobs, retained, scenario: 'cancellation', title: `late native cancellation receipt: hostReceipt=${supportsHostReceipts}, jobs=${jobs}, retained=${retained}`,
})))
cases.push({ jobs: true, retained: false, scenario: 'workdir', title: 'missing native workdir never dispatches or blocks the next Lisp command' })
cases.push({ jobs: true, retained: false, scenario: 'prototype', title: 'human Lisp recovery reopens a failed protected prototype on the same task' })
cases.push({ jobs: true, retained: false, scenario: 'completion', title: 'Lisp native Bash verifies the bound command in a subdirectory' })
cases.push({ jobs: true, retained: false, scenario: 'foreground', title: 'Lisp command times out in foreground without registering a job or blocking later work' })
cases.push({ jobs: true, retained: false, scenario: 'reset', title: 'human reset restarts SBCL and preserves the exact session Lisp tool definitions' })
for (const { jobs, retained, scenario, title } of cases) test(title, { timeout: 30000 }, async () => {
  const [cordis, prompt, tools, scope, sessions] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-session'].map(load))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'native-receipt-'))), root = join(base, 'repo')
  await mkdir(root); execFileSync('git', ['init', '-q', root])
  const db = openConnection(join(base, 'state.sqlite3'))
  const session = sessions.Session.create('receipt-session', [], { version: 4, id: 'receipt-session', createdAt: 1, isSeeded: false, cwd: root })
  session.append('turn/start', { turn: 1 })
  const agent: any = { id: 'receipt-agent', session }, owner = { sessionId: session.id, agentId: agent.id, root }
  migrateDatabase(db)
  const runId = scenario === 'completion'
    ? (await prepareAgentTask(db, { requestId: 'lisp-completion', dshSessionId: session.id, cwd: root,
      task: 'Verify the fixture\n完了条件: Selected tests pass', completionMode: 'enforce',
      profileHints: { taskType: 'research', target: '.', expected: 'verification', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })).run.runId
    : workingLispTask(db, owner).taskId
  const runtime: any = { executionJournalDirectory: join(base, 'journal'), withDatabase: async (fn: any) => fn(db) }
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  let deliver!: (value: any) => void, release!: () => void
  const delivered = new Promise<any>(resolve => { deliver = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let local: any, surface: any, intake: OnDemandIntake | undefined, call = 0, bashCalls = 0, finalized: any
  const signal = new AbortController().signal
  const execute = (name: string, args: object) => executeNativeTool(ctx, packages, { name, arguments: args, agent, callId: 'receipt-'+(++call), signal })
  let evaluation: Promise<any> | undefined
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages, fibers)
    fibers.push(await ctx.plugin({ name: 'receipt-services', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      c.provide('sessions', { get: (id: string) => id === session.id ? session : undefined })
      c.provide('commands', { register: (d: any) => { commands.set(d.name, d); return () => commands.delete(d.name) } })
      c.provide('planMode', { get: () => ({ active: false }) })
    } }))
    for (const name of ['dsh-session-projection', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local', 'dsh-shell-env', 'dsh-bash-local']) {
      const config = name === 'dsh-fs-local' ? { cwd: root } : name === 'dsh-working-directory' ? { defaultDirectory: root }
        : name === 'dsh-bash-local' ? { timeoutMs: 10000, graceMs: 200 } : {}
      fibers.push(await ctx.plugin((await load(name)).default ?? await load(name), config))
    }
    if (jobs) fibers.push(await ctx.plugin((await load('dsh-jobs-local')).default, {}))
    fibers.push(await ctx.plugin(await load('dsh-tool-bash'), {}))
    if (scenario === 'foreground') fibers.push(await ctx.plugin(await load('dsh-tool-jobs'), {}))
    if (scenario === 'completion') {
      const unmount = mountTaskCompletion(ctx, { runtime,
        resolve: execution => execution.agent === agent
          ? { runId, sessionId: session.id, repositoryRoot: root, agent } : undefined,
        approve: async () => true })
      fibers.push({ dispose: unmount })
    }
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    const prepared = scenario === 'completion'
    intake = new OnDemandIntake({ validate: async () => {}, nativeOwnership: async () => prepared ? 'owned' : 'unowned',
      existing: async () => prepared, replay: async () => prepared, classify: async () => ({ deferInference: true }),
      prepare: async () => { throw new Error('no implicit preparation') }, ready: () => prepared })
    intake.mount(ctx, ctx.tools)
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL!, startupTimeoutMs: 60000 }))
    assert.equal((await commands.get('kioku-lisp').handler({ rawInput: 'enable', agent, signal })).kind, 'success')
    await intake.capture({ agent, turn: 1, step: 0, messages: [{ id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Verify this isolated fixture.' }] }], signal })
    assert.equal((await execute('lisp_eval', { operationId: 'warm', code: '(+ 20 22)' })).value.ok, true)
    if (scenario === 'reset') {
      const schemas = ctx.tools.schemas(agent).filter((s: any) => s.name.startsWith('lisp_'))
      const definitions = schemas.map((s: any) => ctx.tools.get(s.name, agent))
      const before = await surface.manager.status(owner)
      const journal = new ManagedOperationJournal(db)
      const scope = journal.createScope({ sessionId: session.id, parentId: 'lost-result', runtimeIdentity: 'sbcl:old' })
      const operation = journal.prepare(scope.scopeId, { route: 'native', kind: 'process', request: {} })
      journal.claim(operation.operationId); journal.recover(scope.scopeId)
      const originalDispose = surface.manager.disposeSession
      surface.manager.disposeSession = async () => { throw new Error('injected stop failure') }
      try {
        const rejected = await commands.get('kioku-lisp').handler({ rawInput: 'reset', agent, signal })
        assert.equal(rejected.kind, 'error')
        assert.equal(journal.readOperation(operation.operationId).state, 'unknown')
        schemas.forEach((s: any, index: number) => assert.equal(ctx.tools.get(s.name, agent), definitions[index]))
      } finally { surface.manager.disposeSession = originalDispose }
      const reset = await commands.get('kioku-lisp').handler({ rawInput: 'reset', agent, signal })
      assert.equal(reset.kind, 'success', reset.text)
      const after = await surface.manager.status(owner)
      assert.equal(after.state, 'READY'); assert.notEqual(after.generation, before.generation)
      assert.equal(after.managedReconciliationRequired, false)
      assert.equal(journal.readOperation(operation.operationId).state, 'abandoned')
      assert.deepEqual(ctx.tools.schemas(agent).filter((s: any) => s.name.startsWith('lisp_')), schemas)
      schemas.forEach((s: any, index: number) => assert.equal(ctx.tools.get(s.name, agent), definitions[index]))
      const next = await execute('lisp_eval', { operationId: 'after-reset', code: '(+ 40 2)' })
      assert.equal(next.value.ok, true, JSON.stringify(next))
      return
    }
    if (scenario === 'foreground') {
      let registered = 0
      const originalStart = ctx.jobs.start
      ctx.jobs.start = function (...args: any[]) { registered++; return originalStart.apply(this, args) }
      const script = "require('fs').appendFileSync('effects','x');console.log('partial test output');console.error('failed test');setInterval(()=>{},1000)"
      const result = await execute('lisp_eval', { operationId: 'foreground-timeout',
        code: `(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" ${JSON.stringify(script)}) :timeout-ms 500)` })
      assert.equal(result.value.ok, true, JSON.stringify(result))
      const value = result.value.value.json
      assert.equal(value.timedOut, true)
      assert.equal(registered, 0, 'synchronous Lisp must never enter the jobs registry')
      assert.match(value.stdout, /partial test output/)
      assert.match(value.stderr, /failed test/)
      assert.equal(value.receipt.processStopped, true)
      assert.equal(value.receipt.cancelled, true)
      assert.equal(db.prepare('SELECT state FROM dsh_managed_operations').get<any>()?.state, 'cancelled-confirmed')
      assert.equal((await surface.manager.status(owner)).managedReconciliationRequired, false)
      const next = await execute('lisp_eval', { operationId: 'after-timeout',
        code: `(kioku.process:run ${JSON.stringify(process.execPath)} '("--version"))` })
      assert.equal(next.value.value.json.code, 0, JSON.stringify(next))
      assert.equal(next.value.generation, result.value.generation)
      assert.equal(await readFile(join(root, 'effects'), 'utf8'), 'x', 'the timed out command is never replayed')
      return
    }
    if (scenario === 'completion') {
      await mkdir(join(root, 'selected'))
      await writeFile(join(root, 'selected', 'check.test.mjs'), "import test from 'node:test'; test('selected case', () => {});\n")
      const status = async () => {
        const result = await execute('task_completion', { action: 'status' })
        assert.equal(result.isError, false, JSON.stringify(result))
        return result.value
      }
      const bind = async (command: string, source = 'check.test.mjs') => {
        const result = await execute('task_completion', { action: 'bind', criterionId: (await status()).criteria[0].criterionId,
          method: { kind: 'native_command', command, cwd: 'selected', sourcePaths: [`selected/${source}`], assertion: 'selected_tests_pass' } })
        assert.equal(result.value?.approved, true, JSON.stringify(result))
      }
      const run = async (operationId: string, code: string) => {
        const result = await execute('lisp_eval', { operationId, code })
        assert.equal(result.value?.value?.json?.code, 0, JSON.stringify(result))
        assert.equal(result.value.value.json.receipt.route, 'native')
      }
      const nodeCommand = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap check.test.mjs'
      const nodeEval = '(kioku.process:run "env" (list "-u" "NODE_TEST_CONTEXT" "node" "--test" "--test-reporter=tap" "check.test.mjs") :directory "selected")'
      assert.match(JSON.stringify(await execute('bash', { command: nodeCommand, workdir: 'selected' })), /LISP_ROUTE_REQUIRED/u)
      await bind(`${nodeCommand} && true`)
      await run('different-command', nodeEval)
      assert.equal((await status()).criteria[0].reason, 'command_not_observed')
      await bind(nodeCommand)
      await run('bound-command', nodeEval)
      assert.equal((await status()).criteria[0].state, 'satisfied', JSON.stringify(await status()))
      await writeFile(join(root, 'selected', 'check.test.mjs'), '// source changed\n')
      assert.equal((await status()).criteria[0].state, 'stale')

      if (process.env.KIOKUKO_DSH_RUNTIME_MODE !== 'historical') {
        const cli = await realpath(join(packages, '@deepseek-ai/dsh'))
        await symlink(join(cli, '../../node_modules'), join(root, 'selected/node_modules'), 'dir')
        const file = 'vitest.spec.mjs'
        await writeFile(join(root, 'selected', file),
          "import { describe, test, expect } from 'vitest'; describe('suite', () => test('observed case', () => expect(42).toBe(42)));\n")
        await bind('npx --no-install vitest run --reporter=tap vitest.spec.mjs', file)
        await run('bound-vitest-tap', '(kioku.process:run "npx" (list "--no-install" "vitest" "run" "--reporter=tap" "vitest.spec.mjs") :directory "selected")')
        assert.equal((await status()).criteria[0].state, 'satisfied', JSON.stringify(await status()))
        await bind('./node_modules/.bin/vitest run --reporter=json --includeTaskLocation vitest.spec.mjs', file)
        await run('bound-vitest-json', '(kioku.test:vitest "vitest.spec.mjs" :directory "selected")')
        assert.equal((await status()).criteria[0].state, 'satisfied', JSON.stringify(await status()))
      }
      return
    }
    if (scenario === 'workdir') {
      const command = `(kioku.process:run ${JSON.stringify(process.execPath)} '("--version")`
      const missing = await execute('lisp_eval', { operationId: 'missing', code: `${command} :directory "missing-dir")` })
      assert.equal(missing.value.ok, false)
      assert.match(missing.value.value, /作業ディレクトリ/u)
      assert.equal(db.prepare('SELECT state FROM dsh_managed_operations').get<{state:string}>()?.state, 'denied')
      const next = await execute('lisp_eval', { operationId: 'corrected', code: `${command})` })
      assert.equal(next.value.value.json.code, 0, JSON.stringify(next))
      assert.equal(next.value.generation, missing.value.generation)
      return
    }
    if (scenario === 'prototype') {
      const coding = ctx.get(LISP_CODING_SERVICE) as LispCodingService
      coding.answered!(agent, 'Implement the fixture', 'yes', 'human:choice', 'fixture:1')
      const evaluate = (operationId:string, code:string, inputs: string[] = []) => execute('lisp_eval', {operationId, code, inputs, prototype:true})
      assert.match((await evaluate('bad-prototype', '(error "bad prototype")')).value.value, /bad prototype/u)
      const crashed = await evaluate('crash', '(sb-ext:exit :code 1)')
      assert.equal(crashed.value.code, 'WORKER_EXITED')
      assert.match(JSON.stringify(await evaluate('blocked', '42')), /LISP_PROTOTYPE_FAILED/u)
      const recovery = await commands.get('kioku-lisp').handler({rawInput:'recover', agent, signal})
      assert.equal(recovery.kind, 'success', recovery.text)
      await writeFile(join(root, 'first.txt'), '40')
      await writeFile(join(root, 'second.txt'), '2')
      const fresh = await evaluate('fresh', '(loop for i below 2 sum (parse-integer (kioku.files:read-text (kioku.files:input i))))', ['first.txt', 'second.txt'])
      assert.equal(fresh.value?.value?.json, 42, JSON.stringify(fresh))
      assert.notEqual(fresh.value.generation, crashed.value.generation)
      const saved = await execute('lisp_inspect', { operationId: 'inspect-fresh', resultOperationId: fresh.value.operationId, section: 'result' })
      assert.equal(saved.value.state, 'SUCCEEDED')
      assert.equal((await execute('lisp_status', {})).value.codingPreparation.verified, true)
      return
    }
    const resultObserver = ctx.on('tools/result', (e: any, result: any) => { if (e.name === 'bash') finalized = { code: result.error?.info?.code, meta: result.meta, content: result.content } }, { global: true })
    const dispose = ctx.on('tools/execute', async (e: any, next: () => Promise<any>) => {
      const result = await next()
      if (e.name !== 'bash') return result
      bashCalls++
      if (result.isError) {
        deliver({ execution: e, result })
        let timer: ReturnType<typeof setTimeout>
        try { await Promise.race([released, new Promise((_yes, no) => { timer = setTimeout(() => no(new Error('bounded receipt gate expired')), 5000) })]) }
        finally { clearTimeout(timer!) }
        return retained ? result : { ...result, meta: undefined }
      }
      return result
    }, { global: true })
    try {
      evaluation = execute('lisp_eval', { operationId: 'timeout', timeoutMs: 1000,
        code: `(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" "require('fs').appendFileSync('effects','x');setInterval(()=>{},1000)") :timeout-ms 10000)` })
      // The outer Lisp deadline can finish before the native range observer.
      // Observe the evaluation immediately, but give late host delivery its own bound.
      const outcome = evaluation.then(result => result)
      let receiptTimer: ReturnType<typeof setTimeout>
      const observed = await Promise.race([delivered,
        new Promise<never>((_yes, no) => { receiptTimer = setTimeout(() => no(new Error('host cancellation receipt not delivered within 5s')), 5000) }),
      ]).finally(() => clearTimeout(receiptTimer!))
      assert.equal(observed.result.isError, true); assert.equal(observed.result.error.info.code, 'ABORTED')
      assert.equal(observed.execution.rootCallId, 'receipt-'+call)
      assert.equal(observed.result.meta?.termination !== undefined, supportsHostReceipts, 'the selected host capability must agree with actual emitted proof')
      const pending = db.prepare("SELECT scope_id,state FROM dsh_managed_operations").get<any>()!
      assert.equal(pending.state, 'dispatching', 'undelivered host evidence cannot settle the journal')
      new ManagedOperationJournal(db).recover(pending.scope_id)
      const interim = await surface.manager.status(owner)
      assert.equal(interim.managedReconciliationRequired, true, 'a receipt not yet delivered cannot clear the pending native operation')
      assert.equal(db.prepare("SELECT count(*) n FROM dsh_managed_operations WHERE state='unknown'").get<any>()!.n, 1)
      release()
      const result = await outcome
      assert.equal(result.value.ok, false, 'timeout never becomes evaluation success')
      assert.equal(result.value.code, 'TIMEOUT')
      // Delivery and journal persistence complete independently of the Lisp reply.
      const until = Date.now()+5000
      let status: any
      do { status = await surface.manager.status(owner); if (retained ? !status.managedReconciliationRequired : status.managedReconciliationRequired) break; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now()<until)
      const row = db.prepare("SELECT state,operation_json FROM dsh_managed_operations").get<any>()!
      const operation = JSON.parse(row.operation_json)
      assert.equal(row.state, retained ? 'cancelled-confirmed' : 'unknown', JSON.stringify({ finalized, originalRef: operation.originalRef, receiptRef: operation.receiptRef, deliveredIdentity: observed.result.meta?.termination }))
      assert.equal(operation.originalRef, observed.execution.callId)
      assert.equal(await readFile(join(root, 'effects'), 'utf8'), 'x', 'earlier effects remain and no command is replayed')
      assert.equal(bashCalls, 1)
      assert.equal(status.managedReconciliationRequired, !retained)
      if (!retained) {
        const proof = await execute('lisp_inspect', { operationId: 'inspect-managed', managedOperationId: operation.operationId })
        assert.equal(proof.value.state, 'unknown', JSON.stringify(proof))
        assert.equal(proof.value.originalRef, observed.execution.callId)
        const mixed = await execute('lisp_inspect', { operationId: 'inspect-mixed', managedOperationId: operation.operationId, resultOperationId: result.value.operationId })
        assert.equal(mixed.value?.code ?? mixed.error?.code, 'INVALID_INSPECTION', JSON.stringify(mixed))
        const denied = await execute('lisp_recover', { operationId: 'recover-without-receipt', expectedGeneration: status.generation })
        assert.equal(denied.value.code, 'RECONCILIATION_REQUIRED', JSON.stringify(denied))
        assert.equal(denied.value.nextInspection.managedOperationId, operation.operationId)
        assert.equal((await surface.manager.status(owner) as any).generation, status.generation)
      }
      const recovered = await commands.get('kioku-lisp').handler({ rawInput: 'recover', agent, signal })
      assert.equal(recovered.kind, 'success')
      if (retained) {
        assert.equal((await surface.manager.status(owner) as any).state, 'READY')
        const next = await execute('lisp_eval', { operationId: 'fresh-after-human-recovery', code: '(+ 40 2)' })
        assert.equal(next.value.ok, true, JSON.stringify(next))
        assert.equal(next.value.value.printed, '(42)')
      } else {
        assert.equal(JSON.parse(recovered.text).code, 'RECONCILIATION_REQUIRED')
        assert.equal((await surface.manager.status(owner) as any).managedReconciliationRequired, true)
      }
      assert.equal(await readFile(join(root, 'effects'), 'utf8'), 'x', 'explicit recovery never replays the interrupted command')
    } finally { release(); dispose(); resultObserver() }
  } finally {
    release(); await evaluation?.catch(() => {})
    await intake?.dispose(); surface?.stop(); await surface?.dispose(); await local?.dispose()
    for (const f of fibers.reverse()) await f.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
