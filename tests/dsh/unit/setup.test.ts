import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DSH_MANAGED_BLOCK, renderDshInstructions, setupDsh } from '../../../src/dsh/setup.js'

const begin = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->'
const end = '<!-- END KIOKUKO MANAGED BLOCK -->'
const legacy = `${begin}\nsoulRead: true; create requestId; call task_prepare\n${end}`

test('migration preserves surrounding bytes and CRLF; duplicate, partial and reversed markers fail closed', () => {
  const source = `user prefix\r\n${legacy.replaceAll('\n', '\r\n')}\r\nuser suffix`
  const expected = `user prefix\r\n${DSH_MANAGED_BLOCK.replaceAll('\n', '\r\n')}\r\nuser suffix`
  assert.equal(renderDshInstructions(source), expected)
  assert.equal(renderDshInstructions(expected), expected)
  assert.equal(renderDshInstructions('unmanaged instructions'), 'unmanaged instructions')
  for (const malformed of [begin, end, `${end}${begin}`, `${legacy}${legacy}`]) {
    assert.throws(() => renderDshInstructions(malformed), { code: 'CONFLICT' })
  }
})

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-setup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const cwd = path.join(home, 'workspace')
  await mkdir(cwd)
  return { homeDirectory: home, cwd, agents: path.join(cwd, 'AGENTS.md') }
}

test('read-only check detects missing Japanese output and stale instructions; setup repairs both and stays idempotent', async t => {
  const options = await fixture(t)
  await writeFile(options.agents, `prefix\n${legacy}\nsuffix`, { mode: 0o640 })
  const check = await setupDsh({ ...options, check: true })
  assert.equal(check.current, false)
  assert.equal(check.skills.created, 23)
  assert.equal(check.instructions.status, 'update-needed')
  await assert.rejects(stat(path.join(options.homeDirectory, '.agents')), { code: 'ENOENT' })
  assert.equal(await readFile(options.agents, 'utf8'), `prefix\n${legacy}\nsuffix`)
  const applied = await setupDsh(options)
  assert.equal(applied.skills.created, 23)
  assert.equal(applied.instructions.status, 'updated')
  assert.equal(await readFile(options.agents, 'utf8'), `prefix\n${DSH_MANAGED_BLOCK}\nsuffix`)
  assert.equal((await stat(options.agents)).mode & 0o777, 0o640)
  const mtime = (await stat(options.agents)).mtimeMs
  assert.equal((await setupDsh(options)).skills.unchanged, 23)
  assert.equal((await stat(options.agents)).mtimeMs, mtime)
  const japanese = path.join(options.homeDirectory, '.agents/skills/japanese-translation-for-oss-models/SKILL.md')
  await rm(japanese)
  const missing = await setupDsh({ ...options, check: true })
  assert.equal(missing.current, false)
  assert.equal(missing.skills.created, 1)
  assert.equal((await setupDsh(options)).skills.created, 1)
  assert.equal((await setupDsh({ ...options, check: true })).current, true)
})

test('absent and unmanaged AGENTS.md are not created or replaced', async t => {
  const options = await fixture(t)
  assert.equal((await setupDsh(options)).instructions.status, 'unmanaged-or-absent')
  await assert.rejects(stat(options.agents), { code: 'ENOENT' })
  await writeFile(options.agents, 'my instructions')
  await setupDsh(options)
  assert.equal(await readFile(options.agents, 'utf8'), 'my instructions')
})

test('malformed or linked AGENTS.md prevents all setup writes', async t => {
  const options = await fixture(t)
  await writeFile(options.agents, begin)
  await assert.rejects(setupDsh(options), { code: 'CONFLICT' })
  await assert.rejects(stat(path.join(options.homeDirectory, '.agents')), { code: 'ENOENT' })
  await rm(options.agents)
  const outside = path.join(options.homeDirectory, 'user-instructions')
  await writeFile(outside, legacy)
  await symlink(outside, options.agents)
  await assert.rejects(setupDsh(options), { code: 'SECURITY_REJECTION' })
  assert.equal(await readFile(outside, 'utf8'), legacy)
})

test('unsafe project directory rejects replacement; setup succeeds after permissions are repaired', async t => {
  if (process.platform === 'win32') return t.skip('POSIX directory permissions')
  const options = await fixture(t)
  await writeFile(options.agents, legacy)
  await chmod(options.cwd, 0o777)
  await assert.rejects(setupDsh(options), { code: 'SECURITY_REJECTION' })
  assert.equal(await readFile(options.agents, 'utf8'), legacy)
  await chmod(options.cwd, 0o700)
  assert.equal((await setupDsh(options)).instructions.status, 'updated')
  assert.equal((await setupDsh({ ...options, check: true })).current, true)
})
