import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepConfigurationSchema, DEEP_ROLES, DeepStateSchema, type QualityReply } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'
import { acceptDeepReply } from '../../../src/deep-thinker/acceptance.js'
import { jobFor } from '../../../src/deep-thinker/prompts.js'
import { deepReport, deepStatusText } from '../../../src/deep-thinker/report.js'
import { boundedQualityReport } from '../../../src/deep-thinker/quality-report.js'
import { qualityInput, qualityResponse } from '../helpers/deep-quality-fixture.js'

function initial(quality = true) {
  const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, { provider: 'test', model: role }])),
    ...(quality ? { reasoningMode: 'quality', alternativeSolver: { provider: 'test', model: 'alternative' } } : {}) })
  return initialDeepState({ revision: 0, startId: 's', runId: null, workspace: 'w', sessionId: 's', rootPath: '/repo', commandId: 'c', messageId: 'm', task: 'Compare evidence', status: 'pending', configuration, messages: [], problem: '' }, 'run', '')
}

function reviewed(options: Parameters<typeof qualityResponse>[1] = {}, edit?: (reply: QualityReply) => void) {
  const state = initial(), node = state.nodes[0]!
  for (let i = 0; i < (options.action ? 7 : 5); i++) {
    const job = jobFor(state, node, 'planner', []), reply = qualityResponse(qualityInput(job), options)
    edit?.(reply)
    acceptDeepReply(state, node, job, `attempt-${i}`, reply, [], [])
  }
  state.phase = node.status === 'accepted' ? 'answered' : 'partial'
  return state
}

test('quality report distinguishes supported alternatives from errors and explains every check', () => {
  const state = reviewed(), before = structuredClone(state), report = deepReport(state, [])
  assert.match(report.text, /採用: 案1/)
  assert.match(report.text, /案2 .*\[未選択\]/)
  assert.match(report.text, /案2 .*: 支持 — Analytical fixture assessment/)
  assert.match(report.text, /検証項目: Check answer \(request\)/)
  assert.match(report.text, /検証項目: Check evidence \(request\)/)
  assert.match(report.text, /候補間の評価: 判定不能 — Agreement is not a correctness proof/)
  assert.match(report.text, /未解決・制限: 0件 \/ 未解決の指摘: 0件/)
  assert.doesNotMatch(report.text, /誤答|誤り|表示上限/)
  assert.ok(report.text.indexOf('比較の要約') < report.text.indexOf('\nCORRECT'))
  assert.deepEqual(state, before)
})

for (const [kind, label] of [['agreement', '一致'], ['contradiction', '矛盾'], ['complementary', '相補的']] as const) {
  test(`quality report displays the critic's ${kind} assessment without accepting consensus`, () => {
    const state = reviewed({ a: 'WRONG', b: 'WRONG', rejectConsensus: true }, reply => {
      if (reply.kind === 'quality-review') {
        reply.agreement.forEach(item => { item.kind = kind; item.reason = 'Recorded assessment' })
        reply.issues = [{ checkId: reply.agreement[0]!.checkId, text: 'Evidence is missing' }]
        reply.evaluations[0]!.verdict = 'unresolved'
      }
    })
    const report = deepReport(state, [])
    assert.match(report.text, /採用: なし（検証未完了）/)
    assert.ok(report.text.includes(`候補間の評価: ${label} — Recorded assessment`))
    assert.match(report.text, /案1 .*: 未解決 —/)
    assert.match(report.text, /案2 .*: 矛盾あり —/)
    assert.match(report.text, /未解決・制限: 1件 \/ 未解決の指摘: 1件/)
    assert.match(report.text, /未解決: Evidence is missing/)
  })
}

for (const action of ['repair', 'synthesize'] as const) test(`report preserves final review and issue resolution after ${action}`, () => {
  const state = reviewed({ a: 'WRONG', action }), report = deepReport(state, [])
  assert.match(report.text, /修正・統合の枠: 使用済み（未完了を含む）/)
  assert.match(report.text, /案1 .*: 矛盾あり/)
  assert.match(report.text, /案3 .*: 支持/)
  assert.match(report.text, /解消と評価: Resolve the concrete counterexample — Counterexample addressed/)
  assert.match(report.text, /未解決の指摘: 0件/)
})

test('a corrected candidate awaiting final review is unreviewed, not supported by the old review', () => {
  const state = reviewed({ action: 'repair' }), node = state.nodes[0]!
  node.status = 'verifying'; node.receipt = null
  node.quality!.review!.evaluations = node.quality!.review!.evaluations.filter(item => item.candidateId !== node.quality!.candidates[2]!.id)
  node.quality!.review!.resolutions = []
  const report = deepReport(state, [])
  assert.match(report.text, /採用: なし（検証未完了）/)
  assert.match(report.text, /案3 .*: 未評価/)
  assert.match(report.text, /未解決の指摘: 1件/)
})

test('large quality reports retain the summary, mark omitted text and preserve structured records', () => {
  const state = reviewed({ a: 'WRONG', b: 'WRONG', rejectConsensus: true }, reply => {
    if (reply.kind === 'quality-review') {
      reply.reason = '判定理由'.repeat(8_000)
      reply.evaluations.forEach(item => { item.reason = '理由'.repeat(16_000) })
      reply.issues = [{ checkId: reply.agreement[0]!.checkId, text: 'Unresolved evidence' }]
    }
  })
  DeepStateSchema.parse(state)
  const before = structuredClone(state), report = deepReport(state, [])
  assert.ok(report.text.length <= 131_072)
  assert.match(report.text, /採用: なし（検証未完了）/)
  assert.match(report.text, /未解決・制限: 1件 \/ 未解決の指摘: 1件/)
  assert.match(report.text, /表示上限のため以降の本文・詳細を省略/)
  assert.deepEqual(report.quality![0]!.review, state.nodes[0]!.quality!.review)
  assert.deepEqual(state, before)
  assert.doesNotThrow(() => encodeURIComponent(report.text))
})

test('display truncation preserves Unicode and leaves exactly bounded output alone', () => {
  const exact = 'x'.repeat(131_072)
  assert.equal(boundedQualityReport(exact), exact)
  for (const prefix of ['', 'x']) {
    const text = boundedQualityReport(prefix + '😀'.repeat(70_000))
    assert.ok(text.length <= 131_072)
    assert.doesNotThrow(() => encodeURIComponent(text))
    assert.match(text, /表示上限/)
  }
  const state = reviewed({}, reply => { if (reply.kind === 'quality-review') reply.reason = 'x' + '😀'.repeat(1_000) })
  assert.doesNotThrow(() => encodeURIComponent(deepReport(state, []).text))
})

test('standard reports retain their existing text and omit quality fields', () => {
  const state = initial(false), node = state.nodes[0]!
  node.status = 'accepted'; node.candidate = { kind: 'candidate', answer: 'Standard answer', assumptions: [], unresolved: [], evidence: [] }
  node.receipt = { verifierVersion: 1, inputDigest: 'input', evidenceDigest: 'evidence', assessment: 'analytical' }
  const report = deepReport(state, [])
  assert.equal(report.text, `${deepStatusText(state)}\n\nStandard answer\n\n根拠・出典（内容照合と分析評価。形式証明ではありません）\n- 出典に基づく確認なし。分析上の評価です。`)
  assert.equal('quality' in report, false)
})
