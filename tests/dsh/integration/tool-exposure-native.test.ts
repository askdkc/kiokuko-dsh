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
  const toolCalls: unknown[] = []
  let toolCallAt = 3
  const sse = (events: readonly Record<string, unknown>[]) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).hostname, 'api.openai.com')
    const bodyText = await request.text()
    requests.push({ url: request.url, bodyText, body: JSON.parse(bodyText) })
    if (requests.length === toolCallAt) {
      const item = { id: 'fc_fixture_external', type: 'function_call', status: 'completed', call_id: 'call_fixture_external', name: 'fixture_external', arguments: '{"message":"payload-1"}' }
      return sse([
        { type: 'response.created', response: { id: 'resp_fixture_tool_call' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"message":"payload-1"}' },
        { type: 'response.function_call_arguments.done', output_index: 0, arguments: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_fixture_tool_call', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ])
    }
    if (requests.length === toolCallAt + 1) {
      const item = { id: 'msg_fixture_final', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Tool result received.' }] }
      return sse([
        { type: 'response.created', response: { id: 'resp_fixture_final' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'Tool result received.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_fixture_final', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
      ])
    }
    return new Response(JSON.stringify({ error: { message: 'intentional recording fixture response' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  let fixtureTaskType = 'build'
  const questions = h.ctx.plugin({ name: 'tool-exposure-baseline-ui', apply(ctx: any) {
    return ctx.provide('userQuestions', { ask: async (request: any) => ({ answers: request.questions.map((question: any) => ({ id: question.id, selected: [({ taskType: fixtureTaskType, target: 'src/dsh/tool-exposure.ts', expected: 'phase-eligible tools are the only Kiokuko tools in the native request' } as Record<string, string>)[question.id] ?? '通常実行'] })) }) })
  } }); await questions
  const credentials = h.ctx.plugin({ name: 'tool-exposure-baseline-credentials', apply(ctx: any) {
    return ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }), read: async () => undefined, list: async () => [], registerOwner: () => () => {} })
  } }); await credentials
  const settings = h.ctx.plugin({ name: 'tool-exposure-baseline-settings', apply(ctx: any) {
    return ctx.provide('settings', { describe: (options: unknown) => {
      assert.deepEqual(options, { redactSecrets: true })
      return [{ ns: 'llm-pi-ai', value: { providers: { 'fixture-openai': { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-6-astra', contextWindow: 32768, maxTokens: 1024 }] } } } }]
    } })
  } }); await settings
  let wire: any, adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
  let disposeExternalTool: (() => void) | undefined
  try {
    wire = h.ctx.plugin(pi, { providers: { 'fixture-openai': { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'KIOKUKO_FIXTURE_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'gpt-6-astra', contextWindow: 32768, maxTokens: 1024 }] } } })
    await wire
    adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), toolExposure: { mode: 'full' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
    composition = await mountDshComposition(h.ctx, adapter.host)
    disposeExternalTool = (h.ctx as any).get('tools').register({
      name: 'fixture_external', description: 'Fixture-owned tool description must stay intact.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args: any) { toolCalls.push(args); return { received: args.message } },
    })
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
    const measure = (body: Record<string, any>, bodyText: string, toolNames: string[]) => ({ toolNames, systemBytes: Buffer.byteLength(JSON.stringify(body.instructions ?? body.system ?? '')), toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])), messagesBytes: Buffer.byteLength(JSON.stringify(body.input ?? body.messages ?? [])), bodyBytes: Buffer.byteLength(bodyText) })
    const full = measure(fullBody, requests[0]!.bodyText, modelFacingNames(fullBody))
    const phase = measure(phaseBody, requests[1]!.bodyText, phaseNames)
    assert.ok(phase.toolsBytes < full.toolsBytes)
    assert.ok(phase.bodyBytes < full.bodyBytes)
    const runtimePackage = JSON.parse(await readFile(join(packageRoot, '@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: string }
    const runtimeVersion = runtimePackage.version ?? 'unknown'
    if (process.env.KIOKUKO_EXPECTED_DSH_VERSION) assert.equal(runtimeVersion, process.env.KIOKUKO_EXPECTED_DSH_VERSION)
    let lean: ReturnType<typeof measure> | undefined
    let leanSavings: { tools: number; body: number } | undefined
    if (runtimeVersion === '0.2.0-rc.2') {
      await composition?.dispose(); composition = undefined
      await adapter?.dispose(); adapter = undefined
      adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), toolExposure: { mode: 'lean' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
      composition = await mountDshComposition(h.ctx, adapter.host)
      const leanAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-lean'), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
      const registry = (h.ctx as any).get('tools')
      const registeredSchemas = registry.schemas(leanAgent)
      const diagnostics: string[] = []
      const previousInfo = console.info
      console.info = (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); previousInfo(...args) }
      try { await turn(h, leanAgent, 'Inspect the repository and report the result.') } finally { console.info = previousInfo }
      assert.equal(requests.length, 4, `lean request path did not reach a final answer: ${diagnostics.join(' | ') || '(no diagnostics)'}`)
      const leanBody = requests[2]!.body
      const leanNames = modelFacingNames(leanBody)
      assert.deepEqual(leanNames, ['curator_check', 'memory_checkpoint'], `lean fallback diagnostics: ${diagnostics.join(' | ') || '(none)'}`)
      const toolFor = (body: Record<string, any>, name: string) => (body.tools as any[]).find(tool => tool.name === name || tool.function?.name === name)
      const descriptionFor = (tool: any) => tool?.description ?? tool?.function?.description
      const parametersFor = (tool: any) => tool?.parameters ?? tool?.function?.parameters
      assert.ok(descriptionFor(toolFor(fullBody, 'curator_check')).includes('Business payload:'))
      assert.ok(!descriptionFor(toolFor(leanBody, 'curator_check')).includes('Business payload:'))
      assert.deepEqual(parametersFor(toolFor(leanBody, 'curator_check')), parametersFor(toolFor(phaseBody, 'curator_check')))
      assert.equal(descriptionFor(toolFor(leanBody, 'fixture_external')), 'Fixture-owned tool description must stay intact.')
      assert.ok(diagnostics.join(' | ').includes('unownedSurfaceReductionCount'))
      assert.ok(diagnostics.join(' | ').includes('registration_provenance_unavailable'))
      assert.deepEqual(registry.schemas(leanAgent), registeredSchemas, 'assembly projection must not mutate registered tool schemas')
      assert.equal(toolCalls.length, 1)
      assert.deepEqual(toolCalls[0], { message: 'payload-1' })
      assert.ok(JSON.stringify(requests[3]!.body.input ?? requests[3]!.body.messages).includes('payload-1'), 'the next native request must contain the external tool result')
      lean = measure(leanBody, requests[2]!.bodyText, leanNames)
      assert.ok(lean.toolsBytes < phase.toolsBytes)
      assert.ok(lean.bodyBytes < phase.bodyBytes)
      leanSavings = { tools: phase.toolsBytes - lean.toolsBytes, body: phase.bodyBytes - lean.bodyBytes }
    }
    if (runtimeVersion === '0.2.0-rc.2') {
      for (const taskType of ['build', 'research', 'analysis', 'writing', 'review', 'chat']) {
        fixtureTaskType = taskType
        await composition?.dispose(); composition = undefined
        await adapter?.dispose(); adapter = undefined
        adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
        composition = await mountDshComposition(h.ctx, adapter.host)
        const autoAgent = await h.ctx.agentLoop.create(h.session.SessionId(`tool-exposure-auto-${taskType}`), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
        const before: number = requests.length
        if (taskType === 'research') toolCallAt = before + 1
        try { await turn(h, autoAgent, taskType === 'chat' ? 'Hello' : 'Inspect the repository and report the result.') } catch { /* Capture precedes intentional HTTP 400. */ }
        assert.equal(requests.length, before + (taskType === 'research' ? 2 : 1), taskType)
        if (taskType === 'research') {
          assert.equal(toolCalls.length, 2)
          assert.deepEqual(modelFacingNames(requests[before + 1]!.body), [])
          assert.ok(JSON.stringify(requests[before + 1]!.body).includes('payload-1'))
        }
        const body: Record<string, any> = requests[before]!.body
        assert.deepEqual(modelFacingNames(body), taskType === 'build' ? ['curator_check', 'memory_checkpoint'] : [], taskType)
        const external = (body.tools as any[]).find(tool => tool.name === 'fixture_external')
        assert.equal(external.description, 'Fixture-owned tool description must stay intact.')
      }
    }
    const report = { runtime: runtimeVersion, presentation: 'native', cases: lean ? ['normal-first-request', 'tool-call-result-final-answer'] : ['normal-first-request'], requests: { full, phase, ...(lean ? { lean } : {}) }, byteSavings: { phaseVsFull: { tools: full.toolsBytes - phase.toolsBytes, body: full.bodyBytes - phase.bodyBytes }, ...(leanSavings ? { leanVsPhase: leanSavings } : {}) }, ...(lean ? { appObservation: { transformedDescriptionCount: 2, unownedSurfaceReductionCount: 0, unownedSurfaceReductionReason: 'registration_provenance_unavailable' }, providerUsage: 'not measured; requests were intercepted before OpenAI' } : { providerUsage: 'unavailable' }), skipReason: null }
    console.info('TOOL_EXPOSURE_WIRE_REPORT', JSON.stringify(report))
  } finally {
    globalThis.fetch = nativeFetch
    disposeExternalTool?.()
    await composition?.dispose(); await adapter?.dispose(); await wire?.dispose(); await credentials.dispose(); await questions.dispose(); await h.dispose(); await settings.dispose()
  }
})
