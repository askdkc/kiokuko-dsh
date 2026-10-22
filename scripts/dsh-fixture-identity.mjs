// Development-only fixture preflight. Explicit external hosts retain their own identity.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const packageName = '@deepseek-ai/dsh'
const reinstall = 'npm ci --prefix tests/fixtures/dsh-runtime'

export function assertDshFixtureIdentity(fixtureRoot, installed) {
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
  if (typeof declared !== 'string' || !declared.trim() || declared !== lockDeclaration || declared !== locked) {
    throw new Error(`DSH fixture declaration/lock mismatch: declared=${declared}, lock declaration=${lockDeclaration}, locked=${locked}. Reconcile tests/fixtures/dsh-runtime/package.json and package-lock.json, then run: ${reinstall}`)
  }
  if (installed?.name !== packageName || actual !== declared) {
    throw new Error(`DSH fixture node_modules is stale or missing: declared=${declared}, locked=${locked}, installed=${actual}. Run: ${reinstall}`)
  }
}
