import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('evaluation without config makes no fetches and preserves unknown usage', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-continuity-evaluation.mjs'], { encoding: 'utf8' }))
  assert.equal(result.status, 'unmeasured')
  assert.equal(result.modelRequests, 0)
  assert.equal(result.inputTokens, null)
})
test('configured evaluation uses isolated fixtures, enforces total reservations, and saves no credentials or response text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuity-runner-test-'))
  try {
    const mock = join(root, 'fetch.mjs')
    await writeFile(mock, `globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      if (body.model !== 'fixture') throw new Error('wrong model');
      return new Response(JSON.stringify({model:'fixture', choices:[{message:{content:'{"documentComplete":false,"currentPresentation":"unknown"}'},finish_reason:'stop'}]}));
    };`)
    const config = { model: 'fixture', revision: 'fixed', baseUrl: 'http://127.0.0.1/v1', apiKeyEnv: 'CONTINUITY_TEST_KEY',
      temperature: 0, contextWindow: 4096, maxOutputTokens: 32, repetitions: 1, seed: 42, maxRequests: 20,
      maxTokens: 8256, maxDurationMs: 10000, allowRemote: false, fixture: 'continuity-v1' }
    const configPath = join(root, 'config.json'), output = join(root, 'results')
    await writeFile(configPath, JSON.stringify(config))
    execFileSync(process.execPath, ['--import', mock, '--import', 'tsx', 'scripts/run-continuity-evaluation.mjs', '--config', configPath, '--output', output],
      { env: { ...process.env, CONTINUITY_TEST_KEY: 'private-fixture-credential' } })
    const text = await readFile(join(output, 'report.json'), 'utf8'), report = JSON.parse(text)
    assert.equal(report.status, 'budget_exhausted')
    assert.equal(report.modelRequests, 2)
    assert.equal(report.pairedTasks, 1)
    assert.equal(report.records[0].inputTokens, null)
    assert.deepEqual(report.records.map((r: any) => r.group).sort(), ['A', 'B'])
    assert.doesNotMatch(text, /private-fixture-credential|documentComplete/)
    assert.throws(() => execFileSync(process.execPath, ['--import', mock, '--import', 'tsx', 'scripts/run-continuity-evaluation.mjs', '--config', configPath, '--output', output], { stdio: 'pipe' }))
    assert.equal(await readFile(join(output, 'report.json'), 'utf8'), text)
  } finally { await rm(root, { recursive: true, force: true }) }
})
