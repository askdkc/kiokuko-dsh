import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'catalog-selection-'))
const script = new URL('./repair-continuation-source.mjs', import.meta.url)
function probe(entry, env = {}) {
  const environment = { ...process.env, ...env }
  for (const key of ['KIOKUKO_DSH_PACKAGE_ROOT', 'KIOKUKO_SESSION_FORMAT_CATALOG']) if (!(key in env)) delete environment[key]
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const {loadCatalog}=await import(${JSON.stringify(entry.href)});await loadCatalog();`], { encoding: 'utf8', env: environment })
}
test('catalog selection rejects explicit missing/broken package root instead of installed fallback', () => {
  for (const bad of ['missing', 'broken']) {
    const packages = join(root, bad)
    if (bad === 'broken') { const dir = join(packages, '@deepseek-ai/dsh-session-format-catalog/lib'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.js'), 'throw new Error("broken explicit catalog")') }
    const result = probe(script, { KIOKUKO_DSH_PACKAGE_ROOT: packages })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /configured session-format catalog does not exist|broken explicit catalog/)
  }
})
test('catalog selection accepts installed production package without staging metadata', () => {
  const isolated = join(root, 'production'); mkdirSync(join(isolated, 'scripts'), { recursive: true })
  copyFileSync(script, join(isolated, 'scripts/repair-continuation-source.mjs'))
  writeFileSync(join(isolated, 'scripts/session-history-codec.mjs'), 'export const decodeSessionLog=()=>{},parseJsonl=()=>{},encodeSessionLog=()=>{},repairInformationalRecord=x=>x,repairContinuationRecord=x=>x;')
  const installed = join(isolated, 'node_modules/@deepseek-ai/dsh-session-format-catalog'); mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'package.json'), JSON.stringify({type:'module',exports:'./index.js'})); writeFileSync(join(installed, 'index.js'), 'export const sessionFormatCatalog={};')
  const result = probe(pathToFileURL(join(isolated, 'scripts/repair-continuation-source.mjs')))
  assert.equal(result.status, 0, result.stderr)
})
test('catalog selection does not discover an implicit historical test fixture', () => {
  const isolated = join(root, 'isolated'); mkdirSync(join(isolated, 'scripts'), { recursive: true })
  copyFileSync(script, join(isolated, 'scripts/repair-continuation-source.mjs'))
  writeFileSync(join(isolated, 'scripts/session-history-codec.mjs'), 'export const decodeSessionLog=()=>{},parseJsonl=()=>{},encodeSessionLog=()=>{},repairInformationalRecord=x=>x,repairContinuationRecord=x=>x;')
  const fixture = join(isolated, 'tests/fixtures/dsh-runtime/node_modules/@deepseek-ai/dsh-session-format-catalog/lib'); mkdirSync(fixture, { recursive: true }); writeFileSync(join(fixture, 'index.js'), 'export const sessionFormatCatalog={};')
  const result = probe(pathToFileURL(join(isolated, 'scripts/repair-continuation-source.mjs')))
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unable to load installed/)
})
test.after(() => rmSync(root, { recursive: true, force: true }))
