import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ContinuityConfig, buildContinuationView, renderContinuationView } from '../src/context/continuity-view.ts'
import { adaptContinuity } from '../src/dsh/continuity-adapter.ts'
import { updateExecutionFrame, executionFrameText } from '../src/dsh/execution-frame.ts'
import { findSecret } from '../src/memory/secrets.ts'

const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const hash = text => createHash('sha256').update(text).digest('hex')
const fixtureUrl = new URL('../tests/fixtures/continuity/scenarios.json', import.meta.url)
const fixtureText = await readFile(fixtureUrl, 'utf8')
const manifest = JSON.parse(await readFile(new URL('../tests/fixtures/continuity/manifest.json', import.meta.url), 'utf8'))
assert.equal(hash(fixtureText), manifest.sha256, 'Continuity fixture digest changed; version the manifest')
const scenarios = JSON.parse(fixtureText).scenarios
const configPath = arg('--config')
if (!configPath) {
  process.stdout.write(JSON.stringify({ status: 'unmeasured', scope: 'context-recovery-probe', fixture: manifest,
    reason: 'No explicit model configuration. No network, model requests, user database or sessions accessed.',
    modelRequests: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }) + '\n')
} else {
  await evaluate(configPath)
}

/** Closed probe scoring; this does not claim agent task success or implement a new agent loop. */
async function evaluate(configPath) {
  const safeLabel = z.string().min(1).max(256).refine(value => findSecret(value) === undefined && /^[\w./:@+-]+$/u.test(value))
  const config = z.object({
    model: safeLabel, revision: safeLabel, baseUrl: z.string().url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(), temperature: z.number().min(0).max(2),
    contextWindow: z.number().int().min(4096).max(1048576), maxOutputTokens: z.number().int().min(16).max(4096),
    repetitions: z.number().int().min(1).max(20), seed: z.number().int().min(0).max(4294967295),
    maxRequests: z.number().int().min(1).max(1000), maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxDurationMs: z.number().int().min(100).max(3600000), allowRemote: z.boolean(), fixture: z.literal('continuity-v1'),
  }).strict().parse(JSON.parse(await readFile(configPath, 'utf8')))
  const url = new URL(config.baseUrl)
  assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Invalid endpoint')
  assert.ok(config.allowRemote || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Remote evaluation requires allowRemote:true')
  assert.equal(findSecret(url.href), undefined, 'Endpoint contains secret-like content')
  const output = path.resolve(arg('--output') ?? 'continuity-evaluation-results')
  await mkdir(output, { recursive: true })
  const reportPath = path.join(output, 'report.json')
  await writeFile(reportPath, JSON.stringify({ status: 'running', scope: 'context-recovery-probe', fixture: manifest }) + '\n', { flag: 'wx' })
  // Each trial receives a disposable workspace; no real user state is opened or reused.
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-continuity-evaluation-'))
  const records = [], start = performance.now()
  const reservation = config.contextWindow + config.maxOutputTokens
  let reservedTokens = 0, state = config.seed >>> 0, exhausted = false
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const signal = AbortSignal.timeout(config.maxDurationMs)
  try {
    trials: for (const scenario of scenarios) for (let repeat = 0; repeat < config.repetitions; repeat++) {
      const groups = random() < 0.5 ? ['A', 'B'] : ['B', 'A']
      for (const group of groups) {
        if (records.length >= config.maxRequests || reservedTokens + reservation > config.maxTokens || signal.aborted) { exhausted = true; break trials }
        reservedTokens += reservation
        const workspace = path.join(root, `${scenario.id}-${repeat}-${group}`)
        await mkdir(workspace)
        const frame = updateExecutionFrame(undefined, workspace, scenario.conditions ?? scenario.prompt)
        const evidence = scenario.evidence ? [{ id: 'fixture', callId: 'read', rootCallId: 'read', turn: 1, generation: 'fixture',
          operation: { kind: 'read', paths: [path.join(workspace, 'source.txt')], key: 'read', range: { offset: 1, limit: 2 } },
          acquiredRange: { firstLine: 1, lastLine: 2, totalLines: 40 }, digest: hash('fixture result'), ...scenario.evidence }] : []
        const view = adaptContinuity({ owner: { runId: 'fixture-run', workspace, sessionId: 'fixture-session', mode: 'normal', workUnitId: null, role: null },
          generation: 'fixture', frame, evidence })
        if (scenario.report) {
          const ref = { kind: 'enno-work-result', key: 'fixture-run:dependency', revision: hash(scenario.report) }
          view.sources.push(ref)
          view.items.push({ key: ref.key, kind: 'reported-result', text: scenario.report, basis: 'model-report', validity: 'unknown', sources: [ref] })
        }
        const projection = renderContinuationView(buildContinuationView({ owner: view.owner, stamp: view.stamp, sources: view.sources,
          items: view.items, coverage: view.coverage, omittedItems: view.omittedItems }), ContinuityConfig.parse({ mode: 'active' }))
        const legacyEvidence = evidence.map(item => `Recent evidence presentation (specified ranges only): ${item.presentation}; acquired: ${item.acquisition}`).join('\n')
        const context = executionFrameText(frame) + '\n' + (group === 'B' ? projection.text : legacyEvidence)
        const messages = [{ role: 'system', content: 'Answer only the requested JSON object. Distinguish model reports, historical observations and current verification.' },
          { role: 'user', content: scenario.prompt + '\n' + context }]
        const request = { model: config.model, temperature: config.temperature, seed: config.seed + repeat,
          max_tokens: config.maxOutputTokens, messages, ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}) }
        const record = { scenario: scenario.id, repeat, group, order: groups.indexOf(group), cacheCondition: 'uncontrolled',
          status: 'failed', passed: false, requestBytes: Buffer.byteLength(JSON.stringify(request)), supplementBytes: group === 'B' ? projection.bytes : 0,
          inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 0 }
        const begin = performance.now()
        try {
          const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined
          const response = await fetch(new URL(config.baseUrl.replace(/\/$/u, '') + '/chat/completions'), { method: 'POST', redirect: 'error', signal,
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(request) })
          if (!response.ok) throw new Error('provider_http_error')
          const chunks = []; let size = 0
          for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) throw new Error('response_limit'); chunks.push(chunk) }
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (result.model !== config.model) throw new Error('model_identity_changed')
          const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null
          record.inputTokens = number(result.usage?.prompt_tokens); record.outputTokens = number(result.usage?.completion_tokens)
          record.cacheReadTokens = number(result.usage?.prompt_tokens_details?.cached_tokens)
          const answer = JSON.parse(result.choices?.[0]?.message?.content ?? '')
          record.passed = Object.entries(scenario.expected).every(([key, value]) => answer[key] === value)
          record.status = result.choices?.[0]?.finish_reason === 'stop' ? 'completed' : 'incomplete'
          if (record.status !== 'completed') record.passed = false
        } catch { record.status = signal.aborted ? 'budget_exhausted' : 'failed' }
        finally { record.durationMs = performance.now() - begin; records.push(record) }
      }
    }
    const pairs = scenarios.flatMap(scenario => {
      const a = records.filter(r => r.scenario === scenario.id && r.group === 'A'), b = records.filter(r => r.scenario === scenario.id && r.group === 'B')
      if (a.length !== config.repetitions || b.length !== config.repetitions || [...a, ...b].some(r => r.status !== 'completed')) return []
      return [b.filter(r => r.passed).length / b.length - a.filter(r => r.passed).length / a.length]
    })
    const samples = pairs.length ? Array.from({ length: 2000 }, () => pairs.reduce(sum => sum + pairs[Math.floor(random() * pairs.length)], 0) / pairs.length).sort((a, b) => a - b) : []
    const report = { version: 1, status: exhausted || signal.aborted ? 'budget_exhausted' : 'measured', scope: 'context-recovery-probe',
      fixture: manifest, model: config.model, declaredRevision: config.revision, resolvedRevisionVerified: false, seed: config.seed,
      limitations: ['Context recovery probes, not end-to-end agent tasks.', 'Provider cache state and immutable model revision are not independently verified.', 'No automatic adoption decision; default stays off.'],
      modelRequests: records.length, reservedTokens, durationMs: performance.now() - start,
      pairedTasks: pairs.length, pairedDifference: pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null,
      pairedBootstrap95: samples.length ? [samples[50], samples[1949]] : null, records }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ status: report.status, modelRequests: records.length, pairedTasks: pairs.length, output: path.join(output, 'report.json') }) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}
