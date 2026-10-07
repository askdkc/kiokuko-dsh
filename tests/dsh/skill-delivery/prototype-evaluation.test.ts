import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepSeekFixtureResponse, wireText, wireToolResults } from '../helpers/deepseek-wire.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const enabled = !!packages && process.env.KIOKUKO_TEST_COMPILED_SKILLS === '1' && process.env.KIOKUKO_REQUIRE_LISP_RUNTIME === '1'
test('scripted evaluation setup hands off within the same admitted native turn', {
  skip: !!packages && process.env.KIOKUKO_TEST_COMPILED_SKILLS === '1' ? false : 'requires dedicated Skill delivery runner', timeout: 60000,
}, async () => {
  const { withNativeEvaluationSetup } = await import(new URL('../../../scripts/lisp-prototype-evaluation.mjs', import.meta.url).href)
  const { readEvidence } = await import(new URL('../../../scripts/lisp-prototype-evidence.mjs', import.meta.url).href)
  const { nativeSkillFixture } = await import('../helpers/skill-native.js')
  const { withIsolatedSkillHome } = await import('../helpers/skill-home.js')
  const { DshSkillPrompts } = await import('../../../src/dsh/skill-prompts.js')
  await withIsolatedSkillHome(async () => {
    const f = await nativeSkillFixture({ packages: packages!, explicit: true, prompts: new DshSkillPrompts(),
      extra: { lisp: { enabled: true, sbclPath: 'must-not-start-sbcl' } } })
    let evidenceStart = 0, handoffs = 0
    const task = 'Inspect the protected Lisp task API and current status, without changing files.'
    try {
      assert.equal((await f.ctx.commands.execute(f.agent, '/kioku-lisp enable-task', [], new AbortController().signal)).result.kind, 'success')
      const setupResponses = [f.mock.toolCallResponse('setup-prepare', 'prepare_requested_work', { taskType: 'research' }),
        f.mock.toolCallResponse('setup-describe', 'lisp_describe', { operationId: 'setup-describe' })]
      f.model.stream = withNativeEvaluationSetup(f.model.stream.bind(f.model), setupResponses, async () => {
        handoffs++
        const setup = readEvidence(f.agent.session.snapshotEvents())
        assert.equal(setup.results.find((result: any) => result.callId === 'setup-prepare')?.value?.originalTask, task)
        assert.equal(setup.results.find((result: any) => result.callId === 'setup-prepare')?.value?.prepared, true)
        assert.equal(setup.results.find((result: any) => result.callId === 'setup-describe')?.value?.ok, true)
        evidenceStart = f.agent.session.snapshotEvents().length
        f.responses.push(f.mock.toolCallResponse('measured-status', 'lisp_status', {}), f.mock.textResponse('Protected task status verified.'))
      })
      await f.turn(task)
      const events = f.agent.session.snapshotEvents()
      assert.equal(events.filter((event: any) => event.type === 'turn/start').length, 1)
      assert.equal(events.filter((event: any) => event.type === 'turn/end').length, 1)
      assert.equal(handoffs, 1)
      assert.equal(f.model.requests.length, 2, 'only measured requests reach the downstream model')
      const measured = readEvidence(events.slice(evidenceStart))
      assert.deepEqual(measured.calls.map((call: any) => call.callId), ['measured-status'])
      assert.equal(measured.results[0].isError, false)
      assert.equal(measured.results[0].value.state, 'TASK_READY')
    } finally { await f.close() }
  })
})

test('prototype live path uses the native HTTP serializer and stops before a second request exceeds budget', { skip: enabled ? false : 'requires dedicated protected Skill delivery runner', timeout: 90000 }, async () => {
  const { runPrototypeEvaluation } = await import(new URL('../../../scripts/lisp-prototype-evaluation.mjs', import.meta.url).href)
  const output = await mkdtemp(join(tmpdir(), 'prototype-http-control-'))
  const keyName = 'KIOKUKO_PROTOTYPE_FIXTURE_KEY', previous = process.env[keyName]
  process.env[keyName] = 'fixture-only-no-network'
  const bodies: any[] = []
  try {
    const config = { model: 'fixture-model', revision: 'fixture', baseURL: 'https://prototype.invalid/v1', apiKeyEnv: keyName, allowRemote: true,
      maxRequests: 1, maxTokens: 69632, maxDurationMs: 60000, contextWindow: 65536, maxOutputTokens: 4096, temperature: 0 }
    const report = await runPrototypeEvaluation({ config, output, packages, request: async (url: string, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body)
      assert.equal(body.model, config.model); assert.equal(body.max_tokens, 4096)
      assert.ok(body.tools.some((t: any) => (t.function?.name ?? t.name) === 'lisp_eval'))
      assert.ok(wireText(body).includes('Common Lisp in Kiokuko DSH'))
      const results = wireToolResults(body)
      assert.equal(results.get('prepare-evaluation')?.prepared, true,
        'the first HTTP request must already contain real native preparation evidence')
      assert.equal(results.get('runtime-info')?.ok, true,
        'scripted runtime setup must finish before any HTTP dispatch')
      return deepSeekFixtureResponse(String(url), config.model, { tool: { id: 'probe', name: 'lisp_eval', arguments: { operationId: 'probe', code: '(+ 20 22)' } } })
    } })
    assert.equal(bodies.length, 1, 'budget must stop the continuation before network dispatch')
    assert.equal(report.status, 'budget_exhausted', JSON.stringify(report.records.map((row: any) => ({ stage: row.stage, failure: row.failure,
      calls: row.evidence?.calls?.map((call: any) => ({ name: call.name, callId: call.callId })),
      errors: row.evidence?.results?.filter((result: any) => result.isError).map((result: any) => result.text) }))))
    assert.equal(report.modelQuality, 'pending_manual_review')
    assert.equal(report.modelRequests, 1)
    assert.equal(report.records[0].setupRequests, 2, 'native preparation and runtime inspection are scripted host setup, outside the live request budget')
    assert.equal(report.records[0].runtime?.value?.ok, true, 'setup must actually execute protected runtime inspection')
    assert.ok(report.records[0].evidence.calls.every((call: any) => !['prepare-evaluation', 'runtime-info'].includes(call.callId)),
      'measured evaluation evidence must exclude setup calls')
    assert.ok(report.records[0].evidence.results.some((r: any) => r.value?.value?.json === 42), 'the first tool call must really execute in protected Lisp')
    assert.ok(!(await readFile(join(output, 'report.json'), 'utf8')).includes('fixture-only-no-network'))
    await assert.rejects(runPrototypeEvaluation({ config, output, packages, request: async () => { throw new Error('must not dispatch') } }), { code: 'EEXIST' })
  } finally {
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous
    await rm(output, { recursive: true, force: true })
  }
})
