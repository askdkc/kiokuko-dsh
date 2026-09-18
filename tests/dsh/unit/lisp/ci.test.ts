import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, writeFile, rm, mkdir, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const owner = { sessionId: 'session', agentId: 'agent', root: '/repo' }
const signal = new AbortController().signal

function questions(allow: boolean): DshUserQuestions {
  return { ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![allow ? 1 : 0]!.label] }] }) }
}

test('Lisp CI reads only the bound repository with fixed gh arguments', async () => {
  const calls: unknown[] = []
  const adapter = createLispCiAdapter(undefined, async (file, args, options) => {
    calls.push({ file, args, options })
    return { code: 0, stdout: '[{"databaseId":42}]', stderr: '' }
  })
  assert.deepEqual(await adapter(owner, { kind: 'list-runs', limit: 3 }, signal), { source: 'github', repositoryRoot: '/repo', runs: [{ databaseId: 42 }] })
  assert.deepEqual(calls, [{ file: 'gh', args: ['run', 'list', '--limit', '3', '--json', 'databaseId,name,status,conclusion,headBranch,headSha,url'], options: { cwd: '/repo', timeoutMs: 30000, signal } }])
})

test('Lisp CI verifier fails closed without approval and runs only a fixed target after approval', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ci-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const bound = { ...owner, root }; await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }))
  let calls = 0
  const runner = async (file: string, args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }) => {
    calls++; assert.equal(file, 'npm'); assert.deepEqual(args, ['run', 'typecheck']); assert.equal(options.cwd, bound.root)
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  const denied = createLispCiAdapter(questions(false), runner)
  assert.deepEqual(await denied(bound, { kind: 'verify', target: 'typecheck' }, signal), { target: 'typecheck', script: 'typecheck', state: 'NOT_APPLIED', reason: 'declined' })
  assert.equal(calls, 0)
  const allowed = createLispCiAdapter(questions(true), runner)
  assert.deepEqual(await allowed(bound, { kind: 'verify', target: 'typecheck' }, signal), { target: 'typecheck', script: 'typecheck', state: 'SUCCEEDED', code: 0, stdout: 'ok', stderr: '' })
  assert.equal(calls, 1)
})

test('Lisp CI exposes nonzero verifier outcomes without claiming success', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ci-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const bound = { ...owner, root }; await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'verify:lisp:vendor': 'node vendor.mjs' } }))
  const adapter = createLispCiAdapter(questions(true), async () => ({ code: 2, stdout: '', stderr: 'failed' }))
  assert.deepEqual(await adapter(bound, { kind: 'verify', target: 'vendor' }, signal), { target: 'vendor', script: 'verify:lisp:vendor', state: 'FAILED', code: 2, stdout: '', stderr: 'failed' })
})

test('Lisp verification selects the exact workspace or scratch project and shows it for approval', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ci-directory-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace'), scratch = join(base, 'scratch')
  for (const directory of [root, scratch]) {
    await mkdir(join(directory, 'project'), { recursive: true })
    await writeFile(join(directory, 'project/package.json'), JSON.stringify({ scripts: { test: 'node --test test.mjs' } }))
  }
  for (const location of ['workspace', 'scratch'] as const) {
    const cwd = join(location === 'scratch' ? scratch : root, 'project')
    let asked = 0, executed = 0
    const adapter = createLispCiAdapter({ ask: async request => {
      asked++
      assert.ok(request.questions[0]!.detail!.includes(cwd))
      assert.match(request.questions[0]!.detail!, /npm test/u)
      return questions(true).ask(request)
    } }, async (file, args, options) => {
      executed++; assert.equal(file, 'npm'); assert.deepEqual(args, ['test']); assert.equal(options.cwd, cwd)
      return { code: 0, stdout: 'tests passed', stderr: '' }
    })
    const result = await adapter({ ...owner, root }, { kind: 'verify', target: 'test', location, directory: 'project' }, signal, scratch) as any
    assert.equal(result.state, 'SUCCEEDED'); assert.equal(result.cwd, cwd)
    assert.equal(asked, 1); assert.equal(executed, 1)
  }
})

test('Lisp verifier refuses escaping/link directories and directory replacement during approval', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ci-directory-denial-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project'))
  await writeFile(join(root, 'project/package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }))
  await symlink(join(root, 'project'), join(root, 'link'))
  let calls = 0, approvals = 0
  const adapter = createLispCiAdapter({ ask: async request => {
    approvals++
    await rename(join(root, 'project'), join(root, 'previous'))
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'project/package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }))
    return questions(true).ask(request)
  } }, async () => { calls++; return { code: 0, stdout: '', stderr: '' } })
  for (const directory of ['../project', '/tmp', 'link', '.git']) {
    await assert.rejects(adapter({ ...owner, root }, { kind: 'verify', target: 'test', directory }, signal))
  }
  await assert.rejects(adapter({ ...owner, root }, { kind: 'verify', target: 'test', location: 'scratch' }, signal), /scratch/u)
  assert.equal(approvals, 0); assert.equal(calls, 0)
  const replaced = await adapter({ ...owner, root }, { kind: 'verify', target: 'test', directory: 'project' }, signal) as any
  assert.equal(replaced.code, 'TARGET_CHANGED'); assert.equal(calls, 0)
})
