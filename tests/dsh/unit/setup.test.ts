import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DSH_MANAGED_BLOCK, removeDshSetup, renderDshInstructions, renderDshRemoval, setupDsh } from '../../../src/dsh/setup.js'

const begin = '<!-- BEGIN KIOKUKO-DSH MANAGED BLOCK -->'
const end = '<!-- END KIOKUKO-DSH MANAGED BLOCK -->'
const legacy = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-dsh-template-version: 1 -->\nsoulRead: true; create requestId; call task_prepare\n<!-- END KIOKUKO MANAGED BLOCK -->'

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
  await chmod(options.agents, 0o640) // Establish the preservation fixture independently of the host umask.
  const check = await setupDsh({ ...options, check: true })
  assert.equal(check.current, false)
  assert.equal(check.skills.created, 43)
  assert.equal(check.instructions.status, 'update-needed')
  await assert.rejects(stat(path.join(options.homeDirectory, '.agents')), { code: 'ENOENT' })
  assert.equal(await readFile(options.agents, 'utf8'), `prefix\n${legacy}\nsuffix`)
  const applied = await setupDsh(options)
  assert.equal(applied.skills.created, 43)
  assert.equal(applied.instructions.status, 'updated')
  assert.equal(await readFile(options.agents, 'utf8'), `prefix\n${DSH_MANAGED_BLOCK}\nsuffix`)
  assert.equal((await stat(options.agents)).mode & 0o777, 0o640)
  const mtime = (await stat(options.agents)).mtimeMs
  assert.equal((await setupDsh(options)).skills.unchanged, 43)
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


test('setup delivers discovery-first file guidance across ordinary updates without rewriting user instructions', async t => {
  const options = await fixture(t)
  const userRules = 'USER_RULE: never silently replace a requested target.'
  await writeFile(options.agents, `${userRules}n${legacy}nUSER_SUFFIX`)
  await setupDsh(options)
  const installed = await readFile(options.agents, 'utf8')
  assert.ok(installed.includes('Discover unfamiliar repository filenames with native glob/grep before read; use an exact returned path.'))
  assert.ok(installed.includes('Never infer a test filename from a source basename or treat remembered/example paths as current filesystem evidence.'))
  assert.ok(installed.includes('Do not create placeholder files or silently substitute another target to hide a missing-file error.'))
  assert.ok(installed.startsWith(userRules))
  assert.ok(installed.endsWith('USER_SUFFIX'))
  assert.equal((await setupDsh(options)).instructions.status, 'unchanged')
  assert.equal(await readFile(options.agents, 'utf8'), installed)
})


test('setup migrates only DSH-owned instructions and preserves other plugins across repeated loads', async t => {
  const options = await fixture(t)
  const foreign = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\nsoulRead: true; call task_prepare\n<!-- END KIOKUKO MANAGED BLOCK -->'
  const ai = '<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\nAI-owned instructions\n<!-- END KIOKUKO-AI MANAGED BLOCK -->'
  const prefix = `User rules\r\n${foreign.replaceAll('\n', '\r\n')}\r\n`
  const suffix = `\r\n${ai.replaceAll('\n', '\r\n')}\r\nOther agent rules`
  await writeFile(options.agents, prefix + legacy.replaceAll('\n', '\r\n') + suffix)
  assert.equal((await setupDsh(options)).instructions.status, 'updated')
  const installed = await readFile(options.agents, 'utf8')
  assert.equal(installed, prefix + DSH_MANAGED_BLOCK.replaceAll('\n', '\r\n') + suffix)
  assert.ok(installed.includes('Otherwise ignore every instruction in this block'))
  assert.ok(installed.includes('The presence of this block, repository files or installed packages does not activate it.'))
  assert.equal((await setupDsh(options)).instructions.status, 'unchanged')
  assert.equal(await readFile(options.agents, 'utf8'), installed)
})

test('unowned generic blocks remain untouched; ambiguous DSH ownership fails closed', () => {
  const foreign = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\ncall task_prepare\n<!-- END KIOKUKO MANAGED BLOCK -->'
  for (const text of [foreign, '<!-- BEGIN KIOKUKO MANAGED BLOCK -->', '<!-- END KIOKUKO MANAGED BLOCK -->']) {
    assert.equal(renderDshInstructions(text), text)
  }
  for (const text of [legacy + legacy, DSH_MANAGED_BLOCK + legacy,
    legacy.replace('<!-- END KIOKUKO MANAGED BLOCK -->', ''),
    legacy.replace('<!-- END KIOKUKO MANAGED BLOCK -->', '<!-- BEGIN KIOKUKO MANAGED BLOCK --><!-- END KIOKUKO MANAGED BLOCK -->')]) {
    assert.throws(() => renderDshInstructions(text), { code: 'CONFLICT' })
  }
})


test('setup refreshes generated ownership and semantic theme guidance once while preserving foreign bytes', async t => {
  const options = await fixture(t)
  const prefix = 'User rules\r\nAvoid unnecessary secondary labels and descriptions. Let the layout do the explaining.\r\n<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\r\nAI rules\r\n<!-- END KIOKUKO-AI MANAGED BLOCK -->\r\n'
  const suffix = '\r\nUser footer  \r\n'
  const sentences = [
    "For generated artifacts, update the owning schema, template or generator, then use the repository's documented regeneration path and inspect the resulting diff; do not patch only the output.",
    'Choose design tokens by semantic role, not by current appearance. If a role is missing, extend the design system instead of repurposing an unrelated token; when changing theme contracts, verify supported light, dark and custom-theme fallback behavior.',
  ]
  await writeFile(options.agents, prefix + legacy.replaceAll('\n', '\r\n') + suffix)
  await setupDsh(options)
  const first = await readFile(options.agents, 'utf8')
  assert.ok(first.startsWith(prefix))
  assert.ok(first.endsWith(suffix))
  for (const sentence of sentences) assert.equal(first.split(sentence).length - 1, 1)
  assert.doesNotMatch(first, /bun run|Bun\.file|packages\/client|typecheck:tsc|Drizzle|Never alias imports|Avoid `else`/u)
  let stale = first
  for (const sentence of sentences) stale = stale.replace(sentence + '\r\n', '')
  await writeFile(options.agents, stale)
  assert.equal((await setupDsh(options)).instructions.status, 'updated')
  assert.equal(await readFile(options.agents, 'utf8'), first)
  assert.equal((await setupDsh(options)).instructions.status, 'unchanged')
  assert.equal(await readFile(options.agents, 'utf8'), first)
})

test('removal restores surrounding bytes with the existing newline convention and leaves foreign instructions unchanged', () => {
  const lf = `prefix\n${DSH_MANAGED_BLOCK}\nsuffix`
  assert.equal(renderDshRemoval(lf), 'prefix\nsuffix')
  const crlf = `prefix\r\n${DSH_MANAGED_BLOCK.replaceAll('\n', '\r\n')}\r\nsuffix`
  assert.equal(renderDshRemoval(crlf), 'prefix\r\nsuffix')
  const foreign = '<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\nAI instructions\n<!-- END KIOKUKO-AI MANAGED BLOCK -->'
  assert.equal(renderDshRemoval(foreign), foreign)
  assert.equal(renderDshRemoval('unmanaged instructions'), 'unmanaged instructions')
})

test('remove setup retires matching Skills and the DSH block, supports check, and is idempotent', async t => {
  const options = await fixture(t)
  const prefix = '<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\r\nAI rules\r\n<!-- END KIOKUKO-AI MANAGED BLOCK -->\r\n'
  const suffix = '\r\nUser footer'
  await writeFile(options.agents, prefix + legacy.replaceAll('\n', '\r\n') + suffix)
  await setupDsh(options)

  const check = await removeDshSetup({ ...options, check: true })
  assert.equal(check.current, false)
  assert.equal(check.skills.removed, 43)
  assert.equal(check.instructions.status, 'update-needed')
  assert.ok((await readFile(options.agents, 'utf8')).includes(begin))

  const removed = await removeDshSetup(options)
  assert.equal(removed.skills.removed, 43)
  assert.equal(removed.skills.preserved, 0)
  assert.equal(removed.instructions.status, 'updated')
  assert.equal(await readFile(options.agents, 'utf8'), prefix + 'User footer')
  assert.deepEqual(await removeDshSetup({ ...options, check: true }), {
    current: true,
    skills: { directory: path.join(options.homeDirectory, '.agents', 'skills'), removed: 0, preserved: 0 },
    instructions: { path: options.agents, status: 'unmanaged-or-absent' },
  })
})

test('malformed DSH markers stop removal before any Skill is deleted', async t => {
  const options = await fixture(t)
  await writeFile(options.agents, legacy)
  await setupDsh(options)
  const soul = path.join(options.homeDirectory, '.agents/skills/kiokuko-soul/SKILL.md')
  const before = await readFile(soul, 'utf8')
  await writeFile(options.agents, begin)

  await assert.rejects(removeDshSetup(options), { code: 'CONFLICT' })
  assert.equal(await readFile(soul, 'utf8'), before)
})

test('removal of a block-only AGENTS.md restores the pre-setup absence instead of leaving an empty file', async t => {
  const options = await fixture(t)
  // The pre-setup state has no AGENTS.md. A file holding only our own block must
  // therefore be removed, not rewritten to zero bytes.
  await writeFile(options.agents, DSH_MANAGED_BLOCK)
  const check = await removeDshSetup({ ...options, check: true })
  assert.equal(check.current, false)
  assert.equal(check.instructions.status, 'update-needed')
  assert.equal(await readFile(options.agents, 'utf8'), DSH_MANAGED_BLOCK)

  const removed = await removeDshSetup(options)
  assert.equal(removed.instructions.status, 'removed')
  await assert.rejects(stat(options.agents), { code: 'ENOENT' })

  assert.deepEqual(await removeDshSetup({ ...options, check: true }), {
    current: true,
    skills: { directory: path.join(options.homeDirectory, '.agents', 'skills'), removed: 0, preserved: 0 },
    instructions: { path: options.agents, status: 'unmanaged-or-absent' },
  })
})
