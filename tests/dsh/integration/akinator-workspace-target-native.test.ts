import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionError } from '../../../src/dsh/decisions/contracts.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'

isolateSkillHome()

for (const host of ['core', 'adapter'] as const) for (const mode of host === 'core' ? ['off'] as const : ['off', 'abstain', 'unavailable'] as const) {
  test(`${host}: selected workspace survives ${mode} target classification without asking the user again`, { timeout: 30_000 }, async () => {
    const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'openai' }), () => ({
      capabilities: { maxQuestions: 32, maxChoices: 32, maxBytes: 262144 },
      async evaluate(batch) {
        if (mode === 'unavailable') throw new DecisionError('UNAVAILABLE')
        return { provider: 'openai', requestedModel: 'fixture', policyVersion: 'fixture',
          answers: batch.questions.map(question => ({ id: question.id, status: 'abstained' as const, reason: 'uncertain' })) }
      },
    }))
    const packageRoot = process.env.KIOKUKO_TEST_PLUGIN_PACKAGE_ROOT
    const f = await nativeSkillFixture({
      packages: process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules'),
      ...(packageRoot ? { packageRoot } : {}),
      explicit: host === 'adapter', decisions, intakeAnswers: false,
      startupChoice: mode === 'off' ? 'decision OFF / Lisp OFF' : 'decision ON / Lisp OFF',
      extra: { lisp: { enabled: false }, toolExposure: { mode: 'full' }, answerReview: { mode: 'off' },
        memoryReuse: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' },
        modelAutoMode: { mode: 'off' }, typedDecisions: { provider: 'openai' } },
      nativeAnswer: async request => { assert.fail(`Unexpected clarification: ${JSON.stringify(request.questions)}`) },
    })
    const task = 'READMEに実装済みの機能の説明が抜けているので、調査して修正してください。'
    const originalStream = f.model.stream.bind(f.model)
    f.model.stream = async function* (request: any) {
      if (request.purpose !== 'akinator-expected') { yield* originalStream(request); return }
      yield* f.mock.textResponse(JSON.stringify({ expected: 'READMEに実装済みの機能が説明されている。', quote: 'READMEに実装済みの機能の説明が抜けている' }))
    }
    try {
      await writeFile(join(f.dir, 'README.md'), 'Project introduction')
      f.responses.push(interpretedPreparation(f.mock, 'prepare', 'new', 'change'), (request: any) => {
        assert.equal(toolValue(request, 'prepare').prepared, true)
        assert.equal(toolValue(request, 'prepare').originalTask, task)
        return f.mock.toolCallResponse('read', 'kioku_read', { path: 'README.md' })
      }, (request: any) => {
        const result = nativeToolResults(request.messages).find(item => item.toolCallId === 'read')
        assert.ok(result && !result.isError, JSON.stringify(result))
        assert.match(JSON.stringify(result.content), /Project introduction/)
        return f.mock.textResponse('READMEを確認しました。')
      })
      await f.turn(task)
      assert.equal(f.responses.length, 0)
    } finally { await f.close() }
  })
}
