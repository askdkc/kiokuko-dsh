import assert from 'node:assert/strict'
import test from 'node:test'
import { mountCore } from '../../../src/dsh/core/host.js'

test('direct disabled core never resolves services or mounts model authentication', async () => {
  let touched = 0
  const ctx = {get(){touched++;throw new Error('disabled service access')},inject(){touched++;throw new Error('disabled model mount')}} as any
  const handle = await mountCore(ctx,{enabled:false})
  handle.stopIngress();await handle.drain();await handle.dispose()
  assert.equal(touched,0)
})
