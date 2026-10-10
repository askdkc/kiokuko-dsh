import assert from 'node:assert/strict'
import test from 'node:test'
import { mountNativeSearch } from '../../../src/dsh/native-search.js'

type Listener = (execution: unknown, result: unknown, next: () => Promise<unknown>) => unknown

const missingResult = (path = 'missing/file.ts') => ({
  isError: true,
  error: {
    message: `grep search failed (exit 2): rg: ${path}: IO error for operation on ${path}: No such file or directory (os error 2)`,
    info: { name: 'SearchError', code: 'SEARCH_FAILED' },
  },
  content: [{ type: 'text', text: 'native failure' }],
})

function mount() {
  const listeners = new Map<string, Listener>()
  const context = {
    on(name: string, listener: Listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const dispose = mountNativeSearch(context)
  const listener = listeners.get('tools/post-execute')
  assert.ok(listener, 'mountNativeSearch must install the post-execute hook')
  return { dispose, listeners, listener }
}

function contentText(decision: unknown): string {
  const content = (decision as any)?.content
  return Array.isArray(content) ? content.map((item: any) => item?.text ?? '').join('') : ''
}

test('rewrites only a confirmed native missing-target failure after downstream policy', async () => {
  const { dispose, listener } = mount()
  try {
    const result = missingResult()
    Object.freeze(result)
    Object.freeze(result.error)
    Object.freeze(result.content)
    let downstreamCalled = false
    const downstreamDecision = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'downstream context' }] }
    const decision = await listener(
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } },
      result,
      async () => {
        downstreamCalled = true
        return downstreamDecision
      },
    )

    assert.equal(downstreamCalled, true)
    assert.equal((decision as any).kind, 'accept')
    assert.deepEqual((decision as any).additionalContexts, downstreamDecision.additionalContexts)
    assert.match(contentText(decision), /cannot search "missing\/file\.ts": not found/u)
    assert.match(contentText(decision), /check the path|omit the path/u)
    assert.deepEqual(result.content, [{ type: 'text', text: 'native failure' }])
  } finally {
    dispose()
  }
})

test('passes successful results through unchanged', async () => {
  const { dispose, listener } = mount()
  try {
    const result = { isError: false, value: { matches: [] }, content: [{ type: 'text', text: 'No matches' }] }
    const downstreamDecision = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'context' }] }
    const decision = await listener({ name: 'grep', arguments: { pattern: 'x' } }, result, async () => downstreamDecision)
    assert.equal(decision, downstreamDecision)
  } finally {
    dispose()
  }
})

test('passes policy blocks and downstream replacements through unchanged', async () => {
  const { dispose, listener } = mount()
  try {
    const policy = { kind: 'block', feedback: [{ type: 'text', text: 'policy denial' }] }
    assert.equal(await listener({ name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }, missingResult(), async () => policy), policy)

    const replacementContent = { kind: 'accept', content: [{ type: 'text', text: 'replacement' }] }
    assert.equal(await listener({ name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }, missingResult(), async () => replacementContent), replacementContent)

    const replacementValue = { kind: 'accept', value: 'replacement' }
    assert.equal(await listener({ name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }, missingResult(), async () => replacementValue), replacementValue)

    const undefinedFields = { kind: 'accept', content: undefined, value: undefined, additionalContexts: [{ type: 'text', text: 'context' }] }
    assert.equal(await listener({ name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }, missingResult(), async () => undefinedFields), undefinedFields)
  } finally {
    dispose()
  }
})

test('does not rewrite malformed, unrelated, or non-missing search failures', async () => {
  const { dispose, listener } = mount()
  try {
    const cases = [
      { name: 'grep', arguments: { pattern: '(unclosed', path: 'file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): regex parse error', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'regex parse error' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'private/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): rg: private/file.ts: IO error for operation on private/file.ts: Permission denied (os error 13)', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'permission denied' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 1): no matches', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'no matches' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): rg: missing/file.ts: No such file or directory\nrg: another.ts: No such file or directory', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'multiple diagnostics' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): rg: missing/file.ts: No such file or directory (stderr truncated)', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'truncated diagnostics' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): spawn rg ENOENT', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'launch failure' }] } },
      { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' }, result: { isError: true, error: { message: 'grep search failed (exit 2): rg: missing/file.ts: No such file or directory', info: { name: 'SearchError', code: 'SEARCH_FAILED' } }, content: [{ type: 'text', text: 'missing without os error' }] } },
      { name: 'read', arguments: { path: 'missing/file.ts' }, result: missingResult() },
    ]
    for (const item of cases) {
      const decision = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'context' }] }
      assert.equal(await listener({ name: item.name, arguments: item.arguments }, item.result, async () => decision), decision)
    }
  } finally {
    dispose()
  }
})

test('preserves native path spelling and waits for an asynchronous downstream decision', async () => {
  const { dispose, listener } = mount()
  try {
    const path = 'dir with spaces/name\\with\\slashes.ts'
    const result = missingResult(path)
    let released = false
    const decision = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'context' }] }
    const output = await listener(
      { name: 'grep', arguments: { pattern: 'x', path } },
      result,
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        released = true
        return decision
      },
    )
    assert.equal(released, true)
    assert.equal((output as any).kind, decision.kind)
    assert.deepEqual((output as any).additionalContexts, decision.additionalContexts)
    assert.ok(contentText(output).includes(`cannot search ${JSON.stringify(path)}: not found`))
  } finally {
    dispose()
  }
})

test('ignores missing-path lookalikes and malformed native results', async () => {
  const { dispose, listener } = mount()
  try {
    const execution = { name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }
    const decision = { kind: 'accept' }
    for (const result of [undefined, null, [], {}, { isError: true }, { isError: true, error: null },
      { ...missingResult(), isError: false }, missingResult('missing/file.ts/child'),
      { ...missingResult(), error: { ...missingResult().error, info: { code: 'SEARCH_ABORTED' } } },
      { ...missingResult(), error: { ...missingResult().error, info: { code: 'SEARCH_INVALID_PATTERN' } } },
    ]) assert.equal(await listener(execution, result, async () => decision), decision)
    for (const arguments_ of [undefined, null, [], {}, { path: '' }, { path: 42 }]) {
      assert.equal(await listener({ ...execution, arguments: arguments_ }, missingResult(), async () => decision), decision)
    }
    const withoutPrefix = missingResult()
    withoutPrefix.error.message = withoutPrefix.error.message.replace('exit 2): rg: ', 'exit 2): ')
    assert.match(contentText(await listener(execution, withoutPrefix, async () => decision)), /cannot search/)
  } finally { dispose() }
})

test('does not rewrite a downstream rejection', async () => {
  const { dispose, listener } = mount()
  try {
    const failure = new Error('downstream failure')
    await assert.rejects(async () => { await listener({ name: 'grep', arguments: { pattern: 'x', path: 'missing/file.ts' } }, missingResult(), async () => { throw failure }) }, failure)
  } finally {
    dispose()
  }
})

test('disposes the hook and never registers a replacement grep tool', () => {
  const listeners = new Map<string, Listener>()
  const registrations: unknown[] = []
  const dispose = mountNativeSearch({
    on(name: string, listener: Listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    get tools() {
      return { register(definition: unknown) { registrations.push(definition); return () => undefined } }
    },
  } as any)
  assert.deepEqual([...listeners.keys()], ['tools/post-execute'])
  assert.deepEqual(registrations, [])
  dispose()
  assert.equal(listeners.size, 0)
})
