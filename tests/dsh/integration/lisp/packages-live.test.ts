import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLispPackageAdapter } from '../../../../src/dsh/lisp/packages.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

// Explicit live command approval covers only these public registry operations on copied fixtures.
test('live public registry and protected package managers regenerate copied root locks without lifecycle scripts', {
  skip: process.env.KIOKUKO_PACKAGE_LIVE !== '1' ? 'requires explicit live package-test approval' : false, timeout: 240000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'packages-live-'))), root = join(base, 'workspace')
  await mkdir(root); t.after(() => rm(base, { recursive: true, force: true }))
  const owner = { sessionId: 'live-test', agentId: 'live-test', root }
  const questions: DshUserQuestions = { ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![1]!.label] }] }) }
  const adapter = createLispPackageAdapter(questions), signal = new AbortController().signal
  const versions: Record<string, string> = {}
  for (const name of ['sharp', 'sprintf-js']) {
    const result = await adapter(owner, { kind: 'metadata', name }, signal)
    assert.equal((result.value as any).state, 'SUCCEEDED'); versions[name] = (result.value as any).package.version
  }
  const baseline = await adapter(owner, { kind: 'audit', versions: { sharp: '0.35.4', 'sprintf-js': '1.1.3' } }, signal)
  t.diagnostic(`Current selected advisories: ${JSON.stringify((baseline.value as any).advisories)}`)
  const patched = await adapter(owner, { kind: 'audit', versions }, signal)
  assert.deepEqual((patched.value as any).advisories, {}, 'chosen releases must have no selected npm advisories')
  t.diagnostic(`Registry-selected versions: ${JSON.stringify(versions)}`)
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await writeFile(join(root, name), await readFile(new URL(`../../../../${name}`, import.meta.url), 'utf8'))
  const original = await readFile(join(root, 'package.json'), 'utf8')
  const generated = await adapter(owner, { kind: 'update', versions }, signal), value = generated.value as any
  assert.equal(value.generatedOnly, true)
  assert.deepEqual(value.files.map((file: any) => file.path).sort(), ['package-lock.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
  const npm = JSON.parse(value.files.find((file: any) => file.path === 'package-lock.json').content)
  for (const [name, version] of Object.entries(versions)) assert.equal(npm.packages[`node_modules/${name}`].version, version)
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original)
  t.diagnostic(`Protected package-manager versions: ${JSON.stringify(value.managers)}`)
})
