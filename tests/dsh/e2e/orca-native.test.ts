import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { apply } from '../../../src/dsh/index.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { nativeMock } from '../helpers/native-mock.js'
import { workspaceKey } from '../../../src/dsh/orca-security.js'
import { collect } from '../helpers/orca-fixture.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packageRoot && !sourceRoot) throw new Error('Orca native E2E requires pinned DSH 0.1.2-rc.1')
async function load(name: string, source: string) {
  const base = packageRoot ? join(packageRoot, '@deepseek-ai', name) : join(sourceRoot!, source)
  const meta = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'))
  if (name !== 'cordis') assert.equal(meta.version, '0.1.2-rc.1', `native Orca fixture rejects mismatched ${name}`)
  return import(pathToFileURL(join(base, 'lib/index.js')).href)
}
for (const owner of ['normal', 'explicit'] as const) test(`Orca enabled real DSH ${owner} apply, scoped events, final result, stop/show/export and unload`, {
  skip: !packageRoot && !sourceRoot ? 'requires pinned native DSH runtime' : false,
  timeout: 30_000,
}, async () => {
  const [cordis, llm, sessions, projection, prompt, tools, agents, loop, skills, commands] = await Promise.all([
    load('cordis', 'vendor/cordis'), load('dsh-llm', 'packages/llm/llm'), load('dsh-session', 'packages/core/session'),
    load('dsh-session-projection', 'packages/session/session-projection'), load('dsh-system-prompt', 'packages/core/system-prompt'),
    load('dsh-tools', 'packages/core/tools'), load('dsh-agent', 'packages/core/agent'), load('dsh-agent-loop', 'packages/core/agent-loop'),
    load('dsh-skill', 'packages/skill/skill'), load('dsh-commands', 'packages/core/commands'),
  ])
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-orca-native-')))
  const oldData = process.env.KIOKUKO_DATA_DIR
  process.env.KIOKUKO_DATA_DIR = join(root, 'data')
  await mkdir(join(root, 'project-a')); await mkdir(join(root, 'project-b'))
  const ctx = new cordis.Context()
  ctx.provide('connection', { fetch: { register: () => () => undefined } })
  let adapter: ReturnType<typeof createDshHostAdapter> | undefined
  let plugin: any
  try {
    for (const module of [llm, sessions, projection, tools, agents, skills, commands]) await ctx.plugin(module.default)
    await ctx.plugin(prompt.default, { persona: '' })
    await ctx.plugin(loop.default, { agents: [] })
    const mock = nativeMock(llm)
    ctx.llm.registerAdapter(['mock'], new mock.MockAdapter([mock.textResponse('A'), mock.textResponse('B')]))
    if (owner === 'explicit') {
      adapter = createDshHostAdapter(ctx, { repositoryRoot: root, orca: { enabled: true, shutdownDrainTimeoutMs: 1000 } })
      ctx.provide('kiokukoDsh', adapter.host)
    }
    plugin = ctx.plugin({ name: 'orca-fixture-plugin', apply: (context: any) => apply(context, { orca: { enabled: true, shutdownDrainTimeoutMs: 1000 } }) })
    await plugin
    const a = await ctx.agentLoop.create(sessions.SessionId('orca-a'), { provider: 'mock', model: 'mock' }, { cwd: join(root, 'project-a') })
    const b = await ctx.agentLoop.create(sessions.SessionId('orca-b'), { provider: 'mock', model: 'mock' }, { cwd: join(root, 'project-b') })
    const signal = new AbortController().signal
    const command = async (agent: any, text: string) => {
      const execution = await ctx.commands.execute(agent, `/kioku-orca ${text}`, [], signal)
      assert.equal(execution?.result.kind, 'success', JSON.stringify(execution))
      return JSON.parse(execution.result.text)
    }
    // Exact native agents/sessions are available before a Kiokuko logical run exists.
    const status = await command(a, 'status')
    assert.equal(status.capability, 'available')
    assert.equal(status.sessionRecording, 'awaiting_choice')
    // This fixture has no human question service; explicit commands authorize both sessions.
    await command(a, 'start')
    await command(b, 'start')
    await Promise.all([a, b].map(agent => collect(agent.ctx.llm.stream({ provider: 'mock', model: 'mock', sessionId: agent.session.id, messages: [], signal }))))
    ctx.tools.register({ name: 'orca_test_tool', description: 'fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_: unknown, text: string) => [{ type: 'text', text }] }, execute: () => 'body-success' })
    ctx.on('tools/post-execute', (_exec: any, _result: any, _next: any) => ({ kind: 'block', feedback: [{ type: 'text', text: 'fixture policy denial' }] }), { global: true })
    const result = await a.ctx.tools.execute({ agent: a, callId: 'call-one', name: 'orca_test_tool', arguments: {}, signal })
    assert.equal(result.isError, true)
    await command(a, 'stop')
    const rows = await command(a, 'list')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'completed', JSON.stringify(rows))
    assert.equal(rows[0].store_root, join(root, 'project-a'))
    const id = rows[0].orca_run_id
    const page = await command(a, `show ${id}`)
    assert.equal(page.events.filter((e: any) => e.type === 'model.request').length, 1)
    assert.equal(page.events.find((e: any) => e.type === 'tool.result').attrs.is_error, true)
    const exported = await command(a, `export ${id}`)
    assert.ok((await readFile(exported.path, 'utf8')).includes('kiokuko-dsh'))
    const denied = await ctx.commands.execute(b, `/kioku-orca show ${id}`, [], signal)
    assert.equal(denied.result.text, 'trace_not_found')
    const manifest = JSON.parse(await readFile(join(root, 'project-a/.orca/runs', id, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.env_allowlisted, {})
    // Unload while a native pre-execute gate is pending. Results must still be observed.
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.on('tools/pre-execute', async (_exec: any, next: any) => { entered(); await gate; return next() }, { global: true })
    const executing = b.ctx.tools.execute({ agent: b, callId: 'pending', name: 'orca_test_tool', arguments: {}, signal })
    await pending
    const unloading = plugin.dispose()
    release()
    await executing
    await unloading
    const bRows = adapter ? await adapter.host.orca!.withIndex(store => store.list('orca-b', workspaceKey(join(root, 'project-b')))) : undefined
    // The explicit host owns its DB past shutdown, until its adapter is disposed.
    if (bRows) assert.equal(bRows[0]?.state, 'completed')
    const { readdir } = await import('node:fs/promises')
    const [bId] = await readdir(join(root, 'project-b/.orca/runs'))
    const bEvents = (await readFile(join(root, 'project-b/.orca/runs', bId!, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(bEvents.filter(e => e.type === 'tool.result').length, 1)
    assert.equal(bEvents.at(-1).type, 'run.end')
  } finally {
    await plugin?.dispose()
    await adapter?.dispose()
    if (oldData === undefined) delete process.env.KIOKUKO_DATA_DIR; else process.env.KIOKUKO_DATA_DIR = oldData
    await rm(root, { recursive: true, force: true })
  }
})
