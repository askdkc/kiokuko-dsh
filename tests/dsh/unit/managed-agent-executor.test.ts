import assert from 'node:assert/strict'
import test from 'node:test'
import { ManagedAgentExecutor } from '../../../src/dsh/orchestration/managed-agent-executor.js'

for (const rejectDisposal of [false, true]) test(`awaits exact activation disposal once after cancellation (${rejectDisposal ? 'rejects' : 'resolves'})`, async () => {
  let resolveResult!: (value: { output: unknown; stopReason: string }) => void
  const result = new Promise<{ output: unknown; stopReason: string }>(resolve => { resolveResult = resolve })
  let published!: () => void
  const publication = new Promise<void>(resolve => { published = resolve })
  let disposed = 0
  const parent = { id: 'parent', session: { id: 'parent' } } as any
  const child = { id: 'child', session: { id: 'child' } } as any
  const controller = new AbortController()
  const binding = {}
  let finishDisposal!: () => void
  const disposal = new Promise<void>((resolve, reject) => { finishDisposal = () => rejectDisposal ? reject(new Error('disposal failed')) : resolve() })
  let executor!: ManagedAgentExecutor<object>
  const backend = {
    startActivation: async () => {
      executor.created(child)
      published()
      return { childId: 'child', result, dispose: async () => { disposed++; await disposal } }
    },
  }
  const run = executor = new ManagedAgentExecutor(backend)
  const pending = run.execute(binding, {
    parent, prompt: [{ type: 'text', text: 'test' }], agentOptions: { provider: 'mock', model: 'mock' },
    maxDepth: 1, toolFilter: { allow: [] }, signal: controller.signal, label: 'test',
  }, async (value, receivedChild) => {
    assert.equal(receivedChild, child)
    return value
  })
  await publication
  controller.abort()
  resolveResult({ output: 'done', stopReason: 'completed' })
  let settled = false
  const observed = pending.then(value => { settled = true; return value }, error => { settled = true; throw error })
  const completion = rejectDisposal ? assert.rejects(observed, /disposal failed/) : observed
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'completion must await cancellation cleanup')
  finishDisposal()
  await completion
  assert.equal(disposed, 1)
})
