import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { codingPrelude, fixtureDefinition, interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const installed = existsSync(join(packages, '@deepseek-ai/dsh/package.json'))
if (!installed && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Request intent acceptance requires native DSH')
const extra = { lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
  memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
  deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } }
for (const mode of ['full', 'compiled'] as const) test(`native ${mode}: proposal, shorthand, continuation, verify and scope revision share intent`,
  { skip: !installed, timeout: 120000 }, async () => {
  const choices: string[] = []
  const packageRoot = process.env.KIOKUKO_OWNED_PACKAGE_ROOT
  const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), mode, extra,
    nativeAnswer: async request => {
if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, 'decision OFF / Lisp OFF')

      const q = request.questions[0]
      if (q.id.startsWith('coding-lisp-')) choices.push(q.id)
      return { answers: [{ id: q.id, selected: [q.id.startsWith('coding-lisp-') ? '使わない' : '通常実行'] }] }
    } })
  try {
    f.responses.push(f.mock.textResponse('A/B/C: src/parser.mjs の解析処理、エラー処理、出力を修正する。'))
    await f.turn('src/parser.mjs の修正案を説明して。まだ変更しないで。')
    f.responses.push(...codingPrelude(f.mock, 'proposal'), f.mock.toolCallResponse('first-write', 'kioku_write',
      { path: 'src/parser.mjs', content: 'console.log(41)\n' }),
      f.mock.toolCallResponse('failed-regression', 'kioku_exec', { command: `node -e 'require("node:assert/strict").equal(require("node:child_process").execFileSync(process.execPath,["src/parser.mjs"],{encoding:"utf8"}).trim(),"42")'` }),
      (request: any) => {
        const result = toolValue(request, 'failed-regression')
        assert.equal(result.exitCode, 1, 'a real failed check must precede continuation')
        return f.mock.textResponse('検証が失敗した。未完了の同じGoalを保持する。')
      })
    await f.turn('src/parser.mjs の A/B/C をまとめて入れて。通常実行で。')
    assert.equal(choices.length, 1)
    await f.reload(mode)
    f.responses.push(interpretedPreparation(f.mock, 'continue', 'same_scope_continuation', 'change'),
      f.mock.toolCallResponse('continued-state', 'coding_workflow', { action: 'status' }),
      (request: any) => {
        assert.equal(toolValue(request, 'continued-state').workflowId, toolValue(request, 'proposal-propose').workflowId)
        assert.equal(toolValue(request, 'continued-state').choice.state, 'no')
        return f.mock.toolCallResponse('continued-write', 'kioku_write', { path: 'src/parser.mjs', content: 'console.log(42)\n' })
      }, f.mock.textResponse('再開した同じGoalの修正を続ける。'))
    await f.turn(mode === 'full' ? 'それを直して。' : 'keep going')
    assert.equal(await readFile(join(f.dir, 'src/parser.mjs'), 'utf8'), 'console.log(42)\n')
    assert.equal(choices.length, 1)
    f.responses.push(interpretedPreparation(f.mock, 'verify', 'same_scope_continuation', 'verify'),
      f.mock.toolCallResponse('verify-process', 'kioku_exec', { command: 'node src/parser.mjs' }),
      f.mock.toolCallResponse('forbidden-write', 'kioku_write', { path: 'src/forbidden.mjs', content: 'wrong' }),
      (request: any) => {
        const results = nativeToolResults(request.messages)
        assert.equal(results.find(value => value.toolCallId === 'verify-process')?.isError, false)
        assert.equal(results.find(value => value.toolCallId === 'forbidden-write')?.isError, true)
        return f.mock.textResponse('実行結果を確認した。')
      })
    await f.turn('パッケージを更新した。src/parser.mjs の動作を見てくれ。変更はしないで。')
    assert.equal(existsSync(join(f.dir, 'src/forbidden.mjs')), false)
    assert.equal(choices.length, 1)
    const expansion = 'src/extra.mjs も変更対象に追加して実装して。通常実行で。'
    f.responses.push(interpretedPreparation(f.mock, 'expand', 'scope_change', 'change'),
      f.mock.toolCallResponse('premature-expand', 'kioku_write', { path: 'src/extra.mjs', content: 'wrong' }),
      f.mock.toolCallResponse('expand-state', 'coding_workflow', { action: 'status' }),
      (request: any) => {
        assert.equal(nativeToolResults(request.messages).find(value => value.toolCallId === 'premature-expand')?.isError, true)
        const definition = fixtureDefinition('src/parser.mjs and src/extra.mjs')
        definition.goal.revision = 2; definition.goal.requestBasis = expansion
        return f.mock.toolCallResponse('revise', 'coding_workflow_apply',
          { action: 'revise', expectedRevision: toolValue(request, 'expand-state').revision, definition })
      },
      (request: any) => { toolValue(request, 'revise'); return f.mock.toolCallResponse('expanded-write', 'kioku_write',
        { path: 'src/extra.mjs', content: 'console.log(43)\n' }) }, f.mock.textResponse('改訂したGoalの範囲を実装した。'))
    await f.turn(expansion)
    assert.equal(await readFile(join(f.dir, 'src/extra.mjs'), 'utf8'), 'console.log(43)\n')
    assert.equal(choices.length, 2, 'scope revision requires a fresh coding choice')
  } finally { await f.close() }
})
