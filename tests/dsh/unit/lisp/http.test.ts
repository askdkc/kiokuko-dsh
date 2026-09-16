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
