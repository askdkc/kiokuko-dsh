// The provider protocol baseline is independent from the selected DSH runtime.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { assertDshFixtureIdentity, selectedDshRuntime, dshRuntimeMode } from './dsh-fixture-identity.mjs'
import { stageDshUpstream } from './stage-dsh-upstream.mjs'

const metadata = directory => JSON.parse(readFileSync(join(directory, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
export function selectedCodeHost(root, environment = process.env) {
  return selectedDshRuntime(root, environment).upstream
}
export function assertCodeHost(directory, selected) {
  if (!selected) return
  const identity = assertDshFixtureIdentity(directory, metadata(directory))
  assert.equal(identity?.sha, selected.sha, 'Code acceptance runtime SHA differs')
  assert.equal(identity?.sourceRoot, selected.sourceRoot, 'Code acceptance runtime source differs')
}
export function stageCodeHost(directory, selected) {
  if (!selected) return
  stageDshUpstream(selected.sourceRoot, directory, selected.sha)
  assertCodeHost(directory, selected)
}
export function assertCodeConsumerHost(directory, selected) {
  if (!selected) return
  assertCodeHost(directory, selected)
  const mapping = JSON.parse(readFileSync(join(directory, 'node_modules/.kiokuko-dsh-upstream.json'), 'utf8')).packages
  const require = createRequire(join(directory, 'package.json'))
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm']) {
    const resolved = realpathSync(require.resolve(name))
    assert.ok(resolved.startsWith(realpathSync(mapping[name]) + sep), `${name} resolves outside the selected official graph`)
  }
}
export function codeProfileHostDependencies(installedVersions, selected) {
  // Unpublished master must never be reconstructed from same-version registry packages.
  return selected ? {} : installedVersions
}
export function codeRuntimeEnvironment(root, packed, selected, environment = process.env) {
  const mode = dshRuntimeMode(environment)
  assert.ok(!selected || mode === 'current', 'Historical mode cannot use a current code runtime selection')
  assert.ok(selected || mode === 'historical', 'Current code runtime requires staged official identity')
  const env = { ...environment, KIOKUKO_DSH_PACKAGE_ROOT: packed
    ? join(root, '.artifacts/code-intelligence/profile/node_modules')
    : resolve(environment.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')) }
  if (selected) {
    env.KIOKUKO_DSH_RUNTIME_MODE = 'current'
    env.KIOKUKO_EXPECTED_DSH_SHA = selected.sha
    delete env.KIOKUKO_CODE_CLI_HOST // Do not mount a historical vendor CLI into official DSH.
  } else if (packed) env.KIOKUKO_CODE_CLI_HOST = '1'
  return env
}
