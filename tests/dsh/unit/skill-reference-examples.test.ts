import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const document = readFileSync(new URL('../../../skills/kiokuko-single-purpose-functions/references/kiokuko-patterns.md', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
function example(name: 'parseWindow' | 'parseRequest' | 'useResource'): any {
  const begin = `<!-- example:${name} -->`, end = `<!-- /example:${name} -->`
  assert.equal(document.split(begin).length, 2, `${name}: unique opening marker`)
  assert.equal(document.split(end).length, 2, `${name}: unique closing marker`)
  const section = document.slice(document.indexOf(begin) + begin.length, document.indexOf(end))
  const matches = [...section.matchAll(/```ts\n([\s\S]*?)\n```/g)]
  assert.equal(matches.length, 1, `${name}: exactly one executable block`)
  const compiled = ts.transpileModule(matches[0]![1]!, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true })
  assert.deepEqual(compiled.diagnostics, [])
  const exports = {}
  // Only the three marked, trusted repository examples are executable.
  new Function('require', 'exports', compiled.outputText)(require, exports)
  return exports
}

function hostileObjects(valid: Record<string, unknown>, key: string): { values: unknown[]; calls(): number } {
  let calls = 0
  const getter = (throws: boolean) => Object.defineProperty({ ...valid }, key, { enumerable: true, get() { calls++; if (throws) throw new Error('getter'); return calls === 1 ? 1 : -1 } })
  const proxy = new Proxy(valid, { get() { calls++; throw new Error('get') }, getPrototypeOf() { calls++; throw new Error('prototype') }, ownKeys() { calls++; throw new Error('keys') }, getOwnPropertyDescriptor() { calls++; throw new Error('descriptor') } })
  const revoked = Proxy.revocable(valid, {}); revoked.revoke()
  return { values: [getter(false), getter(true), proxy, revoked.proxy, Object.create(valid), Object.defineProperty({ ...valid }, key, { value: valid[key], enumerable: false }), { ...valid, extra: true }, { ...valid, [Symbol('field')]: true }], calls: () => calls }
}

test('published parseWindow rejects active objects before effects and returns the values it validated', () => {
  const { parseWindow, endOfWindow } = example('parseWindow')
  const input = { start: 0, limit: 100 }, result = parseWindow(input)
  assert.deepEqual(result, input); assert.notEqual(result, input)
  input.start = -1; input.limit = 0
  assert.deepEqual(result, { start: 0, limit: 100 })
  assert.equal(endOfWindow({ start: 5, limit: 2 }), 7)
  assert.deepEqual(parseWindow(Object.assign(Object.create(null), { start: 0, limit: 1 })), { start: 0, limit: 1 })
  for (const value of [null, undefined, [], {}, { start: 0 }, ...[-1, 0.5, NaN, Infinity, '0', undefined].map(start => ({ start, limit: 1 })), ...[0, 101, 1.5, NaN, Infinity, '1', null].map(limit => ({ start: 0, limit }))]) assert.throws(() => parseWindow(value))
  const hostile = hostileObjects({ start: 0, limit: 1 }, 'start')
  for (const value of hostile.values) assert.throws(() => parseWindow(value))
  assert.equal(hostile.calls(), 0)
})

test('published parseRequest validates a closed owned data protocol with omission-only default', () => {
  const { parseRequest } = example('parseRequest')
  const input = { requestId: 'request', paths: ['a'], limit: 100 }, result = parseRequest(input)
  assert.deepEqual(result, input); assert.notEqual(result.paths, input.paths)
  input.paths[0] = 'changed'; assert.deepEqual(result.paths, ['a'])
  assert.deepEqual(parseRequest({ requestId: 'r', paths: [] }), { requestId: 'r', paths: [], limit: 20 })
  assert.deepEqual(parseRequest(Object.assign(Object.create(null), { requestId: 'r', paths: [] })), { requestId: 'r', paths: [], limit: 20 })
  for (const value of [null, [], {}, { paths: [] }, { requestId: 'r' }, ...['', 'r'.repeat(257), 1].map(requestId => ({ requestId, paths: [] })), ...[null, undefined, 0, 101, 1.5, NaN, '20'].map(limit => ({ requestId: 'r', paths: [], limit })), ...[null, undefined, [1], [''], ['a'.repeat(4097)], Array(101).fill('a'), new Array(1), Object.assign(['a'], { extra: 1 })].map(paths => ({ requestId: 'r', paths }))]) assert.throws(() => parseRequest(value))
  const hostile = hostileObjects({ requestId: 'r', paths: [] }, 'requestId')
  for (const value of hostile.values) assert.throws(() => parseRequest(value))
  assert.equal(hostile.calls(), 0)
  let calls = 0
  const paths = Object.defineProperty(['a'], '0', { get() { calls++; throw new Error('element') } })
  for (const value of [paths, new Proxy([], { get() { calls++; throw new Error('array') }, getPrototypeOf() { calls++; throw new Error('array prototype') } })]) assert.throws(() => parseRequest({ requestId: 'r', paths: value }))
  assert.equal(calls, 0)
})

test('published useResource closes once and retains both failures, including throw undefined', async () => {
  const { useResource } = example('useResource')
  const openFailure = new Error('open'), operationFailure = new Error('operation'), cleanupFailure = new Error('cleanup')
  let operated = false
  await assert.rejects(useResource(async () => { throw openFailure }, async () => { operated = true }), (error: unknown) => error === openFailure)
  assert.equal(operated, false)
  for (const operationFails of [false, true]) for (const cleanupFails of [false, true]) for (const failure of [operationFailure, undefined]) {
    const calls: string[] = []
    const result = useResource(async () => { calls.push('open'); return { async close() { calls.push('close'); if (cleanupFails) throw cleanupFailure } } }, async () => { calls.push('operation'); if (operationFails) throw failure; return 42 })
    if (!operationFails && !cleanupFails) assert.equal(await result, 42)
    else {
      const outcome = await result.then((value: unknown) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
      assert.equal(outcome.ok, false)
      if (operationFails && cleanupFails) { assert.ok(outcome.error instanceof AggregateError); assert.deepEqual(outcome.error.errors, [failure, cleanupFailure]) }
      else assert.equal(outcome.error, operationFails ? failure : cleanupFailure)
    }
    assert.deepEqual(calls, ['open', 'operation', 'close'])
  }
})
