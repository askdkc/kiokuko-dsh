import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.ts'
import { DecisionService } from '../src/dsh/decisions/service.ts'
import { TypeSafeDecisionProvider } from '../src/dsh/decisions/providers.ts'
import { selectInstalledSkills } from '../src/dsh/decisions/workflows.ts'

const args = process.argv.slice(2), live = args.includes('--live')
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const minScore = Number(value('--min-score') ?? (live ? NaN : 2))
const minConfidence = Number(value('--min-confidence') ?? (live ? NaN : .8))
const model = value('--model')
if (!Number.isFinite(minScore) || minScore < 0 || minScore > 3 || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1
  || live && (!model || !process.env.TYPESAFE_API_KEY)) {
  console.error('Live use: --live --model VERSIONED_MODEL --min-score 0..3 --min-confidence 0..1 with TYPESAFE_API_KEY')
  process.exit(1)
}
const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/decision-skill-evaluation.json', import.meta.url), 'utf8'))
const rows = []
for (const mode of ['choice', 'score']) for (const fixture of fixtures) {
  const config = TypedDecisionsConfig.parse({ provider: 'typesafe', ...(live ? { typesafe: { model } } : {}),
    skillSelection: mode === 'score' ? { mode, minScore, minConfidence } : { mode } })
  const oracle = { capabilities: { maxQuestions: 64, maxChoices: 255, maxBytes: 262144, questionTypes: ['choice', 'score'], maxScoreLevels: 10 },
    async evaluate(batch) { return { provider: 'fixture-oracle', requestedModel: 'fixture-oracle', policyVersion: batch.contractVersion ?? 'finite-choice-v1',
      usage: { input_tokens: 1, output_tokens: 1 }, answers: batch.questions.map(q => {
        const name = fixture.skills.find(skill => q.instructions.includes(`"name":"${skill.name}"`))?.name, relevant = fixture.gold.includes(name)
        return mode === 'score' ? { id: q.id, status: 'measured', type: 'score', score: relevant ? 3 : 0,
          probabilities: relevant ? [0, 0, 0, 1] : [1, 0, 0, 0], confidence: 1 }
          : { id: q.id, status: 'selected', choiceId: relevant ? 'yes' : 'no' }
      }) } },
  }
  const scoreConfidence = []
  const service = new DecisionService(config, c => {
    const backend = live ? new TypeSafeDecisionProvider(c.typesafe, async () => process.env.TYPESAFE_API_KEY) : oracle
    return { capabilities: backend.capabilities, async evaluate(batch, signal) {
      const result = await backend.evaluate(batch, signal)
      for (const answer of result.answers) if (answer.status === 'measured' && answer.type === 'score') scoreConfidence.push(answer.confidence)
      return result
    } }
  })
  const catalog = fixture.skills.map(skill => ({ kind: 'skill', ...skill }))
  const resolution = { recommendations: [] }
  const started = performance.now()
  try {
    const selected = await selectInstalledSkills(service, `${mode}:${fixture.id}`, fixture.task, catalog, resolution, new AbortController().signal)
    const observations = service.status().decisionObservations
    if (observations.some(o => o.fallbackReason)) throw Object.assign(new Error('Decision fallback'), { code: observations.find(o => o.fallbackReason).fallbackReason })
    const expected = fixture.gold, hits = selected.filter(name => expected.includes(name)).length
    rows.push({ id: fixture.id, mode, language: fixture.language, risk: fixture.risk, status: 'completed', selected,
      tp: hits, fp: selected.length - hits, fn: expected.length - hits, abstained: observations.reduce((n, o) => n + o.abstained, 0),
      scoreConfidence, usage: observations.map(o => ({ inputTokens: o.inputTokens, outputTokens: o.outputTokens })), elapsedMs: Math.round(performance.now() - started) })
  } catch (error) { rows.push({ id: fixture.id, mode, language: fixture.language, status: 'failed', reason: error?.code ?? 'evaluation_failed' }) }
}
const completed = rows.filter(row => row.status === 'completed')
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null
const elapsed = completed.map(r => r.elapsedMs).sort((a, b) => a - b)
const rates = subset => { const tp = subset.reduce((n, r) => n + r.tp, 0), fp = subset.reduce((n, r) => n + r.fp, 0), fn = subset.reduce((n, r) => n + r.fn, 0)
  return { completed: subset.length, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), falsePositives: fp, falseNegatives: fn } }
const report = { version: 1, mode: live ? 'live-synthetic' : 'fixture-oracle', model: live ? model : 'fixture-oracle',
  limitation: 'Four synthetic paired cases; fixture oracle verifies the evaluation pipeline, not model quality. Cost is unavailable without an explicit price.',
  attempted: rows.length, completed: completed.length, precision: completed.reduce((n, r) => n + r.tp, 0) / Math.max(1, completed.reduce((n, r) => n + r.tp + r.fp, 0)),
  recall: completed.reduce((n, r) => n + r.tp, 0) / Math.max(1, completed.reduce((n, r) => n + r.tp + r.fn, 0)),
  falsePositives: completed.reduce((n, r) => n + r.fp, 0), falseNegatives: completed.reduce((n, r) => n + r.fn, 0),
  p50Ms: percentile(elapsed, .5), p95Ms: percentile(elapsed, .95), byLanguage: Object.fromEntries(['ja', 'en'].map(language => [language, rates(completed.filter(r => r.language === language))])),
  scoreConfidenceBands: Object.fromEntries(['0-.5', '.5-.8', '.8-1'].map((band, i) => [band, completed.flatMap(r => r.scoreConfidence).filter(c => i === 0 ? c < .5 : i === 1 ? c < .8 : c <= 1).length])),
  cost: null, rows }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (rows.some(row => row.status !== 'completed') || !live && rows.some(row => row.fp || row.fn)) process.exitCode = 1
