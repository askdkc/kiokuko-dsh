/** Seed only a caller-owned disposable data root, using native Session persistence. */
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { recoveryRuntime } from '../tests/dsh/helpers/session-recovery-runtime.mjs'
const root = process.argv[2]
if (!root?.startsWith(realpathSync('/tmp')+'/krverify-')) throw new Error('A private recovery verification root is required')
const h = await recoveryRuntime(join(root, 'dsh'))
for (const [id, title, provider] of [
  ['11111111-1111-4111-a111-111111111111', 'Interrupted recovery fixture', 'kiokuko-opencode-go-a5676c4f'],
  ['22222222-2222-4222-a222-222222222222', 'Missing model recovery fixture', 'missing-provider'],
  ['33333333-3333-4333-a333-333333333333', 'CLI interrupted recovery fixture', 'kiokuko-opencode-go-a5676c4f'],
]) {
  const { agent } = await h.ctx.agents.create({ sessionId: id, meta: { cwd: join(root, 'project'), agentPreset: 'standard' }, agentOptions: { provider, model: 'fixture' } })
  const s = agent.session
  agent.model.select({ provider, model: 'fixture' })
  s.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  s.append('turn/start', { turn: 1 })
  s.append('user/message', h.llm.createUserMessage({ content: [{ type: 'text', text: 'Inspect the local recovery fixture; preserve existing files.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  s.append('step/start', { turn: 1, step: 1 })
  const call = { type: 'tool-call', id: 'lost-'+id, name: 'bash', arguments: '{"command":"read fixture"}' }
  s.append('assistant/message', { turn: 1, step: 1, stream: [], message: h.llm.createAssistantMessage({ content: [call], source: { kind: 'model', provider, model: 'fixture' } }) }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
  await h.ctx.sessions.flush(s)
}
// Exit without teardown to leave real incomplete turn tails in the disposable logs.
process.exit(0)
