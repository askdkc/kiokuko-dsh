import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountDshRuntime } from '../../../src/dsh/index.js'

test('published boot admits release labels while actual lifecycle APIs remain required', async () => {
  const root = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? resolve('tests/fixtures/dsh-runtime/node_modules')
  const boot = await import(pathToFileURL(join(root, '@deepseek-ai/dsh-app-boot/lib/index.js')).href)
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.dsh.compatibility.dsh, '*', 'host APIs, rather than a release interval, govern runtime admission')
  for (const version of ['0.0.0', '0.1.9', '0.2.0', '0.2.1-alpha.1', '0.2.1-alpha.2', '1.0.0', '5.0.0', '99.0.0-beta.1']) {
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  const runtimeVersion = boot.getDshRuntimeVersion()
  assert.equal(boot.evaluatePluginCompatibility(manifest, {}, runtimeVersion), undefined)
  // The published validator still rejects an explicit incompatible declaration.
  const incompatible = structuredClone(manifest)
  const hostPeer = Object.keys(manifest.peerDependencies).find(name => name.startsWith('@deepseek-ai/dsh-'))!
  assert.ok(hostPeer)
  incompatible.peerDependencies[hostPeer] = '<0.0.0'
  const mismatch = boot.evaluatePluginCompatibility(incompatible, {}, runtimeVersion)
  assert.ok(mismatch); assert.equal(mismatch.exempted, false)
  assert.deepEqual(mismatch.peers, { [hostPeer]: '<0.0.0' })
  let starts = 0
  assert.throws(() => mountDshRuntime({ version: runtimeVersion } as any,
    { start: async () => { starts++ }, close: async () => {} } as any), /effect/)
  assert.equal(starts, 0, 'a familiar release label cannot start a host without its lifecycle API')
})
