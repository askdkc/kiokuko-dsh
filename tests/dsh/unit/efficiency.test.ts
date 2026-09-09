import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/dsh/config.js'
import { DshEfficiencyObserver, finalizationObservationScope, normalizeDshUsage, requestSize } from '../../../src/dsh/efficiency.js'
import { dshProviderCacheTelemetry } from '../../../src/dsh/prompt-cache.js'
import { buildDshMessageSources } from '../../../src/dsh/message-sources.js'
import type { ScopedContextItem } from '../../../src/context/scoped-broker.js'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of source) result.push(value)
  return result
}

test('measurement preserves unicode and wrappers and never invents tokenizer or cache counts', () => {
  const request = { system: '日本語🙂', tools: [{ name: 'read' }], messages: [{ content: 'const a = "\\n"' }] }
  const frozen = structuredClone(request)
  const size = requestSize(request)
  assert.equal(size.totalBytes, Buffer.byteLength(JSON.stringify(request)))
  assert.deepEqual(request, frozen)
  assert.equal(normalizeDshUsage({ inputTokens: 2, outputTokens: 3 }).logicalInputTokens, null)
  assert.equal(normalizeDshUsage({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7, reasoningTokens: 2 }).logicalInputTokens, 14)
  assert.equal(normalizeDshUsage({ outputTokens: 3, reasoningTokens: 2 }).outputTokens, 3)
  assert.equal(normalizeDshUsage({ inputTokens: -1 }).inputTokens, null)
  assert.equal(dshProviderCacheTelemetry({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }).providerCacheHitRate, 1)
  assert.deepEqual(dshProviderCacheTelemetry({}), { providerCacheHitRate: null, cacheReadTokens: null, cacheWriteTokens: null })
  assert.equal(Config.parse({}).efficiency.observe, false)
  assert.equal(Config.parse({}).finalization.inputMode, 'prefix_reuse')
  assert.throws(() => Config.parse({ efficiency: { unknown: true } }))
  assert.throws(() => Config.parse({ finalization: { inputMode: 'invented' } }))
})

test('stream observer is transparent, replaces cumulative usage and keeps distinct calls', async () => {
  const observer = new DshEfficiencyObserver(2)
  const request = { sessionId: 'session', provider: 'mock', model: 'mock', messages: [{ content: 'DO NOT STORE THIS PROMPT' }] }
  const chunks = [{ type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } }]
  let starts = 0
  const next = async function* () { starts++; yield* chunks }
  for (let i = 0; i < 2; i++) assert.deepEqual(await collect(observer.stream(request, { sessionId: 'session', task: 'main' }, next)), chunks)
  assert.equal(starts, 2)
  const snapshot = observer.snapshot()
  assert.equal(snapshot.observations.length, 2)
  assert.notEqual(snapshot.observations[0]!.callId, snapshot.observations[1]!.callId)
  assert.equal(snapshot.observations[0]!.usage.outputTokens, 6)
  assert.equal(snapshot.observations[0]!.usage.logicalInputTokens, 7)
  assert.equal(JSON.stringify(snapshot).includes('DO NOT STORE'), false)
  await finalizationObservationScope.run(true, () => collect(observer.stream(request, { sessionId: 'session', task: 'main' }, next)))
  assert.equal(observer.snapshot().observations.length, 2, 'owned auxiliary call is not counted twice')
  await collect(observer.stream(request, undefined, next))
  assert.equal(observer.snapshot().unattributed, 1)
  await collect(observer.stream(request, { sessionId: 'child', parentSessionId: 'session', runId: 'run', task: 'child' }, next))
  assert.equal(observer.snapshot().evicted, 1)
  observer.close()
  await collect(observer.stream(request, { sessionId: 'session', task: 'main' }, next))
  assert.equal(observer.snapshot().evicted, 1)
})

test('stream failure, early return, missing finish and cancellation preserve native semantics', async () => {
  const observer = new DshEfficiencyObserver()
  const binding = { sessionId: 's', task: 'main' as const }
  const failure = new Error('native error')
  await assert.rejects(collect(observer.stream({}, binding, async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
    throw failure
  })), error => error === failure)
  assert.equal(observer.snapshot().observations[0]!.usage.inputTokens, 10)
  assert.equal(observer.snapshot().observations[0]!.status, 'failed')
  let closed = false
  for await (const _chunk of observer.stream({}, binding, async function* () {
    try { yield 1; yield 2 } finally { closed = true }
  })) break
  assert.equal(closed, true)
  assert.equal(observer.snapshot().observations[1]!.status, 'unknown')
  await collect(observer.stream({}, binding, async function* () { yield { type: 'finish', reason: { kind: 'aborted' } } }))
  assert.equal(observer.snapshot().observations[2]!.status, 'cancelled')
  const cyclic: any = {}; cyclic.messages = cyclic
  assert.deepEqual(await collect(observer.stream(cyclic, binding, async function* () { yield 42 })), [42])
  assert.equal(observer.snapshot().observationErrors, 1)
})

test('memory presentation removes exact duplicates only, preserves exceptions and rejects secrets before rendering', async () => {
  const render = async (item: Partial<ScopedContextItem>) => (await buildDshMessageSources({ task: '', soulInSystemPrompt: true,
    intakeStatus: 'ready', nextAction: 'proceed', memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false },
    context: { untrusted: true, items: [item as ScopedContextItem] } })).find(source => source.kind === 'memory')
  const item = { title: '保存条件', summary: '検証後に保存🙂', bodyPreview: '検証後に保存🙂' }
  const before = structuredClone(item)
  assert.equal((await render(item))?.text, '保存条件\n検証後に保存🙂')
  assert.deepEqual(item, before)
  assert.equal((await render({ title: 'コード', summary: '変更する箇所', bodyPreview: '    indented()\n    next()' }))?.text,
    'コード\n変更する箇所\n    indented()\n    next()')
  assert.equal((await render({ ...item, bodyPreview: '検証後に保存🙂\nただし失敗した場合は保存しない。' }))?.text,
    '保存条件\n検証後に保存🙂\n検証後に保存🙂\nただし失敗した場合は保存しない。')
  assert.equal(await render({ ...item, bodyPreview: `-----BEGIN PRIVATE KEY-----\n${'a'.repeat(80)}\n-----END PRIVATE KEY-----` }), undefined)
})
