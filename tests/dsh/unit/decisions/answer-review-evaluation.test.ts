import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { LayaV1DecisionProvider } from '../../../../src/dsh/decisions/laya-v1.js'
import { answerReviewQuestions } from '../../../../src/dsh/answer-review/contracts.js'
import { layaV1Reply } from '../../helpers/laya.js'
import { requireChoice } from '../../../../src/dsh/decisions/contracts.js'
import { schedule, summarize } from '../../../../scripts/answer-review-evaluation.mjs'

const batch = { purpose: 'answer-review' as const, state: { task: 'Check', answer: 'Claim', evidence: [] }, questions: [answerReviewQuestions[0]!] }
async function evaluate(probabilities: Record<string, number>, acceptance: { minProbability: number; minMargin: number }, observe: (value: any) => void = () => {}) {
  const settings = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', acceptance } })['laya-coreml']!
  const provider = new LayaV1DecisionProvider(settings, async (_path, raw) => {
    const request = JSON.parse(raw)
    if (request.op === 'health') return { version: 1, ok: true, status: 'ready' }
    const reply = layaV1Reply(request, () => Object.entries(probabilities).sort((a,b) => b[1]-a[1])[0]![0])
    for (const answer of Object.values(reply.result!.answers) as any[]) answer.probabilities = probabilities
    return reply
  }, observe)
  return provider.evaluate(batch, new AbortController().signal)
}

test('diagnostics distinguish probability, margin, explicit abstention and keep choice order', async () => {
  const values: any[] = []
  await evaluate({ satisfied: .7, finding: .1, not_applicable: .1, abstain: .1 }, { minProbability: .9, minMargin: .2 }, value => values.push(value))
  assert.deepEqual(values[0].failedChecks, ['probability'])
  assert.deepEqual(values[0].probabilities.map((p: any) => p.id), requireChoice(answerReviewQuestions[0]!).choices.map(c => c.id))
  values.length = 0
  await evaluate({ satisfied: .6, finding: .35, not_applicable: .03, abstain: .02 }, { minProbability: .5, minMargin: .3 }, value => values.push(value))
  assert.deepEqual(values[0].failedChecks, ['margin'])
  values.length = 0
  const outcome = await evaluate({ satisfied: .01, finding: .01, not_applicable: .01, abstain: .97 }, { minProbability: .9, minMargin: .2 }, value => values.push(value))
  assert.equal(outcome.answers[0]?.status, 'abstained')
  assert.equal(values[0].reason, 'insufficient')
})

test('malformed responses emit no diagnostics; observer failures do not alter a valid decision', async () => {
  const values: any[] = []
  await assert.rejects(evaluate({ satisfied: .8, finding: .8, not_applicable: .1, abstain: .1 }, { minProbability: .9, minMargin: .2 }, value => values.push(value)))
  assert.equal(values.length, 0)
  const outcome = await evaluate({ satisfied: .97, finding: .01, not_applicable: .01, abstain: .01 }, { minProbability: .9, minMargin: .2 }, () => { throw new Error('observer') })
  assert.equal(outcome.answers[0]?.status, 'selected')
})

test('evaluation summaries include failed cases and preserve class denominators', () => {
  const cases = [
    { status: 'completed', expected: ['finding','satisfied','abstain'], observed: ['finding','abstain','abstain'], raw: [{status:'selected'}, {status:'abstained',reason:'uncertain'}, {status:'abstained',reason:'insufficient'}], elapsedMs: 10 },
    { status: 'unavailable', expected: ['finding'], reason: 'DECISION_TIMEOUT', elapsedMs: 20 },
  ]
  const result = summarize(cases)
  assert.equal(result.completionRate, .5)
  assert.equal(result.detectionRate, .5)
  assert.equal(result.completedDetectionRate, 1)
  assert.equal(result.allTrialConfusion.finding.failure, 1)
  assert.equal(result.abstentionRateByExpected.satisfied, 1)
  assert.equal(result.statusCountsByReason['unavailable:DECISION_TIMEOUT'], 1)
  assert.equal(result.meanAttemptedMs, 15)
  assert.equal(result.p95AttemptedMs, 20)
  assert.equal(result.confusion.finding.finding, 1)
  const examples = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(schedule(examples, 3, 9), schedule(examples, 3, 9))
  assert.equal(schedule(examples, 3, 9).length, 12)
})

test('archive cases stay in tuning groups and translations do not add independent evidence', async () => {
  const data: { id: string; groupId: string; expected: string[]; split: string; ja: string[]; en: string[] }[] = JSON.parse(await readFile(new URL('../../../fixtures/answer-review/laya-grounding-tune.json', import.meta.url),'utf8'))
  assert.equal(data.length,18)
  assert.equal(new Set(data.map((c: any) => c.groupId)).size,18)
  assert.ok(data.every((c: any) => c.split === 'tune' && c.ja.length === 3 && c.en.length === 3))
  const rows = schedule(data,1,0).map(({example,language}) => ({id:example.id,groupId:example.groupId,language,expected:[example.expected[1]],status:'unavailable',reason:'DECISION_TOO_LARGE',elapsedMs:1}))
  const summary = summarize(rows)
  assert.equal(summary.attempted,36)
  assert.equal(summary.independentGroups,18)
  assert.equal(summary.clusterIntervals.independentGroups,18)
  assert.equal(summary.allTrialConfusion.finding.failure,12)
  assert.equal(summary.detectionRate,0)
  assert.equal(summary.failureRate,1)
})
