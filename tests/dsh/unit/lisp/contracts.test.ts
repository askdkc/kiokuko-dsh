import assert from 'node:assert/strict'
import test from 'node:test'
import { digest, renderResult, RESULT_BYTES } from '../../../../src/dsh/lisp/contracts.js'

test('reordered JSON keys retain request identity; oversized Unicode output remains valid bounded JSON', () => {
  assert.equal(digest({a:1,b:{x:2,y:3}}), digest({b:{y:3,x:2},a:1}))
  assert.notEqual(digest({a:1}), digest({a:2}))
  const output = renderResult({text:'日本語🙂'.repeat(30000)})
  assert.equal(JSON.parse(output).truncated, true)
  assert.ok(Buffer.byteLength(output) <= RESULT_BYTES)
})
