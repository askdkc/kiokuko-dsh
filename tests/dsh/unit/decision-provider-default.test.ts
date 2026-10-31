import assert from 'node:assert/strict'
import test from 'node:test'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'

const question = { purpose: 'lisp' as const, state: {},
  questions: [{ id: 'q', instructions: 'Pick', choices: [{ id: 'yes', description: 'Yes' }, { id: 'no', description: 'No' }], abstainId: 'no' }] }
const signal = () => new AbortController().signal

/** A service that records which backend each dispatch used. */
function make(options: { configuredProvider?: () => any; selection?: { provider: string } } = {}) {
  const dispatched: string[] = []
  let revision = 1
  const service = new DecisionService(
    TypedDecisionsConfig.parse({ provider: 'typesafe' }),
    config => {
      dispatched.push(config.provider)
      return { capabilities: { maxQuestions: 1, maxChoices: 4, maxBytes: 4096 },
        evaluate: async batch => ({ provider: config.provider, requestedModel: 'fixture', policyVersion: 'fixture',
          answers: batch.questions.map((q: any) => ({ id: q.id, status: 'selected' as const, choiceId: q.choices[0]!.id })) }) }
    },
    options.selection ? {
      read: async () => undefined, write: async () => {},
      bind: async (_id: string, config: any) => config,
    } as any : undefined,
    { ...(options.configuredProvider ? { configuredProvider: options.configuredProvider } : {}),
      ...(options.selection ? { selectionStore: {
        load: async () => ({ config: TypedDecisionsConfig.parse({ provider: options.selection!.provider as any }), revision }),
        save: async () => ++revision,
      } } : {}) })
  return { service, dispatched }
}

test('a configured provider drives new requests without an explicit selection', async () => {
  const f = make({ configuredProvider: () => 'openai' })
  assert.equal((await f.service.evaluate('request-1', question, signal())).status, 'completed')
  assert.deepEqual(f.dispatched, ['openai'])
  assert.equal((f.service.status() as any).provider, 'openai')
})

test('without a configured provider the parsed configuration still applies', async () => {
  const f = make()
  await f.service.evaluate('request-2', question, signal())
  assert.deepEqual(f.dispatched, ['typesafe'])
  assert.equal((f.service.status() as any).provider, 'typesafe')
})

test('an explicit saved selection outranks the configured provider', async () => {
  const f = make({ configuredProvider: () => 'openai', selection: { provider: 'laya-coreml' } })
  const outcome = await f.service.evaluate('request-3', question, signal())
  // The stored selection stays in force even though it cannot dispatch here;
  // the configured default must never replace it implicitly.
  assert.equal((f.service.status() as any).provider, 'laya-coreml', 'a project selection is authoritative')
  assert.equal(outcome.status, 'fallback')
  assert.ok(!f.dispatched.includes('openai'), 'the configured default must not replace the selection')
})
