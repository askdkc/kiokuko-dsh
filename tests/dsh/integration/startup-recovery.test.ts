import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDshPlugin, startupProfile, startupRecoveryMessage } from '../../../src/dsh/startup-recovery.js'

const sourceCli = '/checkout/apps/cli/src/bin.ts'

test('startup recovery targets the launch profile and preserves the installation choice', () => {
  assert.equal(startupProfile(['node', sourceCli, 'web', '--no-open']), 'web')
  assert.equal(startupProfile(['node', 'dsh', '--profile', 'custom']), 'custom')
  assert.equal(startupProfile(['node', 'dsh', '--profile=acp']), 'acp')
  assert.equal(startupProfile(['node', 'dsh', '--', '--profile=ignored']), undefined)
  assert.equal(startupProfile(['node', 'dsh', '--profile']), undefined)
  assert.equal(startupProfile(['node', 'dsh', 'web'], 'file:///tmp/profiles/team/cordis.yml'), 'team')
  const advice = startupRecoveryMessage(['node', sourceCli, 'web'])
  assert.match(advice, /pnpm dsh plugin --profile web update kiokuko-dsh --latest/)
  assert.match(advice, /pnpm dsh plugin --profile web add kiokuko-dsh@latest --force/)
  assert.match(advice, /GitHub\/local installs, reinstall the original package spec/)
  assert.match(advice, /Reinstallation cannot fix every DSH API mismatch/)
  assert.match(advice, /Do not delete session logs/)
  assert.match(startupRecoveryMessage(['node', '/bin/dsh', '--profile=team']), /Restart DSH with the same profile: dsh --profile team/)
  for (const profile of ['bad;echo unsafe', '$(unsafe)', '']) {
    const message = startupRecoveryMessage(['node', 'dsh', `--profile=${profile}`])
    assert.match(message, /--profile PROFILE_NAME/)
    assert.doesNotMatch(message, /unsafe/)
  }
})

test('import diagnostics preserve the original error and do not log for success', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const module = { apply() {} }
  assert.equal(await loadDshPlugin(async () => module), module)
  assert.equal(log.mock.callCount(), 0)
  const cause = new Error('dependency cause')
  const failure = new Error('dependency is incompatible', { cause })
  await assert.rejects(loadDshPlugin(async () => { throw failure }), error => error instanceof Error && error === failure && error.cause === cause)
  assert.equal(log.mock.callCount(), 2)
  assert.match(String(log.mock.calls[0]!.arguments[1]), /dependency is incompatible/)
  assert.match(String(log.mock.calls[1]!.arguments[0]), /update kiokuko-dsh --latest/)
})
