import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { gte } from 'semver'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../../..')
const json = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const yaml = (name: string) => parse(readFileSync(join(root, name), 'utf8'))
const manifest = json('package.json')
const transformersRequire = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'))

test('security overrides resolve consistently in both package-manager lockfiles', () => {
  const npm = json('package-lock.json')
  const pnpm = yaml('pnpm-lock.yaml')
  const workspace = yaml('pnpm-workspace.yaml')
  for (const [name, minimum] of Object.entries({ 'adm-zip': '0.6.0', sharp: '0.35.4' })) {
    const version = manifest.overrides[name]
    assert.ok(gte(version, minimum), `${name}: the published security fix must not regress`)
    assert.equal(workspace.overrides[name], version)
    assert.equal(pnpm.overrides[name], version)
    const npmVersions = Object.entries(npm.packages)
      .filter(([key]) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`)
      .map(([, entry]) => (entry as { version: string }).version)
    const pnpmVersions = Object.keys(pnpm.packages).filter(key => key.startsWith(`${name}@`))
      .map(key => key.slice(name.length + 1))
    assert.ok(npmVersions.length > 0 && pnpmVersions.length > 0)
    assert.deepEqual([...new Set(npmVersions)], [version])
    assert.deepEqual([...new Set(pnpmVersions)], [version])
  }
})

test('the actual Transformers dependencies use the security pins and retain image/ZIP APIs', async () => {
  const sharp = transformersRequire('sharp')
  assert.equal(sharp.versions.sharp, manifest.overrides.sharp)
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
    .resize(1, 1).png().toBuffer()
  const metadata = await sharp(png).metadata()
  assert.equal(metadata.width, 1)
  assert.equal(metadata.height, 1)

  const ortRequire = createRequire(transformersRequire.resolve('onnxruntime-node'))
  assert.equal(ortRequire('adm-zip/package.json').version, manifest.overrides['adm-zip'])
  const AdmZip = ortRequire('adm-zip')
  const zip = new AdmZip()
  zip.addFile('fixture.txt', Buffer.from('zip round trip'))
  const reopened = new AdmZip(zip.toBuffer())
  assert.equal(reopened.readAsText(reopened.getEntry('fixture.txt')), 'zip round trip')
  // Intentionally do not claim that adm-zip 0.6.0 fixes symlink extraction.
})

test('CI skips the ONNX download/extraction path even when Linux CUDA files are requested', () => {
  const ci = yaml('.github/workflows/ci.yml')
  assert.equal(ci.env.ONNXRUNTIME_NODE_INSTALL, 'skip')
  const ortManifest = transformersRequire.resolve('onnxruntime-node/package.json')
  const installer = join(dirname(ortManifest), 'script/install.js')
  const script = `
    const os = require('node:os');
    os.platform = () => 'linux'; os.arch = () => 'x64';
    require('node:https').get = () => { throw new Error('blocked ONNX installer download'); };
    require(process.argv[1]);
  `
  const env = { ...process.env, ONNXRUNTIME_NODE_INSTALL: ci.env.ONNXRUNTIME_NODE_INSTALL }
  execFileSync(process.execPath, ['-e', script, installer], { env, timeout: 10_000, stdio: 'pipe' })
  // Prove the guard is exercised if optional downloads are explicitly enabled.
  const enabled = spawnSync(process.execPath, ['-e', script, installer], {
    env: { ...env, ONNXRUNTIME_NODE_INSTALL: 'true' }, timeout: 10_000, encoding: 'utf8',
  })
  assert.equal(enabled.error, undefined)
  assert.notEqual(enabled.status, 0)
  assert.match(enabled.stderr, /blocked ONNX installer download/u)
})

test('the bundled ONNX CPU runtime still performs inference without optional downloads', async () => {
  const ort = transformersRequire('onnxruntime-node')
  // ONNX IR 8 / opset 13: one float32 value through Identity, with no external data.
  const model = Buffer.from('08083a480a100a017812017922084964656e74697479121273656375726974792d6370752d736d6f6b655a0f0a0178120a0a08080112040a020801620f0a0179120a0a08080112040a0208014202100d', 'hex')
  const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] })
  try {
    const output = await session.run({ x: new ort.Tensor('float32', Float32Array.from([42]), [1]) })
    assert.deepEqual([...output.y.data], [42])
  } finally {
    await session.release()
  }
})
