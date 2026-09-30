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

const protocols = [
  { name: 'responses', api: 'openai-responses', path: '/v1/responses' },
  { name: 'chat-completions', api: 'openai-completions', path: '/v1/chat/completions' },
] as const
async function verifyNativeToolExposure(protocol: typeof protocols[number]) {
  const h = await harness()
  const pi = await import(modulePath('dsh-llm-pi-ai', 'packages/llm/llm-pi-ai'))
  const requests: { url: string; bodyText: string; body: Record<string, any> }[] = []
  const toolCalls: unknown[] = []
  let roundtrip: 'capture' | 'tool-call' | 'final-answer' = 'capture'
  const completedSessions = new Set<string>()
  const finalAnswers = new Map<string, string>()
  const disposeEvents = h.ctx.on('session/event', (session: any, event: any) => {
    if (event.type === 'assistant/message') {
      finalAnswers.set(session.id, event.data.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''))
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') completedSessions.add(session.id)
  })
  const sse = (events: readonly Record<string, unknown>[]) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, `https://api.openai.com${protocol.path}`)
    assert.equal(request.method, 'POST')
    const bodyText = await request.text()
    const body = JSON.parse(bodyText)
    assert.equal(body.stream, true)
    assert.ok(Array.isArray(body.tools))
    if (protocol.name === 'responses') {
      assert.ok(Array.isArray(body.input))
      assert.ok(body.tools.every((tool: any) => tool.type === 'function' && typeof tool.name === 'string' && !tool.function))
    } else {
      assert.ok(Array.isArray(body.messages))
      assert.ok(body.tools.every((tool: any) => tool.type === 'function' && typeof tool.function?.name === 'string' && !tool.name))
    }
    requests.push({ url: request.url, bodyText, body })
    if (protocol.name === 'chat-completions' && roundtrip !== 'capture') {
      const calling = roundtrip === 'tool-call'
      roundtrip = calling ? 'final-answer' : 'capture'
      const chunks = [
        { index: 0, delta: calling
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_external', type: 'function', function: { name: 'fixture_external', arguments: '' } }] }
          : { role: 'assistant', content: 'Tool result received.' }, finish_reason: null },
        { index: 0, delta: calling ? { tool_calls: [{ index: 0, function: { arguments: '{"message":"payload-1"}' } }] } : {}, finish_reason: calling ? 'tool_calls' : 'stop' },
      ]
      return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: calling ? 'chat_fixture_tool' : 'chat_fixture_final', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [choice] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    if (roundtrip === 'tool-call') {
      roundtrip = 'final-answer'
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
    if (roundtrip === 'final-answer') {
      roundtrip = 'capture'
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
  let questions: any, credentials: any, settings: any
  let wire: any, adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
  let disposeExternalTool: (() => void) | undefined
  try {
    questions = h.ctx.plugin({ name: 'tool-exposure-baseline-ui', apply(ctx: any) {
      return ctx.provide('userQuestions', { ask: async (request: any) => ({ answers: request.questions.map((question: any) => ({ id: question.id, selected: [({ taskType: fixtureTaskType, target: 'src/dsh/tool-exposure.ts', expected: 'phase-eligible tools are the only Kiokuko tools in the native request' } as Record<string, string>)[question.id] ?? '通常実行'] })) }) })
    } }); await questions
    credentials = h.ctx.plugin({ name: 'tool-exposure-baseline-credentials', apply(ctx: any) {
      return ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }), read: async () => undefined, list: async () => [], registerOwner: () => () => {} })
    } }); await credentials
    settings = h.ctx.plugin({ name: 'tool-exposure-baseline-settings', apply(ctx: any) {
      return ctx.provide('settings', { describe: (options: unknown) => {
        assert.deepEqual(options, { redactSecrets: true })
        return [{ ns: 'llm-pi-ai', value: { providers: { 'fixture-openai': { api: protocol.api, baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-6-astra', contextWindow: 32768, maxTokens: 1024 }] } } } }]
      } })
    } }); await settings
    wire = h.ctx.plugin(pi, { providers: { 'fixture-openai': { api: protocol.api, baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'KIOKUKO_FIXTURE_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'gpt-6-astra', contextWindow: 32768, maxTokens: 1024 }] } } })
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
    const externalTools = (body: Record<string, any>) => (body.tools as any[]).filter(tool => !DSH_MODEL_FACING_OPERATIONS.includes(tool.name ?? tool.function?.name))
    const toolFor = (body: Record<string, any>, name: string) => (body.tools as any[]).find(tool => tool.name === name || tool.function?.name === name)
    const descriptionFor = (tool: any) => tool?.description ?? tool?.function?.description
    const parametersFor = (tool: any) => tool?.parameters ?? tool?.function?.parameters
    const assertExternalTools = (body: Record<string, any>) => assert.deepEqual(externalTools(body), externalTools(fullBody), 'all native/external definitions, schemas and relative order must survive')
    assertExternalTools(phaseBody)
    const assertRoundtrip = (agent: any, before: number, expectedNames: string[]) => {
      assert.equal(requests.length, before + 2, 'external execution must reach a final answer without another request')
      assert.equal(roundtrip, 'capture', 'both successful SSE responses must be consumed')
      assert.ok(completedSessions.has(agent.session.id), 'the native loop must complete the turn')
      assert.equal(finalAnswers.get(agent.session.id), 'Tool result received.', 'the serializer must deliver the final assistant text')
      for (const request of requests.slice(before)) {
        assert.deepEqual(modelFacingNames(request.body), expectedNames)
        assertExternalTools(request.body)
      }
      const next = requests[before + 1]!.body
      if (protocol.name === 'responses') {
        const result = next.input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'call_fixture_external')
        assert.ok(result, 'Responses must serialize the external tool result with its call ID')
        assert.ok(result.output.includes('payload-1'))
      } else {
        const call = next.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.some((tool: any) => tool.id === 'call_fixture_external' && tool.function.name === 'fixture_external'))
        const result = next.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_fixture_external')
        assert.ok(call, 'Chat Completions must preserve the assistant tool call')
        assert.ok(result, 'Chat Completions must serialize the tool-role result with its call ID')
        assert.ok(JSON.stringify(result.content).includes('payload-1'))
      }
    }
    const measure = (body: Record<string, any>, bodyText: string, toolNames: string[]) => ({ toolNames, toolCount: body.tools.length, systemBytes: Buffer.byteLength(JSON.stringify(protocol.name === 'responses' ? body.instructions ?? '' : body.messages.filter((message: any) => message.role === 'system' || message.role === 'developer'))), toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])), messagesBytes: Buffer.byteLength(JSON.stringify(body.input ?? body.messages ?? [])), bodyBytes: Buffer.byteLength(bodyText) })
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
      roundtrip = 'tool-call'
      try { await turn(h, leanAgent, 'Inspect the repository and report the result.') } finally { console.info = previousInfo }
      assert.equal(requests.length, 4, `lean request path did not reach a final answer: ${diagnostics.join(' | ') || '(no diagnostics)'}`)
      const leanBody = requests[2]!.body
      const leanNames = modelFacingNames(leanBody)
      assert.deepEqual(leanNames, ['curator_check', 'memory_checkpoint'], `lean fallback diagnostics: ${diagnostics.join(' | ') || '(none)'}`)
      assert.ok(descriptionFor(toolFor(fullBody, 'curator_check')).includes('Business payload:'))
      assert.ok(!descriptionFor(toolFor(leanBody, 'curator_check')).includes('Business payload:'))
      assert.deepEqual(parametersFor(toolFor(leanBody, 'curator_check')), parametersFor(toolFor(phaseBody, 'curator_check')))
      assert.equal(descriptionFor(toolFor(leanBody, 'fixture_external')), 'Fixture-owned tool description must stay intact.')
      assert.ok(diagnostics.join(' | ').includes('unownedSurfaceReductionCount'))
      assert.ok(diagnostics.join(' | ').includes('registration_provenance_unavailable'))
      assert.deepEqual(registry.schemas(leanAgent), registeredSchemas, 'assembly projection must not mutate registered tool schemas')
      assert.equal(toolCalls.length, 1)
      assert.deepEqual(toolCalls[0], { message: 'payload-1' })
      assertRoundtrip(leanAgent, 2, leanNames)
      lean = measure(leanBody, requests[2]!.bodyText, leanNames)
      assert.ok(lean.toolsBytes < phase.toolsBytes)
      assert.ok(lean.bodyBytes < phase.bodyBytes)
      leanSavings = { tools: phase.toolsBytes - lean.toolsBytes, body: phase.bodyBytes - lean.bodyBytes }
    }
    const auto: (ReturnType<typeof measure> & { taskType: string; requestedMode: 'auto'; effectiveMode: 'lean' | 'minimal' })[] = []
    let fullResearch: ReturnType<typeof measure> | undefined
    if (runtimeVersion === '0.2.0-rc.2') {
      fixtureTaskType = 'research'
      await composition?.dispose(); composition = undefined
      await adapter?.dispose(); adapter = undefined
      adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), toolExposure: { mode: 'full' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
      composition = await mountDshComposition(h.ctx, adapter.host)
      const fullResearchAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-full-research'), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
      const fullResearchBefore = requests.length
      try { await turn(h, fullResearchAgent, 'Inspect the repository and report the result.') } catch { /* Capture precedes intentional HTTP 400. */ }
      assert.equal(requests.length, fullResearchBefore + 1)
      const fullResearchBody = requests[fullResearchBefore]!.body
      assert.deepEqual(modelFacingNames(fullResearchBody), [...DSH_MODEL_FACING_OPERATIONS].sort(), 'explicit full must override research minimization')
      assertExternalTools(fullResearchBody)
      fullResearch = measure(fullResearchBody, requests[fullResearchBefore]!.bodyText, modelFacingNames(fullResearchBody))
      for (const [taskType, effectiveMode] of [
        ['build', 'lean'], ['debug', 'lean'], ['devops', 'lean'],
        ['research', 'minimal'], ['analysis', 'minimal'], ['writing', 'minimal'], ['review', 'minimal'], ['chat', 'minimal'],
      ] as const) {
        fixtureTaskType = taskType
        await composition?.dispose(); composition = undefined
        await adapter?.dispose(); adapter = undefined
        adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
        composition = await mountDshComposition(h.ctx, adapter.host)
        const autoAgent = await h.ctx.agentLoop.create(h.session.SessionId(`tool-exposure-auto-${taskType}`), { provider: 'fixture-openai', model: 'gpt-6-astra' }, { cwd: h.root })
        const before: number = requests.length
        const registry = (h.ctx as any).get('tools')
        const registeredSchemas = registry.schemas(autoAgent)
        const diagnostics: string[] = []
        const previousInfo = console.info
        console.info = (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); previousInfo(...args) }
        try {
          if (taskType === 'research') {
            roundtrip = 'tool-call'
            await turn(h, autoAgent, 'Inspect the repository and report the result.')
          } else {
            try { await turn(h, autoAgent, taskType === 'chat' ? 'Hello' : 'Inspect the repository and report the result.') } catch { /* Capture precedes intentional HTTP 400. */ }
          }
        } finally { console.info = previousInfo }
        assert.ok(diagnostics.some(line => line.includes(`"requestedMode":"auto","mode":"${effectiveMode}"`) && line.includes(`:${taskType}:`)), `observed task/mode must match ${taskType}/${effectiveMode}`)
        assert.deepEqual(registry.schemas(autoAgent), registeredSchemas, 'auto must not mutate registered schemas')
        assert.equal(requests.length, before + (taskType === 'research' ? 2 : 1), taskType)
        if (taskType === 'research') {
          assert.equal(toolCalls.length, 2)
          assert.deepEqual(toolCalls[1], { message: 'payload-1' })
          assertRoundtrip(autoAgent, before, [])
        }
        const body: Record<string, any> = requests[before]!.body
        const expectedNames = effectiveMode === 'lean' ? ['curator_check', 'memory_checkpoint'] : []
        assert.deepEqual(modelFacingNames(body), expectedNames, taskType)
        assertExternalTools(body)
        const measurement = { taskType, requestedMode: 'auto' as const, effectiveMode, ...measure(body, requests[before]!.bodyText, expectedNames) }
        assert.ok(measurement.toolsBytes < (taskType === 'research' ? fullResearch.toolsBytes : full.toolsBytes))
        if (effectiveMode === 'lean') assert.deepEqual(body.tools, requests[2]!.body.tools, `${taskType} auto must match explicit lean`)
        auto.push(measurement)
      }
    }
    const report = { runtime: runtimeVersion, protocol: protocol.name, presentation: 'native', cases: lean ? ['normal-first-request', 'tool-call-result-final-answer'] : ['normal-first-request'], requests: { full, phase, ...(lean ? { lean } : {}), ...(fullResearch ? { fullResearch } : {}), auto }, measurementFields: { system: protocol.name === 'responses' ? 'instructions' : 'system/developer messages', messages: protocol.name === 'responses' ? 'input' : 'messages (including system/developer)' }, byteSavings: { phaseVsFull: { tools: full.toolsBytes - phase.toolsBytes, body: full.bodyBytes - phase.bodyBytes }, ...(leanSavings ? { leanVsPhase: leanSavings } : {}) }, ...(lean ? { appObservation: { transformedDescriptionCount: 2, unownedSurfaceReductionCount: 0, unownedSurfaceReductionReason: 'registration_provenance_unavailable' }, providerUsage: 'not measured; requests were intercepted before OpenAI' } : { providerUsage: 'unavailable' }), skipReason: null }
    console.info('TOOL_EXPOSURE_WIRE_REPORT', JSON.stringify(report))
  } finally {
    globalThis.fetch = nativeFetch
    disposeExternalTool?.()
    disposeEvents()
    await composition?.dispose(); await adapter?.dispose(); await wire?.dispose(); await settings?.dispose(); await credentials?.dispose(); await questions?.dispose(); await h.dispose()
  }
}

// Both cases replace global fetch, so keep protocol cases serial.
for (const protocol of protocols) {
  test(`native ${protocol.name} serializer preserves task-aware tool exposure and external execution`, { concurrency: false, skip: !nativeAvailable ? 'requires the pinned DSH runtime' : false, timeout: 30_000 }, () => verifyNativeToolExposure(protocol))
}
