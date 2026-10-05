import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { parseEvaluationConfig, createEvaluationBudget } = await import(new URL('../../../../scripts/skill-evaluation-config.mjs', import.meta.url).href)
const { evaluationFetch } = await import(new URL('../../../../scripts/lisp-prototype-transport.mjs', import.meta.url).href)
const { assessEvidence } = await import(new URL('../../../../scripts/lisp-prototype-evidence.mjs', import.meta.url).href)
const { scenarios } = await import(new URL('../../../../scripts/lisp-prototype-scenarios.mjs', import.meta.url).href)
const config = { model: 'fixed-model', revision: 'fixture-1', baseURL: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'FIXTURE_KEY', allowRemote: false,
  maxRequests: 2, maxTokens: 10240, maxDurationMs: 10000, contextWindow: 4096, maxOutputTokens: 1024, temperature: 0 }

test('prototype configuration rejects implicit remote authority and unknown fields', () => {
  assert.deepEqual(parseEvaluationConfig(config), config)
  for (const input of [{ ...config, baseURL: 'https://example.com' }, { ...config, baseURL: 'http://example.com', allowRemote: true },
    { ...config, baseURL: 'https://name:password@example.com', allowRemote: true }, { ...config, apiKey: 'never-accepted' }, { ...config, maxRequests: 0 }]) assert.throws(() => parseEvaluationConfig(input))
})

test('reservation counts failed calls and independently bounds time, requests and tokens', () => {
  let now = 0
  const budget = createEvaluationBudget(config, () => now)
  assert.equal(budget.reserve(), true); assert.equal(budget.reserve(), true); assert.equal(budget.reserve(), false)
  assert.deepEqual(budget.snapshot(), { requests: 2, reservedTokens: 10240, elapsedMs: 0, exhausted: true })
  const timed = createEvaluationBudget(config, () => now); now = 10000; assert.equal(timed.reserve(), false)
  assert.equal(createEvaluationBudget({ ...config, maxTokens: 5119 }).reserve(), false)
})

test('native transport enforces endpoint/model/response identity, no retries, and budget before dispatch', async () => {
  const records: any[] = [], sent: any[] = []
  const body = { model: config.model, max_tokens: config.maxOutputTokens }
  const fake = async (url: string, init: any) => {
    sent.push({ url, init })
    return new Response(`data: ${JSON.stringify({ model: config.model, choices: [{ delta: { content: 'plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  }
  const request = evaluationFetch(config, createEvaluationBudget(config), new AbortController().signal, records, fake)
  const invoke = (url = `${config.baseURL}/chat/completions`, value = body) => request(url, { method: 'POST', body: JSON.stringify(value) })
  await assert.rejects(invoke('https://other.invalid/chat/completions'), /unapproved/)
  await assert.rejects(invoke(undefined, { ...body, model: 'changed' }), /model/)
  assert.equal(sent.length, 0)
  await invoke(); await invoke(); await assert.rejects(invoke(), /budget/)
  assert.equal(sent.length, 2); assert.equal(sent[0].init.redirect, 'error')
  assert.equal(records[0].status, 'completed'); assert.equal(records[0].responseModel, config.model)
  const mismatch = evaluationFetch(config, createEvaluationBudget(config), new AbortController().signal, [], async () => new Response('data: {"model":"other"}\n\n'))
  await assert.rejects(mismatch(`${config.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify(body) }), /model_changed/)
  let failures = 0
  const failed = evaluationFetch(config, createEvaluationBudget(config), new AbortController().signal, [], async () => { failures++; throw new Error('fixture failure') })
  await assert.rejects(failed(`${config.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify(body) }))
  assert.equal(failures, 1)
})

test('evidence checks reject generated passed flags, fabricated refs and plan-only writes', () => {
  const scenario = scenarios[0]
  const evidence = { calls: [{ name: 'lisp_eval', arguments: { code: '(real-probe)' } }], results: [{ value: { operationId: 'observed', value: { json: { code: 0, stdout: JSON.stringify(scenario.expected) } } } }], final: 'Plan [evidence:observed]' }
  assert.equal(assessEvidence(scenario, evidence, 'same', 'same').passed, true)
  assert.equal(assessEvidence(scenario, { ...evidence, results: [{ value: { operationId: 'observed', passed: true } }] }, 'same', 'same').passed, false)
  assert.equal(assessEvidence(scenario, { ...evidence, final: 'Plan [evidence:invented]' }, 'same', 'same').passed, false)
  assert.equal(assessEvidence(scenario, evidence, 'before', 'after').passed, false)
  assert.equal(assessEvidence(scenario, { ...evidence, calls: [{ name: 'lisp_apply' }] }, 'same', 'same').passed, false)
})

test('contrary evidence and fresh seeds require observed data, not a declaration', () => {
  const failure = scenarios.find((s: any) => s.id === 'B05'), reuse = scenarios.find((s: any) => s.id === 'B04')
  const results = [{ value: { operationId: 'first', value: { json: { code: 1, stdout: 'hypothesis failed' } } } }, { value: { operationId: 'second', value: { json: { code: 0, stdout: JSON.stringify(failure.expected) } } } }]
  const evidence = { calls: [{ name: 'lisp_eval', arguments: { code: 'first' } }, { name: 'lisp_eval', arguments: { code: 'different' } }], results, final: 'Plan [evidence:second]' }
  assert.equal(assessEvidence(failure, evidence, 'same', 'same').passed, true)
  assert.equal(assessEvidence(failure, { ...evidence, results: results.slice(1) }, 'same', 'same').passed, false)
  const seed = { value: { operationId: 'seed', value: { json: { code: 0, stdout: JSON.stringify(reuse.expected) } } } }
  assert.equal(assessEvidence(reuse, { calls: [], results: [], final: 'Plan [evidence:seed]' }, 'same', 'same', seed).passed, true)
})

test('unconfigured CLI performs zero model calls and creates no report, including under a parent test context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prototype-cli-'))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/run-lisp-prototype-planning.mjs', '--output', dir], { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } })
    const result = JSON.parse(stdout.trim())
    assert.equal(result.status, 'unmeasured'); assert.equal(result.modelRequests, 0)
    await assert.rejects(readFile(join(dir, 'report.json')), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
