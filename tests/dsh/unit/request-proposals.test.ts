import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeRequestProposals } from '../../../src/dsh/request-proposals.js'
import {
  bindMainModelRequestIntent,
  createRequestIntentContext,
  requestIntentReferenceIds,
  requestIntentRequiredReferenceIds,
} from '../../../src/dsh/decisions/request-intent.js'
const plan =
  '# Parser plan\nImplement src/parser.ts; preserve package.json and do not publish.'
const event = (turn: number, content: unknown[], id = 'plan-message') => ({
  type: 'assistant/message',
  seq: turn,
  data: { turn, message: { id, role: 'assistant', content } },
})
const call = (args: unknown = JSON.stringify({ plan })) => ({
  type: 'tool-call',
  name: 'exit_plan_mode',
  id: 'review',
  arguments: args,
})

test('native plan body survives a later ordinary reply and is not confused with approval', () => {
  const proposals = nativeRequestProposals(
    [
      event(1, [call()]),
      event(1, [{ type: 'text', text: 'The plan is ready.' }], 'reply'),
    ],
    2,
    'session-a',
  )
  assert.equal(proposals[0]!.text, plan)
  assert.equal(proposals[1]!.text, 'The plan is ready.')
  const context = createRequestIntentContext({
    task: 'PLAN.md を実装',
    messageRefs: [{ id: 'human', digest: 'a'.repeat(64) }],
    proposals,
  })!
  assert.equal(
    bindMainModelRequestIntent(
      {
        relation: 'scope_change',
        action: 'change',
        changeScope: 'implementation',
        evidenceRefs: requestIntentRequiredReferenceIds(context),
      },
      context,
    ),
    undefined,
  )
  const decision = bindMainModelRequestIntent(
    {
      relation: 'scope_change',
      action: 'change',
      changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context),
    },
    context,
  )!
  assert.equal(decision.evidence.proposalRefs[0]!.id, proposals[0]!.id)
  assert.notEqual(
    nativeRequestProposals([event(1, [call()])], 2, 'session-b')[0]!.id,
    proposals[0]!.id,
  )
})

for (const content of [
  [call('{')],
  [call({ plan: '' })],
  [call({ plan: 'x'.repeat(8193) })],
  [call({ plan: 123 })],
]) {
  test('invalid native plan content is excluded', () => {
    assert.deepEqual(
      nativeRequestProposals([event(1, content)], 2, 'session'),
      [],
    )
  })
}

test('a current or future assistant event cannot become a prior plan proposal', () => {
  assert.deepEqual(
    nativeRequestProposals(
      [event(2, [call()]), event(3, [call()])],
      2,
      'session',
    ),
    [],
  )
  assert.deepEqual(
    nativeRequestProposals(
      [{ type: 'user/message', data: event(1, [call()]).data }],
      2,
      'session',
    ),
    [],
  )
})
