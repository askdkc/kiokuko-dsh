import assert from 'node:assert/strict'
import test from 'node:test'
import { digest, renderResult, RESULT_BYTES } from '../../../../src/dsh/lisp/contracts.js'
import { lispToolSchema, ToolInput } from '../../../../src/dsh/lisp/surface.js'
import { selectFields, validateValue } from '../../../../src/dsh/lisp/task-tools.js'

test('reordered JSON keys retain request identity; oversized Unicode output remains valid bounded JSON', () => {
  assert.equal(digest({a:1,b:{x:2,y:3}}), digest({b:{y:3,x:2},a:1}))
  assert.notEqual(digest({a:1}), digest({a:2}))
  const output = renderResult({text:'日本語🙂'.repeat(30000)})
  assert.equal(JSON.parse(output).truncated, true)
  assert.ok(Buffer.byteLength(output) <= RESULT_BYTES)
})

test('task schemas and result projection never treat inherited object fields as evidence', () => {
  assert.throws(() => validateValue({ type: 'object', properties: { toString: { type: 'string' } },
    required: ['toString'], additionalProperties: false }, {}), /Missing toString/)
  assert.deepEqual(selectFields({}, ['/constructor'], 'saved-ref'), { '/constructor': { missing: true } })
})

test('native task-tool requests survive the surface parser before reaching the manager', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  for (const request of [
    { operationId: 'define', name: 'sample', description: 'Sample', source: '(lambda (x) x)', inputSchema: { type: 'string' }, outputSchema: { type: 'string' } },
    { operationId: 'call', toolRef: id, inputRef: id },
    { operationId: 'observe', paths: ['manifest.json'], format: 'json' },
    { operationId: 'stage', resultRef: id, baseRef: id },
    { operationId: 'verify', candidateRef: id, target: 'test', script: 'test:unit' },
    { operationId: 'apply', candidateRef: id, verificationRef: 'verify' },
    { operationId: 'compare', leftRef: id, rightRef: id },
    { operationId: 'describe', toolRef: id },
  ]) assert.deepEqual(ToolInput.parse(request), request)
})

test('generated task tools expose object-root native schemas with their required inputs', () => {
  for (const [name, fields] of [
    ['lisp_define', ['name', 'source', 'inputSchema', 'outputSchema']],
    ['lisp_call', ['toolRef']],
    ['lisp_observe', ['paths']],
    ['lisp_stage', ['resultRef', 'baseRef']],
    ['lisp_verify', ['candidateRef', 'target']],
    ['lisp_apply', ['candidateRef']],
    ['lisp_compare', ['leftRef', 'rightRef']],
  ] as const) {
    const schema = lispToolSchema(name) as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    for (const field of fields) { assert.ok(schema.required.includes(field)); assert.ok(schema.properties[field]) }
  }
})
