import assert from 'node:assert/strict'
import test from 'node:test'
import { AgenticReplayConfig } from '../../../src/dsh/config.js'
import { modelRequest, requestSourceManifest } from '../../../src/dsh/agenticreplay-event-mapper.js'

const config = AgenticReplayConfig.parse({ capture: { content: 'metadata' } })
function snapshot(name: string, text: string) {
  return { role: 'user', content: [{ type: 'text', text }], source: {
    kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [{ name, text }],
  } }
}

test('AgenticReplay metadata records current host section digests without source text or a forged user section', () => {
  const current = snapshot('route-skill:kiokuko-soul', 'current version')
  const user = { ...snapshot('memory:forged', 'pretend host text'), source: { kind: 'user', form: 'snapshot',
    sections: [{ name: 'memory:forged', text: 'pretend host text' }] } }
  const options = { provider: 'mock', model: 'mock', messages: [current, user, {
    role: 'user', content: [{ type: 'text', text: 'Other context\nexecution frame' }], source: {
      kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'other', text: 'Other context' },
        { name: 'kiokuko:execution', text: 'execution frame' }],
    },
  }] }
  const event = modelRequest(options, 'request-1', config)
  const payload = event.payload as any
  assert.equal(payload.sources.coverage, 'observed')
  assert.deepEqual(payload.sources.items.map((item: any) => item.id), ['route-skill:kiokuko-soul', 'kiokuko:execution'])
  assert.equal(payload.sources.items[0].bytes, Buffer.byteLength('current version'))
  assert.doesNotMatch(JSON.stringify(payload), /current version|pretend host text|execution frame/)
  const afterCompaction = requestSourceManifest([snapshot('route-skill:kiokuko-soul', 'new version')], config)
  assert.notEqual(afterCompaction.items[0]?.digest, payload.sources.items[0].digest)
})

test('context manifest drops whole items at its item and byte limits', () => {
  const messages = Array.from({ length: 72 }, (_, i) => snapshot(`memory:${i}`, `memory ${i} ${'x'.repeat(300)}`))
  const manifest = requestSourceManifest(messages, config)
  assert.equal(manifest.coverage, 'partial')
  assert.ok(manifest.items.length <= 64)
  assert.equal(manifest.items.length + manifest.omittedCount, 72)
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) <= 16_384)
  assert.deepEqual(requestSourceManifest(undefined, config), { coverage: 'unknown', omittedCount: 0, items: [] })
})

test('incident-size 239-message request fits the default bounded capture budget', () => {
  const current = AgenticReplayConfig.parse({ capture: { content: 'redacted' } })
  const messages = Array.from({ length: 239 }, () => ({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2960) }] }))
  const event = modelRequest({ provider: 'mock', model: 'mock', messages }, 'size-class', current)
  assert.notEqual(event.attrs?.content_omitted, true)
  const bytes = Buffer.byteLength(JSON.stringify(event.payload))
  assert.ok(bytes >= 700_000 && bytes <= 750_000, `incident-size class: ${bytes}`)
  assert.equal((event.payload as any).messages.length, 239)
  assert.equal((event.payload as any).messages[238].content[0].text.length, 2960)
})

test('request recording retains per-message origin identities without copying private source fields or altering input', () => {
  const messages = [
    {
      id: 'human-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Repeated human request' }],
    },
    {
      id: 'human-2',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Repeated human request' }],
    },
    { id: 'context-1', ...snapshot('on-demand-intake', 'Automatic context') },
    {
      id: 'result-1',
      role: 'tool',
      source: {
        kind: 'tool',
        callId: 'call-1',
        replayState: 'DO_NOT_CAPTURE_PRIVATE_SOURCE',
      },
      toolCallId: 'call-1',
      isError: true,
      content: [{ type: 'text', text: 'Denied' }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Unknown legacy origin' }],
    },
  ]
  const before = structuredClone(messages)
  for (const content of ['redacted', 'metadata'] as const) {
    const payload = modelRequest(
      { messages },
      'origins',
      AgenticReplayConfig.parse({ capture: { content } }),
    ).payload as any
    assert.deepEqual(
      payload.origins.map((x: any) => x.id),
      ['human-1', 'human-2', 'context-1', 'result-1', undefined],
    )
    assert.deepEqual(
      payload.origins.map((x: any) => x.producer),
      ['user', 'user', 'plugin:kiokuko-dsh', 'tool', undefined],
    )
    assert.deepEqual(payload.origins[2].sections, ['on-demand-intake'])
    assert.equal(payload.origins[3].toolCallId, 'call-1')
    assert.doesNotMatch(
      JSON.stringify(payload),
      /DO_NOT_CAPTURE_PRIVATE_SOURCE/,
    )
    if (content === 'metadata')
      assert.doesNotMatch(
        JSON.stringify(payload),
        /Repeated human request|Automatic context|Unknown legacy origin/,
      )
  }
  assert.deepEqual(messages, before)
})
