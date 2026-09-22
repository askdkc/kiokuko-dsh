import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { TypedDecisionsConfig } from '../dist/dsh/decisions/config.js'
import { DecisionService } from '../dist/dsh/decisions/service.js'
import { TypeSafeDecisionProvider } from '../dist/dsh/decisions/providers.js'
import { LayaV1DecisionProvider } from '../dist/dsh/decisions/laya-v1.js'
import { LayaCoreMLDecisionProvider, discoverLayaConfiguration } from '../dist/dsh/decisions/laya-coreml.js'
import { answerReviewInput } from '../dist/dsh/answer-review/evidence.js'

const { values } = parseArgs({ options: { live: { type: 'boolean' }, provider: { type: 'string' }, socket: { type: 'string' }, output: { type: 'string' } } })
if (!values.live || !['jev', 'laya'].includes(values.provider)) {
  console.error('Use --live --provider jev|laya [--socket PATH] [--output PATH]. Only fixed synthetic input is sent.')
  process.exit(1)
}
// Each paired Japanese/English case has identical expected dimensions. No repository or session input.
const examples = [
  { id: 'correct', expected: ['satisfied','satisfied','satisfied'], en: ['Run tests and report the result.', 'Test run failed: 1 failed, 9 passed.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テストを実行し、結果を報告してください。','テストは失敗しました。1件失敗、9件成功です。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'wrong-request', expected: ['finding','not_applicable','not_applicable'], en: ['Summarize the test result.', 'Here is a recipe for apple pie.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テスト結果を要約してください。','アップルパイの作り方を説明します。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'false-success', expected: ['satisfied','finding','finding'], en: ['Run tests and report the result.', 'All 10 tests passed successfully.', 'exit=1; tests: 1 failed, 9 passed'], ja: ['テストを実行し、結果を報告してください。','10件すべてのテストが成功しました。','終了コード1。テストは1件失敗、9件成功。'] },
  { id: 'missing-evidence', expected: ['satisfied','abstain','abstain'], en: ['Report whether the tests passed.', 'The tests passed.', null], ja: ['テストが成功したか報告してください。','テストは成功しました。',null] },
]
const configuration = TypedDecisionsConfig.parse({ provider: values.provider === 'jev' ? 'typesafe' : 'laya-coreml', ...(values.socket ? { 'laya-coreml': { socketPath: values.socket } } : {}) })
const service = new DecisionService(configuration, config => config.provider === 'typesafe'
  ? new TypeSafeDecisionProvider(config.typesafe, async () => { if (!process.env.TYPESAFE_API_KEY) throw new Error('missing_credential'); return process.env.TYPESAFE_API_KEY })
  : config['laya-coreml'].protocol === 'v1' ? new LayaV1DecisionProvider(config['laya-coreml']) : new LayaCoreMLDecisionProvider(config['laya-coreml']), undefined,
  { resolveConfiguration: (config, signal) => discoverLayaConfiguration(config, process.cwd(), signal) })
const report = { version: 1, policy: 'answer-review-v1', timestamp: new Date().toISOString(), provider: values.provider, live: true, cases: [], summaries: {}, limitation: 'Eight fixed synthetic cases. No general accuracy claim. v1 worker input completeness is unverified. Failed evaluations are excluded from rates, with coverage reported.' }
for (const language of ['ja','en']) {
  for (const example of examples) {
    const [task,answer,evidence] = example[language]
    const events = [{ seq:0,type:'turn/start',data:{turn:1}},
      ...(evidence === null ? [] : [{seq:1,type:'tool/call',data:{turn:1,callId:'synthetic',name:'test'}}, {seq:2,type:'tool/result',data:{turn:1,message:{role:'tool',content:[{type:'tool-result',toolCallId:'synthetic',content:[{type:'text',text:evidence}]}]}}}]),
      {seq:3,type:'assistant/message',data:{turn:1,message:{role:'assistant',content:[{type:'text',text:answer}]}}}, {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
    const input = answerReviewInput(task,events,1,0), started = performance.now()
    const row = { id: example.id, language, expected: example.expected, inputDigest: input.inputDigest }
    try {
      if (values.provider === 'jev' && !process.env.TYPESAFE_API_KEY) { row.status = 'unavailable'; row.reason = 'missing_credential'; continue }
      const signal = AbortSignal.timeout(5000), request = `synthetic-answer-review:${language}:${example.id}`
      const bound = await service.bind(request,signal)
      row.inputCompleteness = bound.provider === 'laya-coreml' ? bound['laya-coreml']?.protocol === 'v1' ? 'unverified_v1' : 'strict_preflight' : 'host_complete'
      const result = await service.evaluate(request,input.batch,signal)
      row.status = result.status
      if (result.status === 'fallback') row.reason = result.reason
      else {
        row.raw = result.result.answers
        row.observed = result.result.answers.map(answer => input.unassessed.includes(answer.id) || answer.status === 'abstained' ? 'abstain' : answer.choiceId)
        row.model = result.result.returnedModel ?? result.result.requestedModel
      }
    } catch (error) { row.status = 'unavailable'; row.reason = typeof error?.code === 'string' && /^DECISION_[A-Z_]+$/.test(error.code) ? error.code : 'evaluation_unavailable' }
    finally { row.elapsedMs = Math.round(performance.now()-started); report.cases.push(row) }
  }
  const cases = report.cases.filter(row=>row.language===language), completed = cases.filter(row=>row.status==='completed')
  const pairs = completed.flatMap(row=>row.observed.map((actual,index)=>({actual,expected:row.expected[index]})))
  const positives=pairs.filter(p=>p.expected==='finding'), negatives=pairs.filter(p=>p.expected!=='finding')
  report.summaries[language] = { attempted:cases.length, completed:completed.length,
    falseFindingRate: negatives.length ? negatives.filter(p=>p.actual==='finding').length/negatives.length : null, negativeDimensions:negatives.length,
    detectionRate: positives.length ? positives.filter(p=>p.actual==='finding').length/positives.length : null, positiveDimensions:positives.length,
    abstentionRate: pairs.length ? pairs.filter(p=>p.actual==='abstain').length/pairs.length : null, assessedDimensions:pairs.length,
    meanCompletedMs: completed.length ? completed.reduce((n,row)=>n+row.elapsedMs,0)/completed.length : null,
    totalElapsedMs: cases.reduce((n,row)=>n+row.elapsedMs,0) }
}
const json=JSON.stringify(report,null,2)+'\n'
if(values.output)await writeFile(values.output,json)
process.stdout.write(json)
if(report.cases.some(row=>row.status!=='completed'))process.exitCode=1
