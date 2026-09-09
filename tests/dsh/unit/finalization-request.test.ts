import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFinalizationRequest } from '../../../src/dsh/finalization-request.js'
import { reduceDshFinalizationLog, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'

async function* log(): AsyncIterable<DshLogEvent> {
  yield { seq: 0, time: 0, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'EARLIER RUN' }] } }
  yield { seq: 1, time: 1, type: 'turn/start' }
  yield { seq: 2, time: 2, type: 'request/header', data: { header: { config: { provider: 'mock', model: 'mock', reasoningEffort: 'high' }, system: 's'.repeat(10_000), tools: [{ name: 'read' }] } } }
  yield { seq: 3, time: 3, type: 'request/context', data: { contextWindow: 128_000 } }
  yield { seq: 4, time: 4, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'Current request 日本語🙂' }] } }
  yield { seq: 5, time: 5, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Verification passed.' }] } } }
  yield { seq: 6, time: 6, type: 'turn/end' }
  yield { seq: 7, time: 7, type: 'user/message', data: { content: [{ type: 'text', text: 'FUTURE RUN' }] } }
}
const job = { runId: 'r', dshSessionId: 's', sourceStartSeq: 1, sourceEndSeq: 6, inputMode: 'prefix_reuse' as const }

test('prefix request retains the original envelope, messages, capsule prompt and native call options', async () => {
  const prepared = await reduceDshFinalizationLog(log(), 1, 6)
  const signal = new AbortController().signal
  const built = buildFinalizationRequest(job, prepared, signal)
  const request = built.request
  assert.equal(built.inputMode, 'prefix_reuse')
  assert.equal(built.fallback, undefined)
  assert.equal(request.signal, signal)
  assert.equal(request.provider, 'mock'); assert.equal(request.model, 'mock'); assert.equal(request.reasoningEffort, 'high')
  assert.equal(request.maxTokens, 16_384); assert.equal(request.temperature, 0); assert.equal(request.purpose, 'compaction')
  assert.equal(request.sessionId, 's')
  assert.equal(request.system, prepared.envelope.system)
  assert.deepEqual(request.tools, prepared.envelope.tools)
  assert.deepEqual(request.messages.slice(0, -1), prepared.messages)
  const last = request.messages.at(-1) as any
  assert.equal(last.id, 'kiokuko-memory-finalization:r')
  assert.match(last.content[0].text, /No additional off-surface evidence was selected; use the conversation prefix\./u)
  assert.match(last.content[0].text, /at most 65536 bytes/u)
  assert.equal(prepared.evidence, '')
})

test('bounded request includes on-surface evidence, excludes other runs and has no copied tool schema', async () => {
  const prepared = await reduceDshFinalizationLog(log(), 1, 6, 'bounded_evidence')
  assert.equal(prepared.evidence, '')
  const built = buildFinalizationRequest({ ...job, inputMode: 'bounded_evidence' }, prepared, new AbortController().signal)
  assert.equal(built.inputMode, 'bounded_evidence')
  assert.equal(built.request.tools, undefined)
  const text = JSON.stringify(built.request.messages)
  assert.match(text, /Current request 日本語🙂/u)
  assert.match(text, /Verification passed/u)
  assert.doesNotMatch(text, /EARLIER RUN|FUTURE RUN/u)
})

test('fallback is decided before a model call when evidence, size or context budget is unsuitable', async () => {
  const prepared = await reduceDshFinalizationLog(log(), 1, 6, 'bounded_evidence')
  const signal = new AbortController().signal
  const bounded = { ...job, inputMode: 'bounded_evidence' as const }
  assert.equal(buildFinalizationRequest(bounded, { ...prepared, boundedEvidence: '' }, signal).fallback, 'empty_evidence')
  assert.equal(buildFinalizationRequest(bounded, { ...prepared, envelope: { provider: 'mock', model: 'mock' } }, signal).fallback, 'context_budget_unknown')
  assert.equal(buildFinalizationRequest(bounded, { ...prepared, messages: [], envelope: { provider: 'mock', model: 'mock', contextWindow: 128_000 } }, signal).fallback, 'request_not_smaller')
})
