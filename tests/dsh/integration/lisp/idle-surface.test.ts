import { workingLispTask } from '../../helpers/lisp-task.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LispError } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'

for (const hostFences of [false,true]) test(`native lifecycle hooks (${hostFences ? 'host fence' : 'root fence'}) retain the session heap across idle and reopening`, {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-idle-surface-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  workingLispTask(db, { sessionId: 'one', agentId: 'one', root: base })
  const listeners = new Map<string, (...args: any[]) => any>(), definitions = new Map<string, any>(), sections = new Map<string, string>()
  let command: any, guard: any, registrations = 0
  const tools = { guard(fn: any) { guard = fn; return () => {} }, presentAs: () => () => {}, restrict: () => () => {},
    register(d: any) { registrations++; definitions.set(d.name, d); return () => definitions.delete(d.name) }, get: (name: string) => definitions.get(name) }
  const local = { get: (name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? {
    section(d: any) { sections.set(d.name, d.text); return () => sections.delete(d.name) },
  } : undefined }
  let agent: any = { id: 'one', status: 'idle', session: { id: 'one', header: { cwd: base } }, ctx: local }
  let currentAgent: any = agent, currentSession: any = agent.session
  const services: Record<string, any> = { tools, agents: { get: (id: string) => id === currentAgent?.id ? currentAgent : undefined },
    sessions: { get: (id: string) => id === currentSession?.id ? currentSession : undefined }, commands: { register(d: any) { command = d; return () => {} } } }
  if (hostFences) services.executionFences = { attach(options: any) { guard = options.check; listeners.set('agent/pre-step', async (payload: any, next: any) => await options.beforeStep(payload.agent) ? next() : {kind:'reject'}); return {protect() {}, release() {}} } }
  let approvalMode = 'ask'
  services.settings = { writable: true, installSection(_ctx: any, _ns: string, _schema: any, _base: any, hooks: any) { hooks.setSource(() => ({approvalMode})) }, async update(_ns: string, patch: any) { approvalMode = patch.approvalMode } }
  const ctx: any = { inject(_names: string[], callback: any) { callback(ctx) }, get: (name: string) => services[name], provide: () => () => {},
    on(name: string, fn: any) { listeners.set(name, fn); return () => listeners.delete(name) } }
  ctx.root = ctx
  const runtime: any = { withDatabase: async (fn: any) => fn(db) }
  const surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode: 'protected', enabled: true, idleTimeoutMs: 1000, startupTimeoutMs: 60000 }))
  const owner = { sessionId: 'one', agentId: 'one', root: base }
  const state = async () => await surface.manager.status(owner) as any
  const step = () => listeners.get('agent/pre-step')!({ agent }, () => 'model-ready')
  try {
    assert.equal((await command.handler({ rawInput: 'enable', agent, signal: new AbortController().signal })).kind, 'success')
    const firstGeneration = (await state()).generation
    const firstPid = (await state()).runtimePid
    const failedStartup = t.mock.method(surface.manager, 'prepare', async () => {
      throw new LispError('STARTUP_FAILED', 'injected worker startup failure')
    })
    try {
      assert.equal(await step(), 'model-ready', 'the model can diagnose a failed worker')
      assert.match(guard({ agent, name: 'lisp_eval' }), /RECOVERY_REQUIRED/u)
      assert.equal(guard({ agent, name: 'lisp_status' }), undefined)
      assert.match(guard({ agent, name: 'bash' }), /Lisp/u)
    } finally { failedStartup.mock.restore() }
    assert.equal(await step(), 'model-ready')
    await surface.manager.execute(owner, 'lisp_eval', {operationId:'session-definition',code:'(defparameter *session-value* 42)'})
    await listeners.get('agent/status')!({ agent, status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal((await state()).state, 'READY')
    await listeners.get('agent/status')!({ agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal((await state()).state, 'READY')
    assert.equal((await state()).runtimePid, firstPid)
    assert.match(guard({ agent, name: 'bash' }), /Lisp/u, 'idle retains the selected route')
    assert.match((await command.handler({ rawInput: 'status', agent })).text, /READY/u)
    assert.equal(await step(), 'model-ready')
    assert.match((sections.get('kiokuko:lisp-approval') as unknown as () => string)(), /mode: ask/)
    assert.equal((await command.handler({ rawInput: 'approval auto', agent })).kind, 'success')
    await step()
    assert.match((sections.get('kiokuko:lisp-approval') as unknown as () => string)(), /mode: auto/)
    assert.equal((await state()).approval.mode, 'auto')
    const applied = await surface.manager.execute(owner, 'lisp_eval', {operationId:'auto-identity',code:'(kioku.files:propose-write "auto.txt" "ok")'}) as any
    assert.equal(applied.changes?.[0]?.state, 'APPLIED', JSON.stringify(applied))
    const nextGeneration = (await state()).generation
    assert.equal(nextGeneration, firstGeneration)
    assert.doesNotMatch(sections.get('kiokuko:lisp-runtime')!, /automatically restarted/u)
    assert.ok(sections.get('kiokuko:lisp-runtime')!.includes(nextGeneration), 'new generation reaches the model before its next step')
    await listeners.get('session/disposed')!({ ...agent.session })
    assert.equal((await state()).state, 'READY', 'a same-ID stale session cannot terminate this worker')
    const ended = agent.session
    currentAgent = undefined; currentSession = undefined
    await listeners.get('session/disposed')!(ended)
    assert.equal((await state()).state, 'READY')
    assert.equal(definitions.size, 0)
    assert.equal(sections.size, 0)
    agent = { ...agent, session: { ...ended } }; currentAgent = agent; currentSession = agent.session
    assert.equal(await step(), 'model-ready', 'reopening the conversation resumes without manual recovery')
    assert.ok(definitions.has('lisp_eval'))
    assert.equal((await state()).runtimePid, firstPid)
    const retained = await surface.manager.execute(owner, 'lisp_eval', {operationId:'after-reopen',code:'*session-value*'}) as any
    assert.equal(retained.value.printed, '(42)')
    assert.equal(retained.generation, firstGeneration)
    assert.match(guard({ agent, name: 'bash' }), /Lisp/u)
    // Session disposal can arrive before startup registers tools. It still
    // cancels the admission and must not register a dead agent afterward.
    let entered!: () => void, release!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const start = LispWorker.prototype.start
    t.mock.method(LispWorker.prototype, 'start', async function(this: LispWorker) {
      await start.call(this)
      entered()
      await gate
    })
    agent = { ...agent, id: 'starting', session: { id: 'starting', header: { cwd: base } } }
    currentAgent = agent; currentSession = agent.session
    workingLispTask(db, { ...owner, sessionId: 'starting', agentId: 'starting' })
    const beforeStartup = registrations
    const starting = command.handler({ rawInput: 'enable', agent, signal: new AbortController().signal })
    await Promise.race([entering, starting.then((result: unknown) => assert.fail(JSON.stringify(result)))])
    currentAgent = undefined; currentSession = undefined
    const disposal = listeners.get('session/disposed')!(agent.session)
    release()
    assert.equal((await starting).kind, 'error')
    await disposal
    assert.equal((await surface.manager.status({ ...owner, sessionId: 'starting', agentId: 'starting' }) as any).state, 'RECOVERY_REQUIRED')
    assert.equal(registrations, beforeStartup, 'startup completion cannot register tools for a disposed agent')
  } finally { surface.stop(); await surface.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
