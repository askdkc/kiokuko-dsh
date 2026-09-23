import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { DSH_MODEL_FACING_OPERATIONS } from '../../../src/dsh/tools.js'

const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeAvailable = sourceRoot !== undefined || existsSync(join(packageRoot, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !nativeAvailable) throw new Error('Mandatory native tool-exposure coverage requires the pinned DSH runtime')
function modulePath(name: string, source: string) {
  return pathToFileURL(sourceRoot !== undefined ? join(sourceRoot, source, 'lib/index.js') : join(packageRoot, '@deepseek-ai', name, 'lib/index.js')).href
}
async function harness() {
  const [cordis, llm, session, projection, prompt, tools, agents, loop, skills, subagents, spawn] = await Promise.all([
    import(modulePath('cordis', 'vendor/cordis')), import(modulePath('dsh-llm', 'packages/llm/llm')),
    import(modulePath('dsh-session', 'packages/core/session')), import(modulePath('dsh-session-projection', 'packages/session/session-projection')),
    import(modulePath('dsh-system-prompt', 'packages/core/system-prompt')), import(modulePath('dsh-tools', 'packages/core/tools')),
    import(modulePath('dsh-agent', 'packages/core/agent')), import(modulePath('dsh-agent-loop', 'packages/core/agent-loop')),
    import(modulePath('dsh-skill', 'packages/skill/skill')), import(modulePath('dsh-subagent', 'packages/subagent/subagent')),
    import(modulePath('dsh-subagent-spawn-in-process', 'packages/subagent/subagent-spawn-in-process')),
  ])
  const ctx = new cordis.Context(), fibers: any[] = []
  for (const [plugin, config] of [[llm.default], [session.default], [projection.default], [prompt.default, { persona: '' }], [tools.default], [agents.default], [skills.default], [loop.default, { agents: [] }], [subagents.default], [spawn, { providerName: 'spawn' }]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber
  }
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-tool-exposure-'))
  return { ctx, llm, session, root, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function turn(h: Awaited<ReturnType<typeof harness>>, agent: any, text: string) {
  agent.followup(h.llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

test('native full-mode baseline captures Kiokuko tool definitions after the real provider serializer', { skip: !nativeAvailable ? 'requires the pinned DSH runtime' : false, timeout: 30_000 }, async () => {
  const h = await harness()
  const pi = await import(modulePath('dsh-llm-pi-ai', 'packages/llm/llm-pi-ai'))
  const requests: { url: string; bodyText: string; body: Record<string, any> }[] = []
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).hostname, 'fixture.invalid')
    const bodyText = await request.text()
    requests.push({ url: request.url, bodyText, body: JSON.parse(bodyText) })
    return new Response(JSON.stringify({ error: { message: 'intentional recording fixture response' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const questions = h.ctx.plugin({ name: 'tool-exposure-baseline-ui', apply(ctx: any) {
    return ctx.provide('userQuestions', { ask: async (request: any) => ({ answers: request.questions.map((question: any) => ({ id: question.id, selected: [({ taskType: 'build', target: 'src/dsh/tool-exposure.ts', expected: 'phase-eligible tools are the only Kiokuko tools in the native request' } as Record<string, string>)[question.id] ?? '通常実行'] })) }) })
  } }); await questions
  const credentials = h.ctx.plugin({ name: 'tool-exposure-baseline-credentials', apply(ctx: any) {
    return ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }), read: async () => undefined, list: async () => [], registerOwner: () => () => {} })
  } }); await credentials
  let wire: any, adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
  try {
    wire = h.ctx.plugin(pi, { providers: { 'fixture-openai': { api: 'openai-responses', baseURL: 'https://fixture.invalid/v1', apiKeyEnv: 'KIOKUKO_FIXTURE_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'gpt-6-astra', contextWindow: 32768, maxTokens: 1024 }] } } })
    await wire
    adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
    composition = await mountDshComposition(h.ctx, adapter.host)
    const modelFacingNames = (body: Record<string, any>) => {
      const names = (Array.isArray(body.tools) ? body.tools : []).map((tool: any) => typeof tool.name === 'string' ? tool.name : tool.function?.name).filter((name: unknown): name is string => typeof name === 'string')
      return [...DSH_MODEL_FACING_OPERATIONS].filter(name => names.includes(name)).sort()
    }
    const fullAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-baseline'), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
    try { await turn(h, fullAgent, 'Inspect the repository and report the result.') } catch { /* The fake provider deliberately returns HTTP 400 after capture. */ }
    const fullBody = requests[0]?.body
    assert.ok(fullBody)
    assert.deepEqual(modelFacingNames(fullBody), [...DSH_MODEL_FACING_OPERATIONS].sort())
    await composition?.dispose(); composition = undefined
    await adapter?.dispose(); adapter = undefined
    adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), toolExposure: { mode: 'phase' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
    composition = await mountDshComposition(h.ctx, adapter.host)
    const phaseAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-phase'), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
    const phaseWarnings: string[] = []
    const previousWarn = console.warn
    console.warn = (...args: unknown[]) => { phaseWarnings.push(args.map(String).join(' ')); previousWarn(...args) }
    try { await turn(h, phaseAgent, 'Inspect the repository and report the result.') } catch { /* The fake provider deliberately returns HTTP 400 after capture. */ } finally { console.warn = previousWarn }
    assert.equal(requests.length, 2)
    const phaseBody = requests[1]!.body
    const phaseNames = modelFacingNames(phaseBody)
    assert.deepEqual(phaseNames, ['curator_check', 'memory_checkpoint'], `phase fallback diagnostics: ${phaseWarnings.join(' | ') || '(none)'}`)
    assert.deepEqual(phaseBody.input ?? phaseBody.messages, fullBody.input ?? fullBody.messages)
    const lock = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    const measure = (body: Record<string, any>, bodyText: string, toolNames: string[]) => ({ toolNames, systemBytes: Buffer.byteLength(JSON.stringify(body.instructions ?? body.system ?? '')), toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])), messagesBytes: Buffer.byteLength(JSON.stringify(body.input ?? body.messages ?? [])), bodyBytes: Buffer.byteLength(bodyText) })
    const full = measure(fullBody, requests[0]!.bodyText, modelFacingNames(fullBody))
    const phase = measure(phaseBody, requests[1]!.bodyText, phaseNames)
    assert.ok(phase.toolsBytes < full.toolsBytes)
    assert.ok(phase.bodyBytes < full.bodyBytes)
    const report = { runtime: lock.packages['node_modules/@deepseek-ai/dsh']?.version ?? 'unknown', presentation: 'native', cases: ['normal-first-request'], requests: { full, phase }, byteSavings: { tools: full.toolsBytes - phase.toolsBytes, body: full.bodyBytes - phase.bodyBytes }, usage: 'unavailable', skipReason: null }
    console.info('TOOL_EXPOSURE_WIRE_REPORT', JSON.stringify(report))
  } finally {
    globalThis.fetch = nativeFetch
    await composition?.dispose(); await adapter?.dispose(); await wire?.dispose(); await credentials.dispose(); await questions.dispose(); await h.dispose()
  }
})
