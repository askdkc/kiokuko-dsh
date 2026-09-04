import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import * as lifecycle from '../../../src/dsh/session-bridge.js'
import { DSH_MEMORY_CAPSULE_MAX_BYTES } from '../../../src/dsh/session-memory-finalizer.js'

const root = path.resolve(import.meta.dirname, '../../..')

test('DSH integration exposes no event-mirroring compatibility bridge', async () => {
  assert.equal('DshSessionBridge' in lifecycle, false)
  assert.equal('mountDshSessionBridge' in lifecycle, false)
  assert.equal('mountDshDurabilityBarriers' in lifecycle, false)
  const composition = await readFile(path.join(root, 'src/dsh/composition.ts'), 'utf8')
  assert.doesNotMatch(composition, /session\/event|on\(['"]session\/flush/gu)
})

test('the complete memory capsule, not each fragment, is bounded to 64 KiB', () => {
  assert.equal(DSH_MEMORY_CAPSULE_MAX_BYTES, 65_536)
})
