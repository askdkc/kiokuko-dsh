import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileSkillBundle, compileSkillResource } from '../../../src/dsh/skill-compiler.js'
import { DshSkillPrompts } from '../../../src/dsh/skill-prompts.js'
import { loadSkillSources } from '../../../src/dsh/skill-sources.js'
import { requestSize } from '../../../src/dsh/efficiency.js'

const source = (content: string) => ({ name: 'fixture', relativePath: 'SKILL.md', content })
const contract = '<!-- kiokuko:runtime core -->\nNever replay completed effects.\n<!-- /kiokuko:runtime -->\n<!-- kiokuko:documentation explanation -->\nLong background.\n<!-- /kiokuko:documentation -->'
test('current canonical Skills satisfy the unchanged CI efficiency budget without a prior build', async () => {
  const baseline = JSON.parse(await readFile(new URL('../../fixtures/skill-prompts/baseline.json', import.meta.url), 'utf8')) as { resources: { path: string; content: string }[] }
  const compiled = compileSkillBundle(await loadSkillSources())
  const cases = [
    ['kiokuko-soul'], ['kiokuko-soul', 'natural-japanese-output'],
    ['kiokuko-soul', 'natural-japanese-output', 'kiokuko-lisp'],
    ['kiokuko-soul', 'kiokuko-enno-oduno', 'kiokuko-single-purpose-functions'],
    ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'kiokuko-ui-design-soul'],
  ]
  let before = 0, after = 0
  for (const names of cases) {
    const prior = names.map(name => baseline.resources.find(r => r.path.endsWith(`/${name}/SKILL.md`) || name === 'natural-japanese-output' && r.path.endsWith('/japanese-translation-for-oss-models/SKILL.md'))!.content).join('\n\n')
    const current = names.map(name => compiled.resources.find(r => r.id === `${name}/SKILL.md`)!.content).join('\n\n')
    const priorBytes = Buffer.byteLength(prior), currentBytes = Buffer.byteLength(current)
    assert.ok(currentBytes <= priorBytes, `${names.join(',')}: runtime guidance grew beyond the fixed baseline`)
    const envelope = (system: string) => ({ system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Complete this bounded task.' }] }] })
    assert.ok(requestSize(envelope(current)).totalBytes <= requestSize(envelope(prior)).totalBytes, `${names.join(',')}: serialized request grew`)
    before += priorBytes; after += currentBytes
  }
  const reduction = 1 - after / before
  assert.ok(reduction >= 0.3, `Canonical Skill reduction ${(reduction * 100).toFixed(2)}% is below the CI minimum 30%`)
})
test('compiler retains rules, excludes only documentation, preserves unannotated resources and is deterministic', () => {
  const result = compileSkillResource(source(contract))
  assert.match(result.content, /Never replay completed effects\./u)
  assert.doesNotMatch(result.content, /Long background/u)
  assert.deepEqual(result.blocks, ['core'])
  assert.equal(compileSkillResource(source('unchanged reference')).content, 'unchanged reference')
  assert.deepEqual(compileSkillBundle([source(contract)]), compileSkillBundle([source(contract)]))
})
test('compiled Lisp guidance retains TypeSafe discovery and answer-consuming examples', async () => {
  const compiled = compileSkillBundle(await loadSkillSources())
  const lisp = compiled.resources.find(resource => resource.id === 'kiokuko-lisp/SKILL.md')!.content
  for (const contract of ['kioku.typesafe:evaluate', '/kioku-typesafe-key', 'inspect-diagnosis', 'kioku.decisions:status', 'assess-relevance', 'result.answers', 'Cancellation stops work', 'Existing approvals remain authoritative', 'See lisp_hot_* schemas.']) assert.ok(lisp.includes(contract), contract)
  // The protected runtime suite locates and executes this delivered example.
  const example = lisp.match(/^### TypeSafe\n[\s\S]*?```lisp\n([\s\S]*?)```/m)?.[1]
  assert.ok(example, 'compiled TypeSafe section must expose its executable Lisp example')
  assert.match(example, /\(defun inspect-diagnosis /)
})
test('Lisp planning and execution safeguards survive full, compiled and fallback delivery', async () => {
  const sources = await loadSkillSources()
  const lisp = sources.find(s => s.name === 'kiokuko-lisp' && s.relativePath === 'SKILL.md')!
  // Historical prose is not a byte-prefix contract: package APIs and profile
  // approvals deliberately extend it. Verify the executable safeguards in every
  // delivered representation, including the no-artifact fallback.
  const safeguards = ['Never spoof host-bound session/agent/directory/generation',
    'never escape protection', 'Unknown\ntest status or generated `passed` fields never prove host verification',
    'IN_PROGRESS', 'ID_CONFLICT', 'RUNNING/UNKNOWN', 'RESULT_EXPIRED', 'Never replay effects',
    'profile policy on frozen targets/diffs', 'Refusal/skip/UI failure/cancellation never authorizes',
    'Generation\napproval never authorizes writes', 'no reapply/\nrollback', 'Cancellation stops work',
    'execute authorized actions without permission or resubmission questions']
  const check = (body: string) => { for (const safeguard of safeguards) assert.ok(body.includes(safeguard), safeguard) }
  const expected = 'For Lisp coding, plans or reviews, settle testable doubts with current evidence or authorized target-runtime probes. Choose controls and counterexamples first; record commands, failures, observations and refs in one reasoned plan. Stop when evidence suffices or budgets expire; ask only for needed intent or authority.'
  const compiled = compileSkillResource(lisp)
  assert.deepEqual(compiled.blocks, ['contract', 'prototype-driven-planning', 'approval-policy'])
  assert.ok(compiled.content.includes(expected))
  check(compiled.content)
  const misplaced = lisp.content.replace(/<!-- kiokuko:runtime prototype-driven-planning -->\n([\s\S]*?)<!-- \/kiokuko:runtime -->/u,
    '<!-- kiokuko:documentation prototype-driven-planning -->\n$1<!-- /kiokuko:documentation -->')
  assert.ok(!compileSkillResource({ ...lisp, content: misplaced }).content.includes(expected), 'the negative control must lose the obligation')
  const dir = await mkdtemp(join(tmpdir(), 'lisp-contract-'))
  try {
    const artifact = pathToFileURL(join(dir, 'bundle.json'))
    const fallback = new DshSkillPrompts({ mode: 'compiled' }, artifact, async () => sources)
    assert.ok((await fallback.require('kiokuko-lisp')).includes(expected))
    check(await fallback.require('kiokuko-lisp'))
    assert.equal(fallback.diagnostics().find(d => d.id === compiled.id)?.fallback, 'bundle_unavailable')
    await writeFile(artifact, JSON.stringify(compileSkillBundle(sources)))
    for (const mode of ['full', 'compiled'] as const) {
      const prompts = new DshSkillPrompts({ mode }, artifact, async () => sources)
      assert.ok((await prompts.require('kiokuko-lisp')).includes(expected))
      check(await prompts.require('kiokuko-lisp'))
      assert.ok((await prompts.require('one-shot-software-completion')).includes('with prototype-driven-planning for\ncoding/plans'))
      assert.ok(prompts.diagnostics().every(d => !d.fallback))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('compiler rejects unclassified, duplicate, nested, empty and malformed blocks', () => {
  for (const content of [`unclassified\n${contract}`, `${contract}\n${contract}`, contract.replace('Never replay completed effects.', ''),
    contract.replace('runtime core', 'runtime INVALID'), contract.replace('<!-- /kiokuko:runtime -->', ''),
    contract.replace('Never replay completed effects.', '<!-- kiokuko:runtime nested -->')]) {
    assert.throws(() => compileSkillResource(source(content)))
  }
})
test('markers inside fenced examples remain literal, not executable compiler instructions', () => {
  const content = '<!-- kiokuko:runtime core -->\n```md\n<!-- kiokuko:runtime example -->\n```\n<!-- /kiokuko:runtime -->'
  assert.match(compileSkillResource(source(content)).content, /<!-- kiokuko:runtime example -->/u)
  const reference = '# Reference\n```md\n<!-- kiokuko:runtime example -->\n```'
  assert.equal(compileSkillResource(source(reference)).content, reference)
})
test('extraction preserves code indentation, trailing spaces and CRLF within runtime blocks', () => {
  const literal='    literal code  \r\nsecond line\r'
  const compiled=compileSkillResource(source(`<!-- kiokuko:runtime code -->\r\n${literal}\n<!-- /kiokuko:runtime -->\r\n`))
  assert.ok(compiled.content.includes(literal))
})
test('runtime never compiles: absent, stale and corrupt artifacts deliver full source with diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-compiler-'))
  const artifact = pathToFileURL(join(dir, 'bundle.json')), sources = async () => [source(contract)]
  try {
    const absent = new DshSkillPrompts({mode:'compiled'}, artifact, sources)
    assert.equal((await absent.get('fixture'))?.content, contract)
    assert.equal(absent.diagnostics()[0]?.fallback, 'bundle_unavailable')
    absent.diagnostics()[0]!.representation = 'compiled'
    assert.equal(absent.diagnostics()[0]?.representation, 'full', 'caller cannot corrupt diagnostic state')
    await writeFile(artifact, JSON.stringify(compileSkillBundle(await sources())))
    const active = new DshSkillPrompts({mode:'compiled'}, artifact, sources)
    assert.equal((await active.get('fixture'))?.representation, 'compiled')
    assert.equal(await active.get('../fixture'), undefined)
    const stale = new DshSkillPrompts({mode:'compiled'}, artifact, async () => [source(`${contract}\n`)])
    assert.equal((await stale.get('fixture'))?.fallback, 'resource_mismatch')
    const corrupt = compileSkillBundle(await sources()); corrupt.resources[0]!.content = 'forged'
    await writeFile(artifact, JSON.stringify(corrupt))
    assert.equal((await new DshSkillPrompts({mode:'compiled'}, artifact, sources).get('fixture'))?.fallback, 'resource_mismatch')
    const invalidSource = new DshSkillPrompts({mode:'compiled'}, artifact, async () => { throw new Error('original integrity') })
    await assert.rejects(invalidSource.get('fixture'), /original integrity/u)
  } finally { await rm(dir, {recursive:true, force:true}) }
})

 test('approval policy survives compiled, full and missing-bundle fallback delivery', async () => {
  const sources = await loadSkillSources()
  const dir = await mkdtemp(join(tmpdir(), 'lisp-approval-guidance-'))
  try {
    const artifact = pathToFileURL(join(dir,'missing.json'))
    const expected = 'execute authorized actions without permission or resubmission questions'
    for (const mode of ['compiled','full'] as const) {
      const prompts = new DshSkillPrompts({mode}, artifact, async()=>sources)
      assert.ok((await prompts.require('kiokuko-lisp')).includes(expected))
    }
    assert.ok(compileSkillBundle(sources).resources.find(r=>r.id==='kiokuko-lisp/SKILL.md')!.content.includes(expected))
  } finally { await rm(dir,{recursive:true,force:true}) }
})
