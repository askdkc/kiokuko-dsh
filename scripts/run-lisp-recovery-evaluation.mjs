// Explicitly opt-in, bounded synthetic evaluation using the saved model route.
import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KiokukoModelsService } from '../src/dsh/models/service.ts'
import { ModelsConfigStore } from '../src/dsh/models/config-store.ts'
import { CredentialFile, defaultCredentialsFile } from '../src/dsh/models/vendor/credentials.ts'
import { NodeSqliteAdapter } from '../src/db/adapter.ts'
import { workingLispTask } from '../tests/dsh/helpers/lisp-task.ts'
import { LispManager } from '../src/dsh/lisp/manager.ts'
import { LispConfig } from '../src/dsh/lisp/contracts.ts'
import { LispStore } from '../src/dsh/lisp/store.ts'

const { values } = parseArgs({ options: { live: { type: 'boolean' }, profile: { type: 'string' }, output: { type: 'string' } } })
if (!values.live || !values.profile || !values.output) throw new Error('Use --live --profile PATH --output PATH; no implicit network execution.')
const profile = resolve(values.profile), output = resolve(values.output)
const patch = parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
const binding = patch.find(row => row.id === 'agent-default-model')?.config
if (!binding?.provider || !binding?.model) throw new Error('Saved default model route required; no substitution.')
const configPath = join(profile, 'kiokuko-models.json'), credentialPath = defaultCredentialsFile()
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const before = await Promise.all([hash(configPath), hash(credentialPath)])
class ReadOnlyConfig extends ModelsConfigStore { async write() { throw new Error('evaluation_config_is_read_only') } }
class ReadOnlyCredentials extends CredentialFile {
  async modify() { throw new Error('evaluation_credentials_are_read_only') }
  async delete() { throw new Error('evaluation_credentials_are_read_only') }
}
let adapter, requests = 0
const started = performance.now(), records = []
const report = { version: 1, scope: 'live-synthetic', binding, modelRequests: 0, status: 'running', records,
  limitations: ['Five interleaved runs per arm; selected synthetic finite choices only. No general quality or superiority claim.',
    'Recovery uses a harness decisionCall backed by the saved ordinary model adapter, not the deployed typed-decision service or native UI.',
    'Prototype workflow is scripted: successful prototype:true evaluation and full saved-result inspection before model choice. Autonomous tool-use is unmeasured.',
    'Source worker only; installed/running user processes are not changed. Latency includes model/worker path and excludes first worker compilation.'],
  budget: { maxRequests: 20, maxOutputTokens: 256, maxDurationMs: 600000 }, configurationAndCredentialsUnchanged: null }
const llm = { registerAdapter(_ids, value) { adapter = value; const dispose = () => {}; dispose.replace = () => {}; return dispose },
  async resolveCallConfig(v) { await adapter.resolveModel(v.provider, v.model); return v }, async discoverModels() { throw new Error('evaluation_discovery_disabled') } }
const service = new KiokukoModelsService({ llm, config: new ReadOnlyConfig(configPath), credentials: new ReadOnlyCredentials(credentialPath) })
const ask = async (request, signal) => {
  if (++requests > 20 || performance.now() - started > 600000) throw new Error('evaluation_budget_exhausted')
  const scoped = AbortSignal.any([signal, AbortSignal.timeout(30000)])
  const prepared = await adapter.prepareCall(binding.provider, binding.model, scoped)
  let text = '', finish
  for await (const chunk of prepared.stream({ ...binding, signal: scoped, temperature: 0, maxTokens: 256,
    system: 'Synthetic finite-choice test. Return JSON only: {"choiceId":"EXACT_OFFERED_ID"}. Do not execute, request tools, replay an effect, or invent choices. Choose abstention when an effect outcome is unknown.',
    messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(request) }], source: { kind: 'user' } })] })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (text.length > 8192) throw new Error('evaluation_response_limit')
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind !== 'stop') throw new Error(`provider_${finish?.kind ?? 'missing_finish'}`)
  const result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, ''))
  if (typeof result.choiceId !== 'string') throw new Error('model_response_invalid')
  return result.choiceId
}
const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-recovery-eval-'))), root = join(base, 'work'); await mkdir(root)
const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
const owner = { sessionId: 'synthetic', agentId: 'synthetic', root }; workingLispTask(db, owner)
let currentSelection
const manager = new LispManager({ store: new LispStore(async fn => fn(db)), dataRoot: join(base, 'data'),
  config: LispConfig.parse({ enabled: true, executionMode: 'development', startupTimeoutMs: 60000 }),
  decisionCall: async (_owner, _method, batch, context) => {
    const question = batch.questions[0], choiceId = await ask(batch, context.signal)
    currentSelection = { choiceId, offered: question.choices.map(c => c.id), abstainId: question.abstainId }
    return { status: 'completed', result: { answers: [{ id: question.id, ...(choiceId === question.abstainId
      ? { status: 'abstained', reason: 'uncertain' } : { status: 'selected', choiceId }) }] } }
  } })
const run = (operationId, code, extra = {}) => manager.execute(owner, 'lisp_eval', { operationId, code, ...extra })
const save = async () => { report.modelRequests = requests; await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
try {
  report.sourceHashes = Object.fromEntries(await Promise.all(['lisp/tools.lisp', 'src/dsh/lisp/recovery.ts', 'src/dsh/lisp/manager.ts', 'src/dsh/lisp/worker.ts', 'scripts/run-lisp-recovery-evaluation.mjs'].map(async path => [path, await hash(new URL('../' + path, import.meta.url))])))
  report.runtime = { node: process.version, platform: process.platform, architecture: process.arch }
  await service.start(); await manager.start()
  if ((await manager.enable(owner)).state !== 'READY') throw new Error('worker_not_ready')
  report.compilation = (await manager.status(owner)).compilation
  for (let attempt = 0; attempt < 5; attempt++) {
    const uncertain = attempt % 2 === 1
    for (const arm of attempt % 2 ? ['live-restart', 'unwound-error'] : ['unwound-error', 'live-restart']) {
      const id = `recovery-${attempt}-${arm}`, local = 41 + attempt
      await run(`${id}-init`, '(defparameter *effects* 0)')
      const evidence = { local, effectOutcome: uncertain ? 'UNKNOWN' : 'synthetic counter increment completed', instruction: uncertain ? 'Effect outcome unknown. Abort; do not continue or retry.' : 'Use the captured local value plus one; skipping is incorrect. Never repeat the effect.' }
      const code = arm === 'live-restart'
        ? `(let ((local ${local})) (handler-bind ((simple-error (lambda (condition) (kioku.recovery:select-restart condition (kioku.data:parse-json ${JSON.stringify(JSON.stringify(evidence))}) '((use-local "Use the captured local value plus one") (discard "Skip the result and return -1")) :timeout-ms 30000)))) (restart-case (progn (incf *effects*) (error "synthetic")) (use-local () (+ local 1)) (discard () -1))))`
        : `(let ((local ${local})) (declare (ignore local)) (incf *effects*) (error "synthetic"))`
      currentSelection = undefined
      const begun = performance.now(), result = await run(id, code)
      if (arm === 'unwound-error') {
        const choices = [{ id: 'use-local', description: 'Use captured local value plus one' }, { id: 'discard', description: 'Skip result and return -1' }, { id: 'abort', description: 'Abort recovery' }]
        currentSelection = { choiceId: await ask({ state: evidence, choices, abstainId: 'abort' }, AbortSignal.timeout(30000)), offered: choices.map(c => c.id), abstainId: 'abort' }
      }
      const effectCount = (await run(`${id}-count`, '*effects*')).value?.json
      const choice = currentSelection?.choiceId, selectedIndex = currentSelection?.offered.indexOf(choice)
      records.push({ family: 'recovery', attempt, arm, uncertain, executionSuccess: result.ok === true,
        recoveredValueCorrect: result.ok === true && result.value?.json === local + 1,
        selectionAppropriate: uncertain ? choice === currentSelection?.abstainId : selectedIndex === 0,
        stoppedOnUnknown: uncertain ? result.ok === false && effectCount === 1 : null,
        effectCount, duplicateEffects: typeof effectCount === 'number' ? Math.max(0, effectCount - 1) : null,
        selection: choice === currentSelection?.abstainId ? 'abstain' : selectedIndex, state: result.state ?? (result.ok ? 'SUCCEEDED' : 'FAILED'), elapsedMs: Math.round(performance.now() - begun) })
      await save()
    }
    for (const arm of attempt % 2 ? ['prototype-inspected', 'direct'] : ['direct', 'prototype-inspected']) {
      const id = `prototype-${attempt}-${arm}`, lower = attempt + 2, upper = attempt + 5
      const source = [
        `(lambda (x) (and (<= ${lower} x) (< x ${upper})))`,
        `(lambda (x) (and (< ${lower} x) (<= x ${upper})))`,
        `(lambda (x) (and (<= ${lower} x) (<= x ${upper})))`,
      ]
      const expected = attempt % 2, requirement = expected === 0 ? 'Include the lower boundary and exclude the upper boundary.' : 'Exclude the lower boundary and include the upper boundary.'
      const begun = performance.now(); let observation, inspected = false, probeSucceeded = null
      if (arm === 'prototype-inspected') {
        const probe = await run(id, `(vector ${source.map(f => `(map 'vector ${f} (vector ${lower} ${upper}))`).join(' ')})`, { prototype: true })
        probeSucceeded = probe.ok === true
        const page = await manager.execute(owner, 'lisp_inspect', { operationId: `${id}-inspect`, resultOperationId: id, section: 'result', offset: 0, limit: 2000 })
        inspected = probeSucceeded && page.offset === 0 && page.nextOffset === null
        if (!inspected) throw new Error('prototype_inspection_failed')
        observation = page.data
      }
      const choice = await ask({ requirement, candidates: source.map((expression, i) => ({ id: String(i), expression })), ...(observation ? { inspectedPrototypeResult: observation } : {}) }, AbortSignal.timeout(30000))
      const chosen = Number(choice), execution = ['0', '1', '2'].includes(choice) && source[chosen]
        ? await run(`${id}-chosen`, `(map 'vector ${source[chosen]} (vector ${lower} ${upper}))`) : undefined
      records.push({ family: 'prototype', attempt, arm, expected, selected: choice, choiceCorrect: choice === String(expected),
        executionSuccess: execution?.ok === true, probeSucceeded, inspected, workflowSatisfied: arm === 'direct' ? null : inspected,
        elapsedMs: Math.round(performance.now() - begun) })
      await save()
    }
  }
  report.status = 'completed'
} catch (error) { report.status = 'stopped'; report.failure = { code: error.code ?? error.name, reason: /^provider_[a-z_]+$|^evaluation_[a-z_]+$|^model_response_invalid$|^worker_not_ready$/.test(error.message) ? error.message : 'execution_failed' } }
finally {
  await manager.dispose(); await service.close(); db.close(); await rm(base, { recursive: true, force: true })
  report.configurationAndCredentialsUnchanged = JSON.stringify(before) === JSON.stringify(await Promise.all([hash(configPath), hash(credentialPath)]))
  await save()
}
console.log(JSON.stringify({ status: report.status, modelRequests: requests, records: records.length, output, configurationAndCredentialsUnchanged: report.configurationAndCredentialsUnchanged }))
if (report.status !== 'completed' || !report.configurationAndCredentialsUnchanged) process.exitCode = 1
