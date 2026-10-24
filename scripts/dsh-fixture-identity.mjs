// Development-only fixture preflight. Explicit external hosts retain their own identity.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { upstreamIdentity } from './stage-dsh-upstream.mjs'

const packageName = '@deepseek-ai/dsh'
const reinstall = 'npm ci --prefix tests/fixtures/dsh-runtime'

export function assertDshFixtureIdentity(fixtureRoot, installed) {
  const upstreamFile = join(fixtureRoot, 'node_modules/.kiokuko-dsh-upstream.json')
  if (existsSync(upstreamFile)) {
    const recorded = JSON.parse(readFileSync(upstreamFile, 'utf8'))
    const identity = upstreamIdentity(recorded.sourceRoot, recorded.sha)
    if (recorded.schema !== identity.schema || recorded.repository !== identity.repository || recorded.version !== identity.version
      || installed?.name !== packageName || installed.version !== identity.version
      || realpathSync(join(fixtureRoot, 'node_modules', packageName)) !== realpathSync(join(identity.sourceRoot, 'apps/cli'))) {
      throw new Error('Official DSH fixture identity is stale or inconsistent; rebuild and stage the selected SHA')
    }
    if (!recorded.packages || !Object.keys(recorded.packages).length) throw new Error('Official DSH package map is missing')
    for (const packageRoot of new Set([join(fixtureRoot, 'node_modules'), recorded.developmentPackageRoot].filter(Boolean))) {
      const expected = Object.keys(recorded.packages).map(name => name.slice('@deepseek-ai/'.length)).sort()
      if (JSON.stringify(readdirSync(join(packageRoot, '@deepseek-ai')).sort()) !== JSON.stringify(expected)) {
        throw new Error('Official DSH package scope differs from the recorded workspace map')
      }
      for (const [name, target] of Object.entries(recorded.packages)) {
        if (!/^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/.test(name) || typeof target !== 'string' || !target.startsWith(identity.sourceRoot + '/')
          || realpathSync(join(packageRoot, name)) !== realpathSync(target)) {
          throw new Error(`Official DSH package mapping is stale: ${name}`)
        }
      }
    }
    return { ...identity, developmentPackageRoot: recorded.developmentPackageRoot }
  }
  let manifest, lock
  try {
    manifest = JSON.parse(readFileSync(join(fixtureRoot, 'package.json'), 'utf8'))
    lock = JSON.parse(readFileSync(join(fixtureRoot, 'package-lock.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read DSH fixture declaration/lock: ${error.message}. Restore the tracked fixture manifests, then run: ${reinstall}`)
  }
  const declared = manifest?.dependencies?.[packageName]
  const lockDeclaration = lock?.packages?.['']?.dependencies?.[packageName]
  const locked = lock?.packages?.[`node_modules/${packageName}`]?.version
  const actual = installed?.version
  if (typeof declared !== 'string' || !declared.trim() || declared !== lockDeclaration || typeof locked !== 'string' || !locked.trim()) {
    throw new Error(`DSH fixture declaration/lock mismatch: declared=${declared}, lock declaration=${lockDeclaration}, locked=${locked}. Reconcile tests/fixtures/dsh-runtime/package.json and package-lock.json, then run: ${reinstall}`)
  }
  if (installed?.name !== packageName || actual !== locked) {
    throw new Error(`DSH fixture node_modules is stale or missing: declared=${declared}, locked=${locked}, installed=${actual}. Run: ${reinstall}`)
  }
}

/** Historical fixtures are explicit reproductions, never the default current gate. */
export function dshRuntimeMode(environment = process.env) {
  const mode = environment.KIOKUKO_DSH_RUNTIME_MODE ?? 'current'
  if (!['current', 'historical'].includes(mode)) throw new Error('KIOKUKO_DSH_RUNTIME_MODE must be current or historical')
  if (mode === 'historical' && environment.KIOKUKO_EXPECTED_DSH_SHA) throw new Error('Historical DSH mode cannot satisfy an exact official DSH SHA check')
  return mode
}
function samePath(left, right) {
  if (left === right) return true
  try { return realpathSync(left) === realpathSync(right) } catch { return false }
}
/** Shared fail-closed preflight for CLI, provider, browser and evaluation runners. */
export function selectedDshRuntime(root, environment = process.env) {
  const mode = dshRuntimeMode(environment)
  const fixtureRoot = join(root, 'tests/fixtures/dsh-runtime')
  const packageRoot = resolve(environment.KIOKUKO_DSH_PACKAGE_ROOT ?? join(fixtureRoot, 'node_modules'))
  const canonical = samePath(packageRoot, join(fixtureRoot, 'node_modules'))
  let manifest
  try { manifest = JSON.parse(readFileSync(join(packageRoot, packageName, 'package.json'), 'utf8')) }
  catch (error) { throw new Error(`Cannot read installed DSH runtime: ${error.message}. Stage current official DSH with scripts/stage-dsh-upstream.mjs; use KIOKUKO_DSH_RUNTIME_MODE=historical only for an explicit historical reproduction.`) }
  if (manifest.name !== packageName || typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Invalid selected DSH package metadata')
  const marked = existsSync(join(packageRoot, '.kiokuko-dsh-upstream.json'))
  let upstream
  if (mode === 'historical') {
    if (marked) throw new Error('Historical DSH mode requires a separate historical fixture, not a staged current runtime')
    if (canonical) assertDshFixtureIdentity(fixtureRoot, manifest)
  } else {
    if (!marked) throw new Error('Current DSH acceptance requires a staged official SHA identity; run scripts/stage-dsh-upstream.mjs, or explicitly select KIOKUKO_DSH_RUNTIME_MODE=historical for historical reproduction')
    upstream = assertDshFixtureIdentity(dirname(realpathSync(packageRoot)), manifest)
    if (!upstream?.developmentPackageRoot || !samePath(upstream.developmentPackageRoot, join(root, 'node_modules'))
      || (environment.KIOKUKO_EXPECTED_DSH_SHA && environment.KIOKUKO_EXPECTED_DSH_SHA !== upstream.sha)) {
      throw new Error('Runtime must use the exact official DSH SHA and coherent development graph selected for this run')
    }
    if (environment.DSH_BIN && !samePath(resolve(environment.DSH_BIN), join(packageRoot, '.bin/dsh'))) throw new Error('Current DSH CLI must come from the selected official runtime')
    if (environment.KIOKUKO_DSH_SOURCE_ROOT !== undefined && (!environment.KIOKUKO_DSH_SOURCE_ROOT.trim()
      || !samePath(resolve(environment.KIOKUKO_DSH_SOURCE_ROOT), upstream.sourceRoot))) throw new Error('Selected DSH source root differs from the staged official runtime')
  }
  return { mode, packageRoot, manifest, upstream, environment: { ...environment,
    KIOKUKO_DSH_RUNTIME_MODE: mode, KIOKUKO_DSH_PACKAGE_ROOT: packageRoot, KIOKUKO_EXPECTED_DSH_VERSION: manifest.version,
    ...(upstream ? { KIOKUKO_EXPECTED_DSH_SHA: upstream.sha } : {}),
    DSH_BIN: environment.DSH_BIN ?? join(packageRoot, '.bin/dsh'),
  } }
}
