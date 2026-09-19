import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'

const [packagePath, nativeRoot, combination = 'core'] = process.argv.slice(2)
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
const [cordis, llm, session, projection, systemPrompt, tools, agents, loop, skills, commands] = await Promise.all(
  ['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'skill', 'commands'].map(name => import(pathToFileURL(join(nativeRoot, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')))))
class FixtureModel extends llm.LlmAdapter {
  requests = []
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'fixture' }] }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(options) {
    this.requests.push(options)
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
const registeredCommands = new Map()
ctx.on('agent/error', payload => failures.push(String(payload.error?.stack ?? JSON.stringify(payload))))
let handle
try {
  for (const plugin of [llm, session, projection, systemPrompt, tools, agents, skills, commands]) fibers.push(await ctx.plugin(plugin.default, plugin === systemPrompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  fibers.push(await ctx.plugin({ name: 'module-questions', apply(context) { context.provide('userQuestions', { async ask(request) { const question = request.questions[0]; questions.push(question.id); if (question.id === 'taskType') return { answers: [{ id: question.id, selected: ['文章作成'] }] }; throw new Error('Ordinary tasks must not open a module selection question') } }) } }))
  ctx.llm.registerAdapter(['fixture'], provider)
  const registerCommand = ctx.commands.register.bind(ctx.commands)
  ctx.commands.register = definition => { registeredCommands.set(definition.name, definition); return registerCommand(definition) }
  const configuration = { repositoryRoot: directory, databasePath: join(directory, 'memory.sqlite3'), migrationsDirectory: join(packageRoot, 'migrations'), skillPrompts: { mode: 'compiled' } }
  if (legacy) {
    const prompts = new publicEntry.DshSkillPrompts({ mode: 'compiled' })
    const adapter = publicEntry.createDshHostAdapter(ctx, { ...configuration, skillPrompts: prompts, deepPlanning: { enabled: false }, orca: { enabled: false }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' } })
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
  for (const task of ['こんにちは', 'この文章を要約してください', 'この資料を調査してください']) {
    const count = provider.requests.length
    parent.followup(llm.createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.ok(provider.requests.length > count, `native model path did not run: ${task}; ${JSON.stringify(failures)}; ${JSON.stringify(parent.session.snapshotEvents().filter(event => event.type === "turn/end"))}`)
  }
  assert.ok(questions.every(id => id === 'taskType'), 'No coding, Enno, Lisp or model selection questions')
  assert.ok(provider.requests.every(request => !JSON.stringify(request).includes('submit_ideal')), 'ordinary requests do not receive role directives')
  if (combination.includes('lisp')) {
    let effects = 0
    const removeProbe = ctx.tools.register({ name: 'module_fixture_write', description: 'fixture effect', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
    const enabled = await registeredCommands.get('kioku-lisp').handler({ rawInput: 'enable', agent: parent, signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)
    const arguments_ = { operationId: 'packed-eval', code: '(+ 20 22)' }
    const result = await ctx.tools.execute({ callId: 'packed-lisp-eval', name: 'lisp_eval', arguments: arguments_, agent: parent, signal: new AbortController().signal })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.equal(result.value.ok, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /42/)
    const replay = await ctx.tools.execute({ callId: 'packed-lisp-replay', name: 'lisp_eval', arguments: arguments_, agent: parent, signal: new AbortController().signal })
    assert.equal(replay.value.replay, true, 'exact completed effects must not execute twice')
    await handle.dispose(); handle = undefined
    const blocked = await ctx.tools.execute({ callId: 'packed-after-stop', name: 'module_fixture_write', arguments: {}, agent: parent, signal: new AbortController().signal })
    assert.equal(blocked.isError, true, 'stopping the module must retain the protected session fence')
    assert.equal(effects, 0)
    removeProbe()
  }
  await handle?.dispose(); handle = undefined
  const first = provider.requests[0]
  const system = first.system ?? first.messages.filter(message => message.role === 'system').flatMap(message => message.content).map(block => block.text ?? '').join('\n')
  console.log(JSON.stringify({ combination, status: 'passed', nativeRequests: provider.requests.length, skills: names, startupModules: imported.map(url => url.slice(pathToFileURL(packageRoot).href.length + 1)), constantPromptBytes: Buffer.byteLength(system), protectedLisp: combination.includes('lisp'), liveModelQuality: 'unmeasured' }))
} finally {
  await handle?.dispose()
  for (const fiber of fibers.reverse()) await fiber?.dispose?.()
  await rm(directory, { recursive: true, force: true })
}
