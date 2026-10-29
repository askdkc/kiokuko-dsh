import { registerHooks, createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? resolve(import.meta.dirname, '../../fixtures/dsh-runtime/node_modules')
const nativeRequire = createRequire(resolve(packages, '../package.json'))
// One selected module graph is required by Session's private record API.
let resolving = false
registerHooks({ resolve(specifier, context, next) {
  if (!specifier.startsWith('@deepseek-ai/') || resolving) return next(specifier, context)
  resolving = true
  try { return { url: pathToFileURL(nativeRequire.resolve(specifier)).href, shortCircuit: true } }
  finally { resolving = false }
} })

const native = name => import('@deepseek-ai/' + name)
export async function recoveryRuntime(root) {
  const [{ Context }, llm, sessions, projections, prompt, tools, agents, loop, persistence, executor] = await Promise.all([
    native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'), native('dsh-system-prompt'),
    native('dsh-tools'), native('dsh-agent'), native('dsh-agent-loop'), native('dsh-session-persistence-jsonl'), native('dsh-tool-executor-native'),
  ])
  const ctx = new Context(), requests = []
  for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, agents.default]) await ctx.plugin(plugin)
  await ctx.plugin(executor)
  await ctx.plugin(persistence.default ?? persistence, { root: join(root, 'sessions') })
  await ctx.plugin(loop.default, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], new class extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered from durable history.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  const counter = join(root, 'effect-count.txt')
  ctx.tools.register(tools.defineTool({
    name: 'write_fixture', description: 'Count an actual test-only file mutation', parameters: {},
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { const next = Number(await readFile(counter, 'utf8').catch(() => '0')) + 1; await writeFile(counter, String(next)); return next },
  }))
  return { ctx, llm, sessions, requests, counter }
}
if (process.argv[2] === '--crash') {
  const root = process.argv[3], h = await recoveryRuntime(root)
  const { agent } = await h.ctx.agents.create({ sessionId: 'crashed-session', meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  agent.model.select({ provider: 'fixture', model: 'fixture' })
  const session = agent.session
  session.append('turn/start', { turn: 1 })
  session.append('user/message', h.llm.createUserMessage({ content: [{ type: 'text', text: 'Inspect the effect and continue safely.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  const call = { type: 'tool-call', id: 'before-crash', name: 'write_fixture', arguments: '{}' }
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: h.llm.createAssistantMessage({ content: [call], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
  await h.ctx.tools.execute({ calls: [call], agent, signal: new AbortController().signal })
  await h.ctx.sessions.flush(session)
  process.exit(73)
}
