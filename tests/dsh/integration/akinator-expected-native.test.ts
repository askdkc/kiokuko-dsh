import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { OpenAIDecisionProvider } from '../../../src/dsh/decisions/openai.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'

isolateSkillHome()

const packageRoot = process.env.KIOKUKO_TEST_PLUGIN_PACKAGE_ROOT
const reportedRequest = 'このログの内容からkiokuko-dshの問題点を調査し、必要な修正をじっし'
const unclearRequest = 'kiokuko-dsh の挙動を改善してください。'
const successCondition = 'ログの調査で判明した kiokuko-dsh の不具合が修正されている。'

for (const scenario of ['reported request', 'unclear request', 'unsupported evidence'] as const) {
  const clear = scenario === 'reported request'
  const task = clear ? reportedRequest : unclearRequest
  test(`native intake gives the main model the first decision about completion (${scenario})`, { timeout: 30_000 }, async () => {
    const order: string[] = []
    const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'openai' }), config =>
      new OpenAIDecisionProvider(config.openai, async () => 'fixture-key', async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        return Response.json({
          model: 'gpt-6-luna',
          answers: body.questions.map((question: { name: string; choices: { value: string }[] }) => {
            if (question.name.startsWith('request-') || question.name === 'task-type')
              return { name: question.name, type: 'refusal' }
            if (question.name === 'intake-expected') order.push('decision provider')
            const choice = question.name.startsWith('intake-') ? 'source-0'
              : question.name.startsWith('semantic-') ? 'supported'
                : question.choices.find(candidate => candidate.value === 'abstain')?.value ?? question.choices[0]!.value
            return { name: question.name, type: 'choice', choice, confidence: 1,
              probabilities: question.choices.map(({ value }) => ({ value, probability: Number(value === choice) })) }
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        })
      }))
    const f = await nativeSkillFixture({
      packages: process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules'),
      ...(packageRoot ? { packageRoot } : {}),
      explicit: true, decisions, intakeAnswers: false, startupChoice: 'decision ON / Lisp OFF',
      extra: { lisp: { enabled: false }, toolExposure: { mode: 'full' }, answerReview: { mode: 'off' },
        memoryReuse: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' },
        modelAutoMode: { mode: 'off' }, typedDecisions: { provider: 'openai' } },
      nativeAnswer: async request => {
        const question = request.questions[0]
        assert.equal(question.id, 'expected')
        order.push('asked user')
        return { answers: [{ id: question.id, selected: [], custom: '実行時の待ち時間が短くなる。' }] }
      },
    })
    const originalStream = f.model.stream.bind(f.model)
    f.model.stream = async function* (request: any) {
      if (request.purpose !== 'akinator-expected') {
        yield* originalStream(request)
        return
      }
      assert.equal(request.provider, 'mock')
      assert.equal(request.model, 'qwen3-coder')
      assert.deepEqual(request.tools, [])
      assert.deepEqual(JSON.parse(request.messages[0].content[0].text), { request: task })
      order.push('main model')
      yield* f.mock.textResponse(JSON.stringify(scenario === 'unclear request'
        ? { expected: null }
        : { expected: successCondition, quote: '問題点を調査し、必要な修正をじっし' }))
    }
    try {
      await writeFile(join(f.dir, 'session-log.txt'), 'Fixture log was read.')
      f.responses.push(interpretedPreparation(f.mock, 'prepare', 'new', 'change'), (request: any) => {
        const value = toolValue(request, 'prepare')
        assert.equal(value.prepared, true)
        assert.equal(value.originalTask, task)
        assert.match(JSON.stringify(request.messages), clear ? /不具合が修正されている/ : /実行時の待ち時間が短くなる/)
        return f.mock.toolCallResponse('read-log', 'kioku_read', { path: 'session-log.txt' })
      }, (request: any) => {
        const result = nativeToolResults(request.messages).find(item => item.toolCallId === 'read-log')
        assert.ok(result && !result.isError, JSON.stringify(result))
        assert.match(JSON.stringify(result.content), /Fixture log was read/)
        return f.mock.textResponse('The log was read.')
      })
      await f.turn(task)
      assert.deepEqual(order, ['main model', ...(clear ? [] : ['asked user'])])
      assert.equal(f.responses.length, 0)
    } finally {
      await f.close()
    }
  })
}
