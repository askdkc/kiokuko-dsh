import assert from 'node:assert/strict'
import test from 'node:test'
import { reportTestResult } from '../../../../src/dsh/lisp/test-report.js'

const testFile = '/project/tests/conversation.spec.ts'
const definition = { line: 3, column: 1 }

function vitestFailure(message: string) {
  const stdout = JSON.stringify({
    numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false,
    testResults: [{
      name: testFile, status: 'failed', message: '',
      assertionResults: [{ fullName: 'conversation updates', status: 'failed', failureMessages: [message], location: definition }],
    }],
  })
  return reportTestResult('vitest', { code: 1, stdout, stderr: '' })
}

test('Vitest retains the test definition and reports the assertion location separately', () => {
  const message = `AssertionError: expected 41 to be 42\n    at ${testFile}:6:18`
  const result = vitestFailure(message)
  assert.equal(result.code, 1)
  assert.deepEqual(result.failures, [{
    name: 'conversation updates', file: testFile, ...definition, message,
    assertionLocation: { file: testFile, line: 6, column: 18 },
  }])
})

test('Vitest locates an assertion in a helper through a file URL', () => {
  const message = [
    'AssertionError [ERR_ASSERTION]: unexpected update',
    '    at assertUpdate (/project/node_modules/helper/dist/index.js:2:4)',
    '    at verify (file:///project/tests/update%20helper.ts:9:14)',
    `    at ${testFile}:12:2`,
  ].join('\n')
  assert.deepEqual(vitestFailure(message).failures, [{
    name: 'conversation updates', file: testFile, ...definition, message,
    assertionLocation: { file: '/project/tests/update helper.ts', line: 9, column: 14 },
  }])
})

test('Vitest leaves the assertion location absent without a usable assertion frame', () => {
  for (const message of [
    'AssertionError: missing stack',
    'AssertionError: runtime only\n    at run (file:///project/node_modules/vitest/run.js:6:18)\n    at node:internal/test:4:1',
    `AssertionError: invalid location\n    at ${testFile}:0:18`,
    `Error: unrelated failure\n    at ${testFile}:6:18`,
  ]) {
    assert.deepEqual(vitestFailure(message).failures, [{ name: 'conversation updates', file: testFile, ...definition, message }])
  }
})
