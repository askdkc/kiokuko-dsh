import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { TypedDecisionsConfig } from '../dist/dsh/decisions/config.js'
import { DecisionService } from '../dist/dsh/decisions/service.js'
import { TypeSafeDecisionProvider } from '../dist/dsh/decisions/providers.js'
import { LayaV1DecisionProvider } from '../dist/dsh/decisions/laya-v1.js'
import { LayaCoreMLDecisionProvider, discoverLayaConfiguration } from '../dist/dsh/decisions/laya-coreml.js'
import { answerReviewInput } from '../dist/dsh/answer-review/evidence.js'
import { groundingPairs, groundingQuestion } from '../dist/dsh/answer-review/grounding.js'
import { schedule, summarize } from './answer-review-evaluation.mjs'

const { values } = parseArgs({ options: { live: { type: 'boolean' }, provider: { type: 'string' }, socket: { type: 'string' }, output: { type: 'string' }, config: { type: 'string' }, repetitions: { type: 'string' }, seed: { type: 'string' }, warmup: { type: 'string' }, dataset: { type: 'string' }, split: { type: 'string', default: 'tune' }, input: { type: 'string', default: 'full' }, question: { type: 'string', default: 'current' }, choices: { type: 'string', default: 'current' }, dimension: { type: 'string', default: 'all' } } })
const live = !!values.live, provider = values.provider ?? 'laya', repetitions = Number(values.repetitions ?? 1), seed = Number(values.seed ?? 0), warmup = Number(values.warmup ?? 0)
if (!['jev', 'laya'].includes(provider) || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 10 || !live && (values.provider || values.socket) || values.config && values.socket) {
  console.error('Use [--live --provider jev|laya] [--config PATH] [--repetitions 1..100] [--seed UINT32] [--warmup 0..10] [--output PATH].')
  process.exit(1)
}
// Each paired Japanese/English case has identical expected dimensions. No repository or session input.
let examples = [
  { id: 'correct', expected: ['satisfied','satisfied','satisfied'], en: ['Run tests and report the result.', 'Test run failed: 1 failed, 9 passed.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テストを実行し、結果を報告してください。','テストは失敗しました。1件失敗、9件成功です。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'wrong-request', expected: ['finding','not_applicable','not_applicable'], en: ['Summarize the test result.', 'Here is a recipe for apple pie.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テスト結果を要約してください。','アップルパイの作り方を説明します。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'false-success', expected: ['satisfied','finding','finding'], en: ['Run tests and report the result.', 'All 10 tests passed successfully.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テストを実行し、結果を報告してください。','10件すべてのテストが成功しました。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'missing-evidence', expected: ['satisfied','abstain','abstain'], en: ['Report whether the tests passed.', 'The tests passed.', null], ja: ['テストが成功したか報告してください。','テストは成功しました。',null] },
]
if (!['tune','final'].includes(values.split) || !['full','paired'].includes(values.input) || !['current','focused'].includes(values.question) || !['current','focused'].includes(values.choices) || !['all','grounding'].includes(values.dimension)) throw new Error('Invalid experiment variant')
if (values.dataset) {
  const dataset = JSON.parse(await readFile(values.dataset, 'utf8'))
  if (!Array.isArray(dataset) || !dataset.length) throw new Error('Dataset must be a nonempty array')
  const groups = new Map(), ids = new Set()
  for (const example of dataset) {
    if (typeof example.id !== 'string' || ids.has(example.id) || typeof example.groupId !== 'string' || !example.groupId || !['tune','final'].includes(example.split)
      || !Array.isArray(example.expected) || example.expected.length !== 3 || example.expected.some(x => !['satisfied','finding','not_applicable','abstain'].includes(x))
      || ['ja','en'].some(lang => !Array.isArray(example[lang]) || example[lang].length !== 3 || typeof example[lang][0] !== 'string' || typeof example[lang][1] !== 'string' || example[lang][2] !== null && typeof example[lang][2] !== 'string')) throw new Error('Invalid grouped evaluation example')
    if (groups.has(example.groupId) && groups.get(example.groupId) !== example.split) throw new Error('Related examples cross tune/final boundary')
    groups.set(example.groupId,example.split); ids.add(example.id)
  }
  examples = dataset.filter(example => example.split === values.split)
  if (!examples.length) throw new Error('Empty evaluation split')
} else if (values.split === 'final') throw new Error('Final evaluation requires a separate grouped dataset')
const supplied = values.config ? JSON.parse(await readFile(values.config, 'utf8')) : { provider: provider === 'jev' ? 'typesafe' : 'laya-coreml', ...(values.socket ? { 'laya-coreml': { socketPath: values.socket } } : {}) }
const parsed = TypedDecisionsConfig.parse(supplied)
if (parsed.mode !== 'auto' || parsed.provider !== (provider === 'jev' ? 'typesafe' : 'laya-coreml') || !live && parsed.provider !== 'laya-coreml') throw new Error('Evaluation provider and configuration disagree')
if (!live && (parsed['laya-coreml']?.model && parsed['laya-coreml'].model !== 'laya-rl-agent' || parsed['laya-coreml']?.runtimeFingerprint)) throw new Error('Offline evaluation requires Laya v1 without a runtime fingerprint')
const offlineLaya = { ...parsed['laya-coreml'], model: 'laya-rl-agent', protocol: 'v1' }
delete offlineLaya.runtimeFingerprint
const configuration = live ? parsed : TypedDecisionsConfig.parse({ ...parsed, 'laya-coreml': offlineLaya })
const fixtureDigest = createHash('sha256').update(JSON.stringify(examples)).digest('hex')
const artifactHash = createHash('sha256')
for (const path of ['../dist/dsh/answer-review/evidence.js', '../dist/dsh/decisions/service.js', '../dist/dsh/decisions/laya-coreml.js', '../dist/dsh/decisions/laya-v1.js', '../dist/dsh/decisions/providers.js', '../dist/dsh/answer-review/grounding.js', '../dist/dsh/decisions/config.js', './answer-review-evaluation.mjs', './evaluate-answer-review.mjs']) artifactHash.update(await readFile(new URL(path, import.meta.url)))
const artifactDigest = artifactHash.digest('hex')
const report = { version: 3, experiment: { split: values.split, input: values.input, question: values.question, choices: values.choices, dimension: values.dimension }, policy: 'answer-review-v1', timestamp: new Date().toISOString(), provider: live ? provider : 'laya-fixture', mode: live ? 'live-synthetic' : 'offline-contract', live, fixtureDigest, artifactDigest, settings: { model: configuration[configuration.provider]?.model ?? null, acceptance: configuration[configuration.provider]?.acceptance, timeoutMs: configuration[configuration.provider]?.timeoutMs, protocol: configuration['laya-coreml']?.protocol ?? null }, repetitions, seed, warmup, cases: [], summaries: {}, limitation: 'Fixed synthetic cases. Offline fixtures verify the pipeline, not model quality. Detection and false finding rates include failed attempts in class denominators; completed-only rates are separately named. Laya v1 input completeness and fingerprint are unverified.' }
function fixtureTransport(example) {
  return async (_socket, body) => {
    const request = JSON.parse(body)
    if (request.op === 'health') return { version: 1, ok: true, status: 'ready' }
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      let choice = example.id === 'missing-evidence' && id !== 'request_fit' ? 'finding' : example.expected[id.startsWith('grounding:') ? 1 : ['request_fit','grounding','verification'].indexOf(id)], keys = Object.keys(question.criteria), rest = .03/(keys.length-1)
      if (keys.includes('supported')) choice = example.expected[1] === 'finding' ? 'contradicted' : example.expected[1] === 'satisfied' ? 'supported' : 'unknown'
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? .97 : rest])), confidence: .97, action: { act_probability: .97 } }]
    }))
    return { version: 1, ok: true, result: { model: 'laya-rl-agent', answers, usage: { input_tokens: 1, output_tokens: 0 } }, server: { predict_ms: 1 } }
  }
}
async function evaluateCase({ language, example, attempt }, warm = false) {
    const [task,answer,evidence] = example[language]
    const events = [{ seq:0,type:'turn/start',data:{turn:1}},
      ...(evidence === null ? [] : [{seq:1,type:'tool/call',data:{turn:1,callId:'synthetic',name:'test'}}, {seq:2,type:'tool/result',data:{turn:1,message:{role:'tool',content:[{type:'tool-result',toolCallId:'synthetic',content:[{type:'text',text:evidence}]}]}}}]),
      {seq:3,type:'assistant/message',data:{turn:1,message:{role:'assistant',content:[{type:'text',text:answer}]}}}, {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
    const input = answerReviewInput(task,events,1,0), started = performance.now()
    let evaluationBatch = input.batch
    const focused = values.question === 'focused' || values.choices === 'focused' || values.dimension === 'grounding'
    if (evaluationBatch && values.input === 'paired') {
      const paired = groundingPairs(answer,events,1,0,3)
      evaluationBatch = paired.pairs.length === 1 && paired.skipped.length === 0 ? paired.pairs[0].batch : undefined
    }
    if (evaluationBatch && (focused || values.input === 'paired')) {
      const currentGrounding = input.batch?.questions.find(q => q.id === 'grounding')
      const base = values.input === 'paired' ? evaluationBatch.questions[0] : currentGrounding
      evaluationBatch = { ...evaluationBatch, questions: [{ ...base,
        instructions: values.question === 'focused' ? groundingQuestion.instructions : currentGrounding.instructions,
        choices: values.choices === 'focused' ? groundingQuestion.choices : currentGrounding.choices,
        abstainId: values.choices === 'focused' ? groundingQuestion.abstainId : currentGrounding.abstainId,
      }] }
    }
    const expected = values.input === 'paired' || focused ? [example.expected[1]] : example.expected
    if (!input.batch) return { id: example.id, language, attempt, groupId: example.groupId ?? example.id, expected, status: 'unavailable', reason: input.skipped, elapsedMs: performance.now()-started }
    const row = { id: example.id, language, attempt, groupId: example.groupId ?? example.id, expected, inputDigest: input.inputDigest, inputBytes: Buffer.byteLength(JSON.stringify(evaluationBatch ?? input.batch)), evaluatedInputDigest: evaluationBatch ? createHash('sha256').update(JSON.stringify(evaluationBatch)).digest('hex') : null, diagnostics: [], inputCompleteness: 'unknown' }
    if (!evaluationBatch) return { ...row, status: 'completed', observed: ['abstain'], raw: [{ status: 'abstained', reason: 'unassessed' }], reason: 'unlinked', elapsedMs: performance.now()-started }
    const selectedBatch = evaluationBatch
    const service = new DecisionService(configuration, config => config.provider === 'typesafe'
      ? new TypeSafeDecisionProvider(config.typesafe, async () => { if (!process.env.TYPESAFE_API_KEY) throw new Error('missing_credential'); return process.env.TYPESAFE_API_KEY }, fetch, value => row.diagnostics.push(value))
      : config['laya-coreml'].protocol === 'v1' ? new LayaV1DecisionProvider(config['laya-coreml'], live ? undefined : fixtureTransport(example), value => row.diagnostics.push(value))
        : new LayaCoreMLDecisionProvider(config['laya-coreml'], undefined, value => row.diagnostics.push(value)), undefined,
      { resolveConfiguration: live ? (config, signal) => discoverLayaConfiguration(config, process.cwd(), signal) : undefined })
    try {
      if (live && provider === 'jev' && !process.env.TYPESAFE_API_KEY) { row.status = 'unavailable'; row.reason = 'missing_credential'; return row }
      const signal = AbortSignal.timeout(configuration[configuration.provider]?.timeoutMs ?? 5000), request = `synthetic-answer-review:${language}:${example.id}:${attempt}:${warm ? 'warmup' : 'sample'}`
      const bound = await service.bind(request,signal)
      row.boundSettings = { model: bound[bound.provider]?.model ?? null, acceptance: bound[bound.provider]?.acceptance, timeoutMs: bound[bound.provider]?.timeoutMs, protocol: bound['laya-coreml']?.protocol ?? null, runtimeFingerprint: bound['laya-coreml']?.runtimeFingerprint ?? null }
      row.inputCompleteness = bound.provider === 'laya-coreml' ? bound['laya-coreml']?.protocol === 'v1' ? 'unverified_v1' : 'strict_preflight_pending' : 'host_complete'
      const result = await service.evaluate(request,selectedBatch,signal)
      row.status = result.status
      if (result.status === 'fallback') row.reason = result.reason
      else {
        row.raw = result.result.answers
        row.observed = result.result.answers.map(answer => input.unassessed.includes(answer.id) || answer.status === 'abstained' ? 'abstain' : answer.choiceId === 'supported' ? 'satisfied' : answer.choiceId === 'contradicted' ? 'finding' : answer.choiceId)
        row.model = result.result.returnedModel ?? result.result.requestedModel
        row.usage = result.result.usage ?? null
        if (row.inputCompleteness === 'strict_preflight_pending') row.inputCompleteness = 'strict_preflight'
        const ids = selectedBatch.questions.map(question => question.id)
        if (row.diagnostics.length !== ids.length || new Set(row.diagnostics.map(value => value.questionId)).size !== ids.length || row.diagnostics.some(value => !ids.includes(value.questionId))) throw new Error('Diagnostic observations do not match the completed decision')
      }
    } catch (error) { row.status = 'unavailable'; row.reason = typeof error?.code === 'string' && /^DECISION_[A-Z_]+$/.test(error.code) ? error.code : error?.message === 'Diagnostic observations do not match the completed decision' ? 'diagnostic_mismatch' : 'evaluation_unavailable' }
    finally { row.elapsedMs = Math.round(performance.now()-started) }
    return row
}
const warmupCases = []
for (let i=0;i<warmup;i++) for (const item of schedule(examples,1,seed+i)) warmupCases.push(await evaluateCase(item,true))
report.warmupSummary = { attempted: warmupCases.length, completed: warmupCases.filter(row => row.status === 'completed').length, totalElapsedMs: warmupCases.reduce((n,row) => n + row.elapsedMs,0), failures: warmupCases.filter(row => row.status !== 'completed').map(row => ({ id: row.id, language: row.language, reason: row.reason })) }
for (const item of schedule(examples,repetitions,seed)) report.cases.push(await evaluateCase(item))
for (const language of ['ja','en']) report.summaries[language] = summarize(report.cases.filter(row => row.language === language))
report.summaries.all = summarize(report.cases)
const json=JSON.stringify(report,null,2)+'\n'
if(values.output)await writeFile(values.output,json)
process.stdout.write(json)
if(report.cases.some(row=>row.status!=='completed') || warmupCases.some(row => row.status !== 'completed'))process.exitCode=1
