import { execFileSync } from 'node:child_process'
import { isolateSkillHome } from '../helpers/skill-home.js'
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
import { workspaceKey } from '../../../src/dsh/agenticreplay-security.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packageRoot && !sourceRoot) throw new Error('AgenticReplay native E2E requires a DSH runtime')
const expectedVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION
  ?? JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
async function load(name: string, source: string) {
  const base = packageRoot ? join(packageRoot, '@deepseek-ai', name) : join(sourceRoot!, source)
  const meta = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'))
  if (name !== 'cordis' && expectedVersion) assert.equal(meta.version, expectedVersion, `native AgenticReplay fixture rejects mismatched ${name}`)
  return import(pathToFileURL(join(base, 'lib/index.js')).href)
}
for (const owner of ['normal', 'explicit'] as const) test(`AgenticReplay enabled real DSH ${owner} apply, scoped events, final result, stop/show/export and unload`, {
  skip: !packageRoot && !sourceRoot ? 'requires pinned native DSH runtime' : false,
  timeout: 30_000,
}, async () => {
  const [cordis, llm, sessions, projection, prompt, tools, agents, loop, skills, commands] = await Promise.all([
    load('cordis', 'vendor/cordis'), load('dsh-llm', 'packages/llm/llm'), load('dsh-session', 'packages/core/session'),
    load('dsh-session-projection', 'packages/session/session-projection'), load('dsh-system-prompt', 'packages/core/system-prompt'),
    load('dsh-tools', 'packages/core/tools'), load('dsh-agent', 'packages/core/agent'), load('dsh-agent-loop', 'packages/core/agent-loop'),
    load('dsh-skill', 'packages/skill/skill'), load('dsh-commands', 'packages/core/commands'),
  ])
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-native-')))
  execFileSync('git', ['init', '-q', root])
  const oldCwd = process.cwd()
  process.chdir(root)
  const oldData = process.env.KIOKUKO_DATA_DIR
  process.env.KIOKUKO_DATA_DIR = join(root, 'data')
  const otherRoot = join(root, 'other-project')
  await mkdir(otherRoot)
  execFileSync('git', ['init', '-q', otherRoot])
  const ctx = new cordis.Context()
  ctx.provide('connection', { fetch: { register: () => () => undefined } })
  let adapter: ReturnType<typeof createDshHostAdapter> | undefined
  let plugin: any
  let release: (() => void) | undefined
  try {
    for (const module of [llm, sessions, projection, tools, agents, skills, commands]) await ctx.plugin(module.default)
    await ctx.plugin(prompt.default, { persona: '' })
    await ctx.plugin(loop.default, { agents: [] })
    const mock = nativeMock(llm)
    class AgenticReplayModel extends mock.MockAdapter {
      override async *stream(request: any) {
        // Native completion may finalize memory between sessions; it must not
        // consume another session's conversational script.
        if (request.purpose === 'compaction') {
          yield* mock.textResponse(JSON.stringify({ schemaVersion: 1, memories: [] }))
          return
        }
        yield* super.stream(request)
      }
    }
    const model = new AgenticReplayModel([
      mock.toolCallResponse('prepare-a', TASK_PREPARE_TOOL, { taskType: 'research' }),
      mock.toolCallResponse('call-one', 'agenticreplay_test_tool', {}),
      mock.textResponse('A: fixture policy denied the tool result.'),
      mock.toolCallResponse('prepare-b', TASK_PREPARE_TOOL, { taskType: 'research' }),
      mock.toolCallResponse('pending', 'agenticreplay_test_tool', {}),
      mock.textResponse('B: fixture policy denied the pending tool result.'),
    ])
    ctx.llm.registerAdapter(['mock'], model)
    if (owner === 'explicit') {
      adapter = createDshHostAdapter(ctx, { repositoryRoot: root, agenticReplay: { enabled: true, askOnStart: true, shutdownDrainTimeoutMs: 1000 } })
      ctx.provide('kiokukoDsh', adapter.host)
    }
    plugin = ctx.plugin({ name: 'agenticreplay-fixture-plugin', apply: (context: any) => apply(context, { efficiency: { observe: true }, finalization: { inputMode: 'bounded_evidence' }, agenticReplay: { enabled: true, askOnStart: true, shutdownDrainTimeoutMs: 1000 } }) })
    await plugin
    const a = await ctx.agentLoop.create(sessions.SessionId('agenticreplay-a'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const b = await ctx.agentLoop.create(sessions.SessionId('agenticreplay-b'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const other = await ctx.agentLoop.create(sessions.SessionId('agenticreplay-other'), { provider: 'mock', model: 'mock' }, { cwd: otherRoot })
    const signal = new AbortController().signal
    const errors: unknown[] = []
    const results = new Map<string, any>()
    let toolCalls = 0
    ctx.on('agent/error', (event: any) => { errors.push(event.error) })
    ctx.on('tools/result', (execution: any, result: any) => { results.set(execution.callId, result) }, { global: true })
    const run = (agent: any) => {
      agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Research the fixture using agenticreplay_test_tool without Enno and report its result.' }] }))
      return agent.whenIdle()
    }
    const command = async (agent: any, text: string) => {
      const execution = await ctx.commands.execute(agent, `/kioku-agenticreplay ${text}`, [], signal)
      assert.equal(execution?.result.kind, 'success', JSON.stringify(execution))
      return JSON.parse(execution.result.text)
    }
    // Exact native agents/sessions are available before a Kiokuko logical run exists.
    const readableStatus = await ctx.commands.execute(a, '/kioku-agenticreplay status', [], signal)
    assert.equal(readableStatus.result.kind, 'success')
    assert.match(readableStatus.result.text, /^AgenticReplay: 未開始/u)
    assert.match(readableStatus.result.text, /\/kioku-agenticreplay start/u)
    const status = await command(a, 'status --json')
    assert.equal(status.capability, 'available')
    assert.equal(status.sessionRecording, 'awaiting_choice')
    // This fixture has no human question service; explicit commands authorize both sessions.
    await command(a, 'start')
    await command(b, 'start')
    ctx.tools.register({ name: 'agenticreplay_test_tool', description: 'fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_: unknown, text: string) => [{ type: 'text', text }] }, execute: () => { toolCalls++; return 'body-success' } })
    ctx.on('tools/post-execute', (execution: any, _result: any, next: any) => execution.name === 'agenticreplay_test_tool'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'fixture policy denial' }] } : next(), { global: true })
    await run(a)
    assert.deepEqual(errors, [])
    assert.equal(results.get('prepare-a')?.isError, false, JSON.stringify([...results]))
    assert.equal(toolCalls, 1, 'the tool body executes in the explicitly prepared native turn')
    assert.equal(results.get('call-one')?.isError, true)
    assert.match(JSON.stringify(results.get('call-one')), /fixture policy denial/u)
    await command(a, 'stop')
    const rows = await command(a, 'list')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'completed', JSON.stringify(rows))
    assert.equal(rows[0].store_root, root)
    const id = rows[0].agenticreplay_run_id
    const page = await command(a, `show ${id}`)
    assert.equal(page.events.filter((e: any) => e.type === 'model.request').length, 3)
    assert.equal(page.events.find((e: any) => e.type === 'tool.result' && e.attrs.name === 'agenticreplay_test_tool').attrs.is_error, true)
    assert.equal(page.events.find((e: any) => e.type === 'tool.result' && e.attrs.name === TASK_PREPARE_TOOL).attrs.is_error, false)
    const exported = await command(a, `export ${id}`)
    assert.ok((await readFile(exported.path, 'utf8')).includes('kiokuko-dsh'))
    const denied = await ctx.commands.execute(b, `/kioku-agenticreplay show ${id}`, [], signal)
    assert.equal(denied.result.text, 'trace_not_found')
    const deniedWorkspace = await ctx.commands.execute(other, `/kioku-agenticreplay show ${id}`, [], signal)
    assert.equal(deniedWorkspace.result.text, 'trace_not_found')
    assert.deepEqual(await command(other, 'list'), [])
    const bRowsBefore = await command(b, 'list')
    assert.equal(bRowsBefore.length, 1, 'history is scoped to the exact session even in one workspace')
    assert.notEqual(bRowsBefore[0].agenticreplay_run_id, id)
    const bId = bRowsBefore[0].agenticreplay_run_id
    const manifest = JSON.parse(await readFile(join(root, '.agenticreplay/runs', id, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.env_allowlisted, {})
    // Unload while a native pre-execute gate is pending. Results must still be observed.
    let entered!: () => void
    const pending = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.on('tools/pre-execute', async (execution: any, next: any) => {
      if (execution.callId === 'pending') { entered(); await gate }
      return next()
    }, { global: true })
    const executing = run(b)
    await Promise.race([pending, executing.then(() => { throw new Error(`Native turn ended before its pending tool gate: ${JSON.stringify([...results])}`) })])
    assert.equal(results.get('prepare-b')?.isError, false, JSON.stringify([...results]))
    assert.equal(toolCalls, 1, 'the pending tool has not dispatched before unload')
    let unloaded = false
    const unloading = plugin.dispose().then(() => { unloaded = true })
    try {
      // Allow shutdown to stop ingress while the native tool gate is held.
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(unloaded, false, 'plugin unload must drain the pending native tool result')
    } finally { release!() }
    await executing
    await unloading
    const bRows = adapter ? await adapter.host.agenticReplay!.withIndex(store => store.list('agenticreplay-b', workspaceKey(root))) : undefined
    // The explicit host owns its DB past shutdown, until its adapter is disposed.
    if (bRows) assert.equal(bRows[0]?.state, 'completed')
    const bEvents = (await readFile(join(root, '.agenticreplay/runs', bId, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(results.get('pending')?.isError, true, 'the drained call retains its final native policy result')
    assert.match(JSON.stringify(results.get('pending')), /fixture policy denial/u)
    assert.equal(bEvents.filter(e => e.type === 'model.request').length, 2, 'session B records only its preparation and tool request, with no session A calls')
    assert.equal(bEvents.filter(e => e.type === 'tool.result').length, 2, 'session B records only its own preparation and pending tool result')
    const pendingResults = bEvents.filter(e => e.type === 'tool.result' && e.attrs.name === 'agenticreplay_test_tool')
    assert.equal(pendingResults.length, 1, 'the final native tool result survives observer shutdown')
    assert.equal(pendingResults[0].attrs.is_error, true)
    assert.equal(bEvents.at(-1).type, 'run.end')
    assert.equal(bEvents.at(-1).attrs.reason, 'unload')
    assert.equal(bEvents.at(-1).attrs.unresolved_calls, 0)
    assert.equal(bEvents.at(-1).attrs.recording_complete, true)
  } finally {
    release?.()
    await plugin?.dispose()
    await adapter?.dispose()
    process.chdir(oldCwd)
    if (oldData === undefined) delete process.env.KIOKUKO_DATA_DIR; else process.env.KIOKUKO_DATA_DIR = oldData
    await rm(root, { recursive: true, force: true })
  }
})

// Isolate the plugin's startup deployment from the user's Skill directory.
isolateSkillHome()
