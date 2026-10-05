import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

test('pstack evaluation without configuration makes no model requests', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/run-skill-quality.mjs', '--pstack'], { encoding: 'utf8' }))
  assert.equal(result.status, 'unmeasured')
  assert.equal(result.modelRequests, 0)
})
test('pstack evaluation includes independent boundary cases and both named targets', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/skill-prompts/pstack-scenarios.json', 'utf8'))
  assert.deepEqual(fixture.models, ['gpt-6-astra', 'gpt-6.1-sol'])
  assert.equal(fixture.repetitions, 3)
  for (const id of ['small-fix', 'missing-model', 'authority', 'japanese', 'benchmark', 'review']) {
    assert.ok(fixture.cases.some((c: {id: string}) => c.id === id))
  }
})

for (const pstack of [false, true]) test(`quality evaluation preserves ${pstack ? 'three pstack' : 'two standard'} modes and shared budget`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-mode-budget-'))
  try {
    const fixture = new URL(`../../fixtures/skill-prompts/${pstack ? 'pstack-scenarios' : 'scenarios'}.json`, import.meta.url)
    const config = join(dir, 'config.json'), preload = join(dir, 'provider.mjs'), output = join(dir, 'result')
    const modes = pstack ? ['baseline-full', 'candidate-full', 'compiled'] : ['full', 'compiled']
    const requests = modes.length * 2
    await writeFile(config, JSON.stringify({ model: 'fixture', revision: 'fixture', baseURL: 'https://fixture.invalid', apiKeyEnv: 'QUALITY_FIXTURE_KEY', allowRemote: true,
      maxRequests: requests, maxTokens: requests * (4096 + 256), maxDurationMs: 10000, contextWindow: 4096, maxOutputTokens: 256, temperature: 0 }))
    await writeFile(preload, `import {readFileSync,appendFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL(${JSON.stringify(fixture.href)}),'utf8'));
globalThis.fetch=async(url,init)=>{
  if(url!=='https://fixture.invalid/chat/completions')throw new Error('unexpected endpoint');
  const body=JSON.parse(init.body),scenario=fixture.cases.find(c=>c.prompt===body.messages.at(-1).content);
  if(!scenario)throw new Error('unexpected scenario');
  appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))},JSON.stringify(body)+'\\n');
  return Response.json({model:'fixture',choices:[{message:{content:JSON.stringify(scenario.expected)},finish_reason:'stop'}]});
};`)
    const env: NodeJS.ProcessEnv = { ...process.env, QUALITY_FIXTURE_KEY: 'fixture-only' }
    delete env.NODE_TEST_CONTEXT
    let exitCode = 0
    try {
      await promisify(execFile)(process.execPath, ['--import', preload, 'scripts/run-skill-quality.mjs', ...(pstack ? ['--pstack'] : []), '--config', config, '--output', output], { env })
    } catch (error) { exitCode = (error as { code: number }).code }
    assert.equal(exitCode, 1, 'exhausted budget must not become a complete evaluation')
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    assert.equal(report.status, 'budget_exhausted')
    assert.deepEqual(report.records.map((r: { mode: string }) => r.mode), [...modes, ...modes.slice(1), modes[0]])
    assert.ok(report.records.every((r: { status: string; correct: boolean; systemBytes: number; elapsedMs: number }) => r.status === 'completed' && r.correct && r.systemBytes > 0 && r.elapsedMs >= 0))
    assert.equal((await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').length, requests)
    assert.equal(report.gates.complete, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
