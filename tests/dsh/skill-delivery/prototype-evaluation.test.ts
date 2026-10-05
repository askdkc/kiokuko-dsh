import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const enabled = !!packages && process.env.KIOKUKO_TEST_COMPILED_SKILLS === '1' && process.env.KIOKUKO_REQUIRE_LISP_RUNTIME === '1'
test('prototype live path uses the native HTTP serializer and stops before a second request exceeds budget', { skip: enabled ? false : 'requires dedicated protected Skill delivery runner', timeout: 90000 }, async () => {
  const { runPrototypeEvaluation } = await import(new URL('../../../scripts/lisp-prototype-evaluation.mjs', import.meta.url).href)
  const output = await mkdtemp(join(tmpdir(), 'prototype-http-control-'))
  const keyName = 'KIOKUKO_PROTOTYPE_FIXTURE_KEY', previous = process.env[keyName]
  process.env[keyName] = 'fixture-only-no-network'
  const bodies: any[] = []
  try {
    const config = { model: 'fixture-model', revision: 'fixture', baseURL: 'https://prototype.invalid/v1', apiKeyEnv: keyName, allowRemote: true,
      maxRequests: 1, maxTokens: 69632, maxDurationMs: 60000, contextWindow: 65536, maxOutputTokens: 4096, temperature: 0 }
    const report = await runPrototypeEvaluation({ config, output, packages, request: async (_url: string, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body)
      assert.equal(body.model, config.model); assert.equal(body.max_tokens, 4096)
      assert.ok(body.tools.some((t: any) => t.function.name === 'lisp_eval'))
      assert.ok(body.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('Common Lisp in Kiokuko DSH')))
      const frame = { model: config.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'probe', type: 'function', function: { name: 'lisp_eval', arguments: JSON.stringify({ operationId: 'probe', code: '(+ 20 22)' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    assert.equal(bodies.length, 1, 'budget must stop the continuation before network dispatch')
    assert.equal(report.status, 'budget_exhausted')
    assert.equal(report.modelQuality, 'pending_manual_review')
    assert.equal(report.modelRequests, 1)
    assert.ok(report.records[0].evidence.results.some((r: any) => r.value?.value?.json === 42), 'the first tool call must really execute in protected Lisp')
    assert.ok(!(await readFile(join(output, 'report.json'), 'utf8')).includes('fixture-only-no-network'))
    await assert.rejects(runPrototypeEvaluation({ config, output, packages, request: async () => { throw new Error('must not dispatch') } }), { code: 'EEXIST' })
  } finally {
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous
    await rm(output, { recursive: true, force: true })
  }
})
