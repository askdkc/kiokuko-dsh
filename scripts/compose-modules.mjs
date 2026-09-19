import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function files(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(directory, path))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`Unexpected non-file in local artifact: ${path}`)
  }
  return result
}

/** Assemble trusted local artifacts. The output must be new; conflicting ownership fails closed. */
export async function composeModules(sources, destination) {
  if (!sources.core || Object.keys(sources).some(name => !['core', 'enno', 'lisp'].includes(name))) throw new Error('Expected core and optional enno/lisp artifact directories')
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Composition output must be empty')
  const manifest = JSON.parse(await readFile(join(sources.core, 'package.json'), 'utf8'))
  const resources = new Map(), owned = new Map()
  for (const [name, directory] of Object.entries(sources)) {
    const descriptor = JSON.parse(await readFile(join(directory, `module-${name}.json`), 'utf8'))
    if (descriptor.id !== name || descriptor.coreVersion !== 1) throw new Error(`Incompatible local artifact: ${name}`)
    const extra = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (extra.name !== manifest.name || extra.version !== manifest.version) throw new Error(`Artifact package identity mismatch: ${name}`)
    for (const field of ['dependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      for (const [key, value] of Object.entries(extra[field] ?? {})) if (manifest[field]?.[key] !== undefined) assert.deepEqual(manifest[field][key], value, `Conflicting dependency: ${key}`)
      manifest[field] = { ...manifest[field], ...extra[field] }
    }
    const bundle = JSON.parse(await readFile(join(directory, `dist/dsh/skill-prompts-${name}.json`), 'utf8'))
    for (const resource of bundle.resources) {
      if (resources.has(resource.id)) assert.deepEqual(resources.get(resource.id), resource, `Conflicting Skill: ${resource.id}`)
      resources.set(resource.id, resource)
    }
    for (const path of await files(directory)) {
      if (path === 'package.json' || path === 'dist/dsh/skill-prompts.json') continue
      const content = await readFile(join(directory, path))
      if (owned.has(path)) assert.deepEqual(owned.get(path), content, `Conflicting artifact file: ${path}`)
      owned.set(path, content)
    }
  }
  for (const [path, bytes] of owned) { await mkdir(dirname(join(destination, path)), { recursive: true }); await writeFile(join(destination, path), bytes) }
  const baseBundle = JSON.parse(await readFile(join(sources.core, 'dist/dsh/skill-prompts-core.json'), 'utf8'))
  await writeFile(join(destination, 'dist/dsh/skill-prompts.json'), JSON.stringify({ ...baseBundle, resources: [...resources.values()] }))
  const optional = Object.keys(sources).filter(name => name !== 'core')
  const imports = ["import { createConfiguredPlugin } from './core/index.js'", ...(optional.length ? ["import { codingSkills } from './modules/resources.js'"] : []), ...optional.map(name => `import { ${name}Module } from './modules/${name}.js'`)]
  const registrations = [...(optional.length ? ['{ module: codingSkills }'] : []), ...optional.map(name => `{ module: ${name}Module }`)]
  await writeFile(join(destination, 'dist/dsh/configured.js'), `${imports.join('\n')}\nexport const { name, inject, Config, apply } = createConfiguredPlugin([${registrations.join(', ')}])\n`)
  await writeFile(join(destination, 'dist/dsh/configured.d.ts'), `import { createConfiguredPlugin } from './core/index.js'\ndeclare const plugin: ReturnType<typeof createConfiguredPlugin>\nexport declare const name: typeof plugin.name\nexport declare const inject: typeof plugin.inject\nexport declare const Config: typeof plugin.Config\nexport declare const apply: typeof plugin.apply\n`)
  manifest.private = true
  manifest.exports = { '.': { types: './dist/dsh/configured.d.ts', default: './dist/dsh/configured.js' }, './core': { types: './dist/dsh/core/index.d.ts', default: './dist/dsh/core/index.js' }, ...Object.fromEntries(optional.map(name => [`./modules/${name}`, { types: `./dist/dsh/modules/${name}.d.ts`, default: `./dist/dsh/modules/${name}.js` }])) }
  const inject = ['skills', 'systemPrompt', 'tools', 'sessions', 'agents', 'commands', 'userQuestions', ...(sources.enno ? ['llm', 'subagents', 'sessionQuery', 'sessionPersistence', 'attachments', 'connection'] : [])]
  await mkdir(join(destination, 'dsh'))
  await writeFile(join(destination, 'dsh/cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'kiokuko-dsh', name: 'kiokuko-dsh', inject, config: { enabled: true } }] }], null, 2) + '\n')
  manifest.dsh = { bundle: { patch: './dsh/cordis.patch.yml' }, permissions: { summary: 'Configured local Kiokuko core and explicitly selected modules.', readPaths: ['Registered workspace and configured Kiokuko database'], writePaths: ['Configured Kiokuko database, pre-migration backups and selected managed Skills under ~/.agents/skills', ...(sources.lisp ? ['Protected Lisp scratch, journals, backups and explicitly approved project changes'] : [])], commands: sources.lisp ? ['Explicit protected SBCL and brokered subprocesses'] : [] } }
  manifest.files = ['dist/', 'skills/', 'scripts/', 'migrations/', 'dsh/cordis.patch.yml', ...(sources.lisp ? ['lisp/'] : []), ...Object.keys(sources).map(name => `module-${name}.json`), 'LICENSE', 'THIRD_PARTY_NOTICES.md']
  await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [staging, output, ...selected] = process.argv.slice(2)
  if (!staging || !output || selected.some(name => !['enno', 'lisp'].includes(name)) || new Set(selected).size !== selected.length) throw new Error('Usage: node scripts/compose-modules.mjs STAGING EMPTY_OUTPUT [enno] [lisp]')
  await composeModules(Object.fromEntries(['core', ...selected].map(name => [name, resolve(staging, name)])), resolve(output))
  console.log(`Configured local package: ${resolve(output)}`)
}
