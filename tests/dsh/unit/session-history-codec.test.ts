import assert from 'node:assert/strict'
import test from 'node:test'
import { repairLegacyAbortRecord } from '../../../scripts/session-history-codec.mjs'

const text = 'kiokuko dsh Enno continuation stopped: continuation_limit'
const ending = (cause: unknown) => ({ type: 'turn/end', seq: 730, time: 2,
  data: { turn: 1, reason: { kind: 'aborted', reason: cause } } })

test('known legacy cancellation retains coordinates, text and caller ownership', () => {
  const source = ending(text), before = structuredClone(source)
  const fixed = repairLegacyAbortRecord(source)
  assert.deepEqual(fixed, { ...source, data: { ...source.data, reason: { kind: 'aborted', reason: { kind: 'hook', reason: text } } } })
  assert.deepEqual(source, before)
  assert.equal(repairLegacyAbortRecord(fixed), fixed)
})

test('unrecognized causes and other events are untouched', () => {
  for (const cause of ['other', text + ' ', null, [], { kind: 'hook', reason: text }, { kind: 'unknown', stack: 'stack' }, { kind: 'parent', stack: 42 }]) {
    const source = ending(cause)
    assert.equal(repairLegacyAbortRecord(source), source)
  }
  for (const source of [{ ...ending(text), type: 'step/end' }, { ...ending(text), data: { turn: 1, reason: { kind: 'error', reason: text } } }]) {
    assert.equal(repairLegacyAbortRecord(source), source)
  }
})

test('recognized object causes still remove only diagnostic stack metadata', () => {
  for (const kind of ['user', 'parent', 'disposed', 'legacy', 'hook']) {
    const cause = { kind, ...(kind === 'hook' ? { reason: 'hook text' } : {}), stack: 'stack' }
    const source = ending(cause)
    const { stack: _stack, ...expected } = cause
    assert.deepEqual(repairLegacyAbortRecord(source), ending(expected))
    assert.equal(cause.stack, 'stack')
  }
})
