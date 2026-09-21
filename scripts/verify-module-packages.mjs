import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { stageModules } from './stage-modules.mjs'
import { composeModules } from './compose-modules.mjs'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const nativeRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')
await access(join(nativeRoot, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
const work = await mkdtemp(join(tmpdir(), 'kiokuko-module-pack-'))
const env = { ...process.env, npm_config_cache: join(work, 'cache') }
delete env.NODE_TEST_CONTEXT
async function command(executable, args, cwd) {
  try { return await exec(executable, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }) }
  catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error }
}
async function pack(directory, destination) {
  await mkdir(destination, { recursive: true })
  const result = JSON.parse((await command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], directory)).stdout)[0]
  await command('tar', ['-xzf', join(destination, result.filename), '-C', destination], directory)
  return { ...result, directory: join(destination, 'package') }
}
async function installedPackage(name, from) {
  const require = createRequire(join(from, 'package.json'))
  let entry
  try { entry = require.resolve(`${name}/package.json`) } catch { entry = require.resolve(name) }
  let directory = dirname(await realpath(entry))
  while (directory !== dirname(directory)) {
    try { const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (manifest.name === name) return { directory, manifest } } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = dirname(directory)
  }
  throw new Error(`Installed dependency not found: ${name}`)
}
/** Copy only declared dependencies and their dependency closure; never link the development node_modules. */
async function isolatedDependencies(packageRoot, dependencies) {
  const copied = new Map()
  async function copyDependency(name, from, parent) {
    const source = await installedPackage(name, from)
    const previous = copied.get(name)
    if (previous === source.manifest.version) return
    const target = join(previous ? parent : packageRoot, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    await cp(source.directory, target, { recursive: true, dereference: true, filter: path => !path.slice(source.directory.length).split('/').includes('node_modules') })
    if (!previous) copied.set(name, source.manifest.version)
    for (const dep of Object.keys(source.manifest.dependencies ?? {})) await copyDependency(dep, source.directory, target)
    for (const dep of Object.keys(source.manifest.peerDependencies ?? {})) if (!source.manifest.peerDependenciesMeta?.[dep]?.optional) await copyDependency(dep, source.directory, target)
  }
  for (const name of Object.keys(dependencies)) await copyDependency(name, root, packageRoot)
  return Object.fromEntries(copied)
}
try {
  const staged = join(work, 'staged'), report = await stageModules(staged)
  const packed = {}
  for (const name of ['core', 'enno', 'lisp']) packed[name] = await pack(join(staged, name), join(work, `pack-${name}`))
  const coreFiles = new Set(packed.core.files.map(file => file.path))
  for (const path of ['scripts/laya-worker.py', 'scripts/smoke-laya-coreml.mjs', 'docs/laya-coreml.md', 'docs/laya-coreml-LICENSE.txt', 'dist/dsh/decisions/laya-coreml.js', 'dist/dsh/decisions/laya-transport.js']) {
    assert.ok(coreFiles.has(path), `Missing Laya core asset: ${path}`)
  }
  for (const name of ['enno', 'lisp']) for (const file of report.artifacts[name].sourceFiles) assert.ok(!coreFiles.has(file), `${name} duplicates core implementation: ${file}`)
  assert.ok(!packed.core.files.some(file => /^lisp\/|^skills\/kiokuko-(lisp|enno-oduno)\//.test(file.path)))
  assert.ok(!Object.keys(report.artifacts.core.dependencies).some(name => name.startsWith('@orcareplay/')))
  assert.deepEqual(packed.core.files.filter(file => file.path.startsWith('migrations/')).map(file => file.path).sort(), report.sharedCompatibilityAssets.map(asset => asset.path).sort())
  const results = []
  for (const configuration of [[], ['enno'], ['lisp'], ['enno', 'lisp']]) {
    const combination = ['core', ...configuration].join('-'), consumer = join(work, combination)
    const manifest = await composeModules(Object.fromEntries(['core', ...configuration].map(name => [name, packed[name].directory])), consumer)
    assert.ok(manifest.dsh.permissions.externalServices.some(service => service.includes('Laya-CoreML Unix socket')))
    const composed = await pack(consumer, join(work, `configured-${combination}`))
    if (configuration.includes('lisp')) {
      for (const path of ['docs/typesafe.md', 'PERMISSIONS.md', 'scripts/smoke-typesafe.mjs', 'dist/dsh/typesafe/client.js']) assert.ok(composed.files.some(file => file.path === path), `Missing TypeSafe module asset: ${path}`)
      assert.ok(manifest.dsh.permissions.externalServices.some(service => service.includes('TypeSafe')))
    }
    const dependencies = { ...manifest.dependencies, ...Object.fromEntries(Object.entries(manifest.peerDependencies).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional)) }
    const resolvedDependencies = await isolatedDependencies(consumer, dependencies)
    // Type consumers need declaration-only imports too. Node types are validation tooling.
    await isolatedDependencies(consumer, { '@types/node': '*' })
    await writeFile(join(consumer, 'consumer.mts'), "import { createConfiguredPlugin, DshModules } from 'kiokuko-dsh/core'\nconst plugin = createConfiguredPlugin([])\nvoid plugin.Config.parse({})\nvoid new DshModules([], [])\n")
    await command(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', 'consumer.mts'], consumer)
    const smoke = await command(process.execPath, [join(root, 'scripts/module-package-smoke.mjs'), consumer, nativeRoot, combination], consumer)
    const result = smoke.stdout.trim().split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.combination === combination)
    assert.equal(result?.status, 'passed')
    results.push({ ...result, packedBytes: composed.size, unpackedBytes: composed.unpackedSize, fileCount: composed.files.length, resolvedDependencies })
    console.log(`${combination}: packed native startup, ordinary requests and teardown passed`)
  }
  packed.full = await pack(root, join(work, 'pack-full'))
  const baselines = [['full', packed.full.directory]]
  if (process.env.KIOKUKO_MODULE_BASELINE) {
    const directory = join(work, 'baseline')
    await mkdir(directory)
    await command('tar', ['-xzf', resolve(process.env.KIOKUKO_MODULE_BASELINE), '-C', directory], root)
    baselines.push(['baseline-full', join(directory, 'package')])
  }
  for (const [combination, consumer] of baselines) {
    const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'))
    const dependencies = { ...manifest.dependencies, ...Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional)) }
    const resolvedDependencies = await isolatedDependencies(consumer, dependencies)
    const smoke = await command(process.execPath, [join(root, 'scripts/module-package-smoke.mjs'), consumer, nativeRoot, combination], consumer)
    const result = smoke.stdout.trim().split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.combination === combination)
    assert.equal(result?.status, 'passed')
    results.push({ ...result, resolvedDependencies })
    console.log(`${combination}: isolated compatibility package passed`)
  }
  const output = resolve(process.env.KIOKUKO_MODULE_REPORT ?? join(root, '.artifacts/module-report.json'))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ ...report, packed: Object.fromEntries(Object.entries(packed).map(([name, value]) => [name, { bytes: value.size, unpackedBytes: value.unpackedSize, files: value.files }])), results }, null, 2) + '\n')
  console.log(`Measurements: ${output}`)
} finally { await rm(work, { recursive: true, force: true }) }
