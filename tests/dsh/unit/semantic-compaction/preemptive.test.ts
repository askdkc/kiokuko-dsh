import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, history } from '../../helpers/semantic-compaction.js'
import { SessionProgress } from '../../../../src/dsh/semantic-compaction/progress.js'

function exposed() {
  const events = history()
  for (const index of [10, 11]) events[index] = { seq: index, type: 'assistant/message', data: { stream: [], message: { id: `completed-${index}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Continue.' }] } } }
  return events
}
const pending = [{ content: 'first', status: 'in_progress' }, { content: 'second', status: 'pending' }]
const done = [{ content: 'first', status: 'completed' }, { content: 'second', status: 'pending' }]
function boundary(f: ReturnType<typeof fixture>) { f.session.append('todo/write', { todos: pending }); f.session.append('todo/write', { todos: done }) }
test('TODO boundary permits below-threshold compaction in one logical timing/candidate batch, once only', async () => {
  const f = fixture({ events: exposed() }); f.services.llm.resolveModelInfo = async () => ({ context: { contextWindow: 50000 } })
  try {
    boundary(f); await f.step()
    assert.equal((f.service.status() as any).semanticCompaction.last.trigger, 'todo_boundary')
    assert.equal((f.service.status() as any).semanticCompaction.last.outcome, 'shortened')
    const calls = f.calls.filter(c => c.purpose === 'compaction'); assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.questions.map(q => q.id), ['timing', 'r7'])
    f.session.append('todo/write', { todos: done }); await f.step(); assert.equal(f.calls.filter(c => c.purpose === 'compaction').length, 1)
  } finally { f.coordinator.stop() }
})
test('native token measurement includes the currently assembled tool schemas', async () => {
  const f = fixture({ events: exposed() }), measured: any[] = [], measure = f.meter.measure
  const tools = [{ name: 'observation_read', description: 'Current definition', parameters: { type: 'object' } }]
  f.coordinator.recordTools(f.agent, tools)
  f.services.tokenMeter.measure = (session: unknown, header: unknown) => { measured.push(header); return measure() }
  try {
    boundary(f); await f.step()
    assert.ok(measured.length >= 2)
    assert.ok(measured.every(header => JSON.stringify(header.tools) === JSON.stringify(tools)))
  } finally { f.coordinator.stop() }
})
for (const kind of ['defer', 'uncertain', 'young', 'disabled', 'auth', 'too-large', 'timeout', 'changed'] as const) test(`preemptive keeps evidence: ${kind}`, async () => {
  const f = fixture({ events: kind === 'young' ? history() : exposed(), configured: kind !== 'auth', budgetMs: kind === 'timeout' ? 5 : 5000,
    evaluate: async batch => {
      if (batch.purpose !== 'compaction') return f.result(batch)
      if (kind === 'timeout') await new Promise(resolve => setTimeout(resolve, 20))
      if (kind === 'changed') f.session.append('todo/write', { todos: [] })
      return { ...f.result(batch), answers: batch.questions.map(q => q.id === 'timing' && kind === 'uncertain' ? { id: q.id, status: 'abstained', reason: 'uncertain' } : { id: q.id, status: 'selected', choiceId: q.id === 'timing' ? kind === 'defer' ? 'defer' : 'compact' : 'shorten' }) }
    } })
  f.services.llm.resolveModelInfo = async () => ({ context: { contextWindow: 50000 } })
  if (kind === 'disabled') f.service.semanticCompaction.preemptive = false
  if (kind === 'too-large') f.events[0]!.data.content[0].text = 'long required task '.repeat(16000)
  try {
    boundary(f)
    if (kind === 'changed') await assert.rejects(f.step(), /changed/); else await f.step()
    assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
    const count = f.calls.length; await f.step(); assert.equal(f.calls.length, count)
  } finally { f.coordinator.stop(); await f.coordinator.drain() }
})
test('progress ignores initial completion, rename, reorder, final completion, interrupted attempts and historical boundaries', () => {
  const f = fixture({ events: exposed() }), progress = new SessionProgress(f.session)
  const write = (todos: unknown) => { f.session.append('todo/write', { todos }); progress.scan(f.session); return progress.takeBoundary() }
  assert.equal(write(done), undefined)
  assert.equal(write([...done].reverse()), undefined)
  assert.equal(write([{ content: 'renamed', status: 'completed' }, done[1]]), undefined)
  assert.equal(write([{ content: 'renamed', status: 'completed' }, { content: 'second', status: 'completed' }]), undefined)
  write(pending); assert.ok(write(done))
  assert.equal(new SessionProgress(f.session).takeBoundary(), undefined)
  const young = f.session.seq
  f.session.append('assistant/message', { stream: [], interrupted: true, message: { source: { kind: 'model' } } })
  f.session.append('assistant/attempt', {}); progress.scan(f.session); assert.equal(progress.exposedTwice(young), false)
  f.coordinator.stop()
})
