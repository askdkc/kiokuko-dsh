import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshConfirmationAnswerer, renderDshConfirmation, type DshUserQuestions } from '../../../../src/dsh/user-interaction.js'
import type { UserFacingConfirmation } from '../../../../src/enno-oduno/types.js'

const confirmation: UserFacingConfirmation = {
  presentationVersion: 1, title: 'Approve plan',
  summary: { basis: 'proposal', text: 'Apply the bounded change.' },
  scope: { basis: 'repository', paths: ['src/dsh/tools.ts'] },
  exclusions: { basis: 'user', paths: ['dist/'] },
  completion: { basis: 'proposal', items: ['Focused checks pass'] },
  skills: [{ label: 'kiokuko-soul', basis: 'repository', required: true, purposes: ['review'], referenceOnly: false }],
  workItems: [{ number: 1, summary: 'Implement boundary', paths: ['src/dsh/tools.ts'], dependsOn: [], doneWhen: ['No identity injection'], checks: [], expertise: [] }],
  finalChecks: { basis: 'repository', checks: [{ category: 'typecheck', executable: 'npm', arguments: ['run', 'typecheck'], directory: '.', timeoutMs: 120000 }] },
  attemptLimit: { basis: 'proposal', maxAttempts: 3 }, actions: ['approve', 'revise', 'cancel'],
}

function service(answer: { selected: string[]; custom?: string }): DshUserQuestions {
  return { ask: async (request) => ({ answers: [{ id: request.questions[0]!.id, selected: answer.selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) }] }) }
}

test('confirmation exposes the public contract while omitting host identity', () => {
  const text = renderDshConfirmation(confirmation)
  assert.match(text, /src\/dsh\/tools\.ts/u)
  assert.match(text, /Choose approve or cancel here\. Use Chat about it to describe a revision/u)
  assert.equal(/runId|resumeToken|leaseToken|expectedRevision/iu.test(text), false)
})

test('only an explicit revise action may carry requested changes', async () => {
  const answerer = createDshConfirmationAnswerer(service({ selected: ['revise'], custom: 'Narrow the scope.' }))
  assert.deepEqual(await answerer.ask(confirmation), { action: 'revise', requestedChanges: 'Narrow the scope.' })
  await assert.rejects(
    createDshConfirmationAnswerer(service({ selected: ['approve'], custom: 'smuggle changes' })).ask(confirmation),
    /Only a revision may carry requested changes/u,
  )
})

test('confirmation binds the request to the exact native agent', async () => {
  const agent = { id: 'root-agent' }
  let receivedAgent: object | undefined
  let receivedQuestion: Parameters<DshUserQuestions['ask']>[0] | undefined
  const answerer = createDshConfirmationAnswerer({
    ask: async (request) => {
      receivedAgent = request.agent
      receivedQuestion = request
      return { answers: [{ id: request.questions[0]!.id, selected: ['approve'] }] }
    },
  })
  await answerer.ask(confirmation, undefined, agent)
  assert.equal(receivedAgent, agent)
  assert.deepEqual(receivedQuestion?.questions[0]?.intent, { kind: 'plan-review', approve: 'approve' })
  assert.deepEqual(receivedQuestion?.questions[0]?.options?.map((option) => option.label), ['approve', 'cancel'])
})
