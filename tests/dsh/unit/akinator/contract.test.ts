import assert from 'node:assert/strict'
import test from 'node:test'
import { dshTurnRequestId, resolveGroundedIntakeProfile } from '../../../../src/dsh/intake-profile-resolver.js'

test('Akinator input resolution keeps grounded profile and turn identity deterministic', () => {
  const input = {
    task: '  Implement the plugin  ',
    cwd: '/repo',
    profileHints: { taskType: 'build' as const, target: 'src/dsh', expected: 'focused checks pass' },
    evidence: ['repository root is verified'],
  }
  const profile = resolveGroundedIntakeProfile(input)
  assert.equal(profile.task, 'Implement the plugin')
  assert.equal(profile.profileHints.taskType, 'build')
  assert.equal(profile.profileHints.target, 'src/dsh')
  assert.equal(profile.profileHints.expected, 'focused checks pass')
  assert.deepEqual(input, {
    task: '  Implement the plugin  ',
    cwd: '/repo',
    profileHints: { taskType: 'build', target: 'src/dsh', expected: 'focused checks pass' },
    evidence: ['repository root is verified'],
  })
  assert.equal(
    dshTurnRequestId({ dshSessionId: 'session-a', turn: 1 }),
    dshTurnRequestId({ dshSessionId: 'session-a', turn: 1 }),
  )
  assert.notEqual(
    dshTurnRequestId({ dshSessionId: 'session-a', turn: 1 }),
    dshTurnRequestId({ dshSessionId: 'session-a', turn: 2 }),
  )
})

test('Akinator input resolution rejects non-canonical cwd before any domain work', () => {
  assert.throws(
    () => resolveGroundedIntakeProfile({ task: 'task', cwd: 'relative' }),
    /absolute/u,
  )
})
