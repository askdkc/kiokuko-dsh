import assert from 'node:assert/strict'
import test from 'node:test'
import { reportTestResult } from '../../../../src/dsh/test-report.js'

const processResult = (code: number | null, stdout: string, stderr = '') => ({ code, stdout, stderr })

test('selected tests preserve process failures, unknowns and reports independently', () => {
  const missing = reportTestResult('vitest', processResult(2, '', 'Could not load config'))
  assert.equal(missing.code, 2)
  assert.equal(missing.testStatus, 'failed')
  assert.equal(missing.summary, null)
  assert.equal(missing.diagnostic, 'Could not load config')
  assert.equal(reportTestResult('vitest', processResult(0, 'no report')).testStatus, 'unknown')
  assert.equal(reportTestResult('node', {
    ...processResult(0, ''), timedOut: true,
  }).testStatus, 'unknown')
  assert.equal(reportTestResult('node', processResult(null, '')).testStatus, 'unknown')

  const trailer = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.equal(reportTestResult('node', processResult(0, '# Subtest: empty.test.mjs\n' + trailer)).testStatus, 'unknown')
  const stdout = '# Subtest: named case\n' + trailer
  assert.equal(reportTestResult('node', processResult(0, stdout)).testStatus, 'passed')
  const truncated = reportTestResult('node', { ...processResult(0, stdout), stdoutTruncated: true })
  assert.equal(truncated.testStatus, 'unknown')
  assert.equal(truncated.logsTruncated, true)
  assert.equal(truncated.summary, null)
})

test('Vitest counts skipped and todo cases and identifies failed file setup with no test assertions', () => {
  const report = {
    numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1, success: false,
    testResults: [
      { name: 'ok.spec.ts', status: 'passed', message: '', assertionResults: [
        { fullName: 'pass', status: 'passed', failureMessages: [] },
        { fullName: 'skip', status: 'skipped', failureMessages: [] },
        { fullName: 'todo', status: 'todo', failureMessages: [] },
      ] },
      { name: 'load.spec.ts', status: 'failed', message: 'module missing', assertionResults: [] },
    ],
  }
  const result = reportTestResult('vitest', processResult(1, 'noise\n' + JSON.stringify(report)))
  assert.deepEqual(result.summary, { tests: 3, pass: 1, fail: 0, skipped: 1, todo: 1, cancelled: 0 })
  assert.deepEqual(result.failures, [{ name: 'load.spec.ts', file: 'load.spec.ts', message: 'module missing' }])
  assert.equal(result.testStatus, 'failed')
  assert.equal(reportTestResult('vitest', processResult(0, [report, report].map(value => JSON.stringify(value)).join('\n'))).testStatus, 'unknown')
})

test('a long Vitest startup error preserves the cause and the end of the stack', () => {
  const headline = 'SyntaxError: Invalid regular expression: /[/: Unterminated character class'
  const stderr = headline + '\n' + '    at a long Vitest dependency path\n'.repeat(60) + '    at startVitest'
  const report = reportTestResult('vitest', processResult(1, '', stderr))
  assert.equal(report.code, 1)
  assert.equal(report.testStatus, 'failed')
  assert.ok(report.diagnostic?.startsWith(headline))
  assert.ok(report.diagnostic?.endsWith('at startVitest'))
  assert.ok(report.diagnostic!.length <= 1200)
  assert.equal(report.stderr, stderr)
})
