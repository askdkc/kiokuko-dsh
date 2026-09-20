import test from 'node:test'
import assert from 'node:assert/strict'
import { compactionBatch, selectCandidates } from '../../../../src/dsh/semantic-compaction/policy.js'
import { COMPACTION_MARKER } from '../../../../src/dsh/semantic-compaction/contracts.js'
import { renderHistoryResult, renderResult } from '../../../../src/dsh/lisp/model-result.js'
import { fixture, history } from '../../helpers/semantic-compaction.js'

for (const text of ['English log. '.repeat(1000), '日本語🙂𠮷'.repeat(1000)]) test(`Unicode head/tail projection: ${text.slice(0, 7)}`, () => {
  const f = fixture({ events: history(text) }), before = structuredClone(f.events)
  const [candidate] = selectCandidates(f.events, f.meter, new Map())
  assert.ok(candidate)
  const shortened = candidate.replacement.content[0]!.content[0].text
  assert.equal(shortened, Array.from(text).slice(0, 300).join('') + '\n' + COMPACTION_MARKER + '\n' + Array.from(text).slice(-100).join(''))
  assert.deepEqual(f.events, before)
  const batch = compactionBatch(f.events, [], [candidate])
  assert.ok(!JSON.stringify(batch).includes('replay-only'))
  assert.ok(JSON.stringify(batch).includes('acceptance criteria'))
  f.coordinator.stop()
})

for (const change of ['first-call', 'recent-result', 'ambiguous', 'multiple-text', 'image', 'unknown-block-field', 'replacement', 'short', 'enno', 'lisp-unknown']) test(`preserves protected content: ${change}`, () => {
  const f = fixture(), result = f.events[7]!.data.message.content[0], call = f.events[6]!.data.message.content[0]
  if (change === 'first-call') f.events.shift()
  if (change === 'recent-result') f.events.pop()
  if (change === 'ambiguous') f.events[6]!.data.message.content.push({ ...call })
  if (change === 'multiple-text') result.content.push({ type: 'text', text: 'second' })
  if (change === 'image') result.content.push({ type: 'image', attachment: {} })
  if (change === 'unknown-block-field') result.content[0].unknown = true
  if (change === 'replacement') f.events[7]!.sourceEventSeqs = [0]
  if (change === 'short') result.content[0].text = '🙂'.repeat(1024)
  if (change === 'enno') call.name = 'enno_work_report'
  if (change === 'lisp-unknown') call.name = 'lisp_eval'
  assert.equal(selectCandidates(f.events, f.meter, new Map()).length, 0)
  f.coordinator.stop()
})

test('Lisp history profile preserves failed outcomes, change summaries and exact inspection paths', () => {
  const source = { ok: true, operationId: 'operation-1', generation: 2, state: 'COMPLETED', changes: [{ id: 'edit', state: 'FAILED', reason: 'No approval' }], value: { json: { code: 2, state: 'FAILED', stdout: 'old output '.repeat(1000), stderr: '' } } }
  const original = renderResult(source), shortened = renderHistoryResult(original)
  assert.ok(shortened); assert.ok(Buffer.byteLength(shortened) <= 1024)
  const result = JSON.parse(shortened)
  assert.equal(result.value.json.code, 2); assert.equal(result.value.json.state, 'FAILED')
  assert.deepEqual(result.changes, source.changes); assert.equal(result.changeSummary.states.FAILED, 1)
  assert.equal(result.inspect.resultOperationId, 'operation-1'); assert.equal(result.inspect.pointer, '/value/json/stdout')
  const inspected = result.inspect.pointer.slice(1).split('/').reduce((v: any, key: string) => v[key], source)
  assert.equal(inspected, source.value.json.stdout)
  assert.equal(renderHistoryResult(JSON.stringify({ ...source, message: 'protected'.repeat(1000) })), undefined)
})
