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
