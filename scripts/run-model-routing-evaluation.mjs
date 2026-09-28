import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.ts'
import { DecisionService } from '../src/dsh/decisions/service.ts'
import { TypeSafeDecisionProvider } from '../src/dsh/decisions/providers.ts'
import { LayaV1DecisionProvider } from '../src/dsh/decisions/laya-v1.ts'
import { LayaCoreMLDecisionProvider, discoverLayaConfiguration } from '../src/dsh/decisions/laya-coreml.ts'
import { buildModelRoutingBatch } from '../src/dsh/model-auto/batch.ts'
import { DEFAULT_MODEL_AUTO_ROUTES, MODEL_AUTO_POLICY } from '../src/dsh/model-auto/contracts.ts'
import { ROUTE_LABELS, routingInputCompleteness, summarizeModelRouting } from './model-routing-evaluation.ts'
import { schedule } from './answer-review-evaluation.mjs'

const usage = 'Use [--live --provider jev|laya --config PATH] [--repetitions 1..10] [--seed UINT32] [--output PATH].'
let values
try {
  ;({ values } = parseArgs({ options: { live: { type: 'boolean' }, provider: { type: 'string' }, config: { type: 'string' },
    repetitions: { type: 'string' }, seed: { type: 'string' }, output: { type: 'string' } } }))
} catch { console.error(usage); process.exit(2) }
const live = !!values.live, repetitions = Number(values.repetitions ?? 1), seed = Number(values.seed ?? 0)
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
  || live && (!['jev', 'laya'].includes(values.provider) || !values.config)
  || !live && (values.provider || values.config) || values.output === '') {
  console.error(usage)
  process.exit(2)
}

const fixtureText = await readFile(new URL('../tests/fixtures/model-routing-evaluation.json', import.meta.url), 'utf8')
const examples = JSON.parse(fixtureText)
if (!Array.isArray(examples) || examples.length !== 8 || new Set(examples.map(x => x.id)).size !== 8
  || examples.some(x => !ROUTE_LABELS.includes(x.expected) || !['routine', 'high', 'unknown'].includes(x.consequence)
    || !x.id || !x.rationale || !x.ja || !x.en)) throw new Error('Invalid model-routing evaluation fixtures')
let configuration
if (live) {
  let raw
  try { raw = JSON.parse(await readFile(values.config, 'utf8')); configuration = TypedDecisionsConfig.parse(raw) }
  catch { console.error('Invalid decision configuration.'); process.exit(2) }
  if (configuration.mode !== 'auto' || configuration.provider !== (values.provider === 'jev' ? 'typesafe' : 'laya-coreml')
    || values.provider === 'jev' && (!raw.typesafe?.model || !/^jev-\d+\.\d+\.\d+$/.test(raw.typesafe.model))) {
    console.error('Configuration must use the selected provider and a fixed Jev model version.')
    process.exit(2)
  }
} else configuration = TypedDecisionsConfig.parse({ provider: 'typesafe', typesafe: { model: 'jev-fixture' } })

const fixtureDigest = createHash('sha256').update(fixtureText).digest('hex')
const batchContractDigest = createHash('sha256').update(JSON.stringify(buildModelRoutingBatch({
  task: '<task>', taskType: '<taskType>', attachmentTypes: [], routes: DEFAULT_MODEL_AUTO_ROUTES,
}))).digest('hex')
const report = { version: 1, policy: MODEL_AUTO_POLICY, mode: live ? 'live-synthetic' : 'offline-contract',
  provider: live ? values.provider : 'jev-fixture', fixtureDigest, batchContractDigest,
  repetitions, seed, settings: { model: configuration[configuration.provider]?.model ?? null,
    acceptance: configuration[configuration.provider]?.acceptance ?? null },
  limitation: 'Fixed synthetic task-fit cases. Offline responses verify only the evaluation contract. Live results do not establish real-work quality, cost savings, or a universally best model.',
  cases: [], quality: null, contract: null, cost: null }

let activeExpected = 'retain'
let diagnostics = []
const fixtureRequest = async (_url, init) => {
  const request = JSON.parse(String(init.body))
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const choices = Object.keys(question.criteria)
    const choice = id === 'fruit' ? 'apple' : activeExpected
    const other = (1 - .97) / (choices.length - 1)
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(choices.map(key => [key, key === choice ? .97 : other])), confidence: .97 }]
  }))
  return Response.json({ model: 'jev-fixture', answers })
}

let readinessReason = null
if (live && values.provider === 'laya') {
  try { configuration = await discoverLayaConfiguration(configuration, process.cwd(), AbortSignal.timeout(configuration['laya-coreml']?.timeoutMs ?? 5000)) }
  catch (error) { readinessReason = typeof error?.code === 'string' ? error.code : 'worker_unavailable' }
}
const service = new DecisionService(configuration, config => config.provider === 'typesafe'
  ? new TypeSafeDecisionProvider(config.typesafe, async () => {
    if (!live) return 'offline-fixture'
    const key = process.env.TYPESAFE_API_KEY
    if (!key) throw new Error('missing_credential')
    return key
  }, live ? fetch : fixtureRequest, value => { diagnostics.push(value) })
  : config['laya-coreml']?.protocol === 'v1'
    ? new LayaV1DecisionProvider(config['laya-coreml'], undefined, value => { diagnostics.push(value) })
    : new LayaCoreMLDecisionProvider(config['laya-coreml'], undefined, value => { diagnostics.push(value) }))
if (!readinessReason) {
  try {
    const ready = await service.probe(AbortSignal.timeout(configuration[configuration.provider]?.timeoutMs ?? 5000))
    if (ready.state !== 'ready') readinessReason = ready.reason ?? ready.state
  } catch (error) { readinessReason = typeof error?.code === 'string' ? error.code : 'provider_unavailable' }
}

for (const { language, example, attempt } of schedule(examples, repetitions, seed)) {
  const row = { id: example.id, language, consequence: example.consequence, expected: example.expected,
    status: 'failed', elapsedMs: 0, inputCompleteness: 'unknown' }
  if (readinessReason) { row.reason = readinessReason; report.cases.push(row); continue }
  activeExpected = example.expected
  diagnostics = []
  const batch = buildModelRoutingBatch({ task: example[language], taskType: example.taskType, routes: DEFAULT_MODEL_AUTO_ROUTES })
  const requestId = `model-routing-evaluation:${language}:${example.id}:${attempt}`
  const started = performance.now()
  try {
    const signal = AbortSignal.timeout(configuration[configuration.provider]?.timeoutMs ?? 5000)
    const outcome = await service.evaluate(requestId, batch, signal, batchContractDigest)
    if (outcome.status === 'fallback') row.reason = outcome.reason
    else {
      const answer = outcome.result.answers[0]
      if (!answer || diagnostics.length !== 1 || diagnostics[0].questionId !== 'model-route') throw new Error('diagnostic_mismatch')
      row.status = 'completed'
      row.decision = answer.status === 'selected' ? 'selected' : 'abstained'
      row.actual = row.decision === 'selected' ? answer.choiceId : 'retain'
      row.reason = row.decision === 'abstained' ? answer.reason : undefined
      row.requestedModel = outcome.result.requestedModel
      row.returnedModel = outcome.result.returnedModel ?? null
      row.confidence = diagnostics[0].confidence
      row.topProbability = diagnostics[0].topProbability
      row.margin = diagnostics[0].margin
      row.inputTokens = outcome.result.usage?.input_tokens ?? null
      row.outputTokens = outcome.result.usage?.output_tokens ?? null
      row.inputCompleteness = routingInputCompleteness(!live || values.provider === 'jev' ? 'jev' : 'laya',
        configuration['laya-coreml']?.protocol === 'v1' ? 'v1' : 'strict', true)
    }
  } catch (error) { row.reason = error?.message === 'diagnostic_mismatch' ? 'diagnostic_mismatch'
    : typeof error?.code === 'string' && /^DECISION_[A-Z_]+$/.test(error.code) ? error.code : 'evaluation_unavailable' }
  finally { row.elapsedMs = Math.round(performance.now() - started) }
  report.cases.push(row)
}
report.contract = { attempted: report.cases.length, completed: report.cases.filter(row => row.status === 'completed').length,
  failed: report.cases.filter(row => row.status === 'failed').length }
if (live) report.quality = summarizeModelRouting(report.cases, values.provider)
const output = `${JSON.stringify(report, null, 2)}\n`
try { if (values.output) await writeFile(values.output, output) }
catch { console.error('Could not write evaluation output.'); process.exitCode = 1 }
process.stdout.write(output)
if (report.contract.failed) process.exitCode = 1
