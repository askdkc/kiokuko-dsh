import assert from 'node:assert/strict'
import test from 'node:test'
import { updateVolatile, createVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../../../../src/dsh/config.js'
import { APPROVAL_CONFIG_SERVICE, bindApprovalConfig, nativeApprovalConfig } from '../../../../src/dsh/live-approval-config.js'
import { mountApprovalPolicy } from '../../../../src/dsh/lisp/approval-settings.js'

test('native ConfigForms approval settings persist through the current profile service', async () => {
  const schema = nativeApprovalConfig(Config)
  const resolved = schema({ lisp: { enabled: true, approvalMode: 'auto' } }) as any
  const services: Record<string, any> = {}
  const ctx: any = { fiber: { entry: { options: { id: 'kiokuko-dsh' } } }, get: (name: string) => services[name], provide: (name: string, value: unknown) => { services[name] = value } }
  const configuration = Config.parse(bindApprovalConfig(ctx, resolved))
  assert.equal(configuration.lisp.approvalMode, 'auto')
  const source = services[APPROVAL_CONFIG_SERVICE]
  assert.equal(source.namespace, 'kiokuko-dsh')
  assert.deepEqual(source.path, ['lisp', 'approvalMode'])
  let writes = 0
  services.settings = { writable: true, async update(namespace: string, patch: any) { assert.equal(namespace, 'kiokuko-dsh'); writes++; updateVolatile(resolved.lisp.approvalMode, createVolatile(patch.lisp.approvalMode)) } }
  const policy = mountApprovalPolicy(ctx, configuration.lisp.approvalMode, () => {})
  assert.equal(policy.mode(), 'auto'); assert.equal(policy.writable(), true)
  await policy.set('ask')
  assert.equal(policy.mode(), 'ask'); assert.equal(writes, 1)
})
