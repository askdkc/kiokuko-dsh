import { LlmAdapter, createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { writeFile } from 'node:fs/promises'

export const inject = ['llm', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets']
export async function apply(ctx) {
  let requests = 0
  const registration = ctx.llm.registerAdapter(['recovery-fixture'], new class extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Recovery fixture' } }
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Recovery fixture' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 }, defaultMaxTokens: 256 } }
    async *stream(options) {
      requests++
      await writeFile(process.env.KIOKUKO_RECOVERY_REQUESTS, JSON.stringify({ requests, sessionId: options.sessionId }))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY_CONTINUE_OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  ctx.effect(() => registration)
  await ctx.agentDefaultModel.saveSelection({ provider: 'recovery-fixture', model: 'fixture' })
  const seeds = []
  for (const [sessionId, title, provider] of [
    ['interrupted-recovery-ui', 'Interrupted recovery fixture', 'recovery-fixture'],
    ['missing-model-recovery-ui', 'Missing model recovery fixture', 'missing-provider'],
  ]) {
    const handle = await ctx.agents.create({ sessionId,
      meta: { cwd: process.env.KIOKUKO_RECOVERY_PROJECT, agentPreset: 'standard' },
      agentOptions: { provider, model: 'fixture' },
      setup: async scope => { await ctx.agentPresets.mount(scope, 'standard') },
    })
    const session = handle.agent.session
    handle.agent.model.select({ provider, model: 'fixture' })
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect the local recovery fixture; preserve existing files.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    const call = { type: 'tool-call', id: `lost-${sessionId}`, name: 'bash', arguments: '{"command":"read fixture"}' }
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [call], source: { kind: 'model', provider, model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    await ctx.sessions.flush(session)
    await handle.dispose()
    seeds.push({ sessionId, title })
  }
  await writeFile(process.env.KIOKUKO_RECOVERY_READY, JSON.stringify({ seeds }))
}
