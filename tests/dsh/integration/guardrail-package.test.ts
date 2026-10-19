import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const target = 'x86_64-unknown-linux-musl'
const host = { platform: 'linux', arch: 'x64' }

test('guardrail shipping contract verifies bundled bytes and fails closed before enrollment', async t => {
  const packageMetadata = readJson(join(root, 'package.json'))
  // This assertion must run before importing the new resolver: RED is a missing shipping contract, not a missing module.
  assert.ok(packageMetadata.files.includes('guardrail/'), 'package files must ship the precompiled guardrail directory')
  assert.ok(packageMetadata.files.includes('scripts/guardrail-artifacts.mjs'))
  assert.ok(packageMetadata.files.includes('scripts/guardrail-artifacts.d.mts'))
  assert.equal(packageMetadata.scripts['verify:guardrail'], 'node scripts/guardrail-artifacts.mjs --verify-bundled')
  assert.equal(packageMetadata.scripts['check:guardrail'], 'node scripts/guardrail-artifacts.mjs --check-host')
  const { resolveGuardrail } = await import('../../../scripts/guardrail-artifacts.mjs')
  const manifest = readJson(join(root, 'guardrail/manifest.json'))
  assert.equal(packageMetadata.guardrail.manifestSha256, sha(readFileSync(join(root, 'guardrail/manifest.json'))))
  assert.deepEqual(Object.keys(manifest.targets), ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin'])
  assert.deepEqual(manifest.unavailableTargets, [])
  assert.equal(existsSync(join(root, 'guardrail/x86_64-apple-darwin')), false)

  function fixture(fn: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'guardrail-package-'))
    try {
      cpSync(join(root, 'guardrail'), join(directory, 'guardrail'), { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify(packageMetadata))
      mkdirSync(join(directory, 'scripts'))
      cpSync(join(root, 'scripts/guardrail-artifacts.mjs'), join(directory, 'scripts/guardrail-artifacts.mjs'))
      fn(directory)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  function repin(directory: string, change: (binary: Buffer) => Buffer) {
    const binaryPath = join(directory, 'guardrail', target, 'kiokuko-guardrail')
    const bytes = change(readFileSync(binaryPath))
    writeFileSync(binaryPath, bytes)
    const releasePath = join(directory, 'guardrail', target, 'manifest.json')
    const release = readJson(releasePath)
    release.artifacts['bin/kiokuko-guardrail'] = { bytes: bytes.length, sha256: sha(bytes) }
    writeFileSync(releasePath, JSON.stringify(release))
    const indexPath = join(directory, 'guardrail/manifest.json')
    const index = readJson(indexPath)
    Object.assign(index.targets[target], { bytes: bytes.length, sha256: sha(bytes), manifestSha256: sha(readFileSync(releasePath)) })
    writeFileSync(indexPath, JSON.stringify(index))
    const pkg = readJson(join(directory, 'package.json'))
    pkg.guardrail.manifestSha256 = sha(readFileSync(indexPath))
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg))
  }

  await t.test('resolves exact bundled identity with no runtime process or PATH dependency', () => {
    const result = resolveGuardrail(root, host)
    assert.deepEqual(Object.keys(result).sort(), ['binary', 'engineDigest', 'manifestDigest', 'protocol', 'protocolFileDigest', 'target', 'version'])
    assert.equal(result.binary, join(root, 'guardrail', target, 'kiokuko-guardrail'))
    assert.equal(result.protocol, join(root, 'guardrail/protocols/coding-routine.lisp'))
    assert.equal(result.engineDigest, sha(readFileSync(result.binary)))
    assert.equal(result.protocolFileDigest, sha(readFileSync(result.protocol)))
    assert.equal(result.manifestDigest, packageMetadata.guardrail.manifestSha256)
    assert.equal(result.version, manifest.version)
    assert.equal(result.target, target)
    assert.ok((lstatSync(result.binary).mode & 0o111) !== 0)
  })
  await t.test('missing platforms report unavailable; unsupported hosts never select another architecture', () => {
    for (const options of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'linux', arch: 'arm64' }]) {
      const selected = resolveGuardrail(root, options)
      assert.equal(manifest.targets[selected.target].verification.native_smoke, 'not run')
      fixture(directory => {
        const indexPath = join(directory, 'guardrail/manifest.json'), index = readJson(indexPath)
        delete index.targets[selected.target]; index.unavailableTargets.push(selected.target); writeFileSync(indexPath, JSON.stringify(index))
        const pkg = readJson(join(directory, 'package.json')); pkg.guardrail.manifestSha256 = sha(readFileSync(indexPath)); writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg))
        assert.throws(() => resolveGuardrail(directory, options), /unavailable.*not bundled/i)
      })
    }
    for (const options of [{ platform: 'darwin', arch: 'x64' }, { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'ia32' }, { platform: '../../linux', arch: 'x64' }]) {
      assert.throws(() => resolveGuardrail(root, options), /unsupported host/i)
    }
  })
  await t.test('missing binary, release manifest and protocol are failures', () => {
    for (const path of [`guardrail/${target}/kiokuko-guardrail`, `guardrail/${target}/manifest.json`, 'guardrail/protocols/coding-routine.lisp']) fixture(directory => {
      rmSync(join(directory, path))
      assert.throws(() => resolveGuardrail(directory, host), /missing|unavailable/i)
    })
  })
  await t.test('tampered index, release manifest, binary and protocol are failures', () => {
    for (const path of ['guardrail/manifest.json', `guardrail/${target}/manifest.json`, `guardrail/${target}/kiokuko-guardrail`, 'guardrail/protocols/coding-routine.lisp']) fixture(directory => {
      writeFileSync(join(directory, path), Buffer.concat([readFileSync(join(directory, path)), Buffer.from('\n')]))
      assert.throws(() => resolveGuardrail(directory, host), /digest|size|integrity/i)
    })
  })
  await t.test('non-executable binary cannot enroll', () => fixture(directory => {
    chmodSync(join(directory, 'guardrail', target, 'kiokuko-guardrail'), 0o644)
    assert.throws(() => resolveGuardrail(directory, host), /executable/i)
  }))
  await t.test('binary, manifest, protocol and asset-parent symlinks are rejected', () => {
    for (const path of [`guardrail/${target}/kiokuko-guardrail`, `guardrail/${target}/manifest.json`, 'guardrail/protocols/coding-routine.lisp', 'guardrail/protocols']) fixture(directory => {
      const full = join(directory, path), elsewhere = join(directory, 'original')
      cpSync(full, elsewhere, { recursive: true })
      rmSync(full, { recursive: true })
      symlinkSync(elsewhere, full)
      assert.throws(() => resolveGuardrail(directory, host), /symlink/i)
    })
  })
  await t.test('directory and FIFO binaries are rejected promptly without opening a blocking stream', () => fixture(directory => {
    const binary = join(directory, 'guardrail', target, 'kiokuko-guardrail')
    rmSync(binary); mkdirSync(binary)
    assert.throws(() => resolveGuardrail(directory, host), /regular/i)
    if (process.platform !== 'win32') {
      rmSync(binary, { recursive: true })
      const fifo = spawnSync('mkfifo', [binary], { encoding: 'utf8', timeout: 2_000 })
      assert.equal(fifo.status, 0, fifo.stderr)
      const resolveCode = `const { resolveGuardrail } = await import(${JSON.stringify(pathToFileURL(join(directory, 'scripts/guardrail-artifacts.mjs')).href)}); try { resolveGuardrail(${JSON.stringify(directory)}, { platform: 'linux', arch: 'x64' }); } catch (error) { console.error(error.message); process.exitCode = 1; }`
      const checked = spawnSync(process.execPath, ['--input-type=module', '--eval', resolveCode], { encoding: 'utf8', timeout: 2_000 })
      assert.equal(checked.status, 1, checked.stderr)
      assert.match(checked.stderr, /regular/i)
    }
  }))
  await t.test('truncated, wrong-architecture and malformed executable layout fail even when file hashes are repinned', () => {
    const cases: Array<(binary: Buffer) => Buffer> = [
      binary => binary.subarray(0, 64),
      binary => { binary.writeUInt16LE(183, 18); return binary },
      binary => { binary.writeUInt32LE(0, 0); return binary },
      binary => { binary.writeBigUInt64LE(2n ** 63n, 32); return binary },
      binary => { binary.writeUInt16LE(0, 56); return binary },
      binary => { binary.writeBigUInt64LE(BigInt(binary.length + 1), 64 + 32); return binary },
      binary => { binary.writeUInt32LE(3, 64); return binary },
    ]
    for (const change of cases) fixture(directory => {
      repin(directory, change)
      assert.throws(() => resolveGuardrail(directory, host), /ELF|static|executable|architecture|truncated/i)
    })
  })
  await t.test('release target and version mismatch cannot be hidden by updating the index hash', () => {
    for (const field of ['target', 'version']) fixture(directory => {
      const releasePath = join(directory, 'guardrail', target, 'manifest.json')
      const release = readJson(releasePath); release[field] = 'mismatch'
      writeFileSync(releasePath, JSON.stringify(release))
      const indexPath = join(directory, 'guardrail/manifest.json'), index = readJson(indexPath)
      index.targets[target].manifestSha256 = sha(readFileSync(releasePath)); writeFileSync(indexPath, JSON.stringify(index))
      const pkg = readJson(join(directory, 'package.json')); pkg.guardrail.manifestSha256 = sha(readFileSync(indexPath)); writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg))
      assert.throws(() => resolveGuardrail(directory, host), /manifest.*identity/i)
    })
  })
  await t.test('product version is metadata-derived independently of the engine version', () => fixture(directory => {
    const pkg = readJson(join(directory, 'package.json')), expectedPackageVersion = `${pkg.version}-fixture`
    pkg.version = expectedPackageVersion; writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg))
    assert.equal(readJson(join(directory, 'package.json')).version, expectedPackageVersion)
    assert.equal(resolveGuardrail(directory, host).version, manifest.version)
  }))
  await t.test('verification helper validates bundled artifacts and distinguishes host enrollment', () => {
    const checked = spawnSync(process.execPath, [join(root, 'scripts/guardrail-artifacts.mjs'), '--verify-bundled'], { encoding: 'utf8', timeout: 5_000, env: { PATH: '', HOME: tmpdir() } })
    assert.equal(checked.status, 0, checked.stderr)
    const output = JSON.parse(checked.stdout)
    assert.deepEqual(output.verifiedTargets, Object.keys(manifest.targets))
    assert.deepEqual(output.unavailableTargets, manifest.unavailableTargets)
    assert.equal(output.nativeExecutionClaim, false)
    const quiet = spawnSync(process.execPath, [join(root, 'scripts/guardrail-artifacts.mjs'), '--verify-bundled', '--quiet'], { encoding: 'utf8', timeout: 5_000, env: { PATH: '', HOME: tmpdir() } })
    assert.equal(quiet.status, 0, quiet.stderr); assert.equal(quiet.stdout, '')
  })
  await t.test('isolated package consumer invokes precompiled engine twice without Cargo, SBCL or PATH fallback', () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') { t.diagnostic('Native execution is unavailable on this test host; branch coverage is not a native claim.'); return }
    fixture(directory => {
      const resolved = resolveGuardrail(directory, host)
      const environment = { PATH: '', HOME: directory }
      for (let restart = 0; restart < 2; restart++) {
        const version = spawnSync(resolved.binary, ['--version'], { encoding: 'utf8', env: environment, timeout: 5_000 })
        assert.equal(version.status, 0, version.stderr)
        assert.equal(version.stdout.trim(), `kiokuko-guardrail ${manifest.version}`)
        const validated = spawnSync(resolved.binary, ['validate', resolved.protocol], { encoding: 'utf8', env: environment, timeout: 5_000 })
        assert.equal(validated.status, 0, validated.stderr)
      }
      assert.equal(existsSync(join(directory, 'target')), false)
    })
  })
  await t.test('package and core staging explicitly retain guardrail assets with bounded permission metadata', () => {
    const pack = readFileSync(join(root, 'scripts/pack-check.mjs'), 'utf8')
    const stage = readFileSync(join(root, 'scripts/stage-modules.mjs'), 'utf8')
    assert.match(pack, /guardrail\/node-runner\.mjs/)
    assert.match(pack, /resolveGuardrail/)
    assert.match(stage, /guardrail\/manifest\.json/)
    assert.match(stage, /guardrail\/.*walk|walk\(join\(root, 'guardrail'\)\)/)
    assert.match(stage, /manifest\.guardrail/)
    assert.match(stage, /Bundled Rust guardrail/)
  })
})

test('composed core package preserves declared guardrail files, executable modes and permissions', async () => {
  const modulePath = '../../../scripts/compose-modules.mjs'
  const { composeModules } = await import(modulePath)
  const { resolveGuardrail } = await import('../../../scripts/guardrail-artifacts.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'guardrail-compose-'))
  try {
    const core = join(directory, 'core'), composed = join(directory, 'composed')
    mkdirSync(join(core, 'dist/dsh'), { recursive: true })
    mkdirSync(join(core, 'scripts')); mkdirSync(join(core, 'lisp'))
    cpSync(join(root, 'guardrail'), join(core, 'guardrail'), { recursive: true })
    cpSync(join(root, 'micro-judge'), join(core, 'micro-judge'), { recursive: true })
    cpSync(join(root, 'scripts/verify-micro-judge.mjs'), join(core, 'scripts/verify-micro-judge.mjs'))
    for (const file of ['guardrail-artifacts.mjs', 'guardrail-artifacts.d.mts']) cpSync(join(root, 'scripts', file), join(core, 'scripts', file))
    cpSync(join(root, 'lisp/supervisor.mjs'), join(core, 'lisp/supervisor.mjs'))
    const metadata = readJson(join(root, 'package.json'))
    metadata.dsh.permissions = { summary: 'Core fixture permissions', readPaths: ['Bundled Rust guardrail artifacts'], commands: ['Bundled Rust guardrail check/validate'], failureBoundaries: ['Cross-built targets are not native-tested'] }
    writeFileSync(join(core, 'package.json'), JSON.stringify(metadata))
    writeFileSync(join(core, 'module-core.json'), JSON.stringify({ id: 'core', coreVersion: 1 }))
    writeFileSync(join(core, 'dist/dsh/skill-prompts-core.json'), JSON.stringify({ resources: [] }))
    // An unrelated executable mode must not become executable merely because composition copies it.
    writeFileSync(join(core, 'scripts/unrelated.mjs'), 'export const unrelated = true\n', { mode: 0o755 })
    const composedMetadata = await composeModules({ core }, composed)
    assert.ok(composedMetadata.files.includes('micro-judge/'), 'composed package retains the required semantic detector')
    assert.ok(composedMetadata.files.includes('guardrail/'), 'composed package files must preserve bundled guardrail assets')
    assert.ok(composedMetadata.files.includes('lisp/supervisor.mjs'), 'core-only composition retains the owned process supervisor')
    assert.ok(composedMetadata.dsh.permissions.commands.includes('Bundled Rust guardrail check/validate'))
    assert.ok(composedMetadata.dsh.permissions.readPaths.includes('Bundled Rust guardrail artifacts'))
    assert.deepEqual(composedMetadata.dsh.permissions.failureBoundaries, metadata.dsh.permissions.failureBoundaries)
    assert.equal(lstatSync(join(composed, 'scripts/unrelated.mjs')).mode & 0o111, 0)
    assert.equal(lstatSync(join(composed, 'guardrail', target, 'kiokuko-guardrail')).mode & 0o777, 0o755)
    for (const options of [host, { platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' }]) resolveGuardrail(composed, options)
    assert.equal(existsSync(join(composed, 'guardrail/x86_64-apple-darwin')), false)
    assert.throws(() => resolveGuardrail(composed, { platform: 'darwin', arch: 'x64' }), /unsupported host.*no binary fallback/i)
    if (process.platform === 'linux' && process.arch === 'x64') {
      const selected = resolveGuardrail(composed)
      const checked = spawnSync(selected.binary, ['validate', selected.protocol], { encoding: 'utf8', env: { PATH: '', HOME: directory }, timeout: 5_000 })
      assert.equal(checked.status, 0, checked.stderr)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('bundle verification rejects a pinned manifest with no actual bundled target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guardrail-empty-bundle-'))
  try {
    cpSync(join(root, 'guardrail'), join(directory, 'guardrail'), { recursive: true })
    mkdirSync(join(directory, 'scripts'))
    cpSync(join(root, 'scripts/guardrail-artifacts.mjs'), join(directory, 'scripts/guardrail-artifacts.mjs'))
    const indexPath = join(directory, 'guardrail/manifest.json'), index = readJson(indexPath)
    index.unavailableTargets = Object.keys(index.targets); index.targets = {}
    writeFileSync(indexPath, JSON.stringify(index))
    const metadata = readJson(join(root, 'package.json'))
    metadata.guardrail.manifestSha256 = sha(readFileSync(indexPath))
    writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata))
    for (const flags of [[], ['--quiet']]) {
      const checked = spawnSync(process.execPath, [join(directory, 'scripts/guardrail-artifacts.mjs'), '--verify-bundled', ...flags], { encoding: 'utf8', timeout: 2_000 })
      assert.equal(checked.status, 1, 'an empty but repinned manifest must not pass bundled artifact verification')
      assert.match(checked.stderr, /no bundled targets/i)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
