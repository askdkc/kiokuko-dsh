import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { installDshModelRouting } from '../../../src/dsh/model-routing.js'
import { MODEL_ROLES, MODEL_TEMPLATES, type ModelBinding } from '../../../src/dsh/model-configuration.js'
import { nativeMock } from '../helpers/native-mock.js'
import { loadJapaneseOutputSkill } from '../../../src/dsh/japanese-output-skill.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packageRoot && !sourceRoot) throw new Error('Model routing coverage requires the pinned DSH runtime')
function modulePath(name: string, source: string) {
  return pathToFileURL(packageRoot ? join(packageRoot, '@deepseek-ai', name, 'lib/index.js') : join(sourceRoot!, source, 'lib/index.js')).href
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
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-model-native-'))
  return { ctx, llm, session, root, mock: nativeMock(llm), dispose: async () => { for (const f of fibers.reverse()) await f.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function turn(h: Awaited<ReturnType<typeof harness>>, agent: any, text: string) {
  agent.followup(h.llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
test('native routing delivers the full Japanese Skill to selected OSS models and removes it on model changes', {
  skip: !packageRoot && !sourceRoot, timeout: 30_000,
}, async () => {
  const h = await harness(), skill = await loadJapaneseOutputSkill()
  const models = ['deepseek-chat','moonshotai/kimi-k2','z-ai/glm-4.6','qwen3-coder:30b','tencent/HY3-preview','xiaomi/MiMo-V2','MiniMaxAI/MiniMax-M2']
  const provider = new h.mock.MockAdapter([...models,'gpt-4.1'].map(()=>h.mock.textResponse('確認しました。')))
  h.ctx.llm.registerAdapter(['gateway'],provider)
  const agent = await h.ctx.agentLoop.create(h.session.SessionId('japanese-routing'), {provider:'gateway',model:'gpt-4.1'}, {cwd:h.root})
  let selection: ModelBinding | undefined
  const dispose = installDshModelRouting(agent, async()=>selection)
  const systemText = (request:any) => request.system ?? request.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.content).map((block:any)=>block.text??'').join('\n')
  try {
    for(const model of models) {
      selection={provider:'gateway',model}
      const input='この設計を説明してください。`max_threads` は変更しないでください。'
      await turn(h,agent,input)
      const request=provider.requests.at(-1)!
      assert.equal(request.model,model)
      const prompt=systemText(request)
      assert.ok(prompt.includes(skill.content),model)
      assert.equal(prompt.split(skill.content).length,2,model)
      assert.ok(request.messages.some((m:any)=>m.role==='user'&&m.content.some((b:any)=>b.type==='text'&&b.text===input)))
    }
    selection=undefined;await turn(h,agent,'Answer in English.')
    assert.equal(provider.requests.length,8)
    assert.equal(provider.requests.at(-1)!.model,'gpt-4.1')
    assert.equal(systemText(provider.requests.at(-1)).includes(skill.content),false)
  } finally {dispose();await h.dispose()}
})
test('native README normal execution: cancel, plugin reload, original input recovery, write, verification and fresh next-task choice', {
  skip: !packageRoot && !sourceRoot, timeout: 30_000,
}, async () => {
  const h = await harness()
  await writeFile(join(h.root, 'README.md'), 'before\n')
  let writes = 0, questionCount = 0
  const edit = h.ctx.tools.register({ name: 'edit_readme', description: 'Apply the requested README correction.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: async () => { writes++; await writeFile(join(h.root, 'README.md'), 'after\n'); assert.equal(await readFile(join(h.root, 'README.md'), 'utf8'), 'after\n'); return 'README edit verified' },
  })
  const model = new h.mock.MockAdapter([h.mock.toolCallResponse('edit-1', 'edit_readme', {}), h.mock.textResponse('READMEを修正し、内容を検証しました。'), h.mock.textResponse('次の修正も完了しました。')])
  h.ctx.llm.registerAdapter(['ordinary'], model)
  const questions = h.ctx.plugin({ name: 'selection-test-ui', apply(ctx: any) { return ctx.provide('userQuestions', { ask: async (request: any) => {
    const question = request.questions[0]; assert.equal(question.id, 'enno-execution-mode'); questionCount++
    return { answers: [{ id: question.id, selected: [questionCount === 1 ? '取消・作業を保持' : '通常実行'] }] }
  } }) } }); await questions
  const options = { repositoryRoot: h.root, databasePath: join(h.root, 'state.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'),
    llm: { async *stream() { throw new Error('Optional memory backend unavailable in this fixture') } } }
  let adapter = createDshHostAdapter(h.ctx, options)
  let composition = await mountDshComposition(h.ctx, adapter.host)
  const agent = await h.ctx.agentLoop.create(h.session.SessionId('normal-session'), { provider: 'ordinary', model: 'mock' }, { cwd: h.root })
  try {
    await turn(h, agent, 'README.mdを修正してください。')
    assert.equal(model.requests.length, 0)
    assert.equal(writes, 0)
    assert.equal(await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT COUNT(*) AS n FROM enno_contracts').get()?.n), 0)
    await composition.dispose(); await adapter.dispose()
    adapter = createDshHostAdapter(h.ctx, options); composition = await mountDshComposition(h.ctx, adapter.host)
    await turn(h, agent, '続けてください。')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(writes, 1)
    assert.equal(questionCount, 2)
    assert.equal(model.requests.length, 2)
    assert.ok(JSON.stringify(model.requests[0].messages).includes('README.mdを修正してください。'))
    assert.equal(model.requests.every(r => r.provider === 'ordinary' && r.model === 'mock'), true)
    const counts = await adapter.host.runtime!.withDatabase(db => ['enno_contracts', 'dsh_turn_receipts', 'dsh_continuation_outbox'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n))
    assert.deepEqual(counts, [0, 0, 0])
    await turn(h, agent, 'README.mdの追記も実装してください。')
    assert.equal(questionCount, 3)
  } finally { await composition.dispose(); await adapter.dispose(); edit(); await questions.dispose(); await h.dispose() }
})
test('native loop and spawn route every template role, freeze assembly, isolate sessions and restore the ordinary model', {
  skip: !packageRoot && !sourceRoot, timeout: 30_000,
}, async () => {
  const h = await harness()
  let active: ModelBinding | undefined
  const script = new h.mock.MockAdapter(Array.from({ length: MODEL_TEMPLATES.length * MODEL_ROLES.length + 2 }, () => h.mock.textResponse('verified')))
  const providers = ['ordinary', ...MODEL_TEMPLATES.map(t => `route-${t.id}`)]
  h.ctx.llm.registerAdapter(providers, script)
  const parent = await h.ctx.agentLoop.create(h.session.SessionId('matrix-parent'), { provider: 'ordinary', model: 'ordinary' }, { cwd: h.root })
  const other = await h.ctx.agentLoop.create(h.session.SessionId('matrix-other'), { provider: 'ordinary', model: 'other' }, { cwd: h.root })
  const route = installDshModelRouting(parent, async () => active)
  const observed: { provider: string; model: string }[] = []
  const assembly = parent.ctx.on('system-prompt/assemble', async (_a: unknown, _c: unknown, next: () => Promise<any>) => {
    const result = await next(); observed.push(result.variables); return result
  }, { prepend: true })
  try {
    for (const template of MODEL_TEMPLATES) {
      for (const role of MODEL_ROLES.filter(role => role !== 'worker')) {
        active = { provider: `route-${template.id}`, model: template.models[role][0]! }
        await turn(h, parent, `${template.id}:${role}`)
        const request = script.requests.at(-1)!
        assert.equal(request.provider, active.provider); assert.equal(request.model, active.model)
        assert.equal(request.reasoningEffort, undefined)
        assert.equal(observed.at(-1)?.model, active.model)
      }
      const child = await h.ctx.subagents.start('spawn', { parent, signal: new AbortController().signal,
        agentOptions: { provider: `route-${template.id}`, model: template.models.worker[0]! }, maxDepth: 1,
        toolFilter: { allow: [] }, prompt: [{ type: 'text', text: 'Return verification evidence only.' }] })
      try { assert.equal((await child.result).stopReason, 'completed'); assert.equal(script.requests.at(-1)?.model, template.models.worker[0]); assert.equal(script.requests.at(-1)?.sessionId, child.id) } finally { await child.dispose() }
    }
    await turn(h, other, 'independent'); assert.equal(script.requests.at(-1)?.model, 'other')
    active = undefined
    await turn(h, parent, 'ordinary conversation'); assert.equal(script.requests.at(-1)?.model, 'ordinary')
  } finally { assembly(); route(); await h.dispose() }
})
test('pinned pi-ai wire adapter: Astra Responses, Go parent/child/auxiliary session headers, and no Ollama download', {
  skip: !packageRoot && !sourceRoot, timeout: 30_000,
}, async () => {
  const h = await harness()
  const pi = await import(modulePath('dsh-llm-pi-ai', 'packages/llm/llm-pi-ai'))
  const requests: { url: string; headers: Headers; body: any }[] = []
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).hostname, 'fixture.invalid')
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) })
    return new Response(JSON.stringify({ error: { message: 'intentional recording fixture response' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const credentials = h.ctx.plugin({ name: 'fixture-credentials', apply(ctx: any) {
    return ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }), read: async () => undefined, list: async () => [], registerOwner: () => () => {} })
  } }); await credentials
  let adapter: any
  try {
    adapter = h.ctx.plugin(pi, { providers: Object.fromEntries([
      ['astra-wire', 'openai-responses', 'gpt-6-astra'], ['go-wire', 'openai-completions', 'glm-5.3'], ['ollama-wire', 'openai-completions', 'qwen3-coder:30b'],
    ].map(([provider, api, model]) => [provider, { api, baseURL: `https://fixture.invalid/${provider}/v1`, apiKeyEnv: 'KIOKUKO_FIXTURE_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: model, contextWindow: 32768, maxTokens: 1024 }] }])) })
    await adapter
    for (const [provider, model, sessionId, purpose] of [
      ['astra-wire', 'gpt-6-astra', 'parent', undefined], ['go-wire', 'glm-5.3', 'parent', undefined],
      ['go-wire', 'glm-5.3', 'child', undefined], ['go-wire', 'glm-5.3', 'parent', 'session-title'],
      ['ollama-wire', 'qwen3-coder:30b', 'local-child', undefined],
    ]) {
      try { for await (const _chunk of h.ctx.llm.stream({ provider, model, sessionId, ...(purpose ? { purpose } : {}),
        messages: [h.llm.createUserMessage({ content: [{ type: 'text', text: 'transport fixture' }], source: { kind: 'user' } })],
        tools: [{ name: 'read', description: 'Read fixture', parameters: { type: 'object', properties: {} } }],
      })) { /* Inspect actual HTTP requests, never claim provider success. */ } } catch { /* fixture returns 400 */ }
    }
    assert.equal(requests.length, 5)
    assert.match(requests[0]!.url, /\/responses$/u)
    assert.equal(requests[0]!.body.model, 'gpt-6-astra')
    assert.ok(requests[0]!.body.tools.length)
    for (const request of requests.slice(1, 4)) {
      assert.match(request.url, /\/chat\/completions$/u)
      // 0.1.2-rc.1 forwards sessionId into pi-ai options but this path does not
      // emit DSH's native session header. Go remains compatibility-unverified.
      assert.equal(request.headers.has('x-deepseek-harness-session-id'), false)
    }
    assert.equal(requests.some(r => r.url.includes('/pull')), false)
  } finally { globalThis.fetch = nativeFetch; await adapter?.dispose(); await credentials.dispose(); await h.dispose() }
})
