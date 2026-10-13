import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { encodePrompt } from '../../../src/dsh/models/vendor/opencode-codec.js'
import type { OpenCodeModel } from '../../../src/dsh/models/vendor/opencode-catalog.js'

const provider = 'opencode'
const modelId = 'test-model'
const chatModel: OpenCodeModel = {
  id: modelId, name: 'Test model', protocol: 'chat', contextWindow: 16_384, maxTokens: 2_048,
  inputModalities: ['text'], toolCall: true, reasoning: false, temperature: false, efforts: [],
}
const messagesProtocolModel: OpenCodeModel = { ...chatModel, protocol: 'messages' }

function assistant(content: any[], id = 'assistant-1') {
  return { id, role: 'assistant', source: { kind: 'model', provider, model: modelId }, content }
}
function toolResult(toolCallId: string, text: string, isError: boolean, id = `result-${toolCallId}`) {
  return { id, role: 'tool', source: { kind: 'tool', callId: toolCallId }, toolCallId, isError,
    content: [{ type: 'text', text }] }
}
function options(messages: any[]): GenerateOptions {
  return { provider, model: modelId, messages } as GenerateOptions
}
function failure() { return (error: any) => error?.code === 'INVALID_REPLAY_STATE' }

test('a malformed OpenCode chat call with its unique error result becomes bounded retry feedback without mutating history', async () => {
  const argumentsText = '{"action":"propose","api_key":"SECRET_ARGUMENT"}}'
  const history = [assistant([{ type: 'text', text: 'before' }, { type: 'tool-call', id: 'bad-224', name: 'coding_workflow_apply', arguments: argumentsText }]),
    toolResult('bad-224', 'Tool input rejected: expected an object, received string', true)]
  const before = structuredClone(history)

  const prompt = await encodePrompt(options(history), chatModel)
  const assistantPrompt = prompt.find(message => message.role === 'assistant') as any
  const feedback = assistantPrompt.content.find((part: any) => part.type === 'text' && part.text.includes('bad-224'))?.text

  assert.match(feedback, /coding_workflow_apply/u)
  assert.match(feedback, /expected an object, received string/u)
  assert.match(feedback, /new call with valid JSON arguments/u)
  assert.ok(feedback.length < 2_600)
  assert.equal(prompt.some(message => message.role === 'tool'), false)
  assert.equal(JSON.stringify(prompt).includes('SECRET_ARGUMENT'), false)
  assert.deepEqual(history, before)
})

test('valid and malformed parallel calls preserve successful calls, results, ordering, and history', async () => {
  const history = [assistant([
    { type: 'tool-call', id: 'valid-call', name: 'read', arguments: '{"path":"README.md"}' },
    { type: 'tool-call', id: 'bad-call', name: 'write', arguments: '{"path":"x"}}' },
    { type: 'text', text: 'parallel response' },
  ]), toolResult('bad-call', 'Invalid arguments', true), toolResult('valid-call', 'README contents', false)]
  const before = structuredClone(history)

  const prompt = await encodePrompt(options(history), chatModel)
  const assistantPrompt = prompt.find(message => message.role === 'assistant') as any
  const validCall = assistantPrompt.content.find((part: any) => part.type === 'tool-call')
  const feedback = assistantPrompt.content.find((part: any) => part.type === 'text' && part.text.includes('bad-call'))
  const result = prompt.find(message => message.role === 'tool') as any

  assert.deepEqual({ id: validCall.toolCallId, name: validCall.toolName, input: validCall.input },
    { id: 'valid-call', name: 'read', input: { path: 'README.md' } })
  assert.match(feedback.text, /Invalid arguments/u)
  assert.equal(prompt.filter(message => message.role === 'tool').length, 1)
  assert.equal(result.content[0].toolCallId, 'valid-call')
  assert.deepEqual(history, before)
})

test('malformed calls with missing, duplicate, successful, or colliding pairs remain invalid replay state', async () => {
  const malformed = { type: 'tool-call', id: 'call', name: 'write', arguments: '{"x":1}}' }
  const cases = [
    [assistant([malformed])],
    [assistant([malformed]), toolResult('call', 'first', true), toolResult('call', 'duplicate', true, 'result-duplicate')],
    [assistant([malformed]), toolResult('call', 'unexpected success', false)],
    [assistant([malformed, { ...malformed, name: 'other' }]), toolResult('call', 'ambiguous call id', true)],
  ]
  for (const history of cases) await assert.rejects(encodePrompt(options(history), chatModel), failure())
})

test('signed non-chat protocols do not recover malformed stored arguments', async () => {
  const history = [assistant([{ type: 'tool-call', id: 'signed-call', name: 'write', arguments: '{"x":1}}' }]),
    toolResult('signed-call', 'Invalid arguments', true)]
  await assert.rejects(encodePrompt(options(history), messagesProtocolModel), failure())
})
