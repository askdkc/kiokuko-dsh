import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
function walk(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    assert.ok(!entry.isSymbolicLink(), path)
    return entry.isDirectory() ? walk(directory, path) : [path]
  }).sort()
}

test('repository delivers the exact Rust crate, protocol specification and portable offline release recipe', async t => {
  const crate = join(root, 'crates/guardrail'), release = join(root, 'crates/guardrail-release')
  // Genuine absence assertion before reading/importing any newly introduced source file.
  assert.ok(existsSync(join(crate, 'Cargo.toml')), 'repository must include the actual Rust guardrail source module')
  const source = json(join(release, 'source-manifest.json'))
  const manifest = json(join(root, 'guardrail/manifest.json'))
  await t.test('frozen source and executable manifests bind the same complete crate', () => {
    assert.ok(Object.keys(source.files).length > 0, 'source manifest must enumerate the complete crate')
    assert.deepEqual(walk(crate), Object.keys(source.files).sort())
    const actual = Object.fromEntries(walk(crate).map(file => [file, sha(readFileSync(join(crate, file)))]))
    assert.deepEqual(actual, source.files)
    assert.equal(sha(JSON.stringify(actual)), source.sourceSha256)
    for (const target of Object.values(manifest.targets) as Array<{ manifest: string }>) {
      const packaged = json(join(root, target.manifest))
      assert.deepEqual(packaged.sources, actual)
      assert.equal(packaged.source_sha256, source.sourceSha256)
      assert.equal(packaged.version, source.version)
    }
    assert.equal(readFileSync(join(crate, 'examples/coding-routine.lisp'), 'utf8'), readFileSync(join(root, manifest.protocol.path), 'utf8'))
    const specification = readFileSync(join(crate, 'README.md'), 'utf8')
    assert.match(specification, /## Language/)
    assert.match(specification, /## Evidence wire schema v2/)
    assert.match(specification, /not a Common Lisp implementation/)
    assert.match(specification, /not a globally unique task identifier/)
    for (const file of walk(crate)) assert.doesNotMatch(readFileSync(join(crate, file), 'utf8'), /\/workspace\/scratch\/|\/Users\/[^/]+\//)
    assert.doesNotMatch(readFileSync(join(crate, 'Cargo.toml'), 'utf8'), /^\[(?:build-|dev-)?dependencies\]/m)
  })
  await t.test('official component inputs and honest target status accompany the source', () => {
    const provenance = json(join(release, 'release-provenance.json'))
    assert.equal(provenance.source_sha256, source.sourceSha256)
    for (const component of provenance.official_toolchain_components) {
      assert.match(component.url, /^https:\/\/(?:static\.rust-lang\.org|ziglang\.org)\//)
      assert.match(component.sha256, /^[a-f0-9]{64}$/)
    }
    for (const target of Object.keys(manifest.targets)) {
      const inputs = json(join(release, 'build-inputs', `${target}.json`))
      assert.deepEqual(inputs, provenance.package_manifests[target].build_inputs)
      assert.equal(inputs.target, target)
      assert.ok(inputs.command.includes('--offline'))
      assert.ok(inputs.command.includes('--locked'))
    }
    const building = readFileSync(join(release, 'BUILDING.md'), 'utf8')
    assert.match(building, /native execution remains unrun/)
    assert.match(building, /SOURCE_DATE_EPOCH=0/)
    assert.match(building, /does not download or install/)
  })
  await t.test('release plan is relocatable, validates inputs and never runs the supplied tools', () => {
    const directory = mkdtempSync(join(tmpdir(), 'guardrail-recipe-'))
    try {
      const repository = join(directory, 'repository with spaces'), maintenance = join(repository, 'crates/guardrail-release'), fixtureCrate = join(repository, 'crates/guardrail'), tool = join(directory, 'tools with spaces')
      mkdirSync(join(maintenance, 'build-inputs'), { recursive: true }); mkdirSync(fixtureCrate, { recursive: true }); mkdirSync(tool)
      cpSync(join(release, 'release.py'), join(maintenance, 'release.py'))
      const content = 'fixture source\n', files = { 'Cargo.toml': sha(content) }
      writeFileSync(join(fixtureCrate, 'Cargo.toml'), content)
      writeFileSync(join(maintenance, 'source-manifest.json'), JSON.stringify({ files, sourceSha256: sha(JSON.stringify(files)) }))
      const marker = join(directory, 'TOOL_EXECUTED')
      const toolBytes = `#!/bin/sh\nprintf bad > '${marker}'\nexit 99\n`
      for (const name of ['cargo', 'rustc', 'cc', 'ld']) writeFileSync(join(tool, name), toolBytes, { mode: 0o755 })
      writeFileSync(join(maintenance, 'build-inputs/x86_64-unknown-linux-musl.json'), JSON.stringify({ target: 'x86_64-unknown-linux-musl', cargo_sha256: sha(toolBytes), rustc_sha256: sha(toolBytes), source_date_epoch: 0 }))
      writeFileSync(join(maintenance, 'release-provenance.json'), JSON.stringify({ source_sha256: sha(JSON.stringify(files)), toolchains: { linux_x64: { cc_binary_sha256: sha(toolBytes), ld_binary_sha256: sha(toolBytes) } } }))
      const output = join(directory, 'output'), args = [join(maintenance, 'release.py'), '--target', 'x86_64-unknown-linux-musl', '--cargo', join(tool, 'cargo'), '--rustc', join(tool, 'rustc'), '--cc', join(tool, 'cc'), '--ld', join(tool, 'ld'), '--output', output, '--plan']
      const invoke = (argv: string[]) => spawnSync('python3', argv, { encoding: 'utf8', cwd: directory, timeout: 5_000 })
      const planned = invoke(args)
      assert.equal(planned.status, 0, planned.stderr)
      assert.equal(JSON.parse(planned.stdout).executed, false)
      const plan = JSON.parse(planned.stdout)
      assert.ok(Array.isArray(plan.compilerArguments), 'release plan must expose the actual unsplit compiler argument construction')
      assert.deepEqual(plan.compilerArguments, [`--remap-path-prefix=${fixtureCrate}=kiokuko-guardrail`, '--remap-path-prefix=TEMP=build'])
      assert.equal(plan.encodedRustFlags, plan.compilerArguments.join('\u001f'))
      assert.equal(plan.targetLinker, join(tool, 'cc'), 'x64 target must select the verified compiler directly')
      assert.equal(plan.targetLinkerKey, 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER')
      assert.match(plan.driverLinkerBoundary, /search is not enforced/)
      assert.equal(JSON.parse(planned.stdout).command[3], join(fixtureCrate, 'Cargo.toml'))
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(output), false)
      const badOutput = [...args]; badOutput[badOutput.indexOf('--output') + 1] = join(repository, 'generated')
      assert.match(invoke(badOutput).stderr, /output must be outside the repository/)
      writeFileSync(join(tool, 'cargo'), `${toolBytes}#changed\n`)
      assert.match(invoke(args).stderr, /cargo executable identity mismatch/)
      writeFileSync(join(tool, 'cargo'), toolBytes)
      writeFileSync(join(fixtureCrate, 'Cargo.toml'), `${content}changed\n`)
      assert.match(invoke(args).stderr, /Source differs from the frozen release/)
      assert.equal(existsSync(marker), false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  await t.test('runtime notices are preserved and source/build tools stay out of npm', () => {
    const directory = mkdtempSync(join(tmpdir(), 'guardrail-source-pack-'))
    try {
      const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 ** 2, env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), npm_config_cache: join(directory, 'cache') } })
      assert.equal(result.status, 0, result.stderr)
      const packed = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path) as string[]
      assert.ok(!packed.some(path => path.startsWith('crates/')), 'npm runtime must exclude crate source/build tooling')
      assert.ok(packed.includes('guardrail/manifest.json'))
      const noticeRoot = join(root, 'docs/guardrail-licenses'), notices = json(join(noticeRoot, 'manifest.json'))
      for (const [file, entry] of Object.entries(notices.files) as Array<[string, { sha256: string }]>) {
        assert.equal(sha(readFileSync(join(noticeRoot, file))), entry.sha256)
        assert.ok(packed.includes(`docs/guardrail-licenses/${file}`), file)
      }
      assert.match(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /docs\/guardrail-licenses/)
      assert.match(readFileSync(join(root, 'scripts/stage-modules.mjs'), 'utf8'), /guardrail-licenses/)
      assert.match(readFileSync(join(root, 'scripts/pack-check.mjs'), 'utf8'), /'crates\/'/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

test('current release CLI admits three shipping targets and rejects historical Intel Mac', () => {
  const script=join(root,'crates/guardrail-release/release.py')
  const help=spawnSync('python3',[script,'--help'],{encoding:'utf8'})
  assert.equal(help.status,0,help.stderr)
  for(const target of ['x86_64-unknown-linux-musl','aarch64-unknown-linux-musl','aarch64-apple-darwin'])assert.ok(help.stdout.includes(target))
  assert.ok(!help.stdout.includes('x86_64-apple-darwin'))
  const intel=spawnSync('python3',[script,'--target','x86_64-apple-darwin'],{encoding:'utf8'})
  assert.equal(intel.status,2);assert.match(intel.stderr,/invalid choice.*x86_64-apple-darwin/)
})

// Static identities detect stale/inconsistent inputs, not a maliciously rewritten
// history. Fresh output provenance comes from release.py's observed two builds;
// the unsigned records are not an independent supply-chain attestation.
test('current source binding rejects stale source manifests and target provenance', async () => {
  const { verifyGuardrailSource } = await import('../../../scripts/guardrail-artifacts.mjs')
  assert.equal(verifyGuardrailSource(root), json(join(root, 'crates/guardrail-release/source-manifest.json')).sourceSha256)
  const directory = mkdtempSync(join(tmpdir(), 'guardrail-source-binding-'))
  try {
    cpSync(join(root, 'crates'), join(directory, 'crates'), { recursive: true })
    cpSync(join(root, 'guardrail'), join(directory, 'guardrail'), { recursive: true })
    cpSync(join(root, 'package.json'), join(directory, 'package.json'))
    const sourceFile = join(directory, 'crates/guardrail/src/lib.rs')
    const original = readFileSync(sourceFile)
    writeFileSync(sourceFile, Buffer.concat([original, Buffer.from('\n// simulated current source change\n')]))
    assert.throws(() => verifyGuardrailSource(directory), /current source identity mismatch/)
    writeFileSync(sourceFile, original)
    const provenancePath = join(directory, 'crates/guardrail-release/release-provenance.json')
    const provenance = json(provenancePath)
    provenance.source_sha256 = '0'.repeat(64)
    writeFileSync(provenancePath, JSON.stringify(provenance))
    assert.throws(() => verifyGuardrailSource(directory), /provenance source/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
