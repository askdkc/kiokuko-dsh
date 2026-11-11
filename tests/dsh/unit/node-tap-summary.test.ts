import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNodeTapSummary } from '../../../src/dsh/node-tap-summary.js'
import { reportTestResult } from '../../../src/dsh/test-report.js'
const good = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
const bad = good.replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1')
for (const [name, text] of Object.entries({
  'two successes': good + good, 'failure then success': bad + good, 'success then failure': good + bad,
  duplicate: good + '# pass 1\n', malformed: good + '# tests NaN\n', negative: good + '# pass -1\n',
  fragment: good.replace('# pass', 'TAP version 13\n# pass'), interleaved: good.replace('# fail', 'ok 1 - another run\n# fail'),
  'unfinished second execution': good + 'TAP version 13\n# Subtest: unfinished\n',
  'unfinished first execution': 'TAP version 13\n# Subtest: unfinished\nTAP version 13\n' + good,
  'trailing test without summary': good + '# Subtest: unfinished\nok 1 - unfinished\n',
  missing: good.replace('# todo 0\n', ''), inconsistent: good.replace('# tests 1', '# tests 2'),
  unsafe: good.replace('# tests 1', '# tests 9007199254740992'), truncated: good + '# Output capped\n',
})) test(`Node TAP rejects ${name}`, () => {
  assert.equal(parseNodeTapSummary(text), undefined)
})
test('Node TAP accepts exactly one trailer, CRLF, optional suites and skip/todo', () => {
  assert.deepEqual(parseNodeTapSummary(good), { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 })
  assert.equal(parseNodeTapSummary(good.replace('# pass', '# suites 0\n# pass').replaceAll('\n', '\r\n') + '# duration_ms 1\r\n')?.pass, 1)
  assert.equal(parseNodeTapSummary(good.replace('# tests 1', '# tests 3').replace('# skipped 0', '# skipped 1').replace('# todo 0', '# todo 1'))?.tests, 3)
})
for (const failureType of ['testCodeFailure', 'subtestsFailed']) test(`Lisp common report never passes ${failureType} diagnostics`, () => {
  const stdout = `# Subtest: broken\nnot ok 1 - broken\n  ---\n  failureType: '${failureType}'\n  ...\n${good}`
  const report = reportTestResult('node', { code: 0, stdout, stderr: '' })
  assert.equal(report.testStatus, 'failed')
})
test('Lisp common report treats concatenated trailers as unknown and preserves raw output', () => {
  const stdout = 'TAP version 13\n# Subtest: first\nnot ok 1 - first\n' + bad + 'TAP version 13\n# Subtest: second\nok 1 - second\n' + good
  const report = reportTestResult('node', { code: 0, stdout, stderr: '' })
  assert.equal(report.testStatus, 'unknown')
  assert.equal(report.stdout, stdout)
})
