import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
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
