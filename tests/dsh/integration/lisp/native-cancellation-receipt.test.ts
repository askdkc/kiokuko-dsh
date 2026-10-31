/** Actual SBCL -> current native Bash -> process-range observer -> journal.
 * Host delivery is delayed/stripped; the existing journal recovery boundary
 * marks the pending operation unknown before its original receipt arrives. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openConnection } from '../../../../src/db/connection.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { OnDemandIntake } from '../../../../src/dsh/on-demand-intake.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { executeNativeTool, mountNativeTools } from '../../helpers/native-tools.js'
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
// New hosts must retain proof. Older supported hosts exercise the conservative fallback.
const supportsHostReceipts = typeof (await load('dsh-tools')).ToolExecutionError === 'function'
for (const jobs of [false, true]) for (const retained of supportsHostReceipts ? [true, false] : [false]) test(`late native cancellation receipt: hostReceipt=${supportsHostReceipts}, jobs=${jobs}, retained=${retained}`, { timeout: 30000 }, async () => {
  const [cordis, prompt, tools, scope, sessions] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-session'].map(load))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'native-receipt-'))), root = join(base, 'repo')
  await mkdir(root); execFileSync('git', ['init', '-q', root])
  const db = openConnection(join(base, 'state.sqlite3'))
  const session = sessions.Session.create('receipt-session', [], { version: 4, id: 'receipt-session', createdAt: 1, isSeeded: false, cwd: root })
  session.append('turn/start', { turn: 1 })
  const agent: any = { id: 'receipt-agent', session }, owner = { sessionId: session.id, agentId: agent.id, root }
  workingLispTask(db, owner)
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
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    intake = new OnDemandIntake({ validate: async () => {}, nativeOwnership: async () => 'unowned', existing: async () => false,
      classify: async () => ({ deferInference: true }), prepare: async () => { throw new Error('no implicit preparation') }, ready: () => false })
    intake.mount(ctx, ctx.tools)
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL!, startupTimeoutMs: 60000 }))
    assert.equal((await commands.get('kioku-lisp').handler({ rawInput: 'enable', agent, signal })).kind, 'success')
    await intake.capture({ agent, turn: 1, step: 0, messages: [{ id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Verify this isolated fixture.' }] }], signal })
    assert.equal((await execute('lisp_eval', { operationId: 'warm', code: '(+ 20 22)' })).value.ok, true)
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
