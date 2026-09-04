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

test('Akinator input resolution preserves multiline user tasks while rejecting unsafe controls', () => {
  const task = '  ABC\n\nEFG\r\n\tWHAT?  '
  const profile = resolveGroundedIntakeProfile({ task, cwd: '/repo' })

  assert.equal(profile.task, 'ABC\n\nEFG\n\tWHAT?')
  assert.equal(profile.profileHints.expected, 'ABC\n\nEFG\n\tWHAT?')
  assert.equal(
    resolveGroundedIntakeProfile({ task: 'ABC\rEFG', cwd: '/repo' }).task,
    resolveGroundedIntakeProfile({ task: 'ABC\nEFG', cwd: '/repo' }).task,
  )
  assert.throws(
    () => resolveGroundedIntakeProfile({ task: 'before\u0000after', cwd: '/repo' }),
    /bounded non-empty string/u,
  )
  assert.throws(
    () => resolveGroundedIntakeProfile({ task: 'safe task', cwd: '/repo\nother' }),
    /bounded non-empty string/u,
  )
})

test('multiline task validation accepts only standard layout whitespace from control characters', () => {
  const accepted: number[] = []
  const rejected: number[] = []
  for (let codePoint = 0; codePoint <= 0x9f; codePoint += 1) {
    const character = String.fromCodePoint(codePoint)
    if (!/\p{Cc}/u.test(character)) continue
    try {
      resolveGroundedIntakeProfile({ task: `before${character}after`, cwd: '/repo' })
      accepted.push(codePoint)
    } catch {
      rejected.push(codePoint)
    }
  }

  assert.deepEqual(accepted, [0x09, 0x0a, 0x0d])
  assert.equal(rejected.length > 0, true)
  for (const codePoint of [0x00ad, 0x200b, 0x200d, 0x202e, 0x2066, 0xfeff]) {
    assert.throws(
      () => resolveGroundedIntakeProfile({ task: `before${String.fromCodePoint(codePoint)}after`, cwd: '/repo' }),
      /bounded non-empty string/u,
    )
  }
})
