import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadStandardSkillParity } from '../../../src/dsh/standard-skill-integrity.js'
import { compileSkillBundle } from '../../../src/dsh/skill-compiler.js'
import { codingSkills } from '../../../src/dsh/modules/resources.js'

test('all upstream skills and playbooks map to delivered resources', async () => {
  const ledger = JSON.parse(await readFile('docs/pstack-adaptation.json', 'utf8'))
  assert.equal(ledger.skills.length, 49)
  assert.equal(ledger.playbooks.length, 23)
  assert.equal(new Set(ledger.skills.map((r: {upstream: string}) => r.upstream)).size, 49)
  const parity = await loadStandardSkillParity()
  const paths = new Set(parity.files.map(f => `skills/${f.skillName}/${f.relativePath}`))
  for (const row of [...ledger.skills, ...ledger.playbooks]) {
    assert.ok(paths.has(row.destination), row.destination)
    assert.ok(row.disposition || row.changed)
  }
})

test('seven focused specialists reach module resources and compiled guidance', async () => {
  const names = ['investigate', 'architecture', 'review', 'benchmark', 'verification', 'skill-authoring', 'technical-writing'].map(n => `kiokuko-${n}`)
  const resources = codingSkills.resources!
  for (const name of names) {
    const primary = resources.find(r => r.name === name && r.relativePath === 'SKILL.md')!
    assert.ok(primary, name)
    const content = await primary.load()
    const compiled = compileSkillBundle([{ name, relativePath: 'SKILL.md', content }]).resources[0]!
    assert.equal(compiled.representation, 'compiled')
    assert.match(compiled.content, /grants no extra permissions/u)
    assert.ok(Buffer.byteLength(content) < 4096)
    assert.ok(resources.some(r => r.name === name && r.relativePath === 'references/cases.md'))
  }
})
