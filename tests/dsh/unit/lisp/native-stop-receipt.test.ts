import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeStopReceipt } from '../../../../src/dsh/lisp/native-stop-receipt.js'
const expected = { callId: 'child', rootCallId: 'root', ownerId: 'agent', sessionId: 'session', cwd: '/tmp/project' }
const termination = { version: 1, kind: 'managed-range-empty', ...expected }
const result = { isError: true, error: { info: { code: 'ABORTED' } }, meta: { termination } }
test('an exact host cancellation receipt remains cancellation, not successful completion', () => {
  const receipt = nativeStopReceipt(result, expected)!
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.processStopped, true)
  assert.equal(receipt.operationId, expected.callId)
})
for (const key of ['callId', 'rootCallId', 'ownerId', 'sessionId', 'cwd'] as const)
  test(`a mismatched ${key} cannot settle this operation`, () => {
    assert.equal(nativeStopReceipt({ ...result, meta: { termination: { ...termination, [key]: 'foreign' } } }, expected), undefined)
  })
for (const value of [null, {}, { ...result, isError: false }, { ...result, meta: undefined },
  { ...result, error: { info: { code: 'TIMEOUT' } } },
  { ...result, meta: { termination: { ...termination, version: 2 } } },
  { ...result, meta: { termination: { ...termination, kind: 'producerReported' } } },
  { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] },
  { ...result, value: { receipt: { processStopped: true } }, meta: undefined }])
  test('missing, textual, successful or unsupported evidence remains unconfirmed', () => {
    assert.equal(nativeStopReceipt(value, expected), undefined)
  })

test('working directory spelling stays exact; the dispatcher must resolve relative paths before execution', () => {
  assert.equal(nativeStopReceipt({ ...result, meta: { termination: { ...termination, cwd: expected.cwd + '/.' } } }, expected), undefined)
})
