import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { createRequestIntentContext } from '../../../src/dsh/decisions/request-intent.js'
import { bindRequestSourceContext, projectRequestSourceMessages, requestSourceManifest, readRequestSource } from '../../../src/dsh/request-sources.js'

test('multi-megabyte source pages reconstruct every requirement without replacing the original with a summary', () => {
  const text = '# 計画\n置換コードの例: $& $$ $` $\'\n' + '🔎実行手順と禁止事項\n'.repeat(200_000) + '\n最後の受入条件: native と PTC を確認する。'
  const context = createRequestIntentContext({ task: text, messageRefs: [{ id: 'human', digest: canonicalContentHash(text) }] })!
  const source = requestSourceManifest(context)[0]!
  assert.equal(source.truncated, true)
  assert.ok(JSON.stringify(source).length < 1500)
  const parts: string[] = []
  let offset = 0
  do {
    const page = readRequestSource(context, { id: source.id, digest: source.digest, offset, limit: 16384 })
    parts.push(page.text)
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  } while (true)
  assert.equal(parts.join(''), text)
  assert.equal(context.task, text)
  const agent = {}, messages = [{ role: 'user', content: [{ type: 'text', text }] },
    { role: 'tool', content: [{ type: 'text', text: JSON.stringify({ originalTask: text, prepared: true }) }] }]
  bindRequestSourceContext(agent, context)
  const projected = projectRequestSourceMessages(agent, messages)
  assert.ok(JSON.stringify(projected).length < 5000)
  assert.match(projected[0]!.content[0]!.text, /read_request_source/)
  assert.equal(messages[0]!.content[0]!.text, text)
  assert.deepEqual(projectRequestSourceMessages({}, messages), messages, 'another agent cannot use this context')
  bindRequestSourceContext(agent, undefined)
  assert.deepEqual(projectRequestSourceMessages(agent, messages), messages)
  assert.throws(() => readRequestSource(context, { id: 'request', digest: 'a'.repeat(64) }), /changed/)
  assert.throws(() => readRequestSource(context, { id: source.id, digest: source.digest, explicit: true }))
  assert.throws(() => readRequestSource(context, { id: source.id, digest: source.digest, offset: text.length + 1 }), /range/)
  assert.throws(() => readRequestSource(context, { id: source.id, digest: source.digest, limit: 16385 }))
})
