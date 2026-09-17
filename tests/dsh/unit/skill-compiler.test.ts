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
