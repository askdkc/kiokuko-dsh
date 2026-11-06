import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { OpenAIDecisionProvider } from '../../../src/dsh/decisions/openai.js'

isolateSkillHome()
test('ordinary native chat asks mode once, clarifies a vague request, and offers memory after each answer', { timeout: 20000 }, async () => {
  const asked: string[] = []
  const f = await nativeSkillFixture({
    packages: process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules'),
    driver: 'kiokuko', intakeAnswers: false, startupChoice: 'decision OFF / Lisp OFF',
    extra: { lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' }, modelAutoMode: { mode: 'off' } },
    nativeAnswer: async request => {
      const q = request.questions[0]; asked.push(q.id)
      assert.ok(['target', 'expected'].includes(q.id))
      if (q.id === 'expected') assert.equal(f.model.auxiliaryRequests.filter(request => request.purpose === 'akinator-expected').length, 1)
      return { answers: [{ id: q.id, selected: [], custom: q.id === 'target' ? 'src/parser.ts' : 'Empty input returns an empty result' }] }
    },
  })
  const waitForReviews = async (count: number) => {
    const deadline = Date.now() + 3000
    while (f.memoryQuestions.length < count && Date.now() < deadline) await delay(10)
    assert.equal(f.memoryQuestions.length, count)
  }
  try {
    f.responses.push(f.mock.textResponse('Ready to discuss the parser.'))
    await f.turn('Explain how parsers work.')
    await waitForReviews(1)
    f.responses.push(async function* (request: any) {
      assert.match(JSON.stringify(request.messages), /src\/parser.ts/)
      assert.match(JSON.stringify(request.messages), /Empty input returns an empty result/)
      yield* f.mock.textResponse('The clarified target is src/parser.ts.')
    })
    await f.turn('Fix it')
    await waitForReviews(2)
    assert.equal(f.startupQuestions.length, 1)
    assert.deepEqual(asked, ['target', 'expected'])
  } finally { await f.close() }
})

for (const probability of [.509, .51]) test(`native Akinator leaves a concrete request with the main model even on abstention (${probability})`, { timeout: 20000 }, async () => {
  const asked: string[] = [], decided: string[] = []
  const intakeWorkspaces: unknown[] = []
  const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'openai' }), config =>
    new OpenAIDecisionProvider(config.openai, async () => 'fixture-key', async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.questions.some((q: any) => q.name.startsWith('intake-'))) {
        intakeWorkspaces.push(body.input[0].content.find((part: any) => part.type === 'input_json').data.state.workspaceDirectory)
      }
      return Response.json({ model: 'gpt-6-luna', answers: body.questions.map((q: any) => {
        decided.push(q.name)
        const choice = q.name === 'task-type' ? 'debug' : 'source-0'
        const p = q.name === 'intake-target' ? probability : 1
        return { name: q.name, type: 'choice', choice, confidence: p,
          probabilities: q.choices.map((c: any) => ({ value: c.value, probability: c.value === choice ? p : c.value === 'abstain' ? 1 - p : 0 })) }
      }), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })
    }))
  const f = await nativeSkillFixture({
    packages: process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules'),
    driver: 'kiokuko', intakeAnswers: false, explicit: true, decisions, startupChoice: 'decision ON / Lisp OFF',
    extra: { lisp: { enabled: false }, typedDecisions: { provider: 'openai' }, answerReview: { mode: 'off' }, modelAutoMode: { mode: 'off' } },
    nativeAnswer: async request => {
      const q = request.questions[0]; asked.push(q.id)
      return { answers: [{ id: q.id, selected: [], custom: 'src/parser.ts' }] }
    },
  })
  try {
    f.responses.push(async function* (request: any) {
      assert.match(JSON.stringify(request.messages), /Akinator answers/)
      assert.match(JSON.stringify(request.messages), /src\/parser.ts/)
      const guidance = request.messages.flatMap((message: any) => message.source?.sections ?? [])
        .find((section: any) => section.name === 'on-demand-intake')?.text
      assert.ok(guidance)
      const context = JSON.parse(guidance.split('advisory only):\n')[1].split('\n')[0])
      assert.equal(context.workspaceDirectory, f.dir, 'the live session workspace reaches the main model')
      yield* f.mock.textResponse('Understood.')
    })
    await f.turn('Fix src/parser.ts so empty input returns an empty result.')
    assert.deepEqual(asked, [], 'provider uncertainty must not require the human to repeat the target')
    assert.ok(intakeWorkspaces.length > 0)
    assert.ok(intakeWorkspaces.every(cwd => cwd === f.dir), 'the source-answer provider receives the same live workspace')
    for (const id of ['task-type', 'intake-target']) assert.ok(decided.includes(id), id)
    assert.ok(!decided.includes('intake-expected'))
    assert.ok(!f.model.auxiliaryRequests.some(request => request.purpose === 'akinator-expected'), 'success criteria can wait until work is prepared')
  } finally { await f.close() }
})
