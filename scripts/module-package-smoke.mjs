import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'

const [packagePath, nativeRoot, combination = 'core', intakeProbe = 'admitted'] = process.argv.slice(2)
assert.ok(['admitted', 'default'].includes(intakeProbe))
const packageRoot = realpathSync(packagePath)
const legacy = combination.endsWith('full')
const loaded = new Set()
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context) } })
const publicEntry = await import(pathToFileURL(join(packageRoot, legacy ? 'dist/index.js' : 'dist/dsh/configured.js')))
assert.equal(publicEntry.name, 'kiokuko-dsh')
assert.equal(typeof publicEntry.apply, 'function')
const core = legacy ? undefined : await import(pathToFileURL(join(packageRoot, 'dist/dsh/core/index.js')))
if (combination === 'core') assert.ok(![...loaded].some(url => /\/(enno-oduno|lisp|deep-thinker)\//.test(url)), 'core entry imports no optional implementation')
const imported = [...loaded].filter(url => url.startsWith(pathToFileURL(packageRoot).href))
const [cordis, llm, session, projection, systemPrompt, tools, agents, loop, skills, commands, tokenMeter, compaction] = await Promise.all(
  ['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'skill', 'commands', 'token-meter', 'compaction-basic'].map(name => import(pathToFileURL(join(nativeRoot, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')))))
class FixtureModel extends llm.LlmAdapter {
  requests = []
  script = []
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'fixture' }] }
  async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: semanticReady ? 20000 : 100000 } } }
  async *stream(options) {
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"schemaVersion":1,"memories":[]}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(options)
    const scripted = this.script.shift()
    if (scripted) { yield* typeof scripted === 'function' ? await scripted(options) : scripted; return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '確認しました。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '確認しました。' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const directory = realpathSync(await mkdtemp(join(tmpdir(), 'module-native-')))
await mkdir(join(directory, 'home'))
process.env.HOME = join(directory, 'home')
process.env.KIOKUKO_DATA_DIR = join(directory, 'data')
const ctx = new cordis.Context(), fibers = [], provider = new FixtureModel(), questions = []
const failures = []
const toolResults = new Map()
ctx.on('tools/result', (execution, result) => toolResults.set(execution.callId, result), { global: true })
const registeredCommands = new Map()
ctx.on('agent/error', payload => failures.push(String(payload.error?.stack ?? JSON.stringify(payload))))
let handle
let semanticReady = false, semanticCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body))
  if (!body.questions?.fruit && body.state?.policy !== 'semantic-results-v2') return new Response('', { status: 503 })
  if (body.state?.policy === 'semantic-results-v2') semanticCalls++
  return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    const choice = id === 'fruit' ? 'apple' : id === 'timing' ? 'compact' : 'shorten'
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
  })) })
}
try {
  for (const plugin of [llm, session, projection, systemPrompt, tools, agents, skills, commands, tokenMeter]) fibers.push(await ctx.plugin(plugin.default, plugin === systemPrompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  fibers.push(await ctx.plugin({ name: 'module-questions', apply(context) { context.provide('userQuestions', { async ask(request) { const question = request.questions[0]; questions.push(question.id); if (question.id === 'taskType') return { answers: [{ id: question.id, selected: ['文章作成'] }] }; throw new Error('Ordinary tasks must not open a module selection question') } }) } }))
  fibers.push(await ctx.plugin(compaction.default, { thresholdRatio: .8 }))
  fibers.push(await ctx.plugin({ name: 'semantic-fixture-credentials', apply(context) { context.provide('credentials', {
    resolve: async () => semanticReady ? { value: 'fixture-only', source: 'env' } : undefined,
    describe: async () => ({ configured: semanticReady, writable: false }),
  }) } }))
  ctx.llm.registerAdapter(['fixture'], provider)
  const registerCommand = ctx.commands.register.bind(ctx.commands)
  ctx.commands.register = definition => { registeredCommands.set(definition.name, definition); return registerCommand(definition) }
  // Both conversational and tool-backed consumers exercise the public default.
  const configuration = { repositoryRoot: directory, databasePath: join(directory, 'memory.sqlite3'), migrationsDirectory: join(packageRoot, 'migrations'), skillPrompts: { mode: 'compiled' } }
  if (legacy) {
    const prompts = new publicEntry.DshSkillPrompts({ mode: 'compiled' })
    const adapter = publicEntry.createDshHostAdapter(ctx, { ...configuration, skillPrompts: prompts, deepPlanning: { enabled: false }, agenticReplay: { enabled: false }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' } })
    const composition = await publicEntry.mountDshComposition(ctx, adapter.host, undefined, prompts)
    handle = { stopIngress: composition.stopIngress, async dispose() { await composition.dispose(); await adapter.dispose() } }
  } else {
    const plugin = await ctx.plugin(publicEntry, { ...configuration, ...(combination.includes('lisp') ? { modules: { lisp: { enabled: true } } } : {}) })
    handle = { dispose: () => plugin.dispose() }
  }
  const inventory = await ctx.skills.snapshot({ cwd: directory, signal: new AbortController().signal })
  assert.equal(inventory.complete, true)
  const names = inventory.skills.map(skill => skill.name)
  assert.ok(names.includes('kiokuko-soul'))
  assert.equal(names.includes('kiokuko-enno-oduno'), legacy || combination.includes('enno'))
  assert.equal(names.includes('kiokuko-lisp'), legacy || combination.includes('lisp'))
  const parent = await ctx.agentLoop.create(session.SessionId('module-fixture'), { provider: 'fixture', model: 'fixture' }, { cwd: directory })
  const hasTypeSafe = true
  assert.equal(ctx.commands.list(parent).filter(command => command.name === 'kioku-typesafe-key').length, hasTypeSafe ? 1 : 0)
  assert.equal(ctx.commands.list(parent).filter(command => command.name === 'kioku-decisions').length, 1)
  if (hasTypeSafe) {
    const status = await ctx.commands.execute(parent, '/kioku-typesafe-key status', [], new AbortController().signal)
    assert.equal(status.result.kind, 'success'); assert.match(status.result.text, /TypeSafe:/)
  }
  if (intakeProbe === 'default') {
    assert.equal(Object.hasOwn(configuration, 'intakeMode'), false)
    assert.equal(publicEntry.Config.parse({}).intakeMode, 'on-demand')
    parent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'この仕組みを日本語で説明してください。' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.deepEqual(failures, [])
    assert.equal(provider.requests.length, 1)
    assert.deepEqual(questions, [])
    const { openConnection } = await import(pathToFileURL(join(packageRoot, 'dist/db/connection.js')))
    const db = openConnection(configuration.databasePath)
    try {
      for (const table of ['ledger_runs', 'akinator_sessions', 'enno_contracts']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table)
    } finally { db.close() }
    console.log(JSON.stringify({ combination, status: 'passed', intakeProbe, nativeRequests: 1, liveModelQuality: 'unmeasured' }))
  } else {
  for (const task of ['こんにちは', 'この文章を要約してください', 'この仕組みを説明してください']) {
    const count = provider.requests.length
    parent.followup(llm.createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.ok(provider.requests.length > count, `native model path did not run: ${task}; ${JSON.stringify(failures)}; ${JSON.stringify(parent.session.snapshotEvents().filter(event => event.type === "turn/end"))}`)
  }
  assert.ok(questions.every(id => id === 'taskType'), 'No coding, Enno, Lisp or model selection questions')
  assert.ok(provider.requests.every(request => !JSON.stringify(request).includes('submit_ideal')), 'ordinary requests do not receive role directives')
  // Exercise memory lifecycle through the packed full/core native entry points.
  const { openConnection } = await import(pathToFileURL(join(packageRoot, 'dist/db/connection.js')))
  const { recordEntry } = await import(pathToFileURL(join(packageRoot, 'dist/memory/entries.js')))
  const database = openConnection(configuration.databasePath)
  let memory
  try {
    const workspace = database.prepare('SELECT r.workspace FROM repositories r JOIN repository_locations l ON l.repository_id=r.repository_id WHERE l.canonical_root=?').get(directory).workspace
    memory = recordEntry(database, {workspace,kind:'fact',title:'CYCLEPACK',body:'CYCLEPACK saved memory payload for native package verification.',scope:{visibility:'project'}})
  } finally { database.close() }
  const call = (id, name, args) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const nativeResult = (request, id) => request.messages.flatMap(message => message.role === 'tool' && message.toolCallId === id ? [message]
    : (message.content ?? []).filter(block => block.type === 'tool-result' && block.toolCallId === id)).at(-1)
  provider.script.push(request => {
    assert.ok(request.tools.some(tool => tool.name === 'prepare_requested_work'))
    return call('packed-prepare-memory', 'prepare_requested_work', { taskType: 'research' })
  }, async request => {
    const result = nativeResult(request, 'packed-prepare-memory')
    assert.equal(result.isError, false)
    assert.equal(JSON.parse(result.content[0].text).prepared, true)
    const explained = await ctx.commands.execute(parent, `/kioku-memory explain ${memory.id} --json`, [], new AbortController().signal)
    assert.equal(explained.result.kind, 'success', explained.result.text)
    assert.equal(JSON.parse(explained.result.text).evidenceStatus, 'details_unavailable')
    return call('packed-memory-explain', 'memory_explain', { entryId: memory.id })
  }, request => {
    const result = nativeResult(request, 'packed-memory-explain')
    assert.equal(result.isError, false)
    assert.ok(JSON.stringify(result.content).includes(memory.body))
    return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text: '出典を検証しました。' } }, { type: 'finish', reason: { kind: 'stop' } }]
  })
  parent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '通常実行で CYCLEPACK の出典を調査し、記憶ツールで根拠を検証してください。' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  assert.deepEqual(failures, [])
  parent.followup(llm.createUserMessage({content:[{type:'text',text:'CYCLEPACK の内容を確認してください'}],source:{kind:'user'}}))
  await parent.whenIdle()
  assert.ok(JSON.stringify(provider.requests.at(-1).messages).includes(memory.body), 'packed memory must be retrieved')
  const forgotten = await ctx.commands.execute(parent, `/kioku-memory forget ${memory.id} --revision 1 --json`, [], new AbortController().signal)
  assert.equal(forgotten.result.kind,'success',forgotten.result.text)
  parent.followup(llm.createUserMessage({content:[{type:'text',text:'CYCLEPACK の内容を確認してください'}],source:{kind:'user'}}))
  await parent.whenIdle()
  assert.ok(!JSON.stringify(provider.requests.at(-1).messages).includes(memory.body), 'packed forgotten memory cannot reach the next request')
  const forgottenRead = await ctx.commands.execute(parent, `/kioku-memory explain ${memory.id} --json`, [], new AbortController().signal)
  assert.equal(forgottenRead.result.kind,'error')
  const runTools = async (agent, task, operations) => {
    const preparation = `prepare-${operations[0][0]}`
    provider.script.push(call(preparation, 'prepare_requested_work', { taskType: 'research' }),
      request => {
        const result = nativeResult(request, preparation)
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(JSON.parse(result.content[0].text).prepared, true)
        return call(...operations[0])
      }, ...operations.slice(1).map(operation => call(...operation)))
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: `通常実行で ${task}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.deepEqual(failures, [])
    return operations.map(([id]) => {
      const result = toolResults.get(id)
      assert.ok(result, `Missing native result: ${id}`)
      return result
    })
  }
  // Start with a web demand against the installed package, without a prepare call.
  const webParent = await ctx.agentLoop.create(session.SessionId('packed-web-first'), { provider: 'fixture', model: 'fixture' }, { cwd: directory })
  const webBodies = []
  const releaseWeb = ctx.tools.register({ name: 'web_search', description: 'Harmless web search fixture.', parameters: { queries: { type: 'array', items: { type: 'string' }, required: true } }, output: { schema: {}, render: () => [] }, execute(args, execution) {
    assert.equal(execution.agent, webParent)
    webBodies.push({ callId: execution.callId, args })
    return 'packed web fixture'
  } })
  provider.script.push(call('packed-first-web', 'web_search', { queries: ['VMware Tools critical CVE'] }))
  webParent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'vmware toolsの最新の脆弱性でクリティカルレベルのものある？' }], source: { kind: 'user' } }))
  await webParent.whenIdle()
  assert.deepEqual(failures, [])
  assert.equal(toolResults.get('packed-first-web').isError, false)
  assert.deepEqual(webBodies, [{ callId: 'packed-first-web', args: { queries: ['VMware Tools critical CVE'] } }])
  releaseWeb()
  // Exercise the delivered full/core coordinator, not an imported test-only instance.
  semanticReady = true
  const message = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  // Exercise native pressure with a payload inside the decision-provider byte limit.
  const resultText = 'stale packed fixture output. '.repeat(6000)
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: message('packed-first', 'こんにちは') },
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'user/message', data: message(`packed-initial-${i}`, 'Keep initial requirements.') })),
    { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { id: 'packed-call', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: 'packed-old', name: 'read', arguments: '{}' }] } } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { ...llm.createToolResultMessage({ callId: 'packed-old', content: [{ type: 'text', text: resultText }], isError: false }), id: 'packed-result' } } },
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'user/message', data: message(`packed-recent-${i}`, 'Keep recent evidence.') })),
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' } },
  ].map((event, seq) => ({ ...event, seq, time: seq, ...(['user/message', 'assistant/message', 'tool/result'].includes(event.type) ? { surfaceOp: 'append' } : {}) }))
  const packedHandle = await ctx.agents.create({ sessionId: session.SessionId('packed-compaction'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: directory }, seed: events })
  try {
    packedHandle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'こんにちは' }], source: { kind: 'user' } }))
    await packedHandle.agent.whenIdle()
    const packedEvents = packedHandle.agent.session.snapshotEvents()
    const status = await registeredCommands.get('kioku-decisions').handler({ rawInput: 'status', agent: packedHandle.agent, signal: new AbortController().signal })
    assert.equal(JSON.parse(status.text).semanticCompaction.last.outcome, 'shortened', status.text)
    assert.equal(semanticCalls, 1, 'one coordinator classifies this native step')
    assert.equal(packedEvents.filter(event => event.type === 'compaction/prune').length, 1)
    assert.equal(packedEvents.filter(event => event.type === 'tool/result').length, 2)
    assert.equal(packedEvents.some(event => event.type === 'compaction/end'), false)
  } finally { await packedHandle.dispose(); semanticReady = false }
  // The delivered auxiliary reader must work independently of classifier readiness.
  const observationEvents = structuredClone(events)
  observationEvents.splice(9, 0, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'packed-old', name: 'read', arguments: '{}' } })
  observationEvents.forEach((event, seq) => { event.seq = seq; event.time = seq })
  observationEvents[10].sourceEventSeqs = [9]
  for (const seq of [13, 14]) observationEvents[seq] = { seq, time: seq, type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: { id: `full-observation-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Read the full original.' }] } } }
  const observationAgent = await ctx.agents.create({ sessionId: session.SessionId('packed-observation'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: directory }, seed: observationEvents })
  try {
    observationAgent.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'こんにちは' }], source: { kind: 'user' } }))
    await observationAgent.agent.whenIdle()
    const output = nativeResult(provider.requests.at(-1), 'packed-old').content[0].text
    assert.match(output, /^\[Kiokuko ObservationPack v1\]/)
    const reference = JSON.parse(output.split('\n')[1])
    const [page] = await runTools(observationAgent.agent, 'observation_read で保存済みの元の出力を調べてください。',
      [['packed-original-read', 'observation_read', { handle: reference.handle, offset: 100000, limit: 80 }]])
    assert.equal(page.isError, false, JSON.stringify(page))
    assert.equal(page.value.text, resultText.slice(100000, 100080))
    const status = JSON.parse((await registeredCommands.get('kioku-decisions').handler({ rawInput: 'status', agent: observationAgent.agent, signal: new AbortController().signal })).text)
    assert.equal(status.observationPack.mode, 'auto'); assert.equal(status.observationPack.metrics.packed, 1)
    assert.equal(status.observationPack.metrics.reads, 1); assert.equal(status.semanticCompaction.preemptive, true)
    assert.equal(semanticCalls, 1, 'packing and original retrieval do not call Jev')
  } finally { await observationAgent.dispose() }
  if (combination.includes('lisp')) {
    let effects = 0
    const removeProbe = ctx.tools.register({ name: 'module_fixture_write', description: 'fixture effect', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
    const enabled = await registeredCommands.get('kioku-lisp').handler({ rawInput: 'enable', agent: parent, signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)
    const artifact = JSON.parse(await readFile(join(packageRoot, 'dist/dsh/skill-prompts.json'), 'utf8'))
    const expected = artifact.resources.find(resource => resource.id === 'kiokuko-lisp/SKILL.md').content
    const beforeLispRequest = provider.requests.length
    parent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Explain the available Lisp coding contract.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.ok(provider.requests.length > beforeLispRequest, 'Lisp activation must reach a subsequent native model request')
    const delivered = provider.requests.at(-1)
    const deliveredText = [delivered.system ?? '', ...delivered.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))].join('\n')
    assert.ok(deliveredText.includes(expected), 'the packed core+Lisp model receives the complete compiled contract')
    assert.ok(expected.includes('settle testable doubts'), 'the package contains the new mandatory contract')
    const arguments_ = { operationId: 'packed-eval', code: '(+ 20 22)' }
    const [result, discovery, status, replay] = await runTools(parent, 'protected Lisp で (+ 20 22) を実行し、TypeSafeの状態と保存済みの実行結果を検証してください。', [
      ['packed-lisp-eval', 'lisp_eval', arguments_],
      ['packed-typesafe-discovery', 'lisp_describe', { operationId: 'typesafe-discovery' }],
      ['packed-typesafe-status', 'lisp_eval', { operationId: 'typesafe-status', code: '(kioku.typesafe:status)' }],
      ['packed-lisp-replay', 'lisp_eval', arguments_],
    ])
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.equal(result.value.ok, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /42/)
    assert.equal(discovery.value.ok, true, JSON.stringify(discovery))
    assert.ok(JSON.stringify(discovery).includes('kioku.typesafe:evaluate'), JSON.stringify(discovery))
    assert.equal(status.value.ok, true, JSON.stringify(status))
    assert.equal(typeof status.value.value.json.configured, 'boolean')
    assert.equal(replay.value.replay, true, 'exact completed effects must not execute twice')
    await handle.dispose(); handle = undefined
    assert.equal(ctx.commands.list(parent).some(command => command.name === 'kioku-typesafe-key'), false)
    const blocked = await ctx.tools.execute({ callId: 'packed-after-stop', name: 'module_fixture_write', arguments: {}, agent: parent, signal: new AbortController().signal })
    assert.equal(blocked.isError, true, 'stopping the module must retain the protected session fence')
    assert.equal(effects, 0)
    removeProbe()
  }
  await handle?.dispose(); handle = undefined
  assert.equal(ctx.commands.list(parent).some(command => command.name === 'kioku-typesafe-key'), false)
  const first = provider.requests[0]
  const system = first.system ?? first.messages.filter(message => message.role === 'system').flatMap(message => message.content).map(block => block.text ?? '').join('\n')
  console.log(JSON.stringify({ combination, status: 'passed', nativeRequests: provider.requests.length, skills: names, startupModules: imported.map(url => url.slice(pathToFileURL(packageRoot).href.length + 1)), constantPromptBytes: Buffer.byteLength(system), protectedLisp: combination.includes('lisp'), semanticCompaction: semanticCalls === 1, liveModelQuality: 'unmeasured' }))
  }
} finally {
  globalThis.fetch = originalFetch
  await handle?.dispose()
  for (const fiber of fibers.reverse()) await fiber?.dispose?.()
  await rm(directory, { recursive: true, force: true })
}
