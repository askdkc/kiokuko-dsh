// Build upstream separately, then expose its packages without changing its source.
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const upstreamRepository = 'https://github.com/deepseek-ai/deepseek-harness.git'
function canonicalDestination(path) {
  let existing = resolve(path)
  const missing = []
  while (!existsSync(existing)) {
    missing.unshift(basename(existing))
    existing = dirname(existing)
  }
  return resolve(realpathSync(existing), ...missing)
}
export function upstreamIdentity(sourceRoot, expectedSha) {
  const root = realpathSync(sourceRoot)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const sha = git('rev-parse', 'HEAD')
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || sha !== expectedSha) throw new Error('Official DSH checkout does not match the selected full SHA')
  if (git('remote', 'get-url', 'origin').replace(/\.git$/, '') !== upstreamRepository.replace(/\.git$/, '')) throw new Error('DSH checkout is not the official repository')
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Official DSH checkout has source changes')
  const manifest = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Invalid official DSH CLI manifest')
  return { schema: 'kiokuko-dsh-upstream-v1', repository: upstreamRepository, sha, sourceRoot: root, version: manifest.version }
}

export function stageDshUpstream(sourceRoot, fixtureRoot, expectedSha, developmentRoot) {
  const identity = upstreamIdentity(sourceRoot, expectedSha)
  const manifest = JSON.parse(readFileSync(join(identity.sourceRoot, 'package.json'), 'utf8'))
  if (!Array.isArray(manifest.workspaces)) throw new Error('Official DSH workspace declarations are unavailable')
  const packages = new Map()
  for (const pattern of manifest.workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: identity.sourceRoot })) {
      const metadata = JSON.parse(readFileSync(join(identity.sourceRoot, file), 'utf8'))
      if (!metadata.name?.startsWith('@deepseek-ai/')) continue
      if (!/^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/.test(metadata.name)) throw new Error('Invalid official workspace package name')
      if (packages.has(metadata.name)) throw new Error(`Duplicate official workspace: ${metadata.name}`)
      packages.set(metadata.name, dirname(join(identity.sourceRoot, file)))
    }
  }
  for (const [name, file] of [['@deepseek-ai/dsh', 'lib/bin.js'], ['@deepseek-ai/dsh-agent-loop', 'lib/index.js'], ['@deepseek-ai/dsh-tools', 'lib/index.js']]) {
    if (!packages.has(name) || !existsSync(join(packages.get(name), file))) throw new Error(`Build official DSH artifacts first: missing ${name}/${file}`)
  }
  const packageRoot = join(resolve(fixtureRoot), 'node_modules')
  // Retain separately locked CLI/terminal support. Never leave an old DSH package
  // available as a silent fallback when upstream removes or renames a package.
  const developmentPackageRoot = developmentRoot ? join(resolve(developmentRoot), 'node_modules') : undefined
  const destinations = new Set([packageRoot, developmentPackageRoot].filter(Boolean))
  if ([...destinations].map(canonicalDestination).some(destination => destination === identity.sourceRoot || destination.startsWith(identity.sourceRoot + '/'))) {
    throw new Error('Runtime staging must not change the official DSH checkout')
  }
  for (const destination of destinations) {
    const scope = join(destination, '@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    for (const name of readdirSync(scope)) rmSync(join(scope, name), { recursive: true, force: true })
    for (const [name, target] of packages) symlinkSync(target, join(destination, name), process.platform === 'win32' ? 'junction' : 'dir')
    mkdirSync(join(destination, '.bin'), { recursive: true })
    const bin = join(destination, '.bin/dsh')
    rmSync(bin, { force: true })
    // Compiler output is not necessarily executable. A test-owned launcher
    // preserves the official CLI's import.meta.main without chmodding its tree.
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(packages.get('@deepseek-ai/dsh'), 'lib/bin.js'))} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(join(packageRoot, '.kiokuko-dsh-upstream.json'), JSON.stringify({ ...identity, ...(developmentPackageRoot ? { developmentPackageRoot } : {}), packages: Object.fromEntries([...packages].sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n')
  return identity
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 5 && process.argv.length !== 6) throw new Error('Usage: stage-dsh-upstream.mjs SOURCE_ROOT FIXTURE_ROOT SELECTED_SHA [DEVELOPMENT_ROOT]')
  console.log(JSON.stringify(stageDshUpstream(...process.argv.slice(2)), null, 2))
}
