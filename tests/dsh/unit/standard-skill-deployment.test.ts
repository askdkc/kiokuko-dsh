import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { synchronizeStandardSkills } from '../../../src/dsh/standard-skill-deployment.js'
import { loadStandardSkillParity } from '../../../src/dsh/standard-skill-integrity.js'

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-deploy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return realpath(directory)
}

test('deployment creates all six Skills and references, updates managed copies, and preserves user files', async t => {
  const home = await fixture(t)
  const parity = await loadStandardSkillParity()
  const initial = await synchronizeStandardSkills(home)
  assert.deepEqual(initial, { directory: path.join(home, '.agents', 'skills'), created: 21, updated: 0, unchanged: 0 })
  const root = initial.directory
  for (const file of parity.files) assert.equal(await readFile(path.join(root, file.skillName, file.relativePath), 'utf8'), file.content)
  const soul = parity.files.find(file => file.skillName === 'kiokuko-soul')!
  const soulPath = path.join(root, soul.skillName, soul.relativePath)
  await writeFile(soulPath, `${soul.managedMarker}\nold soulRead requestId contract\n`)
  await rm(path.join(root, 'kiokuko-enno-oduno'), { recursive: true })
  await writeFile(path.join(root, 'notes.txt'), 'user notes')
  await writeFile(path.join(root, 'kiokuko-simple-work', 'custom.md'), 'user extension')
  const updated = await synchronizeStandardSkills(home)
  assert.equal(updated.updated, 1)
  assert.equal(updated.created, 1)
  assert.equal(await readFile(soulPath, 'utf8'), soul.content)
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'user notes')
  assert.equal(await readFile(path.join(root, 'kiokuko-simple-work', 'custom.md'), 'utf8'), 'user extension')
  const before = await lstat(soulPath)
  assert.deepEqual(await synchronizeStandardSkills(home), { directory: root, created: 0, updated: 0, unchanged: 21 })
  assert.equal((await lstat(soulPath)).mtimeMs, before.mtimeMs)
})

test('unmanaged conflict is detected before any managed file is changed', async t => {
  const home = await fixture(t)
  const { directory } = await synchronizeStandardSkills(home)
  const parity = await loadStandardSkillParity()
  const first = parity.files[0]!
  const firstPath = path.join(directory, first.skillName, first.relativePath)
  const old = `${first.managedMarker}\nold managed version`
  await writeFile(firstPath, old)
  const conflict = path.join(directory, 'kiokuko-soul', 'SKILL.md')
  await writeFile(conflict, 'user-owned same-name Skill')
  await assert.rejects(synchronizeStandardSkills(home), { code: 'CONFLICT' })
  assert.equal(await readFile(firstPath, 'utf8'), old)
  assert.equal(await readFile(conflict, 'utf8'), 'user-owned same-name Skill')
})

test('deployment refuses linked ancestors, Skill directories, references and files without touching the target', async t => {
  for (const relative of ['.agents', '.agents/skills', '.agents/skills/kiokuko-soul', '.agents/skills/kiokuko-single-purpose-functions/references', '.agents/skills/kiokuko-soul/SKILL.md']) {
    const home = await fixture(t)
    const outside = await fixture(t)
    const linked = path.join(home, relative)
    await mkdir(path.dirname(linked), { recursive: true })
    const isFile = relative.endsWith('SKILL.md')
    const target = isFile ? path.join(outside, 'user.md') : outside
    if (isFile) await writeFile(target, 'untouched')
    await symlink(target, linked, isFile ? 'file' : 'dir')
    await assert.rejects(synchronizeStandardSkills(home), { code: 'SECURITY_REJECTION' })
    assert.equal((await lstat(linked)).isSymbolicLink(), true)
    if (isFile) assert.equal(await readFile(target, 'utf8'), 'untouched')
    else assert.deepEqual(await readdir(outside), [])
  }
})

test('concurrent synchronizations publish complete files without temporary residue', async t => {
  const home = await fixture(t)
  await Promise.all([synchronizeStandardSkills(home), synchronizeStandardSkills(home)])
  const parity = await loadStandardSkillParity()
  for (const file of parity.files) {
    const target = path.join(home, '.agents', 'skills', file.skillName, file.relativePath)
    assert.equal(await readFile(target, 'utf8'), file.content)
    assert.ok((await readdir(path.dirname(target))).every(name => !name.startsWith('.kiokuko-skill-')))
  }
})
