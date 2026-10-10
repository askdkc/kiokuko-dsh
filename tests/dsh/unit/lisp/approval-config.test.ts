import assert from 'node:assert/strict'
import test from 'node:test'
import { updateVolatile, createVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../../../../src/dsh/config.js'
import { nativeApprovalConfig, bindApprovalConfig, APPROVAL_CONFIG_SERVICE } from '../../../../src/dsh/live-approval-config.js'
import { mountApprovalPolicy } from '../../../../src/dsh/lisp/approval-settings.js'
import { confirm } from '../../../../src/dsh/lisp/approval.js'

test('omitted approval mode requires consent through plain and native configuration', async () => {
  const ctx: any = {fiber: {}, get: () => undefined}
  for (const input of [{}, {lisp: {enabled: true}}]) {
    const plain = Config.parse(input)
    const native = Config.parse(bindApprovalConfig(ctx, nativeApprovalConfig(Config)(input)))
    assert.equal(plain.lisp.approvalMode, 'ask')
    assert.equal(native.lisp.approvalMode, 'ask')
    const approvalPolicy = mountApprovalPolicy(ctx, native.lisp.approvalMode, () => {})
    let questions = 0
    const question = { id: 'apply', question: 'Apply?', options: [{ label: 'No' }, { label: 'Yes' }], intent: { kind: 'plan-review', approve: 'Yes' } }
    const decision = await confirm({approvalPolicy, ask: async () => { questions++; return { answers: [{ id: 'apply', selected: ['No'] }] } }} as any, 'agent', question as any, new AbortController().signal)
    assert.deepEqual(decision, { approved: false, reason: 'declined' })
    assert.equal(questions, 1)
    const unavailable = await confirm({approvalPolicy, ask: async () => { throw new Error('UI unavailable') }} as any, 'agent', question as any, new AbortController().signal)
    assert.deepEqual(unavailable, { approved: false, reason: 'unavailable' })
  }
  const explicit = {lisp: {approvalMode: 'ask'}}
  assert.equal(Config.parse(explicit).lisp.approvalMode, 'ask')
  assert.equal(Config.parse(bindApprovalConfig(ctx, nativeApprovalConfig(Config)(explicit))).lisp.approvalMode, 'ask')
})

test('native live Config preserves ordinary config, profile entry identity and current values', async () => {
  const schema = nativeApprovalConfig(Config)
  const resolved = schema({lisp:{enabled:true, approvalMode:'auto', maxWorkers:3}, agenticReplay:{enabled:false}}) as any
  const services: Record<string, any> = {}
  const ctx: any = {fiber:{entry:{id:'include:kiokuko-dsh',options:{id:'kiokuko-dsh'}}},get:(name:string)=>services[name],provide:(name:string,value:any)=>{services[name]=value}}
  const plain = Config.parse(bindApprovalConfig(ctx, resolved))
  assert.equal(plain.lisp.enabled, true); assert.equal(plain.lisp.approvalMode, 'auto'); assert.equal(plain.agenticReplay.enabled,false)
  const source=services[APPROVAL_CONFIG_SERVICE]
  assert.equal(source.namespace,'kiokuko-dsh')
  let writes=0
  services.settings={writable:true,async update(namespace:string, patch:any) {
    writes++; assert.equal(namespace,'kiokuko-dsh'); updateVolatile(resolved.lisp.approvalMode,createVolatile(patch.lisp.approvalMode))
  }}
  const first=mountApprovalPolicy(ctx,'ask',()=>{}), second=mountApprovalPolicy(ctx,'ask',()=>{})
  assert.equal(first.mode(),'auto'); assert.equal(first.writable(),true)
  await first.set('ask'); assert.equal(second.mode(),'ask'); assert.equal(writes,1)
  assert.throws(()=>schema({lisp:{approvalMode:'invalid'}}))
  assert.equal(nativeApprovalConfig(Config).parse({}).lisp.approvalMode,'ask')
})

for (const mode of ['ask', 'auto'] as const) test(`explicit ${mode} remains authoritative without enabling Lisp`, async () => {
  const ctx: any = { fiber: {}, get: () => undefined }
  const input = { lisp: { approvalMode: mode } }
  for (const configuration of [Config.parse(input), Config.parse(bindApprovalConfig(ctx, nativeApprovalConfig(Config)(input)))]) {
    assert.equal(configuration.lisp.enabled, false)
    assert.equal(configuration.lisp.approvalMode, mode)
    const approvalPolicy = mountApprovalPolicy(ctx, configuration.lisp.approvalMode, () => {})
    let asks = 0
    const question = { id: 'apply', question: 'Apply?', options: [{ label: 'No' }, { label: 'Yes' }], intent: { kind: 'plan-review', approve: 'Yes' } }
    const decision = await confirm({ approvalPolicy, ask: async () => { asks++; return { answers: [{ id: 'apply', selected: ['Yes'] }] } } } as any, 'agent', question as any, new AbortController().signal)
    assert.equal(decision.approved, true)
    assert.equal(asks, mode === 'ask' ? 1 : 0)
  }
})
