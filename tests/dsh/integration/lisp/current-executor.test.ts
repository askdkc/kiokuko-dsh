import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { mountLispSurface as sourceMountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { createLispHostDispatch as sourceCreateLispHostDispatch } from '../../../../src/dsh/lisp/host-tool-dispatch.js'
import { LISP_ASSEMBLY_SERVICE } from '../../../../src/dsh/lisp/request-surface.js'
import { currentTaskAuthority, withTaskAuthority } from '../../../../src/dsh/task-authority-context.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
const builtRoot = process.env.KIOKUKO_LISP_BUILT_ROOT
const mountLispSurface: typeof sourceMountLispSurface = builtRoot ? (await import(pathToFileURL(join(builtRoot, 'dsh/lisp/surface.js')).href)).mountLispSurface : sourceMountLispSurface
const createLispHostDispatch: typeof sourceCreateLispHostDispatch = builtRoot ? (await import(pathToFileURL(join(builtRoot, 'dsh/lisp/host-tool-dispatch.js')).href)).createLispHostDispatch : sourceCreateLispHostDispatch
const source = process.env.KIOKUKO_DSH_SOURCE_ROOT
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const currentRequired = process.env.KIOKUKO_EXPECTED_DSH_SHA !== undefined
if (currentRequired && !source && !packages) throw new Error('Current official executor coverage requires the staged package root or verified source root')
const load = (path: string) => {
  const name = `${path.startsWith('vendor/') ? '' : 'dsh-'}${path.split('/').at(-1)}`
  return import(pathToFileURL(source ? join(source, path, 'src/index.ts') : join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
}
const actual = { skip: source || currentRequired ? false : 'current official runtime is checked separately from historical release fixtures', timeout: 30000 }

async function harness(mode: 'native' | 'ptc' = 'native') {
  const [cordis, prompt, tools, native, scope] = await Promise.all([
    load('vendor/cordis'), load('packages/core/system-prompt'), load('packages/core/tools'),
    load('packages/core/tool-executor-native'), load('packages/core/scope'),
  ])
  const ctx = new cordis.Context(), fibers: any[] = []; let ptcRuns = 0
  fibers.push(await ctx.plugin(prompt.default, {}), await ctx.plugin(tools.default, {}))
  if (mode === 'native') fibers.push(await ctx.plugin(native, {}))
  else {
    fibers.push(await ctx.plugin({ name: 'unused-ptc-runtime', apply(c: any) { c.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body', run() { ptcRuns++; throw new Error('This test does not execute PTC programs') } }) } }))
    fibers.push(await ctx.plugin(await load('packages/core/tool-executor-ptc'), {}))
  }
  const root = await mkdtemp(join(tmpdir(), 'current-executor-'))
  const agent: any = { id: 'current', session: { id: 'current', header: { cwd: root }, snapshotEvents: () => [] } }
  const scoped = scope.createScope(ctx, agent); agent.ctx = scoped.ctx
  return { ctx, agent, root, fibers, ptcRuns: () => ptcRuns, close: async () => { await scoped.dispose(); for (const f of fibers.reverse()) await f.dispose(); await rm(root, { recursive: true, force: true }) } }
}

for (const mode of ['native', 'ptc'] as const) test(`current official ${mode} registry enters and leaves development Lisp without replacing its executor`, actual, async () => {
  const h = await harness(mode), commands = new Map<string, any>()
  const db = new NodeSqliteAdapter(join(h.root, 'db'), new DatabaseSync(join(h.root, 'db')))
  migrateDatabase(db)
  h.fibers.push(await h.ctx.plugin({ name: 'current-host', apply(c: any) {
    c.provide('agents', { get: (id: string) => id === h.agent.id ? h.agent : undefined })
    c.provide('sessions', { get: (id: string) => id === h.agent.id ? h.agent.session : undefined })
    c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
  } }))
  let surface: any
  try {
    assert.equal(h.ctx.tools.presentAs, undefined)
    assert.equal(h.ctx.tools.modeFor, undefined)
    let effects = 0
    h.ctx.tools.register({ name: 'ordinary', description: 'counter', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
    const call = async () => (await h.ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'call', name: 'ordinary', arguments: '{}' }], agent: h.agent, signal: new AbortController().signal })).results[0].result
    surface = await mountLispSurface(h.ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true }))
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: h.agent, signal: new AbortController().signal })
    for (let i = 0; i < 2; i++) {
      const enabled = await command('enable-task')
      assert.notEqual(enabled.kind, 'error', enabled.text)
      assert.ok(h.ctx.tools.get('lisp_status', h.agent))
      const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, agent: h.agent })
      assert.equal(assembly.tools.some((tool: any) => tool.name === 'run_code'), mode === 'ptc')
      const projected = await h.ctx.get(LISP_ASSEMBLY_SERVICE).project(h.agent, assembly)
      assert.deepEqual(projected.tools, assembly.tools, 'Lisp cannot replace selected executor schemas or broaden step admission')
      assert.equal((await call()).isError, mode === 'ptc')
      const disabled = await command('disable')
      assert.notEqual(disabled.kind, 'error', disabled.text)
      assert.equal(h.ctx.tools.get('lisp_status', h.agent), undefined)
      assert.equal((await call()).isError, mode === 'ptc')
    }
    surface.stop(); await surface.dispose(); surface = undefined
    assert.equal((await call()).isError, mode === 'ptc')
    assert.equal(effects, mode === 'ptc' ? 0 : 5)
  } finally { surface?.stop(); await surface?.dispose(); db.close(); await h.close() }
})

test('current official nested dispatcher preserves identity, scoped policy and cancellation settlement', actual, async () => {
  const h = await harness()
  try {
    const dispatch = await createLispHostDispatch(h.ctx, h.ctx.tools)
    const parent = Symbol('parent'), signal = new AbortController()
    const seen: any[] = [], stages: string[] = []
    h.agent.ctx.on('tools/pre-execute', async (exec: any, next: any) => { stages.push('pre'); seen.push(exec); return next() })
    h.agent.ctx.get('tools').guard((exec: any) => exec.name === 'denied' ? 'scoped denial' : undefined)
    h.agent.ctx.on('tools/post-execute', async (_exec: any, _result: any, next: any) => { stages.push('post'); return next() })
    let effects = 0
    for (const name of ['allowed', 'denied']) h.ctx.tools.register({ name, description: name, parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
    const input = { name: 'allowed', callId: 'nested', rootCallId: 'root', parent, arguments: {}, agent: h.agent, signal: signal.signal }
    assert.equal((await dispatch(input)).isError, false)
    assert.equal(seen[0].parent, parent); assert.equal(seen[0].rootCallId, 'root'); assert.equal(seen[0].agent, h.agent)
    assert.deepEqual(stages, ['pre', 'post'])
    assert.equal((await dispatch({ ...input, name: 'denied' })).isError, true)
    assert.equal(effects, 1)
    signal.abort()
    assert.equal((await dispatch(input)).isError, true)
    assert.equal(effects, 1)
    let started!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve }), drained = new Promise<void>(resolve => { release = resolve })
    h.ctx.tools.register({ name: 'slow', description: 'slow', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => { started(); await drained; return 'settled' } })
    const runningAbort = new AbortController(); let settled = false
    const pending = dispatch({ ...input, name: 'slow', signal: runningAbort.signal }).then(result => { settled = true; return result })
    await ready; runningAbort.abort(); await Promise.resolve(); assert.equal(settled, false)
    release(); assert.equal((await pending).isError, true)
  } finally { await h.close() }
})


for (const mode of ['native', 'ptc'] as const) test(`current protected Lisp keeps ${mode} selection and denies unauthorized dispatch`, actual, async () => {
  const h = await harness(mode), commands = new Map<string, any>()
  const db = new NodeSqliteAdapter(join(h.root, 'db'), new DatabaseSync(join(h.root, 'db'))); migrateDatabase(db)
  let surface: any, readEffects = 0, writeEffects = 0
  try {
    h.fibers.push(await h.ctx.plugin({ name: 'protected-host', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === h.agent.id ? h.agent : undefined })
      c.provide('sessions', { get: (id: string) => id === h.agent.id ? h.agent.session : undefined })
      c.provide('commands', { register(d: any) { commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    h.ctx.tools.register({ name: 'read', description: 'read', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++readEffects })
    h.ctx.tools.register({ name: 'write', description: 'write', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++writeEffects })
    const mount = () => mountLispSurface(h.ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ executionMode: 'protected', enabled: true }))
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: h.agent, signal: new AbortController().signal })
    const call = async (name: string) => (await h.ctx.tools.execute({ calls: [{ type: 'tool-call', id: name, name, arguments: name === 'run_code' ? JSON.stringify({ code: 'await tools.write({})', description: 'Attempt protected write' }) : '{}' }], agent: h.agent, signal: new AbortController().signal })).results[0].result
    surface = await mount()
    for (let i = 0; i < 2; i++) {
      const enabled = await command('enable-task'); assert.notEqual(enabled.kind, 'error', enabled.text)
      assert.equal((await call('write')).isError, true)
      assert.equal((await call('read')).isError, mode === 'ptc')
      if (mode === 'ptc') assert.match(JSON.stringify(await call('run_code')), /Protected Lisp requires the native/)
      const nested = await createLispHostDispatch(h.ctx, h.ctx.tools)
      assert.equal((await nested({ callId: 'nested-write', name: 'write', arguments: {}, agent: h.agent, parent: Symbol('nested'), signal: new AbortController().signal })).isError, true)
      const disabled = await command('disable'); assert.notEqual(disabled.kind, 'error', disabled.text)
      assert.equal((await call('write')).isError, mode === 'ptc')
    }
    assert.equal(h.ptcRuns(), 0, 'protected programs must never reach the PTC runtime')
    assert.equal(writeEffects, mode === 'native' ? 2 : 0)
    assert.equal(readEffects, mode === 'native' ? 2 : 0)
    assert.notEqual((await command('enable-task')).kind, 'error')
    surface.stop(); await surface.dispose(); surface = undefined
    assert.equal((await call('write')).isError, true, 'protected fence survives unload')
    surface = await mount()
    assert.notEqual((await command('disable')).kind, 'error')
    assert.equal((await call('write')).isError, mode === 'ptc', 'reload/disable preserves prior executor without a tombstone')
  } finally { surface?.stop(); await surface?.dispose(); db.close(); await h.close() }
})

test('current nested dispatch declares tools when mounted by a bootstrap plugin', actual, async () => {
  const h = await harness()
  try {
    let dispatch: Awaited<ReturnType<typeof createLispHostDispatch>> | undefined
    h.ctx.tools.register({ name: 'bootstrap-read', description: 'read', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => 'read completed' })
    h.fibers.push(await h.ctx.plugin({ name: 'bootstrap-consumer', inject: [], async apply(ctx: any) {
      dispatch = await createLispHostDispatch(ctx, ctx.get('tools', false))
    } }))
    assert.ok(dispatch)
    const result = await dispatch({ name: 'bootstrap-read', callId: 'bootstrap', arguments: {}, agent: h.agent, parent: Symbol('bootstrap'), signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value, 'read completed')
  } finally { await h.close() }
})

test('current nested dispatch carries host task authority through reconstructed execution', actual, async () => {
  const h = await harness()
  try {
    const dispatch = await createLispHostDispatch(h.ctx, h.ctx.tools)
    const lease = { taskId: 'task', sessionId: h.agent.id, repositoryRoot: h.root, revision: 3 } as any
    h.ctx.tools.register({ name: 'authority', description: 'authority', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => currentTaskAuthority() })
    const result = await withTaskAuthority(lease, () => dispatch({ name: 'authority', callId: 'authority', arguments: {}, agent: h.agent, parent: Symbol('owner'), signal: new AbortController().signal }))
    assert.equal(result.isError, false); assert.deepEqual(result.value, lease)
    assert.equal(currentTaskAuthority(), undefined)
  } finally { await h.close() }
})

for (const executionMode of ['development', 'protected'] as const) test(`current official new session starts a model turn with ${executionMode} Lisp enabled`, actual, async () => {
  const [cordis, llm, sessions, projections, prompt, tools, native, agents, loop] = await Promise.all([
    load('vendor/cordis'), load('packages/llm/llm'), load('packages/core/session'), load('packages/session/session-projection'),
    load('packages/core/system-prompt'), load('packages/core/tools'), load('packages/core/tool-executor-native'),
    load('packages/core/agent'), load('packages/core/agent-loop'),
  ])
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const root = await mkdtemp(join(tmpdir(), 'current-turn-'))
  const db = new NodeSqliteAdapter(join(root, 'db'), new DatabaseSync(join(root, 'db'))); migrateDatabase(db)
  let surface: any, handle: any
  try {
    for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, native, agents.default]) fibers.push(await ctx.plugin(plugin, {}))
    fibers.push(await ctx.plugin(loop.default, { agents: [] }))
    fibers.push(await ctx.plugin({ name: 'turn-commands', apply(c: any) { c.provide('commands', { register(definition: any) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } }) } }))
    // Only the external model is scripted; session creation, pre-step hooks,
    // scoped lookup, batch dispatch and turn settlement are official DSH.
    class ScriptedAdapter extends llm.LlmAdapter {
      requests: any[] = []
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream(options: any) {
        this.requests.push(options)
        if (this.requests.length === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId('status'), name: 'lisp_status', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'turn completed' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    surface = await mountLispSurface(ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true, executionMode }))
    handle = await ctx.agents.create({ sessionId: sessions.SessionId('fresh'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    const enabled = await commands.get('kioku-lisp').handler({ rawInput: 'enable-task', agent: handle.agent, signal: new AbortController().signal })
    assert.notEqual(enabled.kind, 'error', enabled.text)
    handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'check Lisp status' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 2, 'the real loop must reach the model and settle its actual tool batch')
    const events = handle.agent.session.snapshotEvents()
    assert.ok(events.some((event: any) => event.type === 'turn/start'))
    assert.ok(events.some((event: any) => event.type === 'tool/result' && event.data.message.isError === false))
    assert.ok(events.some((event: any) => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
  } finally { await handle?.dispose(); surface?.stop(); await surface?.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
})
