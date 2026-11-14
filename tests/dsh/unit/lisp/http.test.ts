import assert from 'node:assert/strict'
import test from 'node:test'
import { mountLispHttp } from '../../../../src/dsh/lisp/http.js'

test('recovery HTTP uses DSH authenticated Host, rejects cross-origin and accepts no approval/write action', async () => {
  let handler!: (request: Request) => Promise<Response>, effects = 0
  const ctx = { get: () => ({ fetch: { register: (route: any) => { handler = route.fetch; return () => {} } } }) }
  const manager = { status: async () => ({state:'RECOVERY_REQUIRED'}), recover: async () => { effects++; return {state:'READY'} } }
  mountLispHttp(ctx as any, manager as any, id => ({sessionId:id,agentId:id,root:'/workspace'}))
  const request = (origin: string, action = 'recover') => new Request('http://localhost/api/kiokuko.lisp?sessionId=s', { method:'POST', headers: { host:'127.0.0.1:8123',origin,'content-type':'application/json' }, body: JSON.stringify({action}) })
  assert.equal((await handler(request('http://127.0.0.1:8123'))).status, 200)
  assert.equal(effects, 1)
  assert.equal((await handler(request('https://outside.example'))).status, 403)
  assert.equal((await handler(request('http://127.0.0.1:8123', 'approve'))).status, 409)
  assert.equal(effects, 1)
})

test('authenticated conversation recovery uses the host mode-only route without accepting effects', async () => {
  let handler!: (request: Request) => Promise<Response>, recovered = 0
  const ctx = { get: () => ({ fetch: { register: (route: any) => { handler = route.fetch; return () => {} } } }) }
  mountLispHttp(ctx as any, { recover: () => { throw new Error('The conversation host must own its recovery route') } } as any,
    id => ({ sessionId: id, agentId: id, root: '/workspace' }), async (id, signal) => {
      assert.equal(id, 's'); assert.equal(signal.aborted, false); recovered++; return { state: 'READY' }
    })
  const request = (body: object, origin = 'http://localhost') => new Request('http://localhost/api/kiokuko.lisp?sessionId=s', {
    method: 'POST', headers: { origin }, body: JSON.stringify(body),
  })
  assert.equal((await handler(request({ action: 'recover' }))).status, 200)
  assert.equal((await handler(request({ action: 'recover' }, 'http://outside.example'))).status, 403)
  assert.equal((await handler(request({ action: 'recover', approval: true }))).status, 409)
  assert.equal((await handler(request({ action: 'restore' }))).status, 409)
  assert.equal(recovered, 1)
})

test('human reset uses the session-bound host route without re-registering tools', async () => {
  let handler!: (request: Request) => Promise<Response>, resets = 0
  const ctx = { get: () => ({ fetch: { register: (route: any) => { handler = route.fetch; return () => {} } } }) }
  mountLispHttp(ctx as any, {} as any, (id, register) => {
    assert.equal(register, undefined, 'reset must preserve existing tool registrations')
    return { sessionId: id, agentId: id, root: '/workspace' }
  }, async (id, signal, reset) => {
    assert.equal(id, 's'); assert.equal(signal.aborted, false); assert.equal(reset, true)
    resets++
    if (resets === 1) throw new Error('owned process stop failed')
    return { state: 'READY', toolsPreserved: true, managedUnknownOperations: [] }
  })
  const request = (body: object, origin = 'http://localhost') => new Request('http://localhost/api/kiokuko.lisp?sessionId=s', {
    method: 'POST', headers: { origin }, body: JSON.stringify(body),
  })
  assert.equal((await handler(request({ action: 'reset' }, 'http://outside.example'))).status, 403)
  assert.equal((await handler(request({ action: 'reset', approval: true }))).status, 409)
  assert.equal(resets, 0)
  assert.equal((await handler(request({ action: 'reset' }))).status, 409)
  const result = await handler(request({ action: 'reset' }))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { state: 'READY', toolsPreserved: true, managedUnknownOperations: [] })
  assert.equal(resets, 2)
})
