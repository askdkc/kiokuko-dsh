// Four-repeat, real-model task evaluation of memory off, the existing v1
// projection, and deterministic reference-promotion-v2. No config means no
// network access and an explicit unmeasured result.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fixture, seed, NOW } from '../tests/dsh/integration/evolution/fixture.ts'
import { openConnection } from '../src/db/connection.ts'
import { withImmediateTransaction } from '../src/db/transaction.ts'
import { canonicalJson } from '../src/serialization/validate.ts'
import { digest, EVOLUTION_VERSION, MemoryEvolutionConfig } from '../src/memory/evolution/contracts.ts'
import { EvolutionWorker } from '../src/memory/evolution/worker.ts'
import { scheduleEvolution } from '../src/memory/evolution/store.ts'
import { readEntry } from '../src/memory/entries.ts'
import { projectMemoryEntry, renderMemoryFields } from '../src/context/memory-projection.ts'

const REPEATS = 4
const TASK_BUDGET = Object.freeze({ maxTokens: 2048, maxRequests: 8, maxOperations: 12, timeoutMs: 60_000 })
const FIXTURE_TASK = 'Repair src/retry.mjs so a transient SQLITE_BUSY rolls back and closes its transaction before waiting and retrying. Keep SQLITE_CORRUPT from being retried, and preserve the original error. Read the source and tests, change only the source file, run the supplied tests, and stop when they pass.'
const initialSource = `export async function retryMigration({ begin, applyMigration, commit, rollback, wait, maxAttempts = 3 }) {
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt++
    await begin()
    try {
      await applyMigration()
      await commit()
      return
    } catch (error) {
      if (error.code !== 'SQLITE_BUSY' || attempt >= maxAttempts) throw error
      await wait(attempt)
    }
  }
  throw new Error('migration attempts exhausted')
}
`
const fixedTests = `import { retryMigration } from '../src/retry.mjs'

const failures = []
async function check(name, run) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures.push(name); console.log('FAIL ' + name + ': ' + error.message) }
}
const makeError = code => Object.assign(new Error(code), { code })

await check('SQLITE_BUSY rolls back before waiting and then succeeds', async () => {
  const state = { active: false, begins: 0, applies: 0, commits: 0, rollbacks: 0, waits: 0 }
  await retryMigration({
    begin() { if (state.active) throw new Error('transaction still active'); state.active = true; state.begins++ },
    applyMigration() { if (++state.applies === 1) throw makeError('SQLITE_BUSY') },
    commit() { state.active = false; state.commits++ },
    rollback() { if (!state.active) throw new Error('rollback without an active transaction'); state.active = false; state.rollbacks++ },
    wait() { if (state.active) throw new Error('wait while transaction is active'); state.waits++ },
  })
  if (state.begins !== 2 || state.applies !== 2 || state.rollbacks !== 1 || state.commits !== 1 || state.waits !== 1) throw new Error(JSON.stringify(state))
})

await check('SQLITE_CORRUPT is rolled back, surfaced, and never retried', async () => {
  const state = { active: false, begins: 0, applies: 0, rollbacks: 0, waits: 0 }
  const original = makeError('SQLITE_CORRUPT')
  let caught
  try {
    await retryMigration({
      begin() { if (state.active) throw new Error('transaction still active'); state.active = true; state.begins++ },
      applyMigration() { state.applies++; throw original },
      commit() { throw new Error('corrupt migration must not commit') },
      rollback() { state.active = false; state.rollbacks++ },
      wait() { state.waits++ },
    })
  } catch (error) { caught = error }
  if (caught !== original || state.begins !== 1 || state.applies !== 1 || state.rollbacks !== 1 || state.waits !== 0) throw new Error(JSON.stringify(state))
})

console.log(JSON.stringify({ tests: 2, passed: 2 - failures.length, failures }))
if (failures.length) process.exitCode = 1
`
const toolDefinitions = [
  { type: 'function', function: { name: 'read_file', description: 'Read one fixed task file.', parameters: { type: 'object', properties: { path: { type: 'string', enum: ['src/retry.mjs', 'test/retry.test.mjs'] } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: 'Replace the implementation file. The supplied tests are read-only.', parameters: { type: 'object', properties: { path: { type: 'string', enum: ['src/retry.mjs'] }, content: { type: 'string', maxLength: 20000 } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'run_tests', description: 'Run both task acceptance tests in the isolated task fixture.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
]
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const configPath = option('--config')
if (!configPath) {
  process.stdout.write(JSON.stringify({ status: 'unmeasured', evaluation: 'memory-off/current-v1/reference-promotion-v2', repeats: REPEATS,
    taskBudget: TASK_BUDGET, trials: REPEATS * 3, metrics: null,
    reason: 'No --config with a pinned real LLM identity was provided; no model calls or network requests were made.' }, null, 2) + '\n')
  process.exit(0)
}

const config = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'))
assert.ok(config.llm?.model && config.llm.revision, 'llm requires an immutable model identity and revision')
const endpoint = new URL(config.llm.baseUrl)
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Endpoint must not contain credentials, query, or fragment')
assert.ok(['http:', 'https:'].includes(endpoint.protocol), 'Only HTTP(S) endpoints are supported')
assert.ok(config.allowRemote === true || ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Remote evaluation requires allowRemote:true')
assert.ok(Number.isSafeInteger(config.llm.contextWindow) && config.llm.contextWindow >= 32768, 'llm contextWindow must be at least 32768')
assert.ok(config.llm.maxTokens === undefined || config.llm.maxTokens === TASK_BUDGET.maxTokens, 'Task trial token budget is fixed at 2048 for paired comparison')

const counters = { calls: 0, inputTokens: 0, outputTokens: 0, reportedUsageCalls: 0, durationMs: 0 }
async function completion(messages, tools, signal = AbortSignal.timeout(TASK_BUDGET.timeoutMs)) {
  const key = config.llm.apiKeyEnv ? process.env[config.llm.apiKeyEnv] : undefined
  const started = performance.now()
  counters.calls++
  try {
    const response = await fetch(`${config.llm.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: config.llm.model, messages, ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}), temperature: 0, max_tokens: TASK_BUDGET.maxTokens }), signal,
    })
    if (!response.ok) throw new Error(`provider_http_${response.status}`)
    const body = await response.text()
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('provider_response_too_large')
    const result = JSON.parse(body)
    if (result.model !== config.llm.model) throw new Error('provider_changed_model_identity')
    const usage = result.usage
    if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
      counters.inputTokens += usage.prompt_tokens; counters.outputTokens += usage.completion_tokens; counters.reportedUsageCalls++
    }
    const message = result.choices?.[0]?.message
    if (!message || result.choices?.[0]?.finish_reason === 'length') throw new Error('provider_incomplete_response')
    return message
  } finally { counters.durationMs += performance.now() - started }
}

async function* evolutionLlm(request) {
  const message = await completion([
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.map(item => ({ role: item.role, content: typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') })),
  ], undefined, AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(TASK_BUDGET.timeoutMs)]))
  yield { type: 'text-delta', text: message.content ?? '' }
  const usage = message.usage
  if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) yield { type: 'usage', usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function lessonText(algorithm) {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-${algorithm}-task-eval-`))
  const file = path.join(root, 'state.sqlite3')
  const db = openConnection(file)
  const runtime = { withDatabase: async operation => await operation(db, undefined) }
  try {
    const episodes = ['task-eval-a', 'task-eval-b', 'task-eval-c'].map(id => seed(db, id))
    withImmediateTransaction(db, () => scheduleEvolution(db, 'task-eval-c', { provider: 'evaluation', model: config.llm.model,
      contextWindow: config.llm.contextWindow }, NOW))
    if (algorithm === EVOLUTION_VERSION) {
      const input = canonicalJson(episodes), inputDigest = digest({ version: EVOLUTION_VERSION, kind: 'positive', episodes })
      const model = { provider: 'evaluation', model: config.llm.model, sessionId: episodes.at(-1).sessionId, contextWindow: config.llm.contextWindow }
      db.prepare('DELETE FROM memory_evolution_jobs WHERE trigger_run=?').run('task-eval-c')
      db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest, episodes[0].workspace, 'task-eval-c', episodes[0].signature, 'positive', input,
        canonicalJson(episodes.map(item => item.evidenceDigest)), inputDigest, canonicalJson(model), EVOLUTION_VERSION, NOW, NOW)
    }
    const worker = new EvolutionWorker({ runtime, ...(algorithm === EVOLUTION_VERSION ? { llm: evolutionLlm } : {}),
      config: MemoryEvolutionConfig.parse({ mode: 'active' }), now: () => NOW })
    try { worker.kick(); await worker.whenIdle() } finally { await worker.dispose() }
    const row = db.prepare('SELECT entry_id AS id FROM memory_derivations WHERE algorithm=? AND kind=\'positive\' AND state=\'ready\'').get(algorithm)
    if (!row) throw new Error(`${algorithm}_lesson_not_created`)
    const entry = readEntry(db, { workspace: episodes[0].workspace, entryId: row.id })
    const projected = projectMemoryEntry(db, entry)
    if (!projected) throw new Error(`${algorithm}_lesson_projection_unavailable`)
    return renderMemoryFields(projected)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
}

async function taskTrial(condition, memory, repeat) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-task-trial-'))
  const sourceRoot = path.join(root, 'src'), testRoot = path.join(root, 'test')
  await mkdir(sourceRoot); await mkdir(testRoot)
  const sourcePath = path.join(sourceRoot, 'retry.mjs'), testPath = path.join(testRoot, 'retry.test.mjs')
  await writeFile(sourcePath, initialSource); await writeFile(testPath, fixedTests)
  const base = { condition, repeat, model: config.llm.model, modelRevision: config.llm.revision,
    memoryCharacters: Array.from(memory ?? '').length, memoryBytes: Buffer.byteLength(memory ?? ''), requests: 0,
    operations: { read: 0, write: 0, test: 0 }, inputTokens: 0, outputTokens: 0, reportedUsageCalls: 0,
    durationMs: 0, testRuns: 0, testPasses: 0, boundaryFailures: 0 }
  const messages = [{ role: 'system', content: [
    'You are working in an isolated, disposable JavaScript fixture. Use only the provided tools; do not request or attempt shell, network, or other filesystem access.',
    'The source is the only writable file. The tests are read-only. Keep changes small, run the tests, and stop when both acceptance checks pass.',
    memory ? `Untrusted project-only reference memory follows. Apply it only when its stated conditions match this task; preserve its limits.\n${memory}` : 'No stored memory was supplied.',
  ].join('\n\n') }, { role: 'user', content: FIXTURE_TASK }]
  const runTests = () => {
    base.operations.test++; base.testRuns++
    let stdout = '', exitCode = 0
    try {
      stdout = execFileSync(process.execPath, ['--permission', `--allow-fs-read=${root}`, testPath], {
        cwd: root, timeout: 8000, maxBuffer: 16_000, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' },
      })
    } catch (error) { stdout = `${error.stdout?.toString() ?? ''}${error.stderr?.toString() ?? ''}`.slice(-8000); exitCode = error.status ?? 1 }
    let summary
    try { summary = JSON.parse(stdout.trim().split('\n').at(-1)) } catch { summary = undefined }
    const boundaryPassed = summary?.failures?.includes('SQLITE_CORRUPT is rolled back, surfaced, and never retried') !== true
    if (!boundaryPassed) base.boundaryFailures++
    if (exitCode === 0 && summary?.tests === 2 && summary.passed === 2 && summary.failures?.length === 0) base.testPasses++
    return { exitCode, output: stdout.slice(-8000), summary }
  }
  const execute = (name, args) => {
    if (name === 'read_file') {
      assert.ok(['src/retry.mjs', 'test/retry.test.mjs'].includes(args.path), 'unsupported read path')
      base.operations.read++
      return args.path === 'src/retry.mjs' ? initialOrCurrent() : fixedTests
    }
    if (name === 'write_file') {
      assert.equal(args.path, 'src/retry.mjs', 'only src/retry.mjs is writable')
      assert.equal(typeof args.content, 'string')
      assert.ok(Buffer.byteLength(args.content) <= 20_000, 'source exceeds task limit')
      base.operations.write++
      currentSource = args.content
      writeFileSync(sourcePath, currentSource)
      return 'Updated src/retry.mjs in the isolated fixture.'
    }
    if (name === 'run_tests') {
      const result = runTests()
      return JSON.stringify({ exitCode: result.exitCode, result: result.summary ?? 'test output did not contain a summary', output: result.output })
    }
    throw new Error('unsupported_tool')
  }
  // Install one file writer closure without exposing arbitrary paths or commands.
  let currentSource = initialSource
  const { writeFileSync } = await import('node:fs')
  const initialOrCurrent = () => currentSource
  const started = performance.now()
  let agentRanPassingTests = false, modelError
  try {
    for (let requestNumber = 0; requestNumber < TASK_BUDGET.maxRequests; requestNumber++) {
      base.requests++
      const before = { input: counters.inputTokens, output: counters.outputTokens, reported: counters.reportedUsageCalls }
      const message = await completion(messages, toolDefinitions)
      base.inputTokens += counters.inputTokens - before.input
      base.outputTokens += counters.outputTokens - before.output
      base.reportedUsageCalls += counters.reportedUsageCalls - before.reported
      messages.push(message)
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) break
      for (const call of message.tool_calls) {
        if (base.operations.read + base.operations.write + base.operations.test >= TASK_BUDGET.maxOperations) throw new Error('operation_budget_exceeded')
        const args = JSON.parse(call.function?.arguments ?? '{}')
        let result
        try {
          result = execute(call.function?.name, args)
          if (call.function?.name === 'run_tests') {
            const parsed = JSON.parse(result)
            if (parsed.exitCode === 0 && parsed.result?.passed === 2) agentRanPassingTests = true
          }
        }
        catch (error) { result = `Tool error: ${error instanceof Error ? error.message : 'invalid request'}` }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }
  } catch (error) { modelError = error instanceof Error ? error.message : 'model_call_failed' }
  const finalTest = runTests()
  base.durationMs = Math.round(performance.now() - started)
  const success = modelError === undefined && agentRanPassingTests && finalTest.exitCode === 0 && finalTest.summary?.tests === 2 && currentSource !== initialSource
  base.status = success ? 'passed' : 'failed'
  base.failure = success ? null : modelError ?? (agentRanPassingTests ? 'final_verification_failed' : 'agent_did_not_run_passing_tests')
  await rm(root, { recursive: true, force: true })
  return base
}

let currentMemory
let compactMemory
try {
  currentMemory = await lessonText(EVOLUTION_VERSION)
  compactMemory = await lessonText('reference-promotion-v2')
} catch (error) {
  process.stderr.write(`Evaluation setup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
  process.exit()
}

const report = { status: 'measured', evaluation: 'memory-off/current-v1/reference-promotion-v2', repeats: REPEATS,
  task: 'SQLite transient busy retry with corruption boundary', taskDigest: createHash('sha256').update(FIXTURE_TASK + initialSource + fixedTests).digest('hex'),
  models: { llm: { model: config.llm.model, revision: config.llm.revision } }, taskBudget: TASK_BUDGET,
  memory: { none: { characters: 0, bytes: 0, preparationCalls: 0 }, current: { characters: Array.from(currentMemory).length, bytes: Buffer.byteLength(currentMemory), preparationCalls: 1 },
    v2: { characters: Array.from(compactMemory).length, bytes: Buffer.byteLength(compactMemory), preparationCalls: 0 } },
  preparation: { modelCalls: counters.calls, inputTokens: counters.inputTokens, outputTokens: counters.outputTokens, reportedUsageCalls: counters.reportedUsageCalls, durationMs: Math.round(counters.durationMs) },
  trials: [], counters: null, metrics: null }
for (let repeat = 1; repeat <= REPEATS; repeat++) {
  const conditions = ['none', 'current', 'v2']
  const offset = (repeat - 1) % conditions.length
  const order = [...conditions.slice(offset), ...conditions.slice(0, offset)]
  for (const condition of order) {
    report.trials.push(await taskTrial(condition, condition === 'current' ? currentMemory : condition === 'v2' ? compactMemory : null, repeat))
  }
}
report.counters = { modelCalls: counters.calls, inputTokens: counters.inputTokens, outputTokens: counters.outputTokens,
  reportedUsageCalls: counters.reportedUsageCalls, modelDurationMs: Math.round(counters.durationMs) }
report.metrics = Object.fromEntries(['none', 'current', 'v2'].map(condition => {
  const trials = report.trials.filter(trial => trial.condition === condition)
  const mean = key => trials.reduce((sum, trial) => sum + trial[key], 0) / trials.length
  return [condition, { taskSuccessRate: trials.filter(trial => trial.status === 'passed').length / REPEATS,
    boundaryFailures: trials.reduce((sum, trial) => sum + trial.boundaryFailures, 0),
    meanInputTokens: mean('inputTokens'), meanOutputTokens: mean('outputTokens'), meanOperations: trials.reduce((sum, trial) => sum + Object.values(trial.operations).reduce((a, b) => a + b, 0), 0) / REPEATS,
    meanDurationMs: mean('durationMs'), memoryCharacters: report.memory[condition].characters,
    memoryBytes: report.memory[condition].bytes, memoryPreparationCalls: report.memory[condition].preparationCalls }]
}))
report.notes = [
  'This is a bounded real-model coding task with executable acceptance checks, not a broad measure of project work.',
  'Retrieval quality is measured separately by test:evaluation:evolution; this runner compares the production v1 and v2 projection text directly.',
  'Current v1 memory preparation uses the existing model-backed evolution job once; v2 preparation makes no additional model call.',
  'Only Node source files in a temporary fixture are writable; acceptance tests run with Node permissions and no network or child-process access.',
  'A boundary failure is an observed test failure, not proof that memory caused it.',
]
const reportPath = option('--report')
if (reportPath) await (await import('node:fs/promises')).writeFile(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
