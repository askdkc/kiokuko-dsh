import assert from 'node:assert/strict'
import test from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { preparationCarrierResult } from '../../../src/dsh/preparation-carrier-result.js'

// Current run_code allows logs and optional sandbox, never arbitrary result.
const schema = { type: 'object', additionalProperties: false, properties: {
  logs: { type: 'array', items: { type: 'string' } }, sandbox: { type: 'object' },
}, required: ['logs'] }

test('all host receipts fit the strict PTC output contract and remain model-visible', () => {
  for (const receipt of [
    { prepared: true, programExecuted: false },
    { prepared: false, requestInterpretation: { state: 'required' }, programExecuted: false },
    { status: 'invalid_preparation_request', programExecuted: false },
    { state: 'Pending' },
  ]) {
    const response = preparationCarrierResult(receipt)
    assert.deepEqual(validateJsonSchemaValue(schema, response.value), [])
    assert.deepEqual(Object.keys(response.value), ['logs'])
    assert.deepEqual(JSON.parse(response.value.logs[0]!), receipt)
    assert.equal(response.content[0]!.text, response.value.logs[0])
  }
  assert.match(validateJsonSchemaValue(schema, { logs: [], result: {} }).join(' '), /result/)
})
