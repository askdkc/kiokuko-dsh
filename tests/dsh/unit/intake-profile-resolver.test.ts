import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveGroundedIntakeProfile } from '../../../src/dsh/intake-profile-resolver.js'

test('missing target and success criteria remain Akinator questions, not invented cwd/task answers', () => {
  const resolved = resolveGroundedIntakeProfile({ task: 'Fix it', cwd: '/repo', profileHints: { taskType: 'debug' } })
  assert.equal(resolved.profileHints.target, null)
  assert.equal(resolved.profileHints.expected, null)
})

test('explicit grounded intake answers remain intact', () => {
  const hints = { taskType: 'debug' as const, target: 'login', expected: 'login succeeds', constraints: null }
  assert.deepEqual(resolveGroundedIntakeProfile({ task: 'Fix login', cwd: '/repo', profileHints: hints }).profileHints, hints)
})
