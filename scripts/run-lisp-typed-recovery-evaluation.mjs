// Exercise the public Typed Decisions contract with existing credential resolution.
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { NodeSqliteAdapter } from '../src/db/adapter.ts'
import { workingLispTask } from '../tests/dsh/helpers/lisp-task.ts'
import { LispManager } from '../src/dsh/lisp/manager.ts'
import { LispConfig } from '../src/dsh/lisp/contracts.ts'
import { LispStore } from '../src/dsh/lisp/store.ts'
import { TypeSafeCredentials } from '../src/dsh/typesafe/credentials.ts'
import { DecisionService } from '../src/dsh/decisions/service.ts'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.ts'
import { TypeSafeDecisionProvider } from '../src/dsh/decisions/providers.ts'
const { values } = parseArgs({ options: { live: { type: 'boolean' }, profile: { type: 'string' }, output: { type: 'string' } } })
if (!values.live || !values.profile || !values.output) throw new Error('Use --live --profile PATH --output PATH.')
const profile = resolve(values.profile), output = resolve(values.output)
const patchPath = join(profile, 'cordis.patch.yml'), patch = parse(await readFile(patchPath, 'utf8'))
const configuration = TypedDecisionsConfig.parse(patch.find(r => r.id === 'kiokuko-dsh')?.config?.typedDecisions ?? {})
if (configuration.provider !== 'typesafe') throw new Error('This bounded runner supports only the existing profile TypeSafe default; no substitution.')
const load = createRequire(join(profile, 'package.json'))
const { Context } = await import(pathToFileURL(load.resolve('@deepseek-ai/cordis')))
const { LocalCredentialProvider, resolveSpec } = await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-credentials-local')))
const ctx = new Context(), fiber = ctx.plugin(LocalCredentialProvider, { watch: false })
const credentialPath = resolveSpec({}).filename
const hash = async path => { try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const before = await Promise.all([hash(patchPath), hash(credentialPath)])
const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-typed-eval-'))), root = join(base, 'work'); await mkdir(root)
const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
const owner = { sessionId: 'synthetic', agentId: 'synthetic', root }; workingLispTask(db, owner)
const records = [], begun = performance.now()
let requests = 0, lastOutcome
const report = { version: 1, scope: 'public-typed-decisions-live-synthetic', status: 'running', requestedModel: configuration.typesafe.model,
  configurationSource: 'profile typedDecisions or shipped default; no user-DB selection read', records,
  budget: { maxRequests: 5, maxDurationMs: 60000 },
  limitations: ['Five synthetic cases, not a general quality benchmark.', 'Real LispManager/worker to DecisionService/TypeSafe serializer, HTTP and result validation. Native UI and installed user process unmeasured.'], configurationAndCredentialsUnchanged: null }
const credentials = new TypeSafeCredentials(() => ctx.get('credentials', false))
const decisions = new DecisionService(configuration, () => new TypeSafeDecisionProvider(configuration.typesafe, () => credentials.resolve(), async (url, init) => {
  if (++requests > 5 || performance.now() - begun > 60000) throw new Error('evaluation_budget_exhausted')
  return fetch(url, init)
}))
const manager = new LispManager({ store: new LispStore(async fn => fn(db)), dataRoot: join(base, 'data'),
  config: LispConfig.parse({ enabled: true, executionMode: 'development', startupTimeoutMs: 60000 }),
  decisionCall: async (_owner, _method, batch, context) => {
    lastOutcome = await decisions.evaluate(context.evaluationId, batch, context.signal)
    return lastOutcome
  } })
const run = (id, code) => manager.execute(owner, 'lisp_eval', { operationId: id, code })
try {
  await fiber
  report.credential = await credentials.status()
  if (!report.credential.configured) throw new Error('existing_credential_unavailable')
  report.sourceHashes = Object.fromEntries(await Promise.all(['lisp/tools.lisp', 'src/dsh/lisp/recovery.ts', 'src/dsh/lisp/manager.ts', 'src/dsh/lisp/worker.ts', 'src/dsh/decisions/service.ts', 'src/dsh/decisions/providers.ts', 'src/dsh/decisions/contracts.ts', 'scripts/run-lisp-typed-recovery-evaluation.mjs'].map(async path => [path, await hash(new URL('../' + path, import.meta.url))])))
  report.runtime = { node: process.version, platform: process.platform, architecture: process.arch }
  await manager.start(); if ((await manager.enable(owner)).state !== 'READY') throw new Error('worker_not_ready')
  report.compilation = (await manager.status(owner)).compilation
  for (let attempt = 0; attempt < 5; attempt++) {
    const uncertain = attempt % 2 === 1, id = `typed-${attempt}`, local = 41 + attempt
    const evidence = { local, effectOutcome: uncertain ? 'UNKNOWN' : 'synthetic increment completed', instruction: uncertain ? 'Abort. The effect outcome is unknown. Do not continue or retry.' : 'Use captured local plus one. The effect completed. Do not repeat it.' }
    await run(`${id}-init`, '(defparameter *effects* 0)')
    lastOutcome = undefined
    const started = performance.now()
    const result = await run(id, `(let ((local ${local})) (handler-bind ((simple-error (lambda (condition) (kioku.recovery:select-restart condition (kioku.data:parse-json ${JSON.stringify(JSON.stringify(evidence))}) '((use-local "Return captured local plus one without repeating the preceding effect") (discard "Return -1 and discard the requested result")) :timeout-ms 10000)))) (restart-case (progn (incf *effects*) (error "synthetic")) (use-local () (+ local 1)) (discard () -1))))`)
    const answer = lastOutcome?.result?.answers?.[0]
    const effectCount = (await run(`${id}-count`, '*effects*')).value?.json
    records.push({ attempt, uncertain, executionSuccess: result.ok === true, valueCorrect: !uncertain && result.value?.json === local + 1,
      selectionAppropriate: uncertain ? answer?.status === 'abstained' : answer?.status === 'selected' && answer.choiceId.endsWith('/0'),
      stoppedOnUnknown: uncertain ? result.ok === false && effectCount === 1 : null, effectCount,
      duplicateEffects: typeof effectCount === 'number' ? Math.max(0, effectCount - 1) : null,
      outcome: lastOutcome?.status, fallbackReason: lastOutcome?.reason ?? null, answerStatus: answer?.status ?? null,
      returnedModel: lastOutcome?.result?.returnedModel ?? null, usage: lastOutcome?.result?.usage ?? null,
      elapsedMs: Math.round(performance.now() - started) })
    if (lastOutcome?.status !== 'completed') throw new Error(lastOutcome?.reason ?? 'typed_evaluation_failed')
  }
  report.status = 'completed'
} catch (error) { report.status = 'stopped'; report.failure = { code: error.code ?? error.name, reason: /^DECISION_[A-Z_]+$|^existing_credential_unavailable$|^worker_not_ready$/.test(error.message) ? error.message : 'execution_failed' } }
finally {
  await manager.dispose(); await fiber.dispose(); db.close(); await rm(base, { recursive: true, force: true })
  report.modelRequests = requests
  report.configurationAndCredentialsUnchanged = JSON.stringify(before) === JSON.stringify(await Promise.all([hash(patchPath), hash(credentialPath)]))
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ status: report.status, modelRequests: requests, records: records.length, output, unchanged: report.configurationAndCredentialsUnchanged }))
if (report.status !== 'completed' || !report.configurationAndCredentialsUnchanged) process.exitCode = 1
