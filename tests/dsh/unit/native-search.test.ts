/** Plugin-owned grep: own traversal, own errors, scoped shadowing of the native global tool. */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrepDefinition, formatSearchOutcome, includeMatcher, mountNativeSearch, runGrep } from '../../../src/dsh/native-search.js'

const workspace = mkdtempSync(join(tmpdir(), 'kiokuko-native-search-'))
writeFileSync(join(workspace, 'alpha.ts'), 'const alpha = 1' + String.fromCharCode(10) + 'export const beta = 2' + String.fromCharCode(10))
mkdirSync(join(workspace, 'nested'))
writeFileSync(join(workspace, 'nested', 'gamma.md'), '# Gamma' + String.fromCharCode(10) + 'alpha appears here' + String.fromCharCode(10))
writeFileSync(join(workspace, 'nested', 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]))
mkdirSync(join(workspace, '.git'))
writeFileSync(join(workspace, '.git', 'ignored.ts'), 'alpha in a VCS store' + String.fromCharCode(10))
after(() => rmSync(workspace, { recursive: true, force: true }))
const execution = { agent: { session: { header: { cwd: workspace } } } }

test('a missing path is a plain actionable error, never a search failure', () => {
  assert.throws(() => runGrep({ pattern: 'x', path: 'src/akinator/session.ts' }, execution), (error: Error) =>
    /^cannot search "src\/akinator\/session\.ts": not found/u.test(error.message)
    && !/search failed|exit|rg:/u.test(error.message))
})

test('a directory search returns search-relative path:line rows and skips binary and VCS trees', () => {
  const outcome = runGrep({ pattern: 'alpha' }, execution)
  assert.deepEqual(outcome.matches.map(match => match.path + ':' + match.line), ['alpha.ts:1', 'nested/gamma.md:2'])
  assert.equal(outcome.truncated, false)
})

test('the include glob filters by basename or by relative path', () => {
  assert.deepEqual(runGrep({ pattern: 'alpha', include: '*.md' }, execution).matches.map(match => match.path), ['nested/gamma.md'])
  assert.deepEqual(runGrep({ pattern: 'alpha', include: 'nested/**' }, execution).matches.map(match => match.path), ['nested/gamma.md'])
  assert.equal(includeMatcher('*.ts')('a/b/c.ts'), true)
  assert.equal(includeMatcher('src/*.ts')('a/src/c.ts'), false)
})

test('a file path searches exactly that file and displays the workspace-relative path', () => {
  assert.deepEqual(runGrep({ pattern: 'beta', path: 'alpha.ts' }, execution).matches,
    [{ path: 'alpha.ts', line: 2, text: 'export const beta = 2' }])
})

test('an invalid pattern names the pattern instead of a ripgrep exit', () => {
  assert.throws(() => runGrep({ pattern: '(unclosed' }, execution), /grep pattern rejected/u)
})

test('an empty pattern is refused before any traversal', () => {
  assert.throws(() => runGrep({ pattern: '' }, execution), /non-empty pattern/u)
})

test('caps are explicit in the rendered outcome', () => {
  assert.match(formatSearchOutcome({ matches: [{ path: 'a.ts', line: 1, text: 'x' }], truncated: true, scannedFiles: 3 }), /capped/u)
  assert.equal(formatSearchOutcome({ matches: [], truncated: false, scannedFiles: 2 }), 'No matches')
  assert.equal(formatSearchOutcome({ matches: [], truncated: true, scannedFiles: 2 }), 'No matches in the scanned prefix (the scan cap was reached).')
})

test('the tool definition is a model-facing grep with a rendering output contract', () => {
  const definition = createGrepDefinition() as any
  assert.equal(definition.name, 'grep')
  assert.equal(definition.modelFacing, true)
  assert.deepEqual(definition.parameters.required, ['pattern'])
  assert.equal(Object.keys(definition.parameters.properties).sort().join(','), 'include,path,pattern')
  assert.equal(typeof definition.output.render, 'function')
  assert.match(definition.output.render({}, { matches: [], truncated: false, scannedFiles: 0 })[0].text, /No matches/u)
  assert.equal(definition.execute({ pattern: 'alpha' }, execution).matches.length, 2)
})

test('mounting registers one scoped grep per agent and releases it', () => {
  const listeners = new Map<string, any>(), registered: any[] = [], released: string[] = []
  const agent = { ctx: { get: (name: string) => name === 'tools'
    ? { register: (definition: any) => { registered.push(definition); return () => released.push(definition.name) } }
    : undefined } }
  const dispose = mountNativeSearch({ on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) } })
  listeners.get('agent/session-start')({ agent })
  listeners.get('agent/session-start')({ agent })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'grep')
  listeners.get('agent/disposed')({ agent })
  assert.deepEqual(released, ['grep'])
  dispose()
  assert.equal(listeners.size, 0)
})

test('a scope that refuses the registration keeps the native surface', () => {
  const listeners = new Map<string, any>()
  const agent = { ctx: { get: () => ({ register: () => { throw new Error('scope refuses') } }) } }
  const dispose = mountNativeSearch({ on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) } })
  listeners.get('agent/session-start')({ agent })
  listeners.get('agent/disposed')({ agent })
  dispose()
})
