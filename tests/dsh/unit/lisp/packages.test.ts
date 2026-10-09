import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLispPackageAdapter } from '../../../../src/dsh/lisp/packages.js'
import type { PackageCommand } from '../../../../src/dsh/lisp/package-manager.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const signal = new AbortController().signal
const owner = { root: '/repo', agentId: 'agent', sessionId: 'session' }
const questions = (allow: boolean): DshUserQuestions => ({ ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![allow ? 1 : 0]!.label] }] }) })
const metadata = { name: 'sprintf-js', version: '1.1.3', dist: { integrity: 'sha512-fixture', tarball: 'https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz' } }

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'packages-unit-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { prepare: 'must-not-run' }, dependencies: { 'sprintf-js': '^1.1.2' } }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }))
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\npackages: {}\n')
  await writeFile(join(root, 'pnpm-workspace.yaml'), '# keep policy\nallowBuilds:\n  trusted: true\n')
  return { ...owner, root }
}

test('package broker rejects malformed names, versions and arbitrary URL/command fields before effects', async () => {
  let calls = 0
  const adapter = createLispPackageAdapter(questions(true), async () => { calls++; return Response.json(metadata) })
  for (const request of [
    { kind: 'metadata', name: '../secret' }, { kind: 'metadata', name: 'sprintf-js', version: 'file:/private' },
    { kind: 'metadata', name: 'sprintf-js', url: 'http://localhost' }, { kind: 'audit', versions: {} },
    { kind: 'update', versions: { 'sprintf-js': '^1.1.3' }, command: 'sh' },
  ]) await assert.rejects(adapter(owner, request, signal))
  assert.equal(calls, 0)
})

test('missing, declined and cancelled approvals produce no registry effects', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(metadata) }
  for (const approval of [undefined, questions(false)]) {
    const result = await createLispPackageAdapter(approval, fetcher)(owner, { kind: 'metadata', name: 'sprintf-js' }, signal)
    assert.equal((result.value as any).state, 'NOT_APPLIED')
  }
  const controller = new AbortController(); controller.abort()
  const result = await createLispPackageAdapter(questions(true), fetcher)(owner, { kind: 'metadata', name: 'sprintf-js' }, controller.signal)
  assert.equal((result.value as any).state, 'NOT_APPLIED'); assert.equal(calls, 0)
})

test('metadata and advisory lookup use fixed public endpoints, selected data and no credentials/retries', async () => {
  const requests: unknown[] = []
  const adapter = createLispPackageAdapter(questions(true), async (url, init) => {
    requests.push([url, init?.method, init?.credentials, init?.redirect, init?.body])
    return Response.json(init?.method === 'POST' ? {} : metadata)
  })
  const result = await adapter(owner, { kind: 'metadata', name: 'sprintf-js', version: '1.1.3' }, signal)
  assert.equal((result.value as any).package.version, '1.1.3')
  const audit = await adapter(owner, { kind: 'audit', versions: { 'sprintf-js': '1.1.3' } }, signal)
  assert.deepEqual((audit.value as any).audited, { 'sprintf-js': '1.1.3' })
  assert.deepEqual(requests, [
    ['https://registry.npmjs.org/sprintf-js/1.1.3', 'GET', 'omit', 'error', undefined],
    ['https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', 'POST', 'omit', 'error', '{"sprintf-js":["1.1.3"]}'],
  ])
})

test('registry identity, oversized and failed responses cannot become successful metadata', async () => {
  for (const response of [Response.json({ ...metadata, name: 'other' }), new Response('x'.repeat(262145)), new Response('', { status: 503 })]) {
    let calls = 0
    const adapter = createLispPackageAdapter(questions(true), async () => { calls++; return response })
    await assert.rejects(adapter(owner, { kind: 'metadata', name: 'sprintf-js' }, signal)); assert.equal(calls, 1)
  }
})

test('cancellation settles a noncooperative registry fetch and discards its late response', async () => {
  const controller = new AbortController()
  let release!: (response: Response) => void
  const adapter = createLispPackageAdapter(questions(true), async () => new Promise<Response>(resolve => { release = resolve; controller.abort(new Error('cancelled')) }))
  await assert.rejects(adapter(owner, { kind: 'metadata', name: 'sprintf-js' }, controller.signal), /cancelled/u)
  release(Response.json(metadata))
})

test('dual-lock generation is private, script-free, bounded and leaves original files untouched', async t => {
  const bound = await fixture(t), original = await readFile(join(bound.root, 'package.json'), 'utf8')
  const directories = new Set<string>(), calls: Array<[string, string[]]> = []
  const command: PackageCommand = async (manager, args, directory) => {
    directories.add(directory); calls.push([manager, args]); assert.notEqual(directory, bound.root)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.scripts, undefined); assert.equal(manifest.packageManager, undefined)
    assert.equal(manifest.overrides['sprintf-js'], '1.1.3')
    if (args[0] === '--version') return { code: 0, stdout: manager === 'npm' ? '11.0.0' : '11.0.0', stderr: '' }
    assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--package-lock-only') || args.includes('--lockfile-only'))
    if (manager === 'npm') await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/sprintf-js': { version: '1.1.3' } } }))
    else await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\npackages:\n  sprintf-js@1.1.3: {}\n')
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await createLispPackageAdapter(questions(true), undefined, command)(bound, { kind: 'update', versions: { 'sprintf-js': '1.1.3' } }, signal)
  assert.equal((result.value as any).generatedOnly, true)
  assert.equal((result.value as any).files.length, 4); assert.equal(result.base?.readSet.length, 4)
  assert.match((result.value as any).files.find((file: any) => file.path === 'pnpm-workspace.yaml').content, /# keep policy/u)
  assert.equal(await readFile(join(bound.root, 'package.json'), 'utf8'), original)
  assert.equal(calls.length, 4)
  for (const directory of directories) await assert.rejects(access(directory))
})

test('stale approval and command failure return no generated proposals or project writes', async t => {
  const bound = await fixture(t); let calls = 0
  const changed: DshUserQuestions = { ask: async request => {
    await writeFile(join(bound.root, 'package.json'), '{"name":"changed"}')
    return questions(true).ask(request)
  } }
  const command: PackageCommand = async () => { calls++; return { code: 0, stdout: '11.0.0', stderr: '' } }
  await assert.rejects(createLispPackageAdapter(changed, undefined, command)(bound, { kind: 'update', versions: { 'sprintf-js': '1.1.3' } }, signal), { code: 'PACKAGES_BASE_CHANGED' })
  assert.equal(calls, 0)
  const failing: PackageCommand = async (_manager, args) => ({ code: args[0] === '--version' ? 0 : 2, stdout: '11.0.0', stderr: 'failed' })
  await assert.rejects(createLispPackageAdapter(questions(true), undefined, failing)(bound, { kind: 'update', versions: { 'sprintf-js': '1.1.3' } }, signal), { code: 'PACKAGES_COMMAND_FAILED' })
  assert.equal(await readFile(join(bound.root, 'package.json'), 'utf8'), '{"name":"changed"}')
})

test('local source dependencies and escaping project paths never launch package managers', async t => {
  const bound = await fixture(t); let calls = 0
  await writeFile(join(bound.root, 'package.json'), '{"dependencies":{"secret":"file:/private"}}')
  const command: PackageCommand = async () => { calls++; return { code: 0, stdout: '11.0.0', stderr: '' } }
  const adapter = createLispPackageAdapter(questions(true), undefined, command)
  for (const directory of ['.', '../escape', '/private']) await assert.rejects(adapter(bound, { kind: 'update', directory, versions: { 'sprintf-js': '1.1.3' } }, signal))
  assert.equal(calls, 0)
})
