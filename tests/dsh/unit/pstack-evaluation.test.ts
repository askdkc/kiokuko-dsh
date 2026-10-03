import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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
