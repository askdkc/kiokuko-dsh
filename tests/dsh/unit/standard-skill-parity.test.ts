import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadBundledStandardSkillFiles, STANDARD_SKILL_MANIFESTS } from '../../../src/setup/standard-skills.js'
import { loadStandardSkillParity, validateStandardSkillParity } from '../../../src/dsh/parity.js'

test('standard Skill parity is six skills, 21 Markdown files, and 15 references', async () => {
  const parity = await loadStandardSkillParity()
  assert.deepEqual(parity.skills, STANDARD_SKILL_MANIFESTS.map((manifest) => manifest.name))
  assert.equal(parity.markdownFileCount, 21)
  assert.equal(parity.referenceFileCount, 15)
  assert.match(parity.contentDigest, /^[0-9a-f]{64}$/u)
})

test('parity rejects a marker or frontmatter mutation before provider exposure', async () => {
  const files = await loadBundledStandardSkillFiles()
  const primary = files.find((file) => file.skillName === 'kiokuko-soul' && file.relativePath === 'SKILL.md')!
  const changed = files.map((file) => file === primary ? { ...file, content: file.content.replace('name: kiokuko-soul', 'name: forged-soul') } : file)
  assert.throws(() => validateStandardSkillParity(changed), /frontmatter identity/u)
  const withoutMarker = files.map((file) => file === primary ? { ...file, content: file.content.replace(file.managedMarker, '') } : file)
  assert.throws(() => validateStandardSkillParity(withoutMarker), /marker/u)
  assert.notEqual(createHash('sha256').update(primary.content).digest('hex'), '')
})
