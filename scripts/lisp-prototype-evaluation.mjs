import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile, readdir, readlink, lstat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DshSkillPrompts } from '../src/dsh/skill-prompts.ts'
import { loadSkillSources } from '../src/dsh/skill-sources.ts'
import { compileSkillBundle } from '../src/dsh/skill-compiler.ts'
import { nativeSkillFixture } from '../tests/dsh/helpers/skill-native.ts'
import { withIsolatedSkillHome } from '../tests/dsh/helpers/skill-home.ts'
import { createEvaluationBudget, parseEvaluationConfig } from './skill-evaluation-config.mjs'
import { scenarios, nodeProbe, missingProbe } from './lisp-prototype-scenarios.mjs'
import { digest, requestText, readEvidence, assessEvidence } from './lisp-prototype-evidence.mjs'
import { evaluationFetch } from './lisp-prototype-transport.mjs'

const variants = ['before-full', 'after-full', 'after-compiled']
const root = resolve(import.meta.dirname, '..')

async function workspaceDigest(root) {
  const files = []
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), relative = `${prefix}${name}`, info = await lstat(path)
      if (files.length > 1000 || info.size > 64 * 1024 * 1024) throw new Error('evaluation_workspace_limit')
      if (info.isSymbolicLink()) files.push([relative, 'link', await readlink(path)])
      else if (info.isDirectory()) { files.push([relative, 'directory']); await visit(path, `${relative}/`) }
      else files.push([relative, 'file', digest(await readFile(path))])
    }
  }
  await visit(root)
  return digest(JSON.stringify(files))
}

function offlineScript(f, scenario, seed, evidenceStart) {
  f.responses.push(f.mock.toolCallResponse(`${scenario.id}-describe`, 'lisp_describe', { operationId: `${scenario.id}-describe` }))
  for (const [i, source] of scenario.probes.entries()) f.responses.push(f.mock.toolCallResponse(`${scenario.id}-probe-${i}`, 'lisp_eval', { operationId: `${scenario.id}-probe-${i}`, code: nodeProbe(source, scenario.workspaceInput), ...(scenario.workspaceInput ? { inputs: ['target.mjs'] } : {}) }))
  if (scenario.missingProgram) f.responses.push(f.mock.toolCallResponse(`${scenario.id}-missing`, 'lisp_eval', { operationId: `${scenario.id}-missing`, code: missingProbe }))
  f.responses.push(() => {
    const evidence = readEvidence(f.agent.session.snapshotEvents().slice(evidenceStart))
    const observations = evidence.results.filter(r => r.value?.operationId).map(r => `[evidence:${r.value.operationId}] ${r.text}`)
    if (seed) observations.push(`[evidence:${seed.value.operationId}] ${JSON.stringify(seed.value)}`)
    return f.mock.textResponse(`Plan for ${scenario.title}: retain the observed boundary and use focused checks before any integrated change. This is scratch evidence only.\n${observations.join('\n')}\n${scenario.id === 'B07' ? 'The target runtime is unavailable; no installation or retry was authorized.' : scenario.id === 'B08' ? 'Please decide whether compatibility requires empty input to remain zero or permits rejection.' : 'Use the measured alternative where the observations discriminate; otherwise preserve the current behavior. Timings describe only these samples.'}`)
  })
}

/** Host setup and measured work share one admitted native turn; setup never dispatches a provider request. */
export function withNativeEvaluationSetup(stream, responses, ready) {
  let index = 0, prepared
  return async function* (request) {
    if (index < responses.length) {
      for (const chunk of responses[index++]) { request.signal?.throwIfAborted(); yield chunk }
      return
    }
    prepared ??= Promise.resolve().then(ready)
    await prepared
    request.signal?.throwIfAborted()
    yield* stream(request)
  }
}

async function liveAdapter(f, packages, config, guide, wrap) {
  const provider = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href)
  const adapter = new provider.DeepSeekAdapter({
    options: () => provider.resolveAdapterOptions({ baseURL: config.baseURL, apiKeyEnv: config.apiKeyEnv, maxTokens: config.maxOutputTokens,
      defaultContextWindow: config.contextWindow, models: [{ id: config.model, contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens }],
      thinking: 'disabled', reasoningEffort: 'off', retryPolicy: { mode: 'normal', maxRetries: 0 } }),
    resolveApiKey: async () => process.env[config.apiKeyEnv],
    resolveAuth: async () => ({ headers: { Authorization: `Bearer ${process.env[config.apiKeyEnv]}` } }),
    resolveUserId: () => 'isolated-skill-evaluation',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  const requestDigests = [], originalStream = adapter.stream.bind(adapter), prepareCall = adapter.prepareCall.bind(adapter)
  const dispatch = Symbol('evaluation native dispatch')
  const stream = wrap(options => {
    const { [dispatch]: send, ...request } = options
    requestDigests.push(digest(requestText(request)))
    return send({ ...request, temperature: config.temperature, maxTokens: config.maxOutputTokens })
  })
  const nativeStream = (options, send) => {
    assert.ok(requestText(options).includes(guide), 'the real native request must contain the selected guide')
    return stream({ ...options, [dispatch]: send })
  }
  adapter.stream = options => nativeStream(options, originalStream)
  // DSH freezes a generation via prepareCall; DeepSeek dispatches that frozen
  // call directly rather than through adapter.stream. Preserve that binding.
  adapter.prepareCall = async (...args) => {
    const call = await prepareCall(...args)
    return { ...call, stream: options => nativeStream(options, call.stream) }
  }
  const off = f.ctx.llm.registerAdapter(['deepseek-official'], adapter)
  f.agent.options.provider = 'deepseek-official'; f.agent.options.model = config.model
  return { off, requestDigests }
}

async function runCase({ scenario, variant, sources, artifact, packages, config, signal }) {
  const mode = variant === 'after-compiled' ? 'compiled' : 'full'
  const prompts = new DshSkillPrompts({ mode }, pathToFileURL(artifact), async () => sources)
  const guide = await prompts.require('kiokuko-lisp')
  assert.ok(prompts.diagnostics().every(d => !d.fallback), 'compiled fallback is not comparison evidence')
  const row = { id: scenario.id, variant, status: 'failed', modelQuality: null, sourceDigests: sources.filter(s => ['kiokuko-lisp', 'one-shot-software-completion'].includes(s.name)).map(s => ({ id: `${s.name}/${s.relativePath}`, digest: digest(s.content) })), seed: null }
  let f, detach, timeout, abort, timedOut = false, requests = [], evidenceStart = 0, start = Date.now()
  try {
    f = await nativeSkillFixture({ packages, explicit: true, mode, prompts, extra: { lisp: { enabled: true, startupTimeoutMs: 60000, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl' } },
      nativeAnswer: async request => {
        const q = request.questions[0]
        if (q.id === 'taskType') return { answers: [{ id: q.id, selected: ['research'] }] }
        // Synthetic questions/approvals remain observable; no workspace mutation is authorized.
        row.hostQuestions ??= []; row.hostQuestions.push({ id: q.id, question: q.question ?? q.header ?? '', declined: true })
        return { answers: [] }
      } })
    await writeFile(join(f.dir, 'target.mjs'), 'export const value = 1;\n')
    row.stage = 'enable'
    const enabled = await f.ctx.commands.execute(f.agent, '/kioku-lisp enable', [], signal)
    if (enabled.result.kind !== 'success') row.startup = enabled.result
    assert.equal(enabled.result.kind, 'success', 'protected Lisp must start; missing runtime is not a skip')
    // Replace formerly direct idle dispatch with observable scripted native
    // setup in the original scenario's turn. No second-turn ownership race.
    const setupResponses = [f.mock.toolCallResponse('prepare-evaluation', 'prepare_requested_work', { taskType: 'research' }),
      f.mock.toolCallResponse('runtime-info', 'lisp_eval', { operationId: 'runtime-info', code: '(list (lisp-implementation-type) (lisp-implementation-version))' })]
    if (scenario.seed) setupResponses.push(f.mock.toolCallResponse(`${scenario.id}-seed`, 'lisp_eval', { operationId: `${scenario.id}-seed`, code: nodeProbe(scenario.seed) }))
    const wrap = stream => withNativeEvaluationSetup(stream, setupResponses, async () => {
      signal.throwIfAborted()
      const setup = readEvidence(f.agent.session.snapshotEvents())
      assert.equal(setup.results.find(result => result.callId === 'prepare-evaluation')?.value?.prepared, true)
      row.runtime = setup.results.find(result => result.callId === 'runtime-info')
      assert.equal(row.runtime?.isError, false)
      assert.equal(row.runtime.value?.ok, true, 'runtime metadata must really execute in protected Lisp')
      if (scenario.seed) {
        row.seed = setup.results.find(result => result.callId === `${scenario.id}-seed`)
        assert.equal(row.seed?.isError, false)
        assert.equal(row.seed.value?.ok, true, 'host seed must really execute in protected Lisp')
      }
      row.setupRequests = setupResponses.length
      evidenceStart = f.agent.session.snapshotEvents().length
      row.beforeDigest = await workspaceDigest(f.dir)
      row.stage = 'model'
      if (!config) offlineScript(f, scenario, row.seed, evidenceStart)
    })
    if (config) {
      const connected = await liveAdapter(f, packages, config, guide, wrap); detach = connected.off; requests = connected.requestDigests
    } else {
      const stream = wrap(f.model.stream.bind(f.model))
      f.model.stream = options => { assert.ok(requestText(options).includes(guide)); return stream(options) }
    }
    abort = () => f.agent.cancel({ kind: 'hook', reason: 'evaluation_budget_exhausted' })
    signal.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => { timedOut = true; abort() }, Math.min(config?.maxDurationMs ?? 90000, 90000))
    const shape = scenario.expected ? `Audit stdout keys: ${Object.keys(scenario.expected).join(', ')}. Use actual runtime values, not constants.` : scenario.id === 'B03' ? 'Audit stdout: JSON {warmup: count, samples: [{arrayMs, setMs, equal}]}, with nonnegative durations.' : ''
    const prompt = `${scenario.prompt}\nThis is plan-only. Use the enabled protected Lisp path and its declared read-only inputs/private scratch. Do not stage, propose or apply changes. ${shape}\nReturn one plan, alternatives, observed limits and proving checks. Cite actual operation/result IDs as [evidence:ID].${scenario.seed ? `\nThe host will supply a fresh protected seed result in this turn (runtime ${process.version}); use that exact evidence without rerunning it.` : ''}`
    row.promptDigest = digest(prompt)
    await f.turn(prompt)
    signal.throwIfAborted()
    if (timedOut) throw new Error('evaluation_case_timeout')
    row.afterDigest = await workspaceDigest(f.dir)
    row.evidence = readEvidence(f.agent.session.snapshotEvents().slice(evidenceStart))
    row.assessment = assessEvidence(scenario, row.evidence, row.beforeDigest, row.afterDigest, row.seed)
    row.requestDigests = config ? requests : f.model.requests.map(r => digest(requestText(r)))
    row.scriptedRequests = config ? 0 : f.model.requests.length
    row.status = row.assessment.passed ? 'completed' : 'failed'
  } catch (error) {
    // Do not persist provider error text, credentials, or arbitrary diagnostic payloads.
    row.failure = signal.aborted ? 'budget_exhausted' : timedOut ? 'case_timeout' : 'runtime_or_evidence_failure'
    if (!config) row.diagnostic = String(error.stack ?? error)
    if (f) row.evidence = readEvidence(f.agent.session.snapshotEvents().slice(evidenceStart))
  } finally {
    clearTimeout(timeout)
    if (abort) signal.removeEventListener('abort', abort)
    detach?.()
    try { await f?.close() } catch { row.status = 'failed'; row.failure = 'cleanup_failure' }
    row.elapsedMs = Date.now() - start
  }
  return row
}

/** Source-only evaluation. All workspaces, Skills and Lisp state are disposable. */
export async function runPrototypeEvaluation({ config, output, packages = join(root, 'tests/fixtures/dsh-runtime/node_modules'), request = fetch }) {
  if (config) config = parseEvaluationConfig(config)
  await access(join(packages, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
  if (config && !process.env[config.apiKeyEnv]) throw new Error('evaluation_credential_unavailable')
  const source = await loadSkillSources(), baselineText = await readFile(join(root, 'tests/fixtures/lisp-prototype-planning/before.json'), 'utf8'), baseline = JSON.parse(baselineText)
  for (const item of baseline.resources) assert.equal(digest(item.content), item.sha256, 'frozen baseline identity')
  await mkdir(output, { recursive: true })
  const reportPath = join(output, 'report.json')
  await writeFile(reportPath, '{"status":"running"}\n', { flag: 'wx' })
  const work = await mkdtemp(join(tmpdir(), 'lisp-planning-evaluation-'))
  const before = source.map(s => { const item = baseline.resources.find(r => r.path === `skills/${s.name}/${s.relativePath}`); return item ? { ...s, content: item.content } : s })
  const budgetConfig = config ?? { maxRequests: 500, maxTokens: 10000000, contextWindow: 4096, maxOutputTokens: 1024, maxDurationMs: 600000 }
  const budget = createEvaluationBudget(budgetConfig), controller = new AbortController(), timer = setTimeout(() => controller.abort(), budgetConfig.maxDurationMs)
  const wire = [], originalFetch = globalThis.fetch
  const report = { format: 'kiokuko.lisp-prototype-planning.v1', mode: config ? 'live' : 'offline', status: 'running', model: config?.model ?? null, revision: config?.revision ?? null,
    baselineDigest: digest(baselineText), fixtureDigest: digest(JSON.stringify(scenarios)), environment: { node: process.version, platform: process.platform, arch: process.arch },
    plannedTasks: scenarios.length * variants.length, modelQuality: 'unmeasured', records: [], wire }
  try {
    globalThis.fetch = config ? evaluationFetch(config, budget, controller.signal, wire, request) : async () => { throw new Error('offline_network_forbidden') }
    const artifact = join(work, 'skill-prompts.json')
    await writeFile(artifact, JSON.stringify(compileSkillBundle(source)))
    await withIsolatedSkillHome(async () => {
      outer: for (const [index, scenario] of scenarios.entries()) for (let offset = 0; offset < variants.length; offset++) {
        if (controller.signal.aborted) break outer
        const variant = variants[(index + offset) % variants.length]
        const row = await runCase({ scenario, variant, sources: variant === 'before-full' ? before : source, artifact, packages, config, signal: controller.signal })
        report.records.push(row)
        await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
        if (row.failure) break outer
      }
    })
    report.complete = report.records.length === report.plannedTasks
    const required = config ? report.records.filter(r => r.variant !== 'before-full') : report.records
    report.status = controller.signal.aborted || budget.snapshot().exhausted ? 'budget_exhausted' : !report.complete || required.some(r => r.status !== 'completed') ? 'failed' : config ? 'needs_review' : 'passed'
    report.modelQuality = config ? 'pending_manual_review' : 'unmeasured'
    report.reservations = budget.snapshot(); report.modelRequests = wire.length
    report.manualReview = config ? 'review.json' : null
    if (config) await writeFile(join(output, 'review.json'), JSON.stringify({
      instructions: 'Review actual tool code/results against each final plan. Check causal use of measurements, freshness/ownership of every cited reference, unjustified technical questions, honest limitations, and necessary intent questions (B08). Generated output matching an oracle alone is not proof. Record verdict/reason per row; no automated semantic pass is claimed.',
      cases: report.records.map(r => ({ id: r.id, variant: r.variant, verdict: null, reason: null })),
    }, null, 2) + '\n', { flag: 'wx' })
  } catch {
    report.status = controller.signal.aborted || budget.snapshot().exhausted ? 'budget_exhausted' : 'failed'
    report.failure = 'evaluation_setup_or_recording_failure'
  } finally {
    clearTimeout(timer); controller.abort(); globalThis.fetch = originalFetch
    await rm(work, { recursive: true, force: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
  return report
}
