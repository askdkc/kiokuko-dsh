import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig, LispError } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('recover on a disabled session leaves native tools available without requiring SBCL', {
  skip: packages ? false : 'requires pinned native DSH', timeout: 15000,
}, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ls-disabled-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  migrateDatabase(db)
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const agent: any = { id: 'disabled-session', session: { id: 'disabled-session', header: { cwd: base } } }
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, agentScope: any, effects = 0
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'disabled-lisp-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      c.provide('sessions', { get: (id: string) => id === agent.session.id ? agent.session : undefined })
      c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    } }))
    agentScope = scope.createScope(ctx, agent); agent.ctx = agentScope.ctx
    ctx.tools.register(tools.defineTool({ name: 'ordinary_tool', description: 'counter', parameters: {},
      output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++effects }))
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode: 'protected', enabled: true, sbclPath: '/does-not-exist' }))
    const call = () => executeNativeTool(ctx, packages!, { callId: randomUUID(), name: 'ordinary_tool', arguments: {}, agent, signal: new AbortController().signal })
    assert.equal((await call()).isError, false)
    for (let i = 0; i < 2; i++) {
      const recovered = await commands.get('kioku-lisp').handler({ rawInput: 'recover', agent, signal: new AbortController().signal })
      assert.equal(recovered.kind, 'error'); assert.match(recovered.text, /有効にしていません/)
      assert.equal((await call()).isError, false, 'failed recovery must not hide ordinary tools')
      assert.equal((await surface.manager.status({ sessionId: agent.id, agentId: agent.id, root: base }) as any).state, 'DISABLED')
    }
    assert.equal(effects, 3)
  } finally {
    surface?.stop(); await surface?.dispose(); await agentScope?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})

for (const scenario of ['disabled-config', 'scope-conflict', 'startup-failure'] as const) test(`enable ${scenario}: native tools follow admission, with persisted sessions still fenced`, {
  skip: packages ? false : 'requires pinned native DSH', timeout: 15000,
}, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ls-enable-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  migrateDatabase(db)
  db.prepare('INSERT INTO dsh_lisp_sessions VALUES(?,?,1,?,?)').run('saved', base, 'epoch', new Date().toISOString())
  if (scenario === 'scope-conflict') db.prepare('INSERT INTO dsh_lisp_sessions VALUES(?,?,0,?,?)').run('new', join(base, 'old-root'), 'epoch', new Date().toISOString())
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  const agents: any[] = ['saved', 'new'].map(id => ({ id, session: { id, header: { cwd: base } } }))
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, effects = 0
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'rejected-enable-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => agents.find(agent => agent.id === id) })
      c.provide('sessions', { get: (id: string) => agents.find(agent => agent.id === id)?.session })
      c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    } }))
    for (const agent of agents) { const local = scope.createScope(ctx, agent); scopes.push(local); agent.ctx = local.ctx }
    ctx.tools.register(tools.defineTool({ name: 'ordinary_tool', description: 'counter', parameters: {},
      output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++effects }))
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode: 'protected', enabled: scenario !== 'disabled-config', sbclPath: join(base, 'missing-sbcl') }))
    if (scenario === 'startup-failure') {
      const enable = surface.manager.enable.bind(surface.manager)
      let attempts = 0
      surface.manager.enable = async (...args: Parameters<typeof enable>) => {
        if (attempts++ === 0) {
          const owner = args[0]
          await surface!.manager.options.store.enable(owner)
          surface!.manager.enabled.set(owner.sessionId, owner.root)
          throw new LispError('STARTUP_FAILED', 'injected SBCL ENOENT')
        }
        return enable(...args)
      }
    }
    const call = (agent: any, name = 'ordinary_tool') => executeNativeTool(ctx, packages!, { callId: randomUUID(), name, arguments: {}, agent, signal: new AbortController().signal })
    const command = (agent: any) => commands.get('kioku-lisp').handler({ rawInput: 'enable', agent, signal: new AbortController().signal })
    assert.equal((await call(agents[0])).isError, true, 'saved session remains protected')
    assert.equal((await call(agents[1])).isError, false)
    for (let i = 0; i < 2; i++) {
      const result = await command(agents[1])
      if (scenario !== 'startup-failure' || i === 0) assert.equal(result.kind, 'error', result.text)
      if (scenario === 'disabled-config') assert.match(result.text, /設定の lisp.enabled/)
      if (scenario === 'scope-conflict') assert.match(result.text, /作業場所が変わっています/)
      const admitted = scenario === 'startup-failure'
      assert.equal((await call(agents[1])).isError, admitted, 'only an admitted session may lose ordinary tools')
      assert.equal(Boolean(ctx.tools.executable('lisp_status', agents[1])), admitted, 'rejection must not admit executable Lisp tools')
      assert.equal(surface.manager.enabled.has('new'), admitted)
      if (admitted) assert.equal((await call(agents[1], 'lisp_status')).isError, false, 'startup failure retains diagnostic tools')
      assert.equal((await call(agents[0])).isError, true, 'another session cannot remove the persisted fence')
    }
    if (scenario === 'disabled-config') {
      assert.equal((await command(agents[0])).kind, 'error')
      assert.equal(Boolean(ctx.tools.get('lisp_status', agents[0])), false, 'rejected enable must not alter saved-session registration either')
      assert.equal((await call(agents[0])).isError, true)
    }
    assert.equal(effects, scenario === 'startup-failure' ? 1 : 3)
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const local of scopes.reverse()) await local.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})

test('real DSH registry: session tools, nested/child/late-tool denial, unload fence and safe disable', {
  skip: !packages || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires pinned native DSH and protected SBCL' : false, timeout: 120000,
}, async () => {
  const [cordis, prompt, tools, scope, questions] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-user-questions']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ls-'))), workspace = join(base, 'work')
  await mkdir(workspace)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, effects = 0, failRegistration = false
  const parent: any = { id: 'parent', session: { id: 'parent', header: { cwd: workspace } } }
  workingLispTask(db, { sessionId: parent.session.id, agentId: parent.id, root: workspace })
  const child: any = { id: 'child', session: { id: 'child', header: { cwd: workspace, parentSession: 'parent' } } }
  const outsider: any = { id: 'outsider', session: { id: 'outsider', header: { cwd: workspace } } }
  const agentMap = new Map([parent, child, outsider].map(agent => [agent.id, agent]))
  const config = LispConfig.parse({ executionMode: 'protected', enabled: true, approvalMode: 'ask', sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 })
  const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: parent, signal: new AbortController().signal })
  const call = (name: string, agent = parent, nested = false, args = {}) => executeNativeTool(ctx, packages!, { callId: `call-${randomUUID()}`, name, arguments: args, agent,
    signal: new AbortController().signal, ...(nested ? { parent: Symbol('parent'), rootCallId: 'root' } : {}) })
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'lisp-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => agentMap.get(id), roots: () => [parent, outsider] })
      c.provide('sessions', { get: (id: string) => agentMap.get(id)?.session })
      c.provide('commands', { register: (d: any) => { if (failRegistration) throw new Error('fixture registration unavailable'); commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    fibers.push(await ctx.plugin(questions.default, {}))
    for (const agent of [parent, child, outsider]) { const s = scope.createScope(ctx, agent, agent === child ? { parent } : undefined); scopes.push(s); agent.ctx = s.ctx }
    let asked = 0
    parent.ctx.on('user-questions/request', async (request: any) => {
      assert.equal(request.agent, parent); asked++
      return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }] }
    })
    const define = (name: string) => tools.defineTool({ name, description: 'effect counter', parameters: {}, output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++effects })
    ctx.tools.register(define('fixture_write'))
    assert.equal((await call('fixture_write')).isError, false)
    surface = await mountLispSurface(ctx, runtime, config)
    const enabled = await command('enable'); assert.equal(enabled.kind, 'success', enabled.text)
    const computed = await call('lisp_eval', parent, false, { operationId: 'calc', code: '(+ 10 20)' })
    assert.equal(computed.isError, false, JSON.stringify(computed)); assert.match(JSON.stringify(computed), /30/)
    // Regression: even a completed subprocess used to insert undefined into
    // lisp_status, which the native DSH output validator rejected before rendering.
    await call('lisp_eval', parent, false, { operationId: 'finished-job', code: '(kioku.process:python "print(42)")' })
    assert.equal((await call('lisp_status')).isError, false, 'finished jobs must be lossless native JSON')
    await call('lisp_eval', parent, false, { operationId: 'running-job', code: '(kioku.process:start-job "python3" (list "-I" "-c" "import time; time.sleep(2)") :timeout-ms 100)' })
    assert.equal((await call('lisp_status')).isError, false, 'running jobs must be lossless native JSON')
    await new Promise(resolve => setTimeout(resolve, 200))
    const failedJobStatus = await call('lisp_status')
    assert.equal(failedJobStatus.isError, false); assert.match(JSON.stringify(failedJobStatus), /JOB_TIMEOUT/)
    const large = await call('lisp_eval', parent, false, { operationId: 'large-source', code: '(kioku.files:propose-write "large.ts" (make-string 90000 :initial-element #\\x))' })
    assert.equal(large.isError, false, JSON.stringify(large).slice(0, 500))
    const presented = large.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const summary = JSON.parse(presented)
    assert.ok(Buffer.byteLength(presented) <= 16384); assert.equal(summary.changeSummary.states.APPLIED, 1)
    assert.equal(summary.proposals, undefined)
    const journalCount = db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_operations').get<{n:number}>()!.n
    const evidence = await call('lisp_inspect', parent, false, { operationId: 'saved-proof', resultOperationId: summary.operationId, section: 'changes' })
    assert.equal(evidence.isError, false); assert.match(JSON.stringify(evidence), /APPLIED/)
    assert.equal((await call('lisp_inspect', parent, false, { operationId: 'saved-proof-next', resultOperationId: summary.operationId, section: 'changes', offset: 1 })).isError, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_operations').get<{n:number}>()!.n, journalCount,
      'saved result paging must not create Lisp binding operations')
    assert.equal((await call('lisp_inspect', outsider, false, { operationId: 'foreign-proof', resultOperationId: summary.operationId, section: 'changes' })).isError, true)
    await writeFile(join(workspace, 'keep.txt'), 'keep')
    const deleted = await call('lisp_eval', parent, false, {operationId:'local-delete',code:'(kioku.files:propose-delete "keep.txt")'})
    assert.equal(asked, 0, 'project-local deletion needs no extra permission')
    assert.match(JSON.stringify(deleted), /APPLIED/); await assert.rejects(readFile(join(workspace,'keep.txt')), {code:'ENOENT'})
    const bridge = await call('lisp_eval', parent, false, { operationId: 'bridge', code: '(kioku.tools:call-tool "lisp_status")' })
    assert.equal(bridge.isError, false); assert.match(JSON.stringify(bridge), /EVALUATING/)
    const cycle = await call('lisp_eval', parent, false, { operationId: 'cycle', code: '(kioku.tools:call-tool "lisp_eval")' })
    assert.equal(cycle.isError, false); assert.match(JSON.stringify(cycle), /false/)
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    ctx.tools.register(define('late_write'))
    for (const agent of [parent, child]) for (const name of ['fixture_write', 'late_write']) for (const nested of [false, true]) assert.equal((await call(name, agent, nested)).isError, true)
    assert.equal(effects, 1)
    assert.equal((await call('fixture_write', outsider)).isError, false)
    surface.stop(); await surface.dispose()
    assert.equal((await call('fixture_write')).isError, true, 'unload must not reopen unrestricted execution')
    failRegistration = true
    await assert.rejects(mountLispSurface(ctx, runtime, config), /fixture registration unavailable/)
    failRegistration = false
    surface = await mountLispSurface(ctx, runtime, config)
    assert.match((await command('status')).text, /RECOVERY_REQUIRED/)
    assert.equal((await call('fixture_write')).isError, true)
    assert.equal((await command('recover')).kind, 'success')
    assert.equal((await command('disable')).kind, 'success')
    assert.equal((await call('fixture_write')).isError, false, 'human disable restores native tools only after confirmed stop')
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const s of scopes.reverse()) await s.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})

for (const executionMode of ['development', 'protected'] as const) test(`preparing Lisp preserves diagnostics without starting a worker (${executionMode})`, {
  skip: packages ? false : 'requires pinned native DSH', timeout: 15000,
}, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const { initializeCodingWorkflow, mutateCodingWorkflow } = await import('../../../../src/dsh/coding-workflow/store.js')
  const { LISP_ASSEMBLY_SERVICE } = await import('../../../../src/dsh/lisp/request-surface.js')
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-preparing-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const agent: any = { id: 'owner', session: { id: 'session', header: { cwd: base } } }
  const parent: any = { id: 'parent', session: { id: 'parent-session', header: { cwd: base } } }
  const owner = { sessionId: 'session', agentId: 'owner', root: base }
  const task = workingLispTask(db, owner)
  const { claimExecutionOwner } = await import('../../../../src/dsh/orchestration/execution-owner.js')
  claimExecutionOwner(db, {sessionId:owner.sessionId,workspace:'project:lisp-tests',mode:'normal',startId:'preparing',runId:task.taskId})
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, local: any
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'preparing-services', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : id === parent.id ? parent : undefined, isOwnedBy: () => true })
      c.provide('sessions', { get: (id: string) => id === agent.session.id ? agent.session : id === parent.session.id ? parent.session : undefined })
      c.provide('commands', { register: (d: any) => { commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode, enabled: true, sbclPath: '/does-not-exist' }))
    await surface.manager.options.store.enable(owner)
    surface.manager.enabled.set(owner.sessionId, base)
    const identity = { runId: task.taskId, sessionId: owner.sessionId, repositoryRoot: base }
    let workflow = initializeCodingWorkflow(db, { ...identity, requestId: 'prepare', task: 'Implement parser' })
    const change = (state: typeof workflow.state, choice: typeof workflow.choice.state = 'yes') => {
      workflow = mutateCodingWorkflow(db, identity, randomUUID(), workflow.revision, {state,choice}, value => {
        value.state = state; value.choice.state = choice
      })
    }
    change('preparing')
    const assembly = ctx.get(LISP_ASSEMBLY_SERVICE) as any
    const project = () => assembly.project(agent, { sections: [], variables: {}, tools: ctx.tools.schemas(agent) })
    const call = (name: string, args: object = {}, candidate = agent, signal = new AbortController().signal) =>
      executeNativeTool(ctx, packages!, { callId: randomUUID(), name, arguments: args, agent: candidate, signal })
    const projected = await project()
    assert.ok(projected.tools.some((t: any) => t.name === 'lisp_status'), 'status remains model-visible during preparing')
    const originalStart = surface.manager.enableSessionWorker
    let starts = 0
    surface.manager.enableSessionWorker = async () => { starts++; throw new Error('projection must not start a preparing child') }
    surface.manager.enabled.set(parent.session.id, base)
    agent.session.header.origin = 'subagent'; agent.session.header.parentSession = parent.id
    try { await project(); assert.equal(starts, 0, 'child projection shares the preparing guard') }
    finally { delete agent.session.header.origin; delete agent.session.header.parentSession; surface.manager.enableSessionWorker = originalStart; surface.manager.enabled.delete(parent.session.id) }
    const status = await call('lisp_status')
    assert.equal(status.isError, false, JSON.stringify(status))
    assert.equal(status.value.workflowAccess.state, 'preparing')
    assert.equal(status.value.workflowAccess.effects, 'blocked')
    assert.equal(status.value.generation, null, 'status must not start a worker')
    for (const name of ['lisp_eval', 'lisp_recover']) {
      const denied = await call(name, { operationId: randomUUID(), code: '(+ 1 2)', expectedGeneration: null })
      assert.match(JSON.stringify(denied), /LISP_WORKFLOW_BLOCKED/)
    }
    const journal = surface.manager.options.store
    for (const [savedOwner, id] of [[owner, 'own-result'], [{...owner,sessionId:'another-session'}, 'foreign-result']] as const) {
      await journal.enable(savedOwner)
      await journal.reserve(savedOwner, id, 'lisp_eval', 'fixture-digest', 'old-generation', {})
      await journal.transition(savedOwner, id, ['RUNNING'], 'SUCCEEDED', {ok:true,generation:'old-generation',value:{json:42}})
    }
    const saved = await call('lisp_inspect', { operationId: 'inspect', resultOperationId: 'own-result', section:'result' })
    assert.equal(saved.value.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(saved.value.data).value.json, 42, 'authorized history survives a worker generation change')
    const foreign = await call('lisp_inspect', {operationId:'foreign',resultOperationId:'foreign-result'})
    assert.equal(foreign.value.ok, false)
    assert.doesNotMatch(JSON.stringify(foreign), /fixture-digest|old-generation/)
    assert.equal((await call('lisp_status')).value.generation, null, 'saved inspection never starts a worker')
    const live = await call('lisp_inspect', { operationId: 'inspect-live', ref: 'old-generation/1' })
    assert.match(JSON.stringify(live), /LISP_WORKFLOW_BLOCKED/)
    const stale = { ...agent, id: 'old-owner' }
    assert.equal((await call('lisp_status', {}, stale)).isError, true)
    const stop = new AbortController(); stop.abort()
    assert.equal((await call('lisp_status', {}, agent, stop.signal)).isError, true)
    for (const [state, choice] of [['awaiting_lisp_choice','pending'], ['cancelled','cancelled'], ['superseded','yes']] as const) {
      change(state, choice)
      const hidden = await project()
      assert.ok(hidden.sections.some((s: any) => s.name === 'kiokuko:lisp-workflow-access'))
      assert.ok(!hidden.tools.some((t: any) => t.name === 'lisp_eval'))
    }
    change('ready')
    await project()
    assert.equal((await call('lisp_status')).value.workflowAccess.effects, 'available')
    change('preparing') // Dispatch must recheck a registration captured while ready.
    assert.match(JSON.stringify(await call('lisp_eval', {operationId:'late',code:'(+ 1 2)'})), /LISP_WORKFLOW_BLOCKED/)
  } finally {
    surface?.stop(); await surface?.dispose(); await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, {recursive:true,force:true})
  }
})
