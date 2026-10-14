import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CompletionMethodSchema } from '../../../src/dsh/task-completion.js'

const recipe = { kind: 'bounded-tdd-v1', unitId: 'parser', implementationPaths: ['src/a.mjs', 'src/b.mjs'], testPaths: ['tests/parser.test.mjs'] }
const method = { kind: 'native_command', command: 'node --test --test-reporter=tap tests/parser.test.mjs', cwd: '.', sourcePaths: [...recipe.implementationPaths, ...recipe.testPaths], assertion: 'selected_tests_pass', protocol: recipe }

test('approved completion proposals can declare one bounded multi-file TDD implementation unit', () => {
  const parsed = CompletionMethodSchema.safeParse(method)
  assert.equal(parsed.success, true, 'The real completion binding must admit a bounded TDD recipe before it can enforce its phases')
  if (parsed.success) assert.deepEqual((parsed.data as any).protocol, recipe)
})

test('protocol proposals cannot contain evidence authority, supplied verdicts or overlapping paths', () => {
  for (const protocol of [
    { ...recipe, issuer: 'kiokuko-dsh:owned-execution:v1' }, { ...recipe, receipt: { outcome: 'passed' } },
    { ...recipe, phase: 'implement' }, { ...recipe, implementationPaths: recipe.testPaths },
    { ...recipe, testPaths: ['../outside.mjs'] }, { ...recipe, implementationPaths: [] },
  ]) assert.equal(CompletionMethodSchema.safeParse({ ...method, protocol }).success, false)
})


test('the negative-test helper rejects success and a wrong error without catching its own assertion', async () => {
  const source=readFileSync(new URL('../integration/guardrail-owned.test.ts',import.meta.url),'utf8')
  const body=source.match(/async function denied\([\s\S]*?\n\}\n/u)?.[0]
  assert.ok(body,'The exact exercised helper must be found')
  const javascript=body.replace('work: () => Promise<any>, pattern: RegExp','work, pattern')
  const denied=new Script(`${javascript};denied`).runInNewContext({assert}) as (work:()=>Promise<unknown>,pattern:RegExp)=>Promise<void>
  await assert.rejects(denied(async()=>({receipt:{}}),/effect must fail closed/i),/effect must fail closed|does not match|input did not match/i)
  await denied(async()=>{throw Error('phase rejected')},/phase/)
  await assert.rejects(denied(async()=>{throw Error('different failure')},/phase/),/does not match|input did not match/i)
})
