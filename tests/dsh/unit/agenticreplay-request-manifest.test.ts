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
