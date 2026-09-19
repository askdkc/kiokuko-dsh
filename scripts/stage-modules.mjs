import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import ts from 'typescript'
import { builtinModules } from 'node:module'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const entries = { core: 'dist/dsh/core/index.js', enno: 'dist/dsh/modules/enno.js', lisp: 'dist/dsh/modules/lisp.js' }
const compatibility = JSON.parse(await readFile(join(root, 'scripts/module-compatibility-assets.json'), 'utf8'))
const sharedAssets = compatibility.runtimeAssets
const builtin = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
async function graph(entry, feature) {
  const analysis = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, metafile: true,
    plugins: feature === 'enno' ? [{ name: 'explicit-optional-lisp-mount', setup(build) {
      build.onResolve({ filter: /^\.\/lisp\/surface\.js$/ }, args => args.kind === 'dynamic-import' && args.importer.endsWith('/dsh/composition.js') ? { path: args.path, external: true } : undefined)
    } }] : [] })
  const files = new Set(Object.keys(analysis.metafile.inputs))
  const dependencies = new Set()
  for (const input of Object.values(analysis.metafile.inputs)) for (const imported of input.imports) {
    if (!imported.external || builtin.has(imported.path)) continue
    if (imported.path.startsWith('.')) continue // Explicit compatibility/worker assets are added below.
    dependencies.add(packageName(imported.path))
  }
  const declarations = new Set(), pending = [...files].map(file => file.replace(/\.m?js$/, file.endsWith('.mjs') ? '.d.mts' : '.d.ts'))
  while (pending.length) {
    const file = pending.pop()
    if (declarations.has(file)) continue
    let source
    try { source = await readFile(join(root, file), 'utf8') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    declarations.add(file)
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(root, dirname(file), specifier)).replace(/\.m?js$/, specifier.endsWith('.mjs') ? '.d.mts' : '.d.ts')
        if (path.startsWith('../')) throw new Error(`Declaration escapes package: ${path}`)
        pending.push(path)
      } else if (!builtin.has(specifier)) dependencies.add(packageName(specifier))
    }
  }
  return { files, declarations, dependencies }
}
async function walk(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await walk(join(directory, entry.name), path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`Unexpected symbolic asset: ${path}`)
  }
  return files.sort()
}
function forbiddenCore(path) { return /(?:^|\/)(?:enno-oduno|deep-thinker|lisp)\/|\/dsh\/(?:host-adapter|composition|tool-policy|runtime)\.js$/.test(path) }
async function copyFile(source, target) { await mkdir(dirname(target), { recursive: true }); await cp(source, target) }

export async function stageModules(output) {
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error(`Staging requires an empty directory: ${output}`)
  const graphs = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, entry]) => [name, await graph(entry, name)])))
  for (const file of graphs.core.files) if (forbiddenCore(file)) throw new Error(`Core imports optional implementation: ${file}`)
  for (const file of sharedAssets) { await stat(join(root, file)); graphs.core.files.add(file) }
  // Identical optional host interfaces may be shared by the two add-ons, never by core.
  const shared = [...graphs.enno.files].filter(file => graphs.lisp.files.has(file) && !graphs.core.files.has(file))
  const { coreSkills, codingSkills } = await import(pathToFileURL(join(root, 'dist/dsh/modules/resources.js')))
  const { ennoModule } = await import(pathToFileURL(join(root, entries.enno)))
  const { lispModule } = await import(pathToFileURL(join(root, entries.lisp)))
  const resources = { core: coreSkills.resources, enno: [...codingSkills.resources, ...ennoModule.resources], lisp: [...codingSkills.resources, ...lispModule.resources] }
  const { compileSkillBundle } = await import(pathToFileURL(join(root, 'dist/dsh/skill-compiler.js')))
  const migrations = (await walk(join(root, 'migrations'))).map(file => `migrations/${file}`)
  assert.deepEqual(migrations, compatibility.migrations, 'Update the explicit migration compatibility allowlist before packaging')
  const report = { contractVersion: 1, entries, sharedCompatibilityAssets: migrations.map(path => ({ path, owner: 'core', reason: 'Continuous migration history and checksums required by existing databases' })), sharedHostFiles: shared, artifacts: {} }
  for (const name of Object.keys(entries)) {
    const directory = join(output, name)
    await mkdir(directory, { recursive: true })
    const files = [...graphs[name].files].filter(file => name === 'core' || !graphs.core.files.has(file))
    const assetFiles = name === 'core' ? migrations : name === 'lisp' ? [...(await walk(join(root, 'lisp'))).map(file => `lisp/${file}`), 'docs/typesafe.md', 'docs/lisp.md', 'scripts/smoke-typesafe.mjs', 'PERMISSIONS.md'] : []
    const declarations = [...graphs[name].declarations].filter(file => name === 'core' || !graphs.core.declarations.has(file))
    for (const file of [...files, ...declarations, ...assetFiles]) {
      await copyFile(join(root, file), join(directory, file))
      if (file.endsWith('.js')) for (const suffix of ['.d.ts', '.js.map', '.d.ts.map']) {
        const extra = file.slice(0, -3) + suffix
        try { await stat(join(root, extra)) } catch { continue }
        await copyFile(join(root, extra), join(directory, extra))
      }
    }
    const sources = await Promise.all(resources[name].map(async resource => {
      const content = await resource.load(), directoryName = resource.name === 'natural-japanese-output' ? 'japanese-translation-for-oss-models' : resource.name
      await mkdir(join(directory, 'skills', directoryName, dirname(resource.relativePath)), { recursive: true })
      await writeFile(join(directory, 'skills', directoryName, resource.relativePath), content)
      return { name: resource.name, relativePath: resource.relativePath, content }
    }))
    await mkdir(join(directory, 'dist/dsh'), { recursive: true })
    await writeFile(join(directory, `dist/dsh/skill-prompts-${name}.json`), JSON.stringify(compileSkillBundle(sources)))
    if (name === 'core') await writeFile(join(directory, 'dist/dsh/skill-prompts.json'), JSON.stringify(compileSkillBundle(sources)))
    const dependencies = Object.fromEntries([...graphs[name].dependencies].filter(dep => manifest.dependencies[dep] && (name === 'core' || !graphs.core.dependencies.has(dep))).sort().map(dep => [dep, manifest.dependencies[dep]]))
    const peerDependencies = Object.fromEntries([...graphs[name].dependencies].filter(dep => manifest.peerDependencies[dep]).sort().map(dep => [dep, manifest.peerDependencies[dep]]))
    const packageJson = { name: manifest.name, version: manifest.version, private: true, type: 'module', license: manifest.license, engines: manifest.engines,
      exports: { '.': { types: `./${entries[name].replace(/\.js$/, '.d.ts')}`, default: `./${entries[name]}` } }, files: ['dist/', 'skills/', 'scripts/', ...(name === 'core' ? ['migrations/'] : name === 'lisp' ? ['lisp/', 'docs/', 'PERMISSIONS.md'] : []), `module-${name}.json`, 'LICENSE', 'THIRD_PARTY_NOTICES.md'], dependencies, peerDependencies,
      peerDependenciesMeta: Object.fromEntries(Object.entries(manifest.peerDependenciesMeta).filter(([dep]) => dep in peerDependencies)) }
    await writeFile(join(directory, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, file), join(directory, file))
    await writeFile(join(directory, `module-${name}.json`), JSON.stringify({ id: name, coreVersion: 1, entry: entries[name], resources: sources.map(({ name, relativePath }) => ({ name, relativePath })), dependencies }, null, 2) + '\n')
    const packedFiles = await walk(directory)
    report.artifacts[name] = { files: packedFiles, unpackedBytes: (await Promise.all(packedFiles.map(file => stat(join(directory, file))))).reduce((sum, value) => sum + value.size, 0), dependencies, peerDependencies, sourceFiles: files }
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(join(root, '.artifacts'), { recursive: true })
  const directory = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(root, '.artifacts/modules-'))
  await stageModules(directory)
  console.log(`Staged core and optional modules: ${directory}`)
}
