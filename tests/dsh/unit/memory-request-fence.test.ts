import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRequestFence, MemorySnapshotStale } from '../../../src/dsh/memory-request-fence.js'

const collect = async (stream: AsyncIterable<any>) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
test('pre-send memory invalidation retries once, without dispatching the provider', async () => {
  const fence = new MemoryRequestFence(), signal = new AbortController().signal
  fence.begin({ turn: 1, step: 2 })
  let sent = 0
  const provider = async function* () { sent++; yield 'response' }
  const invalid = async () => { throw new MemorySnapshotStale() }
  const [first] = await collect(fence.stream(invalid, provider))
  assert.equal(sent, 0)
  const settledFailure = structuredClone(first.reason.failure) // Native settlement snapshots every chunk.
  assert.deepEqual(fence.retry({turn:1,step:2,signal,failure:settledFailure}), {kind:'retry'})
  assert.equal(fence.retry({turn:1,step:2,signal,failure:settledFailure}), undefined)
  fence.begin({turn:1,step:2}) // prepareRequest repeats within the same native step.
  const [second] = await collect(fence.stream(invalid, provider))
  assert.equal(second.reason.failure.code, 'DSH_MEMORY_REBUILD_EXHAUSTED')
  assert.equal(fence.retry({turn:1,step:2,signal,failure:second.reason.failure}), null)
  assert.equal(sent, 0)
  fence.begin({turn:2,step:1})
  assert.deepEqual(await collect(fence.stream(async()=>{},provider)), ['response'])
  assert.equal(sent, 1)
})
test('provider lookalikes, changed turns and cancellation cannot claim a memory retry', async () => {
  const fence = new MemoryRequestFence(), controller = new AbortController()
  fence.begin({turn:1,step:1})
  assert.equal(fence.retry({turn:1,step:1,signal:controller.signal,failure:{code:'DSH_MEMORY_SNAPSHOT_STALE'}}),undefined)
  const [first]=await collect(fence.stream(async()=>{throw new MemorySnapshotStale()},async function*(){}))
  assert.equal(fence.retry({turn:2,step:1,signal:controller.signal,failure:first.reason.failure}),null)
  controller.abort()
  assert.throws(()=>fence.retry({turn:1,step:1,signal:controller.signal,failure:first.reason.failure}))
})
test('validation failures stop before dispatch, provider failures are never memory retries', async () => {
  const fence = new MemoryRequestFence()
  let sent=0
  const provider=async function*(){sent++;throw new MemorySnapshotStale()}
  await assert.rejects(collect(fence.stream(async()=>{throw new Error('database read failed')},provider)),/database read failed/)
  assert.equal(sent,0)
  await assert.rejects(collect(fence.stream(async()=>{},provider)),MemorySnapshotStale)
  assert.equal(sent,1)
})

test('a second race performs one memory-free rebuild and still validates before dispatch', async () => {
  const fence = new MemoryRequestFence(), signal = new AbortController().signal
  fence.begin({ turn: 1, step: 1 })
  let sent = 0, omitted = 0
  const provider = async function* () { sent++; yield 'response' }
  const validate = async () => { if (!fence.withoutMemory) throw new MemorySnapshotStale() }
  for (const code of ['DSH_MEMORY_SNAPSHOT_STALE', 'DSH_MEMORY_CONTEXT_OMITTED']) {
    const [chunk] = await collect(fence.stream(validate, provider, async () => { omitted++ }))
    assert.equal(chunk.reason.failure.code, code)
    assert.deepEqual(fence.retry({ turn: 1, step: 1, signal, failure: structuredClone(chunk.reason.failure) }), { kind: 'retry' })
  }
  assert.equal(sent, 0); assert.equal(omitted, 1)
  await assert.rejects(collect(fence.stream(async () => { throw new Error('identity changed') }, provider)), /identity changed/)
  assert.equal(sent, 0)
  assert.deepEqual(await collect(fence.stream(validate, provider)), ['response'])
  assert.equal(sent, 1)
  fence.begin({ turn: 1, step: 2 })
  assert.equal(fence.withoutMemory, false, 'a later step can use memory again')
})

test('failed omission and partial provider output never enter another memory retry', async () => {
  const fence = new MemoryRequestFence(), signal = new AbortController().signal
  fence.begin({ turn: 1, step: 1 })
  const invalid = async () => { throw new MemorySnapshotStale() }
  const [first] = await collect(fence.stream(invalid, async function* () {}))
  fence.retry({ turn: 1, step: 1, signal, failure: first.reason.failure })
  await assert.rejects(collect(fence.stream(invalid, async function* () { assert.fail('must not dispatch') }, async () => { throw new Error('surface unavailable') })), /surface unavailable/)
  assert.equal(fence.withoutMemory, false)
  let dispatched = 0
  const partial = async function* () { dispatched++; yield 'partial response'; throw new MemorySnapshotStale() }
  await assert.rejects(collect(fence.stream(async () => {}, partial)), MemorySnapshotStale)
  assert.equal(dispatched, 1)
  assert.equal(fence.retry({ turn: 1, step: 1, signal, failure: { code: 'DSH_MEMORY_SNAPSHOT_STALE' } }), undefined)
})

test('native Stop during validation or omission prevents dispatch and further retries', async () => {
  for (const phase of ['validation', 'omission']) {
    const controller = new AbortController(), fence = new MemoryRequestFence()
    fence.begin({ turn: 1, step: 1, signal: controller.signal })
    const provider = async function* () { assert.fail('Stop must prevent provider dispatch') }
    if (phase === 'validation') {
      await assert.rejects(collect(fence.stream(async () => { await Promise.resolve(); controller.abort(new Error('stopped')) }, provider, undefined, controller.signal)), /stopped/)
    } else {
      const invalid = async () => { throw new MemorySnapshotStale() }
      const [first] = await collect(fence.stream(invalid, provider))
      fence.retry({ turn: 1, step: 1, signal: controller.signal, failure: first.reason.failure })
      await assert.rejects(collect(fence.stream(invalid, provider, async () => { await Promise.resolve(); controller.abort(new Error('stopped')) }, controller.signal)), /stopped/)
      assert.equal(fence.withoutMemory, false)
    }
  }
})

test('validation and rebuild share one deadline, including native retries', async () => {
  const fence = new MemoryRequestFence(70), controller = new AbortController()
  fence.begin({turn:1,step:1})
  let dispatched = 0
  const keepalive = setTimeout(() => {}, 1000)
  const start = performance.now()
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    const chunks: any[] = []
    for await (const chunk of fence.stream(async () => { await delay(20); return {check(){throw new MemorySnapshotStale()},async rebuild(){await delay(20)}} }, async function* () { dispatched++; yield 1 }, undefined, controller.signal)) chunks.push(chunk)
    assert.deepEqual(fence.retry({turn:1,step:1,failure:chunks[0].reason.failure,signal:controller.signal}),{kind:'retry'})
    await assert.rejects(async () => {
      for await (const _ of fence.stream(async () => { await delay(60) }, async function* () { dispatched++; yield 1 }, undefined, controller.signal)) {}
    })
    assert.ok(performance.now() - start < 160)
    assert.equal(dispatched,0)
  } finally { clearTimeout(keepalive) }
})
