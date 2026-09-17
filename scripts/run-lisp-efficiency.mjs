import assert from 'node:assert/strict'
import { renderResult, RESULT_BYTES, LISP_TOOLS } from '../src/dsh/lisp/contracts.ts'
import { lispToolSchema } from '../src/dsh/lisp/surface.ts'

// Anonymous deterministic fixtures shaped like the observed 13/21-file batches.
// No provider calls, private session data, filesystem changes or token/cost estimates.
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
const legacyRender = value => {
  const text = JSON.stringify(value)
  return bytes(text) <= 65536 ? text : JSON.stringify({ truncated: true,
    message: '応答が表示上限を超えました。lisp_status または /kioku-lisp diagnostics で操作 ID を確認してください。',
    preview: Buffer.from(text).subarray(0, 12000).toString('utf8') })
}
const fixtures = [13, 21].map(count => {
  const result = { ok: true, operationId: 'fixture', generation: 'fixture-generation', value: { printed: 'paths', json: ['paths'], ref: 'g/1' },
    proposals: Array.from({ length: count }, (_, i) => ({ operation: 'write', path: `src/file-${i}.ts`, content: '// 日本語🙂\nexport const fixture = true;\n'.repeat(1000) })),
    changes: Array.from({ length: count }, (_, i) => ({ id: `proposal-${i}`, state: 'APPLIED', path: `src/file-${i}.ts` })) }
  const baselineBytes = bytes(legacyRender(result)), current = renderResult(result), currentBytes = bytes(current)
  assert.ok(currentBytes <= RESULT_BYTES); assert.ok(currentBytes <= baselineBytes * 0.2)
  assert.equal(JSON.parse(current).changeSummary.states.APPLIED, count)
  return { files: count, baselineBytes, currentBytes, reductionPercent: Number((100 * (1 - currentBytes / baselineBytes)).toFixed(1)),
    confirmationsForExistingFiles: { baseline: count, current: 1 } }
})
const currentSchemas = LISP_TOOLS.map(name => ({ name, parameters: lispToolSchema(name) }))
// Reconstruct the previous input schema contract; unchanged fields are identical.
const previousSchemas = structuredClone(currentSchemas)
for (const { name, parameters } of previousSchemas) {
  if (name === 'lisp_status') delete parameters.properties.offset
  if (name === 'lisp_inspect') {
    for (const key of ['resultOperationId', 'section', 'pointer', 'offset', 'limit']) delete parameters.properties[key]
    delete parameters.properties.ref.description; parameters.required.push('ref')
  }
}
console.log(JSON.stringify({ format: 'kiokuko.lisp-efficiency.v1', evidence: 'synthetic serialized model surfaces; confirmation behavior covered by tests',
  providerCalls: 0, tokensSaved: null, costSaved: null, resultLimitBytes: RESULT_BYTES, fixtures,
  toolInputSchemas: { baselineBytes: bytes(previousSchemas), currentBytes: bytes(currentSchemas) } }, null, 2))
