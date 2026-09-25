import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitReader, parseHunks, type SubprocessService } from '../../../../src/diff-review/current-git-source.js'
import { captureNativeTurn } from '../../../../src/diff-review/native-turn-source.js'
import { diffReviewResponse } from '../../../../src/dsh/diff-review-surface.js'
import { resolveReviewSession } from '../../../../src/dsh/session-review-context.js'
import { DiffReviewController } from '../../../../src/diff-review/controller.js'

const subprocess: SubprocessService = {
  async resolveExecutable(command) { return command },
  spawn(spec) {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    const error: Buffer[] = []
    // The fake uses pipes so it has the same bounded-output contract as the native collect mode.
    child.stdout?.on('data', chunk => output.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => error.push(Buffer.from(chunk)))
    const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve({ exitCode: code }))
      spec.signal.addEventListener('abort', () => child.kill(), { once: true })
    })
    return { done, collected: {
      stdout: { readFrom: () => { const value = Buffer.concat(output); return { text: value.toString(), lossy: value.length > spec.stdio.stdout.maxBytes } } },
      stderr: { readFrom: () => ({ text: Buffer.concat(error).toString() }) },
    } }
  },
}

test('hunk parsing retains deletions and no-newline markers for snapshot line mapping', () => {
  const hunks = parseHunks('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n')
  assert.deepEqual(hunks[0]?.lines, ['-old', '\\ No newline at end of file', '+new'])
})

test('current Git keeps staged, unstaged and explicitly selected untracked layers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-diff-review-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(root, 'file.txt'), 'one\n')
    git('add', 'file.txt')
    git('commit', '-qm', 'baseline')
    await writeFile(join(root, 'file.txt'), 'two\n')
    git('add', 'file.txt')
    await writeFile(join(root, 'file.txt'), 'three\n')
    await writeFile(join(root, 'untracked.txt'), 'new\n')
    await writeFile(join(root, '.env'), 'API_KEY=some-secret-value-12345\n')
    const reader = new GitReader(subprocess, await realpath(root), { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000 })
    assert.equal(await reader.available(new AbortController().signal), true)
    const captured = await reader.capture('current', ['untracked.txt', '.env'], new AbortController().signal)
    assert.equal(captured.total, 4)
    assert.deepEqual(captured.files.filter(file => file.displayPath === 'file.txt').map(file => file.layer), ['staged', 'unstaged'])
    assert.ok(captured.files.find(file => file.displayPath === 'file.txt' && file.layer === 'staged')?.hunks[0]?.lines.includes('-one'))
    assert.ok(captured.files.find(file => file.displayPath === 'file.txt' && file.layer === 'unstaged')?.hunks[0]?.lines.includes('-two'))
    assert.ok(captured.files.find(file => file.displayPath === 'untracked.txt')?.hunks[0]?.lines.includes('+new'))
    assert.equal(captured.files.find(file => file.newPath === undefined && file.kind === 'excluded')?.reason, 'secret_path')
    await assert.rejects(reader.capture('current', ['not-listed.txt'], new AbortController().signal), { code: 'invalid_untracked_selection' })
    const runtime = { withDatabase: async (read: (db: unknown) => unknown) => read({ prepare: () => ({ get: () => undefined }) }) }
    const controller = new DiffReviewController({ runtime: runtime as never, sessions: { get: id => ({ id, header: { cwd: root } }) }, subprocess },
      { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000, maxInputBytes: 32768,
        maxChunks: 4, maxOutputTokens: 2048, deadlineMs: 120000, maxCacheBytes: 33554432, ttlMs: 1800000 })
    const review = await controller.capture({ sessionId: 'session', mode: 'current', untracked: ['untracked.txt'], requestId: crypto.randomUUID() })
    const selected = review.snapshot.files.find(file => file.newPath === 'untracked.txt')!
    assert.equal(await controller.fileAddress('session', review.reviewId, selected.fileId), 'dsh-resource://file/session/session/untracked.txt')
    await writeFile(join(root, 'untracked.txt'), 'changed after capture\n')
    await assert.rejects(controller.fileAddress('session', review.reviewId, selected.fileId), { code: 'file_changed' })
    await controller.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unborn HEAD, rename, symlink and untracked edits keep their distinct facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-diff-edge-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(root, 'old name.txt'), 'first\n')
    git('add', 'old name.txt')
    const reader = new GitReader(subprocess, await realpath(root), { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000 })
    const unborn = await reader.capture('staged', [], new AbortController().signal)
    assert.equal(unborn.headOid, undefined)
    assert.equal(unborn.files[0]?.kind, 'text')
    git('commit', '-qm', 'baseline')
    await rename(join(root, 'old name.txt'), join(root, 'renamed name.txt'))
    git('add', '-A')
    await chmod(join(root, 'renamed name.txt'), 0o755)
    await symlink('renamed name.txt', join(root, 'link.txt'))
    await writeFile(join(root, 'untracked.txt'), 'before\n')
    const captured = await reader.capture('current', ['untracked.txt', 'link.txt'], new AbortController().signal)
    assert.equal(captured.files.find(file => file.newPath === 'renamed name.txt')?.oldPath, 'old name.txt')
    assert.equal(captured.files.find(file => file.newPath === 'renamed name.txt' && file.layer === 'unstaged')?.newMode, '100755')
    assert.equal(captured.files.find(file => file.newPath === 'link.txt')?.kind, 'symlink')
    assert.equal(captured.files.find(file => file.newPath === 'untracked.txt')?.kind, 'text')
    assert.equal(await reader.matchesCapturedFiles(captured.files), true)
    await writeFile(join(root, 'untracked.txt'), 'after\n')
    assert.equal(await reader.matchesCapturedFiles(captured.files), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('linked worktree stays bound to its own canonical root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-linked-review-'))
  const main = join(base, 'main'), linked = join(base, 'linked')
  try {
    await mkdir(main)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(main, 'file.txt'), 'before\n')
    git('add', 'file.txt')
    git('commit', '-qm', 'baseline')
    git('worktree', 'add', '-qb', 'review-linked', linked)
    await writeFile(join(linked, 'file.txt'), 'after\n')
    const reader = new GitReader(subprocess, await realpath(linked), { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000 })
    assert.equal(await reader.available(new AbortController().signal), true)
    const captured = await reader.capture('unstaged', [], new AbortController().signal)
    assert.equal(captured.files[0]?.newPath, 'file.txt')
    assert.ok(captured.files[0]?.hunks[0]?.lines.includes('-before'))
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('native turn rejects missing snapshots and excludes paths outside the bound repository', async () => {
  const limits = { maxFiles: 10, maxFileBytes: 262144, maxSnapshotBytes: 2097152 }
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-turn-review-'))
  const root = await realpath(directory)
  try {
    await assert.rejects(captureNativeTurn(undefined, 'session', 3, root, limits, new AbortController().signal), { code: 'turn_snapshot_unavailable' })
    const source = { summary: () => ({ cwd: root, total: 1, files: [{ path: '../other/secret.txt' }] }), diff: async () => { throw new Error('must not read outside root') } }
    const result = await captureNativeTurn(source, 'session', 3, root, limits, new AbortController().signal)
    assert.equal(result.files[0]?.kind, 'excluded')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('HTTP rejects cross-origin mutation before invoking the controller', async () => {
  const response = await diffReviewResponse({ capture: () => { throw new Error('unexpected call') } } as never,
    new Request('http://dsh.internal/api/kiokuko.diff-review?sessionId=s', { method: 'POST', headers: { host: 'dsh.internal', origin: 'https://foreign.invalid' }, body: '{}' }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { code: 'origin_mismatch' })
})

test('review availability distinguishes registered models from catalog failures and missing services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-review-models-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const root = await realpath(directory)
    const runtime = { withDatabase: async (read: (db: unknown) => unknown) => read({ prepare: () => ({ get: () => undefined }) }) }
    const base = { runtime: runtime as never, sessions: { get: (id: string) => ({ id, header: { cwd: root } }) }, llm: {} as never }
    const limits = { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000,
      maxInputBytes: 32768, maxChunks: 4, maxOutputTokens: 2048, deadlineMs: 120000, maxCacheBytes: 33554432, ttlMs: 1800000 }
    const catalog = { listProviders: () => [{ id: 'configured', name: 'Configured' }],
      listModels: async (provider: string) => [{ provider, id: 'review-model', name: 'Review Model' }] }
    const ready = new DiffReviewController({ ...base, catalog }, limits)
    const response = await diffReviewResponse(ready, new Request('http://dsh.internal/api/kiokuko.diff-review?sessionId=session'))
    assert.equal(response.status, 200)
    const body = await response.json() as { modelAvailability: string; models: unknown }
    assert.deepEqual({ modelAvailability: body.modelAvailability, models: body.models },
      { modelAvailability: 'available', models: [{ provider: 'configured', model: 'review-model' }] })
    await ready.dispose()

    const broken = new DiffReviewController({ ...base, catalog: { ...catalog, listModels: async () => { throw new Error('catalog down') } } }, limits)
    assert.equal((await broken.availability('session')).modelAvailability, 'catalog_error')
    await broken.dispose()
    const empty = new DiffReviewController({ ...base, catalog: { ...catalog, listProviders: () => [] } }, limits)
    assert.equal((await empty.availability('session')).modelAvailability, 'no_models')
    await empty.dispose()
    const missing = new DiffReviewController({ runtime: base.runtime, sessions: base.sessions, catalog }, limits)
    assert.equal((await missing.availability('session')).modelAvailability, 'service_unavailable')
    await missing.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('saved native session metadata binds a completed-session review to its current repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-review-binding-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const root = await realpath(directory)
    const runtime = { withDatabase: async (read: (db: unknown) => unknown) => read({ prepare: () => ({ get: () => undefined }) }) }
    const persistence = { stat: async (sessionId: string) => ({ header: { id: sessionId, cwd: root } }) }
    const binding = await resolveReviewSession(runtime as never, undefined, persistence, 'finished-session')
    assert.equal(binding.sessionId, 'finished-session')
    assert.equal(binding.repositoryRoot, root)
    await assert.rejects(resolveReviewSession(runtime as never, undefined, { stat: async () => ({ header: { id: 'other-session', cwd: root } }) }, 'finished-session'),
      { code: 'session_unavailable' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('capture request IDs and review ownership are checked on the server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-review-owner-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const root = await realpath(directory)
    const runtime = { withDatabase: async (read: (db: unknown) => unknown) => read({ prepare: () => ({ get: () => undefined }) }) }
    const controller = new DiffReviewController({ runtime: runtime as never,
      sessions: { get: (id: string) => ({ id, header: { cwd: root } }) },
      workspaceChanges: { summary: () => ({ cwd: root, total: 1, files: [{ path: 'a.txt' }] }),
        diff: async () => ({ kind: 'text' as const, path: 'a.txt', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }) },
    }, { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000,
      maxInputBytes: 32768, maxChunks: 4, maxOutputTokens: 2048, deadlineMs: 120000, maxCacheBytes: 33554432, ttlMs: 1800000 })
    const input = { sessionId: 'session-a', mode: 'turn' as const, turnSeq: 1, untracked: [], requestId: crypto.randomUUID() }
    const first = await controller.capture(input)
    assert.equal((await controller.capture(input)).reviewId, first.reviewId)
    await assert.rejects(controller.capture({ ...input, turnSeq: 2 }), { code: 'request_id_conflict' })
    await assert.rejects(controller.get('session-b', first.reviewId), { code: 'review_identity_mismatch' })
    const second = await controller.capture({ ...input, requestId: crypto.randomUUID() })
    assert.notEqual(second.reviewId, first.reviewId)
    await assert.rejects(controller.get('session-a', first.reviewId), { code: 'review_expired' })
    await controller.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('plugin disposal aborts a pending native snapshot before it is cached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-review-unload-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const root = await realpath(directory)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const runtime = { withDatabase: async (read: (db: unknown) => unknown) => read({ prepare: () => ({ get: () => undefined }) }) }
    const controller = new DiffReviewController({ runtime: runtime as never, sessions: { get: id => ({ id, header: { cwd: root } }) },
      workspaceChanges: { summary: () => ({ cwd: root, total: 1, files: [{ path: 'a.txt' }] }),
        diff: async () => { entered(); return new Promise<never>(() => undefined) } },
    }, { maxFiles: 200, maxFileBytes: 262144, maxSnapshotBytes: 2097152, timeoutMs: 15000, maxInputBytes: 32768,
      maxChunks: 4, maxOutputTokens: 2048, deadlineMs: 120000, maxCacheBytes: 33554432, ttlMs: 1800000 })
    const pending = controller.capture({ sessionId: 'session', mode: 'turn', turnSeq: 1, untracked: [], requestId: crypto.randomUUID() })
    const rejected = assert.rejects(pending)
    await started
    await controller.dispose()
    await rejected
  } finally { await rm(directory, { recursive: true, force: true }) }
})
