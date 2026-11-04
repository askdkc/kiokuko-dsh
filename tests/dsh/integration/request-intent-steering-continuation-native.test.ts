import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const explicit of [true, false]) test(`same-turn human steering refreshes a continued request (${explicit ? 'adapter' : 'public'})`, { timeout: 60000 }, async () => {
  const f = await nativeSkillFixture({ packages, explicit, extra: { lisp: { enabled: false }, typedDecisions: { mode: 'off' },
    answerReview: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
    deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } } })
  try {
    f.responses.push(interpretedPreparation(f.mock, 'initial', 'new', 'change', 'build'), f.mock.textResponse('The parser implementation is prepared.'))
    await f.turn('Implement parser.js. 通常実行で。')
    let runId: string
    f.responses.push(interpretedPreparation(f.mock, 'continue', 'same_scope_continuation', 'change', 'build'), (request: any) => {
      assert.equal(toolValue(request, 'continue').prepared, true)
      f.agent.inject(f.llm.createUserMessage({ content: [{ type: 'text', text: 'Continue this parser implementation and also preserve empty input. 通常実行で。' }], source: { kind: 'user' } }))
      return f.mock.toolCallResponse('before-steering', 'coding_workflow', { action: 'status' })
    }, (request: any) => {
      runId = toolValue(request, 'before-steering').runId
      return interpretedPreparation(f.mock, 'steered', 'same_scope_continuation', 'change', 'build')(request)
    }, (request: any) => {
      assert.equal(toolValue(request, 'steered').prepared, true)
      return f.mock.toolCallResponse('after-steering', 'coding_workflow', { action: 'status' })
    }, (request: any) => {
      assert.equal(toolValue(request, 'after-steering').runId, runId)
      return f.mock.textResponse('The updated request is bound to the current parser task.')
    })
    await f.turn('Continue the parser implementation. 通常実行で。')
    assert.deepEqual(f.agent.session.snapshotEvents().filter((event: any) => event.type === 'turn/start').map((event: any) => event.data.turn), [1, 2])
  } finally { await f.close() }
})
