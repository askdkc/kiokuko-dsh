import assert from 'node:assert/strict'
import test from 'node:test'
import { errorExcerpts, MAX_DIAGNOSTIC_BYTES, MAX_MATCH_LINE_BYTES, MAX_SCAN_BYTES } from '../../../../src/dsh/lisp/error-excerpts.js'

const source = (text: string, visible: readonly (readonly [number, number])[] = []) => ({ text, visible })
const diagnostic = 'src/cache.ts(48,17): error TS2345: Argument of type X is not assignable to Y.'
const excerpts = (text: string, budget = MAX_DIAGNOSTIC_BYTES) => errorExcerpts({ stdout: source(text) }, 'op', budget)
const texts = (result: ReturnType<typeof errorExcerpts>) => Object.values(result.diagnostics).flat().map(e => e.text).join('')
function assertBudget(result: ReturnType<typeof errorExcerpts>, budget = MAX_DIAGNOSTIC_BYTES) {
  const bytes = Object.values(result.diagnostics).reduce((sum, diagnostics) => sum + Buffer.byteLength(JSON.stringify({ diagnostics })), 0)
    + (result.inspect ? Buffer.byteLength(JSON.stringify({ inspect: result.inspect })) : 0)
  assert.equal(result.bytes, bytes)
  assert.ok(bytes <= budget)
  assert.ok(Object.values(result.diagnostics).flat().length <= 3)
}

// Captured with repository-pinned TypeScript 5.9.3 on 2026-09-20:
// node node_modules/typescript/bin/tsc --noEmit --pretty false (and true)
// fixture.ts: const value: string = 1;  tsconfig: files=[fixture.ts], types=[], skipLibCheck=true
// No-position case: tsc --pretty false in an empty directory with tsconfig.json={}; only its temp path is normalized.
const cliFixtures = [
  "fixture.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.\n",
  "\u001b[96mfixture.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'number' is not assignable to type 'string'.\n\n\u001b[7m1\u001b[0m const value: string = 1;\n\u001b[7m \u001b[0m \u001b[91m      ~~~~~\u001b[0m\n\n\nFound 1 error in fixture.ts\u001b[90m:1\u001b[0m\n\n",
  "error TS18003: No inputs were found in config file '/fixture/empty/tsconfig.json'. Specified 'include' paths were '[\"**/*\"]' and 'exclude' paths were '[]'.\n",
]
test('recognizes captured TypeScript CLI headers and preserves original ANSI', () => {
  for (const text of cliFixtures) {
    const result = excerpts(text)
    assert.ok(result.inspect)
    assert.ok(text.startsWith(texts(result)))
    assertBudget(result)
  }
  for (const header of ['C:\\a (b)\\file.ts(2,3): error TS1: yes', 'C:\\a (b)\\file.ts:2:3 - error TS1: yes', 'error TS123: yes']) assert.ok(excerpts(header).inspect)
  for (const header of ['Error: failure TS2345', 'some error TS2345: text', ' error TS1: text', 'x(0,1): error TS1: x', 'x:1:0 - error TS1: x', '(1,1): error TS1: x', 'x(1,1): warning TS1: x']) assert.equal(excerpts(header).inspect, undefined, header)
})

test('adds two preceding and four following lines with exact Unicode and CRLF coordinates', () => {
  for (const ending of ['\n', '\r\n']) for (const terminal of ['', ending]) {
    const lines = ['🙂日本語', 'zero', 'before two', 'before one', '\u001b[31m' + diagnostic + '\u001b[0m', 'after one', 'after two', 'after three', 'after four']
    const text = lines.join(ending) + terminal, result = excerpts(text), excerpt = result.diagnostics.stdout![0]!
    assert.equal(excerpt.startLine, 3); assert.equal(excerpt.endLine, 9)
    assert.equal(excerpt.text, lines.slice(2).join(ending) + terminal)
    assert.equal(excerpt.inspect.offset, Array.from(lines.slice(0, 2).join(ending) + ending).length)
    assert.equal(Array.from(text).slice(excerpt.inspect.offset).join(''), excerpt.text)
    assert.deepEqual(result.inspect, excerpt.inspect)
  }
})

test('visible bodies do not consume anchors; repeated text is compared by position', () => {
  const first = [diagnostic, 'gap', diagnostic, 'gap', diagnostic, 'gap'].join('\n') + '\n'
  const text = first + 'middle\n'.repeat(20) + diagnostic + '\nend'
  const result = errorExcerpts({ stdout: source(text, [[0, first.length - 1]]) }, 'op', 4096)
  assert.equal(result.diagnostics.stdout![0]!.startLine, 25)
  assert.equal(texts(result).split('TS2345').length - 1, 1)
  assert.equal(errorExcerpts({ stdout: source(diagnostic + '\r\n', [[0, diagnostic.length]]) }, 'op', 4096).inspect, undefined)
  assert.ok(errorExcerpts({ stdout: source(diagnostic, [[0, diagnostic.length - 1]]) }, 'op', 4096).inspect)
})

test('short anchors survive expensive intervening context as separate intervals', () => {
  const text = [diagnostic, ...Array(6).fill('x'.repeat(1000)), diagnostic].join('\n')
  const result = excerpts(text)
  assert.equal(result.diagnostics.stdout!.length, 2)
  assert.equal(texts(result).split('TS2345').length - 1, 2)
  assertBudget(result)
})

test('unaffordable and oversized lines consume no slots, including escaped JSON', () => {
  for (const size of [5000, MAX_MATCH_LINE_BYTES - 1, MAX_MATCH_LINE_BYTES, MAX_MATCH_LINE_BYTES + 1]) {
    const prefix = 'error TS1: ', large = prefix + 'x'.repeat(size - prefix.length)
    const result = excerpts([large, large, large, diagnostic].join('\n'))
    assert.equal(result.diagnostics.stdout![0]!.startLine, 4)
    assert.equal(texts(result), diagnostic)
    assertBudget(result)
  }
  const escaped = 'error TS1: ' + '\u0000'.repeat(800)
  const result = excerpts(escaped + '\n' + diagnostic)
  assert.equal(texts(result), diagnostic)
  assertBudget(result)
})

test('offers each stream a slot before filling stdout; merging never frees anchor slots', () => {
  const stdout = Array.from({ length: 8 }, (_, i) => `error TS${i}: out`).join('\n')
  const stderr = 'error TS9: err\nerror TS10: hidden'
  const sources = { stdout: source(stdout), stderr: source(stderr) }
  const result = errorExcerpts(sources, 'op', 4096)
  assert.equal(texts(result), 'error TS0: out\nerror TS1: out\nerror TS9: err\n')
  assert.equal(result.diagnostics.stdout!.length, 1)
  assert.deepEqual(errorExcerpts(sources, 'op', 4096), result)
  assertBudget(result)
})

test('scan bytes apply independently, inclusive at one MiB, before decoration removal', () => {
  for (const size of [MAX_SCAN_BYTES - 1, MAX_SCAN_BYTES, MAX_SCAN_BYTES + 1]) {
    const suffix = '\n' + diagnostic, text = 'x'.repeat(size - Buffer.byteLength(suffix)) + suffix
    assert.equal(Buffer.byteLength(text), size)
    const result = errorExcerpts({ stdout: source(text), stderr: source('error TS2: other') }, 'op', 4096)
    assert.equal(!!result.diagnostics.stdout, size <= MAX_SCAN_BYTES)
    assert.ok(result.diagnostics.stderr)
    assertBudget(result)
  }
  const text = '🙂'.repeat(MAX_SCAN_BYTES / 4) + '\n' + diagnostic
  assert.equal(excerpts(text).inspect, undefined)
})

test('exact cumulative JSON budget includes every reference and long Unicode identity', () => {
  for (const id of ['op', '識'.repeat(256)]) {
    const sources = { stdout: source(diagnostic) }, full = errorExcerpts(sources, id, 4096)
    assert.ok(full.inspect)
    assert.equal(errorExcerpts(sources, id, full.bytes - 1).inspect, undefined)
    assert.deepEqual(errorExcerpts(sources, id, full.bytes), full)
    assert.deepEqual(errorExcerpts(sources, id, full.bytes + 1), full)
    assertBudget(full)
  }
  assert.equal(excerpts(diagnostic, 0).inspect, undefined)
})

test('unaffordable stderr candidates do not evict stdout and later short stderr can fit', () => {
  const sources = { stdout: source(diagnostic), stderr: source('error TS1: ' + 'x'.repeat(3000) + '\nerror TS2: short') }
  const result = errorExcerpts(sources, 'op', 1100)
  assert.ok(result.diagnostics.stdout)
  assert.equal(result.diagnostics.stderr![0]!.text, 'error TS2: short')
  assertBudget(result, 1100)
})
