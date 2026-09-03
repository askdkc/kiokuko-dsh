import assert from 'node:assert/strict'
import test from 'node:test'
import { DshConfirmationController } from '../../../src/dsh/enno-controller.js'
import { createDshConfirmationAnswerer, renderDshConfirmation, type DshUserQuestions } from '../../../src/dsh/user-interaction.js'
import type { UserFacingConfirmation } from '../../../src/enno-oduno/types.js'

function confirmation(): UserFacingConfirmation {
  return {
    presentationVersion: 1,
    title: 'Plan approval',
    summary: { basis: 'proposal', text: 'Apply the approved change.' },
    scope: { basis: 'repository', paths: ['src/dsh/commands.ts'] },
    exclusions: { basis: 'user', paths: ['dist/'] },
    completion: { basis: 'proposal', items: ['Focused test passes'] },
    skills: [{ label: 'kiokuko-soul', basis: 'repository', required: true, purposes: ['review'], referenceOnly: false }],
    workItems: [{
      number: 1, summary: 'Implement command', paths: ['src/dsh/commands.ts'], dependsOn: [], doneWhen: ['Command is request-local'],
      checks: [{ category: 'test', executable: 'node', arguments: ['scripts/run-tests.mjs', 'tests/dsh/integration/ponytail-command.test.ts'], directory: '.', timeoutMs: 120000 }],
      expertise: [{ area: 'Input and data boundaries', basis: 'proposal', reason: 'Reject invalid command input' }],
    }],
    finalChecks: { basis: 'repository', checks: [{ category: 'typecheck', executable: 'npm', arguments: ['run', 'typecheck'], directory: '.', timeoutMs: 120000 }] },
    attemptLimit: { basis: 'proposal', maxAttempts: 3 },
    actions: ['approve', 'revise', 'cancel'],
  }
}

function service(answer: { selected: string[]; custom?: string }): DshUserQuestions {
  return { ask: async (request) => ({ answers: [{ id: request.questions[0]!.id, selected: answer.selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) }] }) }
}

test('confirmation renders every public item and preserves command/path/timeout values', () => {
  const text = renderDshConfirmation(confirmation())
  for (const expected of ['src/dsh/commands.ts', 'dist/', 'node', 'scripts/run-tests.mjs', 'timeoutMs=120000', 'kiokuko-soul']) assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.equal(text.includes('runId'), false)
  assert.equal(text.includes('code.domain.v1'), false)
})

test('explicit approve is the only path that submits host work', async () => {
  const calls: unknown[] = []
  const questionAgents: unknown[] = []
  const nativeAgent = { id: 'live-confirmation-agent' }
  const controller = new DshConfirmationController({
    answerer: createDshConfirmationAnswerer({
      ask: async (request) => {
        questionAgents.push(request.agent)
        return { answers: [{ id: request.questions[0]!.id, selected: ['approve'] }] }
      },
    }),
    readRevision: () => 2,
    submit: async (input) => { calls.push(input) },
  })
  const result = await controller.confirm({ confirmation: confirmation(), expectedRevision: 2, agent: nativeAgent })
  assert.equal(result.kind, 'submitted')
  assert.deepEqual(calls, [{ action: 'approve', expectedRevision: 2 }])
  assert.deepEqual(questionAgents, [nativeAgent])
})

test('revise requires requested changes and stale answers produce no mutation', async () => {
  const calls: unknown[] = []
  let revision = 3
  const controller = new DshConfirmationController({
    answerer: createDshConfirmationAnswerer(service({ selected: ['revise'], custom: 'Change the focused verifier.' })),
    readRevision: () => revision,
    submit: async (input) => { calls.push(input) },
  })
  const result = await controller.confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'blocked', reason: 'stale_revision' })
  assert.deepEqual(calls, [])
})

test('headless confirmation is blocked before asking or mutating', async () => {
  let submitted = false
  const result = await new DshConfirmationController({
    readRevision: () => 2,
    submit: () => { submitted = true },
  }).confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'blocked', reason: 'answerer_unavailable' })
  assert.equal(submitted, false)
})

test('dismissing the dedicated plan review returns the composer without mutating', async () => {
  let submitted = false
  const result = await new DshConfirmationController({
    answerer: { ask: async () => { throw Object.assign(new Error('chat about it'), { code: 'ASK_CANCELLED' }) } },
    readRevision: () => 2,
    submit: () => { submitted = true },
  }).confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'dismissed' })
  assert.equal(submitted, false)
})
