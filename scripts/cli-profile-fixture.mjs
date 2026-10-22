/** Offline provider and observation only; used by verify-cli-profile.mjs. */
import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createQuestionObserver } from './cli-input-barrier.mjs'

export const name = 'kiokuko-cli-profile-fixture'
export const inject = ['llm', 'agents', 'sessions', 'tools', 'commands']

export function apply(ctx) {
  const file = process.env.KIOKUKO_CLI_PROBE_EVENTS
  if (!file) throw new Error('This fixture requires a private observation file')
  const record = value => appendFileSync(file, JSON.stringify({ time: Date.now(), ...value }) + '\n', { mode: 0o600 })
  ctx.logger.exporter({ levels: { default: 3 }, export: message => {
    if (message.type === 'warn' || message.type === 'error') record({ type: 'native-log', level: message.type, name: message.name,
      args: message.args.map(value => value instanceof Error ? value.stack ?? value.message : value) })
  } })
  record({ type: 'fixture-loaded', stdoutTTY: process.stdout.isTTY === true, stdinTTY: process.stdin.isTTY === true })
  const adapter = {
    providerInfo: id => ({ id, name: 'Offline profile fixture' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Offline fixture' },
      { provider, id: 'fixture-next', name: 'Offline fixture continuation' }] },
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } } },
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      const input = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user')
      const text = input?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
      record({ type: 'fixture-request', text, sessionId: options.sessionId, purpose: options.purpose, tools: options.tools?.map(tool => tool.name) ?? [] })
      if (text.includes('profile-fixture-hello') && options.tools?.length) {
        for (const name of ['prepare_requested_work', 'kioku_read']) assert.ok(options.tools?.some(tool => tool.name === name), `Kiokuko tool ${name} was not ready`)
      }
      let answer = 'PROFILE_FIXTURE_OK'
      if (text.includes('profile-fixture-lisp') && options.tools?.length) {
        const nativeResult = id => options.messages.flatMap(message => message.role === 'tool' && message.toolCallId === id ? [message]
          : (message.content ?? []).filter(block => block.type === 'tool-result' && block.toolCallId === id)).at(-1)
        const prepared = nativeResult('profile-fixture-prepare')
        const evaluated = nativeResult('profile-fixture-lisp-eval')
        if (!prepared || !evaluated) {
          const id = prepared ? 'profile-fixture-lisp-eval' : 'profile-fixture-prepare'
          const name = prepared ? 'lisp_eval' : 'prepare_requested_work'
          let args
          if (prepared) {
            assert.notEqual(prepared.isError, true, JSON.stringify(prepared))
            assert.equal(JSON.parse(prepared.content[0].text).prepared, true)
            args = { operationId: 'profile-fixture-eval', code: '(+ 20 22)' }
          } else {
            const section = options.messages.flatMap(message => message.source?.sections ?? []).filter(value => value.name === 'on-demand-intake').at(-1)?.text
            const json = section?.split('Current request references and same-session work (host-bound, advisory only):\n')[1]?.split('\n')[0]
            assert.ok(json, 'Preparation requires current host references')
            args = { requestIntent: { relation: 'new', action: 'verify', changeScope: 'unknown', evidenceRefs: JSON.parse(json).references } }
          }
          assert.ok(options.tools.some(tool => tool.name === name), `Expected exposed ${name}`)
          record({ type: 'fixture-tool-call', id, name, args })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        assert.notEqual(evaluated.isError, true, JSON.stringify(evaluated))
        assert.match(JSON.stringify(evaluated), /42/)
        record({ type: 'fixture-lisp-consumed', text, sessionId: options.sessionId, result: evaluated })
        answer = 'PROFILE_LISP_OK 42'
      }
      if (text.includes('profile-fixture-slow') && options.tools?.length) {
        record({ type: 'fixture-slow-started' })
        await new Promise((resolve, reject) => {
          const aborted = () => { record({ type: 'fixture-aborted' }); reject(options.signal.reason ?? new Error('aborted')) }
          options.signal.addEventListener('abort', aborted, { once: true })
          if (options.signal.aborted) aborted()
        })
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['kiokuko-profile-fixture'], adapter)
  const observedAgents = new Map()
  const recordCommands = agent => record({ type: 'native-commands', sessionId: agent.session.id,
    names: ctx.commands.list(agent).map(command => command.name) })
  ctx.on('agent/created', ({ agent }) => {
    observedAgents.set(agent.id, agent)
    record({ type: 'agent-created', sessionId: agent.session.id, eventCount: agent.session.snapshotEvents().length,
      executionFences: Boolean(ctx.get('executionFences', false)) })
    recordCommands(agent)
  })
  ctx.on('commands/change', () => { for (const agent of observedAgents.values()) recordCommands(agent) }, { global: true })
  ctx.on('agent/error', payload => record({ type: 'native-error', error: String(payload.error?.stack ?? payload.error) }), { global: true })
  ctx.on('tools/result', (execution, result) => record({ type: 'native-tool-result', name: execution.name, callId: execution.callId, result }), { global: true })
  ctx.on('kiokuko/task-state', task => record({ type: 'task-state', task }), { global: true })
  ctx.on('user-questions/request', createQuestionObserver(record), { prepend: true, global: true })
  ctx.on('session/event', (session, event) => {
    if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end', 'command/run', 'command/done'].includes(event.type)) {
      record({ type: 'native-event', sessionId: session.id, event })
    }
  }, { global: true })
  ctx.provide('kiokukoProfileFixture', {})
}
