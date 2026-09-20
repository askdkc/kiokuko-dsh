import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, history, message } from '../../helpers/semantic-compaction.js'
import { DecisionError, type DecisionBatch, type DecisionBatchResult } from '../../../../src/dsh/decisions/contracts.js'

const reply = (batch: DecisionBatch, choice = 'shorten'): DecisionBatchResult => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => q.id === 'fruit' ? { id: q.id, status: 'selected', choiceId: 'apple' } : choice === 'uncertain' ? { id: q.id, status: 'abstained', reason: 'uncertain' } : { id: q.id, status: 'selected', choiceId: choice }) })
const status = (f: ReturnType<typeof fixture>) => (f.service.status() as any).semanticCompaction.last

test('one handler, native overhead gate, durable source references and continuation exactly once', async () => {
  const f = fixture(), before = structuredClone(f.events), pressure = f.meter.measure().totalTokens
  f.coordinator.attach(f.agent); f.created[0]!( { agent: f.agent } )
  assert.equal(f.handlers.length, 1)
  await f.step()
  assert.equal(f.next(), 1); assert.equal(status(f).outcome, 'shortened')
  assert.deepEqual(f.events.slice(0, before.length), before)
  const replacement = f.events.at(-1)!
  assert.deepEqual(replacement.sourceEventSeqs, [7]); assert.equal(replacement.type, 'tool/result')
  assert.ok(f.meter.measure().totalTokens <= pressure * .75)
  assert.deepEqual(f.events[6]!.data, before[6]!.data, 'assistant calls and replay metadata stay intact')
  await f.step(); assert.equal(f.calls.length, 2, 'readiness plus one classification')
  f.coordinator.stop(); await f.coordinator.drain(); assert.equal(f.handlers.length, 0)
})

for (const mode of ['off', 'missing', 'native-off', 'low', 'overhead', 'pending-overhead', 'override', 'unbound-child', 'pruned']) test(`skip/fallback leaves semantic history untouched: ${mode}`, async () => {
  const f = fixture({ mode: mode === 'off' ? 'off' : 'auto', configured: mode !== 'missing', overhead: mode === 'overhead' ? 20000 : 100 })
  if (mode === 'native-off') f.services.compaction.config.auto = false
  if (mode === 'low') f.services.llm.resolveModelInfo = async () => ({ context: { contextWindow: 100000 } })
  if (mode === 'override') f.services.compaction.config.modelPolicies = [{ provider: 'mock', model: 'mock', thresholdRatio: .01, retainRatio: 0 }]
  if (mode === 'unbound-child') f.session.header.origin = 'subagent'
  if (mode === 'pruned') f.session.append('compaction/prune', { shadowedSeqs: [7] })
  const before = structuredClone(f.events)
  await f.step(undefined, mode === 'pending-overhead' ? [message('pending', 'required'.repeat(9000))] : [])
  assert.deepEqual(f.events, before); assert.equal(f.next(), 1)
  f.coordinator.stop()
})

for (const choice of ['keep', 'uncertain', 'error']) test(`classifier ${choice} cannot authorize mutation`, async () => {
  const f = fixture({ evaluate: async batch => { if (choice === 'error' && batch.purpose === 'compaction') throw new DecisionError('UNAVAILABLE'); return reply(batch, choice) } })
  const before = structuredClone(f.events); await f.step(); assert.deepEqual(f.events, before); assert.equal(f.next(), 1)
  assert.equal(status(f).outcome, 'fallback'); f.coordinator.stop()
})

for (const mutation of ['append', 'owner', 'authority', 'route', 'cancel', 'active-compaction']) test(`reject changed ${mutation} before any semantic append`, async () => {
  const abort = new AbortController(); let authority = 'lease-a'
  const f = fixture({ evaluate: async batch => {
    if (batch.purpose === 'compaction') {
      if (mutation === 'append') f.session.append('user/message', message('concurrent', 'changed'))
      if (mutation === 'owner') f.services.agents.get = () => ({})
      if (mutation === 'authority') authority = 'lease-b'
      if (mutation === 'route') f.session.requestHeader = () => ({ config: { provider: 'mock', model: 'other' } })
      if (mutation === 'cancel') abort.abort(new Error('cancelled'))
      if (mutation === 'active-compaction') f.session.append('compaction/start', {})
    }
    return reply(batch)
  } })
  f.coordinator.attach(f.agent, async () => ({ authority }))
  await assert.rejects(f.step(abort.signal))
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0); assert.equal(f.next(), 0)
  f.coordinator.stop()
})

test('budget includes readiness and discards a non-cooperative late result', async () => {
  const f = fixture({ budgetMs: 5, evaluate: async batch => { await new Promise(resolve => setTimeout(resolve, 25)); return reply(batch) } })
  const before = structuredClone(f.events); await f.step(); await new Promise(resolve => setTimeout(resolve, 35))
  assert.deepEqual(f.events, before); assert.equal(f.next(), 1); assert.equal(status(f).outcome, 'fallback'); f.coordinator.stop()
})

test('stop cancels pending evaluation and drains without native fallback mutation', async () => {
  let ready!: () => void; const entered = new Promise<void>(resolve => { ready = resolve })
  const f = fixture({ evaluate: async (batch, signal) => { if (batch.purpose === 'compaction') { ready(); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }; return reply(batch) } })
  const operation = f.step(); const rejected = assert.rejects(operation); await entered; f.coordinator.stop(); await f.coordinator.drain(); await rejected
  assert.equal(f.events.length, 14); assert.equal(f.next(), 0)
})

test('partial append reports landed events and does not blindly retry after reload', async () => {
  const f = fixture(), append = f.session.append
  f.session.append = (type: string, data: any, intent?: any) => { if (type === 'tool/result') throw new Error('fixture write failure'); return append(type, data, intent) }
  await assert.rejects(f.step(), /0 confirmed replacements/u)
  assert.equal(status(f).outcome, 'commit_failed'); assert.equal(status(f).landedEvents, 1)
  await f.step(); assert.equal(f.events.length, 15)
  f.coordinator.stop()
  const restored = fixture({ events: structuredClone(f.events) })
  // Log-only prune markers are not surface nodes.
  restored.nodes.splice(restored.nodes.indexOf(14), 1)
  await restored.step(); assert.equal(restored.events.length, 15); restored.coordinator.stop()
})

test('64 maximum candidate selection ranks savings, preserving surface-order ties', async () => {
  // Selection is exercised independently of provider fitting limits.
  const base = history(), events: any[] = base.slice(0, 6)
  for (let i = 0; i < 66; i++) {
    const pair = structuredClone(base.slice(6, 8)); pair[0]!.data.message.content[0].id = `call-${i}`
    pair[1]!.data.message.source.callId = `call-${i}`; pair[1]!.data.message.content[0].toolCallId = `call-${i}`
    pair[1]!.data.message.content[0].content[0].text = 'x'.repeat(i === 65 ? 20000 : 3000)
    events.push(...pair)
  }
  events.push(...base.slice(8)); events.forEach((e, i) => e.seq = i)
  const f = fixture({ events }); f.coordinator.stop()
  await import('../../../../src/dsh/semantic-compaction/policy.js').then(({ selectCandidates }) => {
    const selected = selectCandidates(events, f.meter, new Map()); assert.equal(selected.length, 64); assert.equal(selected.at(-1)!.callId, 'call-65'); assert.ok(!selected.some(c => c.callId === 'call-64'))
  })
})

test('cancellation inside a native append observer leaves only its landed marker', async () => {
  const f = fixture(), controller = new AbortController(), append = f.session.append
  f.session.append = (type: string, data: any, intent?: any) => { const event = append(type, data, intent); if (type === 'compaction/prune') controller.abort(); return event }
  await assert.rejects(f.step(controller.signal), /0 confirmed replacements/u)
  assert.equal(status(f).landedEvents, 1); assert.equal(f.events.filter(e => e.type === 'tool/result').length, 1)
  assert.equal(f.next(), 0); f.coordinator.stop()
})

test('a wrapper failure after native append reports the landed replacement', async () => {
  const f = fixture(), append = f.session.append
  f.session.append = (type: string, data: any, intent?: any) => { const event = append(type, data, intent); if (intent) throw new Error('post-commit wrapper'); return event }
  await assert.rejects(f.step(), /1 confirmed replacements/u)
  assert.equal(status(f).shortened, 1); assert.equal(status(f).landedEvents, 2); f.coordinator.stop()
})

test('classifier view excludes attachments, secrets and replay output', async () => {
  const f = fixture()
  f.events[0]!.data.content.push({ type: 'image', attachment: { bytes: 'attachment-bytes-must-not-leave' } })
  await f.step()
  assert.ok(!JSON.stringify(f.calls).includes('attachment-bytes-must-not-leave'))
  assert.ok(!JSON.stringify(f.calls).includes('replay-only')); f.coordinator.stop()
  const secret = fixture()
  secret.events[0]!.data.content[0].text = 'Authorization: Bearer fixture-secret-value-long-enough'
  await secret.step(); assert.equal(secret.calls.length, 0); assert.equal(secret.events.length, 14); secret.coordinator.stop()
})

test('unavailable model metadata and multimodal pending input fall through unchanged', async () => {
  const f = fixture(), before = structuredClone(f.events)
  f.services.llm.resolveModelInfo = async () => { throw new Error('model unavailable') }
  await f.step(); assert.deepEqual(f.events, before); assert.equal(status(f).reason, 'model_metadata_unavailable')
  await f.step(undefined, [{ ...message('image', ''), content: [{ type: 'image', attachment: {} }] }])
  assert.deepEqual(f.events, before); assert.equal(status(f).reason, 'unsupported_pending_content'); f.coordinator.stop()
})

test('unload drains database-bearing work after cancelling its step', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), database = new Promise<void>(resolve => { release = resolve })
  const f = fixture()
  f.coordinator.attach(f.agent, async () => { entered(); await database; return { lease: 'current' } })
  const operation = f.step(), rejected = assert.rejects(operation)
  await started; f.coordinator.stop()
  let drained = false
  const drain = f.coordinator.drain().then(() => { drained = true })
  await rejected; await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  release(); await drain; assert.equal(drained, true); assert.equal(f.next(), 0)
  assert.equal((f.service.status() as any).semanticCompaction.active, false)
})

test('changed classifier configuration cannot reuse a persisted decision binding after reload', async () => {
  const configs = new Map(), results = new Map()
  const store = { bind: async (id: string, config: any) => { if (!configs.has(id)) configs.set(id, config); return configs.get(id) },
    read: async (id: string, digest: string) => results.get(id + digest), write: async (id: string, digest: string, value: any) => { results.set(id + digest, value) } }
  const first = fixture({ store, typesafeModel: 'classifier-old', evaluate: async batch => reply(batch, 'keep') })
  await first.step(); assert.equal(status(first).outcome, 'fallback'); first.coordinator.stop()
  const next = fixture({ store, typesafeModel: 'classifier-new', events: structuredClone(first.events) })
  await next.step(); assert.equal(status(next).outcome, 'shortened'); assert.equal(configs.size, 2)
  next.coordinator.stop()
})
