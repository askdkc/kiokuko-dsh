import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter as sourceAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition as sourceComposition } from '../../../src/dsh/composition.js'
import { DSH_MODEL_FACING_OPERATIONS } from '../../../src/dsh/tools.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'

const packedEntry = process.env.KIOKUKO_TOOL_EXPOSURE_ENTRY
const packed = packedEntry ? await import(pathToFileURL(packedEntry).href) : undefined
if (packedEntry) {
  assert.equal(typeof packed?.createDshHostAdapter, 'function', 'packed public entry must expose the tested adapter')
  assert.equal(typeof packed?.mountDshComposition, 'function', 'packed public entry must expose the tested composition')
}
const createDshHostAdapter: typeof sourceAdapter = packed?.createDshHostAdapter ?? sourceAdapter
const mountDshComposition: typeof sourceComposition = packed?.mountDshComposition ?? sourceComposition

const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const nativeAvailable = sourceRoot !== undefined || existsSync(join(packageRoot, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !nativeAvailable) throw new Error('Mandatory native tool-exposure coverage requires the pinned DSH runtime')
const runtimeVersion = nativeAvailable ? (JSON.parse(await readFile(join(packageRoot, '@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: string }).version ?? 'unknown' : 'unavailable'
const expectedRuntimeVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION
  ?? JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
if (nativeAvailable) assert.equal(runtimeVersion, expectedRuntimeVersion)
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
  { name: 'responses', api: 'openai-responses', host: 'https://api.openai.com', path: '/v1/responses', provider: 'fixture-openai', model: 'gpt-6-astra' },
  { name: 'chat-completions', api: 'openai-completions', host: 'https://api.openai.com', path: '/v1/chat/completions', provider: 'fixture-unknown', model: 'gpt-6-astra' },
  { name: 'anthropic', api: 'anthropic-messages', host: 'https://api.anthropic.com', path: '/v1/messages', provider: 'fixture-anthropic', model: 'claude-fixture' },
  { name: 'deepseek', api: 'native-messages', host: 'https://api.deepseek.com', path: '/anthropic/v1/messages', provider: 'deepseek-official', model: 'deepseek-flash' },
] as const
async function verifyNativeToolExposure(protocol: typeof protocols[number]) {
  const h = await harness()
  const pi = await import(modulePath('dsh-llm-pi-ai', 'packages/llm/llm-pi-ai'))
  const requests: { url: string; bodyText: string; body: Record<string, any> }[] = []
  const toolCalls: unknown[] = []
  const unexpectedRequests: string[] = []
  let roundtrip: 'capture' | 'prepare' | 'tool-call' | 'final-answer' = 'capture'
  let afterPreparation: 'capture' | 'tool-call' = 'capture'
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
    if (new URL(request.url).origin + new URL(request.url).pathname !== `${protocol.host}${protocol.path}`) unexpectedRequests.push(request.url)
    assert.equal(new URL(request.url).origin + new URL(request.url).pathname, `${protocol.host}${protocol.path}`)
    assert.equal(request.method, 'POST')
    const bodyText = await request.text()
    const body = JSON.parse(bodyText)
    assert.equal(body.stream, true)
    assert.ok(Array.isArray(body.tools))
    if (protocol.name === 'responses') {
      assert.ok(Array.isArray(body.input))
      assert.ok(body.tools.every((tool: any) => tool.type === 'function' && typeof tool.name === 'string' && !tool.function))
    } else if (protocol.name === 'chat-completions') {
      assert.ok(Array.isArray(body.messages))
      assert.ok(body.tools.every((tool: any) => tool.type === 'function' && typeof tool.function?.name === 'string' && !tool.name))
    }
    if (protocol.name === 'deepseek' || protocol.name === 'anthropic') {
      assert.ok(Array.isArray(body.messages))
      assert.ok(body.tools.every((tool: any) => typeof tool.name === 'string' && tool.input_schema))
    }
    requests.push({ url: request.url, bodyText, body })
    const preparing = roundtrip === 'prepare'
    const toolName = preparing ? TASK_PREPARE_TOOL : 'fixture_external'
    const toolArguments = preparing ? JSON.stringify({ taskType: fixtureTaskType }) : '{"message":"payload-1"}'
    const toolCallId = preparing ? 'call_fixture_prepare' : 'call_fixture_external'
    if (preparing) {
      const names = body.tools.map((tool: any) => tool.name ?? tool.function?.name)
      assert.ok(names.includes(TASK_PREPARE_TOOL), 'first answer-first request exposes public preparation')
      assert.deepEqual(names.filter((name: any) => DSH_MODEL_FACING_OPERATIONS.includes(name)).sort(), [...DSH_MODEL_FACING_OPERATIONS].sort(), 'unprepared first request must not pretend a task phase has been selected')
    }
    if ((protocol.name === 'deepseek' || protocol.name === 'anthropic') && roundtrip !== 'capture') {
      const calling = preparing || roundtrip === 'tool-call'
      roundtrip = preparing ? afterPreparation : calling ? 'final-answer' : 'capture'
      return sse([
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: protocol.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: calling ? { type: 'tool_use', id: toolCallId, name: toolName, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: calling ? { type: 'input_json_delta', partial_json: toolArguments } : { type: 'text_delta', text: 'Tool result received.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: calling ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ])
    }

    if (protocol.name === 'chat-completions' && roundtrip !== 'capture') {
      const calling = preparing || roundtrip === 'tool-call'
      roundtrip = preparing ? afterPreparation : calling ? 'final-answer' : 'capture'
      const chunks = [
        { index: 0, delta: calling
          ? { role: 'assistant', tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: toolName, arguments: '' } }] }
          : { role: 'assistant', content: 'Tool result received.' }, finish_reason: null },
        { index: 0, delta: calling ? { tool_calls: [{ index: 0, function: { arguments: toolArguments } }] } : {}, finish_reason: calling ? 'tool_calls' : 'stop' },
      ]
      return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: calling ? 'chat_fixture_tool' : 'chat_fixture_final', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [choice] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    if (preparing || roundtrip === 'tool-call') {
      roundtrip = preparing ? afterPreparation : 'final-answer'
      const item = { id: 'fc_fixture_external', type: 'function_call', status: 'completed', call_id: toolCallId, name: toolName, arguments: toolArguments }
      return sse([
        { type: 'response.created', response: { id: 'resp_fixture_tool_call' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: toolArguments },
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
  const preparedTurn = async (agent: any, executeExternal = false) => {
    roundtrip = 'prepare'; afterPreparation = executeExternal ? 'tool-call' : 'capture'
    await turn(h, agent, 'Inspect the repository and report the result.')
    const events = agent.session.snapshotEvents()
    const call = events.flatMap((event: any) => event.type === 'assistant/message' ? event.data.message.content : []).find((block: any) => block.type === 'tool-call' && block.name === TASK_PREPARE_TOOL)
    const preparation = events.find((event: any) => event.type === 'tool/result' && event.data.message.toolCallId === call?.id)
    assert.ok(preparation && !preparation.data.message.isError, 'public preparation must execute successfully before phase assertions')
  }
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
        throw new Error('Optional settings metadata unavailable')
      } })
    } }); await settings
    if (protocol.name === 'deepseek') {
      const deepseek = await import(modulePath('dsh-llm-deepseek', 'packages/llm/llm-deepseek'))
      const options = deepseek.resolveAdapterOptions({ baseURL: `${protocol.host}/anthropic`, models: [{ id: protocol.model, contextWindow: 32768, maxTokens: 1024 }], maxTokens: 1024, thinking: 'enabled', reasoningEffort: 'high', retryPolicy: { mode: 'normal', maxRetries: 0 } })
      wire = h.ctx.plugin({ name: 'fixture-deepseek-wire', inject: ['llm'], apply(ctx: any) {
        return ctx.llm.registerAdapter([protocol.provider], new deepseek.DeepSeekAdapter({ options: () => options,
          discoverModels: async (provider: string) => [{ provider, id: protocol.model, name: protocol.model }],
          resolveAuth: async () => ({ headers: { 'x-api-key': 'fixture-token' } }), resolveUserId: () => 'fixture-user',
          prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) }))
      } })
    } else {
      wire = h.ctx.plugin(pi, { providers: { [protocol.provider]: { api: protocol.api, baseURL: protocol.name === 'anthropic' ? protocol.host : `${protocol.host}/v1`, apiKeyEnv: 'KIOKUKO_FIXTURE_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: protocol.model, contextWindow: 32768, maxTokens: 1024 }] } } })
    }
    await wire
    adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode: 'full' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
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
    const fullAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-baseline'), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
    try { await preparedTurn(fullAgent) } catch { /* The fake provider deliberately returns HTTP 400 after capture. */ }
    const fullBody = requests[1]?.body
    assert.ok(fullBody)
    assert.deepEqual(modelFacingNames(fullBody), [...DSH_MODEL_FACING_OPERATIONS].sort())
    await composition?.dispose(); composition = undefined
    await adapter?.dispose(); adapter = undefined
    adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode: 'phase' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
    composition = await mountDshComposition(h.ctx, adapter.host)
    const phaseAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-phase'), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
    const phaseWarnings: string[] = []
    const previousWarn = console.warn
    console.warn = (...args: unknown[]) => { phaseWarnings.push(args.map(String).join(' ')); previousWarn(...args) }
    try { await preparedTurn(phaseAgent) } catch { /* The fake provider deliberately returns HTTP 400 after capture. */ } finally { console.warn = previousWarn }
    assert.equal(requests.length, 4)
    const phaseBody = requests[3]!.body
    const phaseNames = modelFacingNames(phaseBody)
    assert.deepEqual(phaseNames, ['curator_check', 'memory_checkpoint'], `phase fallback diagnostics: ${phaseWarnings.join(' | ') || '(none)'}`)
    assert.deepEqual(phaseBody.input ?? phaseBody.messages, fullBody.input ?? fullBody.messages)
    const externalTools = (body: Record<string, any>) => (body.tools as any[]).filter(tool => !DSH_MODEL_FACING_OPERATIONS.includes(tool.name ?? tool.function?.name))
    const toolFor = (body: Record<string, any>, name: string) => (body.tools as any[]).find(tool => tool.name === name || tool.function?.name === name)
    const descriptionFor = (tool: any) => tool?.description ?? tool?.function?.description
    const parametersFor = (tool: any) => tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters
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
      } else if (protocol.name === 'deepseek' || protocol.name === 'anthropic') {
        const blocks = next.messages.flatMap((message: any) => message.content)
        assert.ok(blocks.some((block: any) => block.type === 'thinking' && block.thinking === 'Fixture reasoning.' && block.signature === 'fixture-signature'), 'thinking and signature must survive tool-result replay')
        assert.ok(blocks.some((block: any) => block.type === 'tool_use' && block.id === 'call_fixture_external'))
        assert.ok(blocks.some((block: any) => block.type === 'tool_result' && block.tool_use_id === 'call_fixture_external' && JSON.stringify(block.content).includes('payload-1')))
      } else {
        const call = next.messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.some((tool: any) => tool.id === 'call_fixture_external' && tool.function.name === 'fixture_external'))
        const result = next.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_fixture_external')
        assert.ok(call, 'Chat Completions must preserve the assistant tool call')
        assert.ok(result, 'Chat Completions must serialize the tool-role result with its call ID')
        assert.ok(JSON.stringify(result.content).includes('payload-1'))
      }
    }
    const measure = (body: Record<string, any>, bodyText: string, toolNames: string[]) => ({ toolNames, toolCount: body.tools.length, systemBytes: Buffer.byteLength(JSON.stringify(protocol.name === 'responses' ? body.instructions ?? '' : protocol.name === 'chat-completions' ? body.messages.filter((message: any) => message.role === 'system' || message.role === 'developer') : body.system ?? '')), toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])), messagesBytes: Buffer.byteLength(JSON.stringify(body.input ?? body.messages ?? [])), bodyBytes: Buffer.byteLength(bodyText) })
    const full = measure(fullBody, requests[1]!.bodyText, modelFacingNames(fullBody))
    const phase = measure(phaseBody, requests[3]!.bodyText, phaseNames)
    assert.ok(phase.toolsBytes < full.toolsBytes)
    assert.ok(phase.bodyBytes < full.bodyBytes)
    let lean: ReturnType<typeof measure> | undefined
    let leanTools: unknown
    let leanSavings: { tools: number; body: number } | undefined
    if (nativeAvailable) {
      await composition?.dispose(); composition = undefined
      await adapter?.dispose(); adapter = undefined
      adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode: 'lean' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
      composition = await mountDshComposition(h.ctx, adapter.host)
      const leanAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-lean'), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
      const registry = (h.ctx as any).get('tools')
      const registeredSchemas = registry.schemas(leanAgent)
      const diagnostics: string[] = []
      const previousInfo = console.info
      console.info = (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); previousInfo(...args) }
      const leanBefore = requests.length
      try { await preparedTurn(leanAgent, true) } finally { console.info = previousInfo }
      assert.equal(requests.length, leanBefore + 3, `lean request path did not reach a final answer: ${diagnostics.join(' | ') || '(no diagnostics)'}`)
      const leanBody = requests[leanBefore + 1]!.body
      const leanNames = modelFacingNames(leanBody)
      leanTools = leanBody.tools
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
      assertRoundtrip(leanAgent, leanBefore + 1, leanNames)
      lean = measure(leanBody, requests[leanBefore + 1]!.bodyText, leanNames)
      assert.ok(lean.toolsBytes < phase.toolsBytes)
      assert.ok(lean.bodyBytes < phase.bodyBytes)
      leanSavings = { tools: phase.toolsBytes - lean.toolsBytes, body: phase.bodyBytes - lean.bodyBytes }
    }
    const auto: (ReturnType<typeof measure> & { taskType: string; requestedMode: 'auto'; effectiveMode: 'lean' | 'minimal' })[] = []
    let fullResearch: ReturnType<typeof measure> | undefined
    if (nativeAvailable) {
      fixtureTaskType = 'research'
      await composition?.dispose(); composition = undefined
      await adapter?.dispose(); adapter = undefined
      adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode: 'full' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
      composition = await mountDshComposition(h.ctx, adapter.host)
      const fullResearchAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-full-research'), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
      const fullResearchBefore = requests.length
      try { await preparedTurn(fullResearchAgent) } catch { /* Capture precedes intentional HTTP 400. */ }
      assert.equal(requests.length, fullResearchBefore + 2)
      const fullResearchBody = requests[fullResearchBefore + 1]!.body
      assert.deepEqual(modelFacingNames(fullResearchBody), [...DSH_MODEL_FACING_OPERATIONS].sort(), 'explicit full must override research minimization')
      assertExternalTools(fullResearchBody)
      fullResearch = measure(fullResearchBody, requests[fullResearchBefore + 1]!.bodyText, modelFacingNames(fullResearchBody))
      for (const [taskType, effectiveMode] of [
        ['build', 'lean'], ['debug', 'lean'], ['devops', 'lean'],
        ['research', 'minimal'], ['analysis', 'minimal'], ['writing', 'minimal'], ['review', 'minimal'],
      ] as const) {
        fixtureTaskType = taskType
        await composition?.dispose(); composition = undefined
        await adapter?.dispose(); adapter = undefined
        adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
        composition = await mountDshComposition(h.ctx, adapter.host)
        const autoAgent = await h.ctx.agentLoop.create(h.session.SessionId(`tool-exposure-auto-${taskType}`), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
        const before: number = requests.length
        const registry = (h.ctx as any).get('tools')
        const registeredSchemas = registry.schemas(autoAgent)
        const diagnostics: string[] = []
        const previousInfo = console.info
        console.info = (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); previousInfo(...args) }
        try {
          if (taskType === 'research') {
            await preparedTurn(autoAgent, true)
          } else {
            try { await preparedTurn(autoAgent) } catch { /* Capture precedes intentional HTTP 400. */ }
          }
        } finally { console.info = previousInfo }
        assert.ok(diagnostics.some(line => line.includes(`"requestedMode":"auto","mode":"${effectiveMode}"`) && line.includes(`:${taskType}:`)), `observed task/mode must match ${taskType}/${effectiveMode}`)
        assert.deepEqual(registry.schemas(autoAgent), registeredSchemas, 'auto must not mutate registered schemas')
        assert.equal(requests.length, before + (taskType === 'research' ? 3 : 2), taskType)
        if (taskType === 'research') {
          assert.equal(toolCalls.length, 2)
          assert.deepEqual(toolCalls[1], { message: 'payload-1' })
          assertRoundtrip(autoAgent, before + 1, [])
        }
        const body: Record<string, any> = requests[before + 1]!.body
        const expectedNames = effectiveMode === 'lean' ? ['curator_check', 'memory_checkpoint'] : []
        assert.deepEqual(modelFacingNames(body), expectedNames, taskType)
        assertExternalTools(body)
        const measurement = { taskType, requestedMode: 'auto' as const, effectiveMode, ...measure(body, requests[before + 1]!.bodyText, expectedNames) }
        assert.ok(measurement.toolsBytes < (taskType === 'research' ? fullResearch.toolsBytes : full.toolsBytes))
        if (effectiveMode === 'lean') assert.deepEqual(body.tools, leanTools, `${taskType} auto must match explicit lean`)
        auto.push(measurement)
      }
    }
    if (nativeAvailable) {
      const chatAgent = await h.ctx.agentLoop.create(h.session.SessionId('tool-exposure-auto-chat'), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
      const before = requests.length
      roundtrip = 'final-answer'
      await turn(h, chatAgent, 'Hello')
      assert.equal(requests.length, before + 1)
      assert.deepEqual(modelFacingNames(requests[before]!.body), [...DSH_MODEL_FACING_OPERATIONS].sort(), 'text-only auto request has no prepared task phase')
      assertExternalTools(requests[before]!.body)
      const state = await adapter!.host.runtime!.withDatabase(db => db.prepare('SELECT COUNT(*) AS n FROM ledger_runs WHERE dsh_session_id=?').get<{ n: number }>(chatAgent.session.id))
      assert.equal(state?.n, 0, 'answer-only turn must not create execution intake')
      assert.ok(completedSessions.has(chatAgent.session.id))
    }
    if (nativeAvailable && protocol.name === 'deepseek') {
      fixtureTaskType = 'build'
      for (const mode of ['auto', 'lean', 'phase'] as const) {
        await composition?.dispose(); composition = undefined
        await adapter?.dispose(); adapter = undefined
        adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
        composition = await mountDshComposition(h.ctx, adapter.host)
        const registry = (h.ctx as any).get('tools')
        const originalGet = registry.get
        const warnings: string[] = []
        const previousWarn = console.warn
        console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); previousWarn(...args) }
        registry.get = function(name: string, ...args: unknown[]) {
          const definition = originalGet.call(this, name, ...args)
          return name === 'curator_check' && definition ? { ...definition, execute: async () => undefined } : definition
        }
        try {
          for (let index = 0; index < 2; index++) {
            const collisionAgent = await h.ctx.agentLoop.create(h.session.SessionId(`tool-exposure-${mode}-collision-${index}`), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
            const before: number = requests.length
            try { await preparedTurn(collisionAgent) } catch { /* Capture precedes intentional HTTP 400. */ }
            assert.equal(requests.length, before + 2)
            assert.deepEqual(requests[before + 1]!.body.tools, fullBody.tools, 'ownership collisions must retain the entire full surface')
          }
          assert.equal(warnings.filter(line => line.includes(`surface unchanged: ${mode}:ownership_unknown`)).length, 1, 'each adapter must warn once with the actual requested mode')
          assert.ok(warnings.every(line => !/model_route_unavailable|unsupported_route/.test(line)))
        } finally { registry.get = originalGet; console.warn = previousWarn }
      }
      await composition?.dispose(); composition = undefined
      await adapter?.dispose(); adapter = undefined
      adapter = createDshHostAdapter(h.ctx, { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' }, toolExposure: { mode: 'lean' }, llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } })
      composition = await mountDshComposition(h.ctx, adapter.host)
      for (const failure of ['model_binding_unavailable', 'unsupported_schema', 'unsupported_runtime', 'ptc', 'both'] as const) {
        const agent = await h.ctx.agentLoop.create(h.session.SessionId(`tool-exposure-fallback-${failure}`), { provider: protocol.provider, model: protocol.model }, { cwd: h.root })
        let originalTools: unknown, observedTools: unknown
        const mutate = agent.ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
          const result = await next()
          if (roundtrip === 'prepare') return result
          const runCode = { name: 'run_code', description: 'Execute PTC', parameters: { type: 'object' } }
          const tools = failure === 'unsupported_schema' ? result.tools.map((tool: any) => tool.name === 'curator_check' ? { ...tool, description: 'Unrecognized description format' } : tool)
            : failure === 'unsupported_runtime' ? [...result.tools, null]
            : failure === 'ptc' ? [runCode] : failure === 'both' ? [...result.tools, runCode] : result.tools
          originalTools = tools
          return { ...result, tools, ...(failure === 'model_binding_unavailable' ? { variables: { ...result.variables, provider: undefined } } : {}) }
        })
        const observe = agent.ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
          const result = await next(); observedTools = result.tools; return result
        }, { prepend: true })
        const warnings: string[] = []
        const previousWarn = console.warn
        console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); previousWarn(...args) }
        try {
          try { await preparedTurn(agent) } catch { /* Invalid injected assembly or intentional HTTP 400. */ }
          assert.ok(originalTools, 'the native assembly must reach the injected failure')
          assert.strictEqual(observedTools, originalTools, `${failure} must retain the exact native tool array`)
          const reason = failure === 'ptc' || failure === 'both' ? 'unsupported_presentation' : failure
          // PTC and both share one reason on this adapter.
          assert.equal(warnings.filter(line => line.includes(`surface unchanged: lean:${reason}`)).length, failure === 'both' ? 0 : 1)
        } finally { mutate(); observe(); console.warn = previousWarn }
      }
    }
    const report = { runtime: runtimeVersion, protocol: protocol.name, presentation: 'native', cases: lean ? ['answer-first-request', 'prepared-request', 'tool-call-result-final-answer'] : ['answer-first-request', 'prepared-request'], requests: { full, phase, ...(lean ? { lean } : {}), ...(fullResearch ? { fullResearch } : {}), auto }, measurementFields: { system: protocol.name === 'responses' ? 'instructions' : protocol.name === 'chat-completions' ? 'system/developer messages' : 'system', messages: protocol.name === 'responses' ? 'input' : protocol.name === 'chat-completions' ? 'messages (including system/developer)' : 'messages' }, byteSavings: { phaseVsFull: { tools: full.toolsBytes - phase.toolsBytes, body: full.bodyBytes - phase.bodyBytes }, ...(lean && leanSavings ? { leanVsPhase: leanSavings, leanVsFull: { tools: full.toolsBytes - lean.toolsBytes, body: full.bodyBytes - lean.bodyBytes } } : {}) }, ...(lean ? { appObservation: { transformedDescriptionCount: 2, unownedSurfaceReductionCount: 0, unownedSurfaceReductionReason: 'registration_provenance_unavailable' }, providerUsage: 'not measured; requests were intercepted before the provider' } : { providerUsage: 'unavailable' }), skipReason: null }
    assert.deepEqual(unexpectedRequests, [], 'unexpected external requests must fail even when a host degradation catches the fetch error')
    console.info('TOOL_EXPOSURE_WIRE_REPORT', JSON.stringify(report))
  } finally {
    globalThis.fetch = nativeFetch
    disposeExternalTool?.()
    disposeEvents()
    await composition?.dispose(); await adapter?.dispose(); await wire?.dispose(); await settings?.dispose(); await credentials?.dispose(); await questions?.dispose(); await h.dispose()
  }
}

// Each case replaces global fetch, so keep protocol cases serial.
for (const protocol of protocols) {
  test(`native ${protocol.name} serializer preserves task-aware tool exposure and external execution`, { concurrency: false, skip: !nativeAvailable ? 'requires the canonical current DSH runtime' : false, timeout: 30_000 }, () => verifyNativeToolExposure(protocol))
}
