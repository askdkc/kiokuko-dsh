import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { withLispNativeCommand } from '../../../../src/dsh/lisp-tool-identity.js'
import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
for (const hostFence of [false, true]) test(`enabled development Lisp routes shell execution through Lisp until explicitly disabled (${hostFence ? 'CLI fence' : 'native fence'})`, {
  skip: packages ? false : 'requires native DSH', timeout: 30000,
}, async () => {
  const load = (name: string) => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope'].map(load))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lisp-shell-routing-')))
  const db = new NodeSqliteAdapter(join(root, 'state.db'), new DatabaseSync(join(root, 'state.db')))
  migrateDatabase(db)
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const agent: any = { id: 'selected', session: { id: 'selected', header: { cwd: root }, snapshotEvents: () => [] } }
  const other: any = { id: 'ordinary', session: { id: 'ordinary', header: { cwd: root } } }
  const agents = new Map([[agent.id, agent], [other.id, other]])
  const protectedSessions = new Set<string>()
  let fenceRequest: any
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, local: any, otherLocal: any, shellEffects = 0
  const call = (name: string, target = agent, nested = false) => executeNativeTool(ctx, packages!, {
    name, callId: `call-${shellEffects}`, arguments: {}, agent: target, signal: new AbortController().signal,
    ...(nested ? { parent: Symbol('untrusted-child') } : {}),
  })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'routing-host', apply(c: any) {
      c.provide('agents', { get: (id: string) => agents.get(id) })
      c.provide('sessions', { get: (id: string) => agents.get(id)?.session })
      c.provide('commands', { register(d: any) { commands.set(d.name, d); return () => commands.delete(d.name) } })
      if (hostFence) c.provide('executionFences', { attach(request: any) {
        fenceRequest = request
        return { protect(id: string) { protectedSessions.add(id) }, release(id: string) { protectedSessions.delete(id) } }
      } })
    } }))
    // Match the CLI's host-owned denial boundary: callback arguments deliberately
    // omit callId, parent, signal and effect methods.
    if (hostFence) ctx.tools.guard((execution: any) => protectedSessions.has(execution.agent?.session.id)
      ? fenceRequest.check(Object.freeze({ name: execution.name, arguments: execution.arguments, agent: execution.agent })) : undefined)
    for (const name of ['bash', 'zsh', 'pwsh']) ctx.tools.register({ name, description: name, parameters: {},
      output: { schema: {}, render: () => [] }, execute: () => ++shellEffects })
    ctx.tools.register({ name: 'read', description: 'read', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => 'contents' })
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    otherLocal = scope.createScope(ctx, other); other.ctx = otherLocal.ctx
    const mount = () => mountLispSurface(ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true }))
    surface = await mount()
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent, signal: new AbortController().signal })
    assert.equal((await call('bash')).isError, false)
    assert.equal((await command('enable-task')).kind, 'success')
    const enabledPrompt = await ctx.systemPrompt.assemble({ scope: agent, agent })
    assert.match(enabledPrompt.sections.find((section: any) => section.name === 'kiokuko:lisp-route')?.text ?? '', /Lisp is ON/)
    for (const name of ['bash', 'zsh', 'pwsh']) for (const nested of [false, true]) {
      const result = await call(name, agent, nested)
      assert.equal(result.isError, true, `${name} must not bypass the selected Lisp route`)
      assert.match(JSON.stringify(result), /LISP_ROUTE_REQUIRED/)
    }
    assert.equal(shellEffects, 1, 'rejected shell calls must have no effects')
    const bridge = { name: 'bash', callId: 'host-lisp-command', parent: Symbol('lisp-native'), arguments: {}, agent, signal: new AbortController().signal }
    const execute = ctx.tools.get('bash', agent).execute
    const runBridge = () => withLispNativeCommand(bridge, execute, { current: () => true }, () => executeNativeTool(ctx, packages!, bridge))
    assert.equal((await runBridge()).isError, false, 'the host-owned Lisp command bridge keeps native execution')
    const deny = ctx.tools.guard((execution: any) => execution.name === 'bash' ? 'NATIVE_COMMAND_DENIED' : undefined)
    assert.match(JSON.stringify(await runBridge()), /NATIVE_COMMAND_DENIED/)
    deny()
    assert.equal(shellEffects, 2, 'the Lisp bridge cannot override native denial')
    assert.equal((await call('read')).isError, false)
    assert.equal((await call('lisp_status')).isError, false)
    assert.equal((await call('bash', other)).isError, false, 'another session keeps its own route')
    surface.stop(); await surface.dispose()
    assert.equal((await call('bash')).isError, true, 'unload must not silently change the selected route')
    surface = await mount()
    assert.equal((await call('bash')).isError, true, 'restored enabled sessions retain their route')
    assert.equal((await command('disable')).kind, 'success')
    assert.equal((await call('bash')).isError, false)
    const disabledPrompt = await ctx.systemPrompt.assemble({ scope: agent, agent })
    assert.equal(disabledPrompt.sections.find((section: any) => section.name === 'kiokuko:lisp-route')?.text ?? '', '')
    assert.equal(shellEffects, 4)
  } finally {
    surface?.stop(); await surface?.dispose(); await otherLocal?.dispose(); await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
})

test('native model loop rejects direct Bash and continues through the selected Lisp tool', {
  skip: packages ? false : 'requires native DSH', timeout: 30000,
}, async () => {
  const load = (name: string) => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, llm, sessions, projections, prompt, tools, agents, loop] = await Promise.all([
    'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop',
  ].map(load))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lisp-shell-turn-')))
  const db = new NodeSqliteAdapter(join(root, 'state.db'), new DatabaseSync(join(root, 'state.db')))
  migrateDatabase(db)
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, handle: any, shellEffects = 0
  try {
    for (const plugin of [llm.default, sessions.default, projections.default, prompt.default]) fibers.push(await ctx.plugin(plugin, {}))
    await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin(agents.default, {}), await ctx.plugin(loop.default, { agents: [] }))
    fibers.push(await ctx.plugin({ name: 'routing-turn-host', apply(c: any) {
      c.provide('commands', { register(d: any) { commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    ctx.tools.register({ name: 'bash', description: 'shell', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++shellEffects })
    // Only model output is scripted. Prompt assembly, session, native dispatch
    // and turn settlement use DSH; real Lisp processes are covered by conversation-intake.
    class Adapter extends llm.LlmAdapter {
      requests = 0
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream() {
        this.requests++
        const name = this.requests === 1 ? 'bash' : this.requests === 2 ? 'lisp_status' : undefined
        if (name) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(name), name, arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checked' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const adapter = new Adapter(); ctx.llm.registerAdapter(['mock'], adapter)
    surface = await mountLispSurface(ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true }))
    handle = await ctx.agents.create({ sessionId: sessions.SessionId('routing-turn'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    assert.equal((await commands.get('kioku-lisp').handler({ rawInput: 'enable-task', agent: handle.agent, signal: new AbortController().signal })).kind, 'success')
    handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Check the current execution status.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests, 3)
    assert.equal(shellEffects, 0)
    const events = handle.agent.session.snapshotEvents()
    const results = events.filter((event: any) => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.equal(results[0].data.message.isError, true)
    assert.match(JSON.stringify(results[0]), /LISP_ROUTE_REQUIRED/)
    assert.equal(results[1].data.message.isError, false)
    assert.ok(events.some((event: any) => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
  } finally {
    await handle?.dispose(); surface?.stop(); await surface?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
})
