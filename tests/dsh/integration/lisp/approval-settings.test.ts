import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountApprovalPolicy } from '../../../../src/dsh/lisp/approval-settings.js'

test('legacy native settings persist approval across restarts and isolate profiles in one document', async () => {
  // This regression targets the removed namespace/file API specifically.
  // The current ConfigForms API is exercised by packed Web acceptance.
  const packages = resolve('tests/fixtures/dsh-runtime/node_modules')
  const [cordis, file] = await Promise.all(['cordis', 'dsh-settings-file'].map(name => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)))
  const dir = await mkdtemp(join(tmpdir(), 'lisp-approval-settings-'))
  const open = async (profile: string, document = profile) => {
    const ctx = new cordis.Context()
    const provider = await ctx.plugin(file.default, { path: join(dir, document + '.yaml'), watch: false })
    let policy!: ReturnType<typeof mountApprovalPolicy>
    const owner = await ctx.plugin({ name: 'approval-consumer', apply(scope: any) { scope.provide('loader', { filename: join(dir, profile, 'cordis.yml') }); policy = mountApprovalPolicy(scope, 'ask', () => {}) } })
    await new Promise(resolve => setTimeout(resolve, 20))
    return { policy, close: async () => { await owner.dispose(); await provider.dispose() } }
  }
  try {
    const first = await open('one')
    assert.equal(first.policy.mode(), 'ask'); assert.equal(first.policy.writable(), true)
    await first.policy.set('auto'); assert.equal(first.policy.mode(), 'auto')
    await first.close()
    const restarted = await open('one'), other = await open('two', 'one')
    try { assert.equal(restarted.policy.mode(), 'auto'); assert.equal(other.policy.mode(), 'ask'); await restarted.policy.set('ask'); assert.equal(restarted.policy.mode(), 'ask') }
    finally { await restarted.close(); await other.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
